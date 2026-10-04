import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { buildMcpServer } from './mcp.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { StubEmbeddingProvider } from '../embeddings/stub.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';

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

  async function connectClient(
    selectedProvider: EmbeddingProvider | null = provider,
    selectedPool: pg.Pool = pool,
    logger?: { error(message: string, error: unknown): void },
  ) {
    const me = await createPrincipal(pool, {
      externalId: 'entra:user:mcp',
      kind: 'user',
      displayName: 'MCP User',
    });
    const teamPayments = await createScope(pool, { kind: 'team', name: 'payments' });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, me.id, teamPayments.id, 'writer');

    const server = buildMcpServer({
      pool: selectedPool,
      embeddingProvider: selectedProvider,
      principal: me,
      logger,
    });
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
    expect(list.sort((a, b) => a.scope.localeCompare(b.scope))).toEqual([
      { scope: 'org', role: 'reader' },
      { scope: 'team:payments', role: 'writer' },
    ]);
  });

  it('returns capture success without exposing embedding failures and audits safely', async () => {
    const privateMessage = 'provider token private-mcp-value';
    const failingProvider: EmbeddingProvider = {
      id: 'test:failing', dim: 3,
      async embed() { throw new Error(privateMessage); },
    };
    const { client } = await connectClient(failingProvider);

    const result = (await client.callTool({
      name: 'continuum.capture',
      arguments: {
        scope_kind: 'team', scope_name: 'payments', type: 'fact',
        title: 'MCP fallback', body: 'private-mcp-memory-text', source: 'manual',
      },
    })) as CallToolResult;
    const body = parseJsonResult(result) as Record<string, unknown>;

    expect(body).toEqual({
      id: expect.any(String),
      scope: 'team:payments',
      expires_at: expect.any(String),
      embedded: false,
    });
    expect(rawText(result)).not.toContain(privateMessage);
    const { rows } = await pool.query(
      'SELECT metadata::text AS metadata FROM audit_log WHERE memory_id = $1',
      [body.id],
    );
    expect(rows[0].metadata).toContain('EMBEDDING_FAILED');
    expect(rows[0].metadata).not.toContain(privateMessage);
    expect(rows[0].metadata).not.toContain('private-mcp-memory-text');
  });

  it('returns and logs a sanitized error when recall audit persistence fails', async () => {
    const privateMessage = 'database password private-audit-value';
    const failingPool = poolRejecting(pool, 'INSERT INTO audit_log', privateMessage);
    const logger = { error: vi.fn() };
    const { client } = await connectClient(null, failingPool, logger);

    const result = (await client.callTool({
      name: 'continuum.recall',
      arguments: { query: 'anything' },
    })) as CallToolResult & { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(parseJsonResult(result)).toEqual({
      error: { code: 'INTERNAL', message: 'An internal error occurred' },
    });
    expect(rawText(result)).not.toContain(privateMessage);
    expect(logger.error).toHaveBeenCalledWith(
      'MCP: internal service error',
      expect.objectContaining({ message: privateMessage }),
    );
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
    await addMembership(pool, me.id, org.id, 'admin');

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

  it('denies org promotion to a writer with the stable MCP error envelope', async () => {
    const { client, me, org, teamPayments } = await connectClient();
    await addMembership(pool, me.id, org.id, 'writer');
    const source = await createMemory(pool, {
      scopeId: teamPayments.id,
      scopeKind: 'team',
      type: 'decision',
      title: 'Needs org approval',
      body: 'Writer is not enough.',
      authorId: me.id,
      source: 'manual',
    });

    const result = (await client.callTool({
      name: 'continuum.promote',
      arguments: {
        memory_id: source.id,
        target_scope_kind: 'org',
        target_scope_name: '',
      },
    })) as CallToolResult & { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(parseJsonResult(result)).toEqual({
      error: { code: 'FORBIDDEN', message: 'principal lacks admin role on target scope' },
    });
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

  it('ensure_scope rejects invalid scope shapes with INVALID_SCOPE', async () => {
    const { client } = await connectClient();
    const result = (await client.callTool({
      name: 'continuum.ensure_scope',
      arguments: { kind: 'org', name: 'not-empty' },
    })) as CallToolResult & { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(parseJsonResult(result)).toEqual({
      error: { code: 'INVALID_SCOPE', message: 'Invalid scope' },
    });
  });

  it('preserves MCP transport metadata across audited tools', async () => {
    const { client, me, org } = await connectClient(null);
    await addMembership(pool, me.id, org.id, 'admin');
    const capture = (await client.callTool({
      name: 'continuum.capture',
      arguments: {
        scope_kind: 'team', scope_name: 'payments', type: 'fact',
        title: 'Transport audit', body: 'MCP marker.', source: 'manual',
      },
    })) as CallToolResult;
    const id = (parseJsonResult(capture) as { id: string }).id;

    await client.callTool({
      name: 'continuum.recall', arguments: { query: 'Transport audit' },
    });
    await client.callTool({
      name: 'continuum.verify', arguments: { memory_id: id, still_true: true },
    });
    await client.callTool({
      name: 'continuum.agents_md', arguments: { team: 'payments' },
    });
    await client.callTool({
      name: 'continuum.promote',
      arguments: {
        memory_id: id, target_scope_kind: 'org', target_scope_name: '',
      },
    });

    const { rows } = await pool.query(
      'SELECT action, metadata FROM audit_log ORDER BY id',
    );
    expect(rows.map((row) => row.action)).toEqual([
      'write', 'read', 'verify', 'read', 'promote',
    ]);
    expect(rows.every((row) => row.metadata.transport === 'mcp')).toBe(true);
  });

  it('rejects verification notes over 2000 characters as invalid input', async () => {
    const { client } = await connectClient(null);
    const capture = (await client.callTool({
      name: 'continuum.capture',
      arguments: {
        scope_kind: 'team', scope_name: 'payments', type: 'fact',
        title: 'Note bound', body: 'Bounded.', source: 'manual',
      },
    })) as CallToolResult;
    const id = (parseJsonResult(capture) as { id: string }).id;
    const result = (await client.callTool({
      name: 'continuum.verify',
      arguments: { memory_id: id, still_true: true, note: 'x'.repeat(2001) },
    })) as CallToolResult & { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(parseJsonResult(result)).toEqual({
      error: {
        code: 'INVALID_INPUT',
        message: 'Verification note must be 2000 characters or fewer',
      },
    });
  });
});

function poolRejecting(
  pool: pg.Pool,
  sqlFragment: string,
  privateMessage: string,
): pg.Pool {
  const reject = (text: unknown): void => {
    if (typeof text === 'string' && text.includes(sqlFragment)) {
      throw new Error(privateMessage);
    }
  };
  return {
    query: (async (...args: unknown[]) => {
      reject(args[0]);
      return (pool.query as (...queryArgs: unknown[]) => unknown)(...args);
    }) as pg.Pool['query'],
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return async (...args: unknown[]) => {
              reject(args[0]);
              return (target.query as (...queryArgs: unknown[]) => unknown)(...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as pg.Pool;
}
