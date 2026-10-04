import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from './server.js';
import { buildMcpServer } from './mcp.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function toolJson(result: ToolResult): any {
  return JSON.parse(result.content.map((item) => item.text ?? '').join(''));
}

describe('REST/MCP semantic parity matrix', () => {
  let pool: pg.Pool;
  let principal: Awaited<ReturnType<typeof createPrincipal>>;
  let client: Client;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
    principal = await createPrincipal(pool, {
      externalId: 'entra:user:parity',
      kind: 'user',
      displayName: 'Parity User',
    });
    const team = await createScope(pool, { kind: 'team', name: 'payments' });
    await addMembership(pool, principal.id, team.id, 'writer');
    const server = buildMcpServer({ pool, embeddingProvider: null, principal });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'parity-test', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it.each([
    ['org name', { kind: 'org', name: 'named' }],
    ['missing non-org name', { kind: 'team', name: '' }],
  ])('rejects the same invalid capture scope shape: %s', async (_name, scope) => {
    const rest = await request(createApp(pool))
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:parity')
      .send({ scope, type: 'fact', title: 'x', body: 'y', source: 'manual' });
    const mcp = (await client.callTool({
      name: 'continuum.capture',
      arguments: {
        scope_kind: scope.kind,
        scope_name: scope.name,
        type: 'fact',
        title: 'x',
        body: 'y',
        source: 'manual',
      },
    })) as ToolResult;

    expect(rest.status).toBe(400);
    expect(rest.body.code).toBe('INVALID_SCOPE');
    expect(mcp.isError).toBe(true);
    expect(toolJson(mcp).error.code).toBe('INVALID_SCOPE');
  });

  it('supports equivalent capture fields and preserves each success shape', async () => {
    const rest = await request(createApp(pool))
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:parity')
      .send({
        scope: { kind: 'team', name: 'payments' },
        type: 'fact', title: 'REST', body: 'body', source: 'manual',
        sourceRef: 'rest-ref', tags: ['shared'], metadata: { transport: 'rest-value' },
      });
    const mcp = (await client.callTool({
      name: 'continuum.capture',
      arguments: {
        scope_kind: 'team', scope_name: 'payments', type: 'fact',
        title: 'MCP', body: 'body', source: 'manual', source_ref: 'mcp-ref',
        tags: ['shared'], metadata: { transport: 'mcp-value' },
      },
    })) as ToolResult;

    expect(rest.status).toBe(201);
    expect(rest.body).toEqual({
      id: expect.any(String),
      scopeId: expect.any(String),
      expiresAt: expect.any(String),
      embedded: false,
    });
    expect(toolJson(mcp)).toEqual({
      id: expect.any(String),
      scope: 'team:payments',
      expires_at: expect.any(String),
      embedded: false,
    });
    const { rows } = await pool.query(
      `SELECT m.title, m.source_ref, m.tags, m.metadata, a.metadata AS audit_metadata
         FROM memories m
         JOIN audit_log a ON a.memory_id = m.id
        WHERE m.title IN ('REST', 'MCP')
        ORDER BY m.title`,
    );
    expect(rows).toEqual([
      {
        title: 'MCP',
        source_ref: 'mcp-ref',
        tags: ['shared'],
        metadata: { transport: 'mcp-value' },
        audit_metadata: {
          source: 'manual', type: 'fact', embedded: false, transport: 'mcp',
        },
      },
      {
        title: 'REST',
        source_ref: 'rest-ref',
        tags: ['shared'],
        metadata: { transport: 'rest-value' },
        audit_metadata: { source: 'manual', type: 'fact', embedded: false },
      },
    ]);
  });

  it.each(['bad', 'org:named', 'team:'])('rejects malformed recall scope %s in both transports', async (scope) => {
    const rest = await request(createApp(pool))
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:parity')
      .send({ query: 'anything', scopes: [scope] });
    const mcp = (await client.callTool({
      name: 'continuum.recall',
      arguments: { query: 'anything', scopes: [scope] },
    })) as ToolResult;

    expect(rest.status).toBe(400);
    expect(rest.body.code).toBe('INVALID_SCOPE');
    expect(mcp.isError).toBe(true);
    expect(toolJson(mcp).error.code).toBe('INVALID_SCOPE');
  });

  it('preserves exact REST and MCP recall success shapes', async () => {
    const team = await createScope(pool, { kind: 'project', name: 'shape' });
    await addMembership(pool, principal.id, team.id, 'writer');
    await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'fact', title: 'Shape marker',
      body: 'Exact shape marker content.', authorId: principal.id, source: 'manual',
      sourceRef: 'shape-ref',
    });

    const rest = await request(createApp(pool))
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:parity')
      .send({ query: 'shape marker', scopes: ['project:shape'] });
    const mcp = (await client.callTool({
      name: 'continuum.recall',
      arguments: { query: 'shape marker', scopes: ['project:shape'] },
    })) as ToolResult;

    expect(rest.status).toBe(200);
    expect(rest.body).toEqual({ results: [{
      id: expect.any(String), score: expect.any(Number), scope: 'project:shape',
      type: 'fact', title: 'Shape marker', excerpt: 'Exact shape marker content.',
      sourceRef: 'shape-ref', createdAt: expect.any(String),
    }] });
    expect(toolJson(mcp)).toEqual([{
      id: expect.any(String), score: expect.any(Number), scope: 'project:shape',
      type: 'fact', title: 'Shape marker', excerpt: 'Exact shape marker content.',
      source_ref: 'shape-ref', created_at: expect.any(String),
    }]);
  });

  it('uses the same readable access set for list_scopes, recall, and AGENTS.md', async () => {
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const payments = (await getScopeByRef(pool, { kind: 'team', name: 'payments' }))!;
    const secret = await createScope(pool, { kind: 'team', name: 'secret' });
    for (const [scope, title] of [
      [org, 'Org parity marker'],
      [payments, 'Payments parity marker'],
      [secret, 'Secret parity marker'],
    ] as const) {
      await createMemory(pool, {
        scopeId: scope.id, scopeKind: scope.kind, type: 'fact', title,
        body: 'Shared parity phrase.', authorId: principal.id, source: 'manual',
      });
    }

    const listed = toolJson((await client.callTool({
      name: 'continuum.list_scopes', arguments: {},
    })) as ToolResult) as Array<{ scope: string }>;
    const recalled = toolJson((await client.callTool({
      name: 'continuum.recall', arguments: { query: 'parity phrase' },
    })) as ToolResult) as Array<{ scope: string; title: string }>;
    const agents = await request(createApp(pool))
      .get('/api/v0/agents-md?team=payments')
      .set('Authorization', 'Bearer entra:user:parity');

    expect(listed.map((item) => item.scope).sort()).toEqual(['org', 'team:payments']);
    expect(recalled.map((item) => item.scope).sort()).toEqual(['org', 'team:payments']);
    expect(agents.text).toContain('Org parity marker');
    expect(agents.text).toContain('Payments parity marker');
    expect(agents.text).not.toContain('Secret parity marker');
  });
});
