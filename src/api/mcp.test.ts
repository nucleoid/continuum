import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { buildMcpServer } from './mcp.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { StubEmbeddingProvider } from '../embeddings/stub.js';

interface CallToolResult {
  content: Array<{ type: string; text?: string }>;
}

function parseJsonResult(res: CallToolResult): unknown {
  const text = res.content.map((c) => c.text ?? '').join('');
  return JSON.parse(text);
}

function rawText(res: CallToolResult): string {
  return res.content.map((c) => c.text ?? '').join('');
}

describe('MCP server', () => {
  let pool: pg.Pool;
  const provider = new StubEmbeddingProvider();

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function connectClient() {
    const me = await createPrincipal(pool, {
      externalId: 'entra:user:mcp',
      kind: 'user',
      displayName: 'MCP User',
    });
    const teamPayments = await createScope(pool, { kind: 'team', name: 'payments' });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, me.id, teamPayments.id, 'writer');

    const server = buildMcpServer({ pool, embeddingProvider: provider, principal: me });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, me, teamPayments, org };
  }

  it('lists tools', async () => {
    const { client } = await connectClient();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'continuum.list_scopes',
        'continuum.capture',
        'continuum.recall',
        'continuum.promote',
        'continuum.verify',
        'continuum.ensure_scope',
      ]),
    );
  });

  it('list_scopes returns membership plus org', async () => {
    const { client } = await connectClient();
    const res = (await client.callTool({
      name: 'continuum.list_scopes',
      arguments: {},
    })) as CallToolResult;
    const list = parseJsonResult(res) as Array<{ scope: string; role: string }>;
    const scopes = list.map((s) => s.scope).sort();
    expect(scopes).toContain('org');
    expect(scopes).toContain('team:payments');
  });

  it('capture + recall round-trip', async () => {
    const { client } = await connectClient();
    const capture = (await client.callTool({
      name: 'continuum.capture',
      arguments: {
        scope_kind: 'team',
        scope_name: 'payments',
        type: 'decision',
        title: 'Checkout retry policy',
        body: 'Exponential backoff capped at 30 seconds.',
        source: 'manual',
      },
    })) as CallToolResult;
    const created = parseJsonResult(capture) as { id: string; embedded: boolean };
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.embedded).toBe(true);

    const recall = (await client.callTool({
      name: 'continuum.recall',
      arguments: { query: 'checkout retry' },
    })) as CallToolResult;
    const hits = parseJsonResult(recall) as Array<{ id: string }>;
    expect(hits.map((h) => h.id)).toContain(created.id);
  });

  it('capture refuses scope without writer role', async () => {
    const { client, me } = await connectClient();
    const readonly = await createScope(pool, { kind: 'team', name: 'readonly' });
    await addMembership(pool, me.id, readonly.id, 'reader');
    const res = (await client.callTool({
      name: 'continuum.capture',
      arguments: {
        scope_kind: 'team',
        scope_name: 'readonly',
        type: 'fact',
        title: 'x',
        body: 'y',
        source: 'manual',
      },
    })) as CallToolResult;
    expect(rawText(res)).toContain('lacks writer role');
  });

  it('promote moves a memory and marks source promoted', async () => {
    const { client, me, org } = await connectClient();
    await addMembership(pool, me.id, org.id, 'writer');

    const capture = (await client.callTool({
      name: 'continuum.capture',
      arguments: {
        scope_kind: 'team',
        scope_name: 'payments',
        type: 'decision',
        title: 'Refund window',
        body: 'Refunds within 30 days.',
        source: 'manual',
      },
    })) as CallToolResult;
    const sourceId = (parseJsonResult(capture) as { id: string }).id;

    const promote = (await client.callTool({
      name: 'continuum.promote',
      arguments: {
        memory_id: sourceId,
        target_scope_kind: 'org',
        target_scope_name: '',
      },
    })) as CallToolResult;
    const result = parseJsonResult(promote) as {
      source_id: string;
      destination_id: string;
    };
    expect(result.source_id).toBe(sourceId);

    const { rows } = await pool.query(
      'SELECT state, promoted_to_id FROM memories WHERE id = $1',
      [sourceId],
    );
    expect(rows[0].state).toBe('promoted');
    expect(rows[0].promoted_to_id).toBe(result.destination_id);
  });

  it('verify(false) marks memory stale', async () => {
    const { client } = await connectClient();
    const capture = (await client.callTool({
      name: 'continuum.capture',
      arguments: {
        scope_kind: 'team',
        scope_name: 'payments',
        type: 'fact',
        title: 'rate',
        body: 'API rate limit is 100/sec.',
        source: 'manual',
      },
    })) as CallToolResult;
    const id = (parseJsonResult(capture) as { id: string }).id;

    const verify = (await client.callTool({
      name: 'continuum.verify',
      arguments: { memory_id: id, still_true: false },
    })) as CallToolResult;
    const v = parseJsonResult(verify) as { state: string };
    expect(v.state).toBe('stale');
  });

  it('ensure_scope creates a new scope idempotently', async () => {
    const { client } = await connectClient();
    const a = (await client.callTool({
      name: 'continuum.ensure_scope',
      arguments: { kind: 'project', name: 'booking-engine' },
    })) as CallToolResult;
    const b = (await client.callTool({
      name: 'continuum.ensure_scope',
      arguments: { kind: 'project', name: 'booking-engine' },
    })) as CallToolResult;
    expect((parseJsonResult(a) as { id: string }).id).toBe(
      (parseJsonResult(b) as { id: string }).id,
    );
  });
});
