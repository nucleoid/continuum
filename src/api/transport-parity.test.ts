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
import type { EmbeddingProvider } from '../embeddings/provider.js';

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
      related: [],
    });
    expect(toolJson(mcp)).toEqual({
      id: expect.any(String),
      scope: 'team:payments',
      expires_at: expect.any(String),
      embedded: false,
      related: [],
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
        metadata: { transport: 'mcp-value', related: [] },
        audit_metadata: {
          source: 'manual', type: 'fact', embedded: false, transport: 'mcp',
        },
      },
      {
        title: 'REST',
        source_ref: 'rest-ref',
        tags: ['shared'],
        metadata: { transport: 'rest-value', related: [] },
        audit_metadata: { source: 'manual', type: 'fact', embedded: false },
      },
    ]);
  });

  it('rejects reserved relation metadata consistently without persistence', async () => {
    const metadata = { related: [{ id: 'forged-candidate' }] };
    const rest = await request(createApp(pool))
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:parity')
      .send({
        scope: { kind: 'team', name: 'payments' }, type: 'fact',
        title: 'REST reserved key', body: 'Must fail.', source: 'manual', metadata,
      });
    const mcp = (await client.callTool({
      name: 'continuum.capture',
      arguments: {
        scope_kind: 'team', scope_name: 'payments', type: 'fact',
        title: 'MCP reserved key', body: 'Must fail.', source: 'manual', metadata,
      },
    })) as ToolResult;

    expect(rest.status).toBe(400);
    expect(rest.body).toMatchObject({
      code: 'INVALID_INPUT', error: 'metadata.related is reserved by Continuum',
    });
    expect(mcp.isError).toBe(true);
    expect(toolJson(mcp)).toEqual({
      error: { code: 'INVALID_INPUT', message: 'metadata.related is reserved by Continuum' },
    });
    const { rows } = await pool.query(
      `SELECT count(*)::int AS memories FROM memories
        WHERE title IN ('REST reserved key', 'MCP reserved key')`,
    );
    expect(rows[0].memories).toBe(0);
  });

  it('returns the same safe relation fields from REST and MCP capture', async () => {
    const vector = Array(768).fill(0) as number[];
    vector[0] = 1;
    const provider: EmbeddingProvider = {
      id: 'test:transport-relations', dim: 768, async embed() { return [vector]; },
    };
    const relationServer = buildMcpServer({ pool, embeddingProvider: provider, principal });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const relationClient = new Client({ name: 'relation-parity', version: '0.0.1' });
    await Promise.all([
      relationServer.connect(serverTransport), relationClient.connect(clientTransport),
    ]);

    const first = await request(createApp(pool, { embeddingProvider: provider }))
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:parity')
      .send({
        scope: { kind: 'team', name: 'payments' }, type: 'fact',
        title: 'Parity policy', body: 'Deploy on Fridays.', source: 'manual',
      });
    const mcp = toolJson((await relationClient.callTool({
      name: 'continuum.capture',
      arguments: {
        scope_kind: 'team', scope_name: 'payments', type: 'fact',
        title: 'Parity policy changed', body: 'Never deploy on Fridays.', source: 'manual',
      },
    })) as ToolResult);
    const rest = await request(createApp(pool, { embeddingProvider: provider }))
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:parity')
      .send({
        scope: { kind: 'team', name: 'payments' }, type: 'fact',
        title: 'Another parity policy', body: 'Ask before Friday deploys.', source: 'manual',
      });

    expect(first.body.related).toEqual([]);
    expect(mcp.related[0]).toMatchObject({
      id: first.body.id, relation: 'possible-conflict',
      similarity: expect.any(Number), provider: provider.id, threshold: 0.92,
      detectedAt: expect.any(String),
    });
    expect(rest.body.related[0]).toMatchObject({
      id: expect.any(String),
      relation: mcp.related[0].relation,
      similarity: mcp.related[0].similarity,
      provider: mcp.related[0].provider,
      threshold: mcp.related[0].threshold,
      detectedAt: expect.any(String),
    });
    expect(Object.keys(rest.body.related[0]).sort()).toEqual(
      ['detectedAt', 'id', 'provider', 'relation', 'similarity', 'threshold'].sort(),
    );
  });

  it('returns equivalent actionable review queues over REST and MCP', async () => {
    const scope = await createScope(pool, { kind: 'project', name: 'review-parity' });
    await addMembership(pool, principal.id, scope.id, 'writer');
    const memory = await createMemory(pool, {
      scopeId: scope.id, scopeKind: scope.kind, type: 'relationship',
      title: 'Review parity', body: 'private queue body', authorId: principal.id,
      source: 'manual',
    });
    await pool.query(
      `UPDATE memories SET state = 'stale', expires_at = '2026-01-01T00:00:00Z' WHERE id = $1`,
      [memory.id],
    );

    const rest = await request(createApp(pool))
      .get('/api/v0/review-queue')
      .query({ scope: 'project:review-parity', type: 'relationship', limit: 1 })
      .set('Authorization', 'Bearer entra:user:parity');
    const mcp = toolJson((await client.callTool({
      name: 'continuum.review_queue',
      arguments: { scopes: ['project:review-parity'], types: ['relationship'], limit: 1 },
    })) as ToolResult);

    expect(rest.status).toBe(200);
    expect(rest.body.items).toHaveLength(1);
    expect(mcp.items).toHaveLength(1);
    expect(rest.body.items[0]).toMatchObject({
      id: memory.id, scope: 'project:review-parity', type: 'relationship',
      state: 'stale', reason: 'stale', canVerify: true,
    });
    expect(mcp.items[0]).toMatchObject({
      id: memory.id, scope: 'project:review-parity', type: 'relationship',
      state: 'stale', reason: 'stale', can_verify: true,
    });
    expect(rest.body.items[0].title).toBe(mcp.items[0].title);
    expect(rest.body.items[0].author).toEqual(mcp.items[0].author);
    expect(rest.body.items[0].due).toBe(mcp.items[0].due);
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
      bodyTruncated: false,
      sourceRef: 'shape-ref', createdAt: expect.any(String),
    }] });
    expect(toolJson(mcp)).toEqual([{
      id: expect.any(String), score: expect.any(Number), scope: 'project:shape',
      type: 'fact', title: 'Shape marker', excerpt: 'Exact shape marker content.',
      body_truncated: false,
      source_ref: 'shape-ref', created_at: expect.any(String),
    }]);
  });

  it('returns equivalent complete point-fetch and browse records', async () => {
    const scope = await createScope(pool, { kind: 'project', name: 'memory-parity' });
    await addMembership(pool, principal.id, scope.id, 'reader');
    const memory = await createMemory(pool, {
      scopeId: scope.id, scopeKind: 'project', type: 'decision', title: 'Parity record',
      body: 'The complete parity body.', metadata: { channel: 'both' }, tags: ['parity'],
      authorId: principal.id, source: 'manual', sourceRef: 'parity-ref',
    });

    const restFetch = await request(createApp(pool))
      .get(`/api/v0/memories/${memory.id}`)
      .set('Authorization', 'Bearer entra:user:parity');
    const mcpFetch = toolJson((await client.callTool({
      name: 'continuum.get_memory', arguments: { memory_id: memory.id },
    })) as ToolResult);
    const restList = await request(createApp(pool))
      .get('/api/v0/memories')
      .query({ scope: 'project:memory-parity', type: 'decision', state: 'live' })
      .set('Authorization', 'Bearer entra:user:parity');
    const mcpList = toolJson((await client.callTool({
      name: 'continuum.list_memories',
      arguments: { scope: 'project:memory-parity', type: 'decision', state: 'live' },
    })) as ToolResult);

    expect(restFetch.status).toBe(200);
    expect(restFetch.body).toMatchObject({
      id: memory.id, scope: 'project:memory-parity', body: 'The complete parity body.',
      authorId: principal.id, authorDisplayName: 'Parity User', sourceRef: 'parity-ref',
    });
    expect(mcpFetch).toMatchObject({
      id: memory.id, scope: 'project:memory-parity', body: 'The complete parity body.',
      author_id: principal.id, author_display_name: 'Parity User', source_ref: 'parity-ref',
    });
    expect(restList.body.items).toEqual([restFetch.body]);
    expect(mcpList.items).toEqual([mcpFetch]);
    expect(restList.body).toMatchObject({ limit: 50, offset: 0 });
    expect(mcpList).toMatchObject({ limit: 50, offset: 0 });
  });

  it('returns authorized decision chains and masks inaccessible MCP anchors as missing', async () => {
    const readable = await createScope(pool, { kind: 'project', name: 'history-parity' });
    const hidden = await createScope(pool, { kind: 'project', name: 'hidden-history-parity' });
    await addMembership(pool, principal.id, readable.id, 'reader');
    const first = await createMemory(pool, {
      scopeId: readable.id, scopeKind: readable.kind, type: 'decision', title: 'First',
      body: 'First body', authorId: principal.id, source: 'manual',
    });
    await pool.query(`UPDATE memories SET state = 'archived' WHERE id = $1`, [first.id]);
    const second = await createMemory(pool, {
      scopeId: readable.id, scopeKind: readable.kind, type: 'decision', title: 'Second',
      body: 'Second body', authorId: principal.id, source: 'manual', supersedesId: first.id,
    });
    const privateDecision = await createMemory(pool, {
      scopeId: hidden.id, scopeKind: hidden.kind, type: 'decision', title: 'Private',
      body: 'Private body', authorId: principal.id, source: 'manual',
    });

    const authorized = toolJson((await client.callTool({
      name: 'continuum.decision_history', arguments: { decision_id: first.id },
    })) as ToolResult);
    const inaccessible = (await client.callTool({
      name: 'continuum.decision_history', arguments: { decision_id: privateDecision.id },
    })) as ToolResult;
    const missing = (await client.callTool({
      name: 'continuum.decision_history',
      arguments: { decision_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    })) as ToolResult;

    expect(authorized.current_id).toBe(second.id);
    expect(authorized.decisions.map((decision: { id: string }) => decision.id))
      .toEqual([first.id, second.id]);
    expect(inaccessible.isError).toBe(true);
    expect(missing.isError).toBe(true);
    expect(toolJson(inaccessible)).toEqual(toolJson(missing));
    expect(toolJson(inaccessible)).toEqual({
      error: { code: 'MEMORY_NOT_FOUND', message: 'Memory not found' },
    });
  });

  it('excludes expired full bodies before REST/MCP pagination and audits each delivered identity', async () => {
    const scope = await createScope(pool, { kind: 'project', name: 'expiry-parity' });
    await addMembership(pool, principal.id, scope.id, 'reader');
    const first = await createMemory(pool, {
      scopeId: scope.id, scopeKind: 'project', type: 'fact', title: 'First active',
      body: 'first transport secret', authorId: principal.id, source: 'manual',
    });
    const boundary = await createMemory(pool, {
      scopeId: scope.id, scopeKind: 'project', type: 'fact', title: 'Boundary expired',
      body: 'expired transport secret', authorId: principal.id, source: 'manual',
    });
    const second = await createMemory(pool, {
      scopeId: scope.id, scopeKind: 'project', type: 'fact', title: 'Second active',
      body: 'second transport secret', authorId: principal.id, source: 'manual',
    });
    await pool.query(
      `UPDATE memories
          SET updated_at = CASE id
            WHEN $1 THEN TIMESTAMPTZ '2026-10-05 03:00:00+00'
            WHEN $2 THEN TIMESTAMPTZ '2026-10-05 02:00:00+00'
            ELSE TIMESTAMPTZ '2026-10-05 01:00:00+00'
          END,
              expires_at = CASE WHEN id = $2 THEN now() ELSE expires_at END
        WHERE id = ANY($3::uuid[])`,
      [first.id, boundary.id, [first.id, boundary.id, second.id]],
    );

    const restExpired = await request(createApp(pool))
      .get(`/api/v0/memories/${boundary.id}`)
      .set('Authorization', 'Bearer entra:user:parity');
    const mcpExpired = (await client.callTool({
      name: 'continuum.get_memory', arguments: { memory_id: boundary.id },
    })) as ToolResult;
    const restPage = await request(createApp(pool))
      .get('/api/v0/memories')
      .query({ scope: 'project:expiry-parity', limit: 1, offset: 0 })
      .set('Authorization', 'Bearer entra:user:parity');
    const mcpPage = toolJson((await client.callTool({
      name: 'continuum.list_memories',
      arguments: { scope: 'project:expiry-parity', limit: 1, offset: 1 },
    })) as ToolResult);

    expect(restExpired.status).toBe(404);
    expect(restExpired.body.code).toBe('MEMORY_NOT_FOUND');
    expect(mcpExpired.isError).toBe(true);
    expect(toolJson(mcpExpired).error.code).toBe('MEMORY_NOT_FOUND');
    expect(restPage.body.items.map((item: { id: string }) => item.id)).toEqual([first.id]);
    expect(mcpPage.items.map((item: { id: string }) => item.id)).toEqual([second.id]);

    const { rows } = await pool.query(
      `SELECT memory_id, metadata FROM audit_log ORDER BY id`,
    );
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.metadata.record_kind === 'summary')).toHaveLength(2);
    expect(rows.filter((row) => row.metadata.record_kind === 'result')
      .map((row) => row.memory_id)).toEqual([first.id, second.id]);
    expect(rows.some((row) => row.memory_id === boundary.id)).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('transport secret');
  });

  it('returns typed point-fetch errors and equivalent browse validation', async () => {
    const malformedRest = await request(createApp(pool))
      .get('/api/v0/memories/not-a-uuid')
      .set('Authorization', 'Bearer entra:user:parity');
    const malformedMcp = (await client.callTool({
      name: 'continuum.get_memory', arguments: { memory_id: 'not-a-uuid' },
    })) as ToolResult & { isError?: boolean };
    expect(malformedRest.status).toBe(400);
    expect(malformedRest.body.code).toBe('INVALID_INPUT');
    expect(malformedMcp.isError).toBe(true);
    expect(toolJson(malformedMcp).error.code).toBe('INVALID_INPUT');

    for (const [query, code] of [
      [{ scope: 'bad' }, 'INVALID_SCOPE'],
      [{ type: 'bogus' }, 'INVALID_INPUT'],
      [{ state: 'bogus' }, 'INVALID_INPUT'],
      [{ limit: 0 }, 'INVALID_INPUT'],
      [{ limit: 101 }, 'INVALID_INPUT'],
      [{ offset: -1 }, 'INVALID_INPUT'],
    ] as const) {
      const rest = await request(createApp(pool)).get('/api/v0/memories')
        .query(query).set('Authorization', 'Bearer entra:user:parity');
      const mcp = (await client.callTool({
        name: 'continuum.list_memories', arguments: query,
      })) as ToolResult & { isError?: boolean };
      expect(rest.status).toBe(400);
      expect(rest.body.code).toBe(code);
      expect(mcp.isError).toBe(true);
      expect(toolJson(mcp).error.code).toBe(code);
    }

    const restAtMax = await request(createApp(pool)).get('/api/v0/memories?limit=100')
      .set('Authorization', 'Bearer entra:user:parity');
    const mcpAtMax = toolJson((await client.callTool({
      name: 'continuum.list_memories', arguments: { limit: 100 },
    })) as ToolResult);
    expect(restAtMax.status).toBe(200);
    expect(restAtMax.body.limit).toBe(100);
    expect(mcpAtMax.limit).toBe(100);
  });

  it('uses the same readable access set for list_scopes, recall, and AGENTS.md', async () => {
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const payments = (await getScopeByRef(pool, { kind: 'team', name: 'payments' }))!;
    const secret = await createScope(pool, { kind: 'team', name: 'secret' });
    await addMembership(pool, principal.id, org.id, 'admin');
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
    })) as ToolResult) as Array<{ scope: string; role: string }>;
    const recalled = toolJson((await client.callTool({
      name: 'continuum.recall', arguments: { query: 'parity phrase' },
    })) as ToolResult) as Array<{ scope: string; title: string }>;
    const agents = await request(createApp(pool))
      .get('/api/v0/agents-md?team=payments')
      .set('Authorization', 'Bearer entra:user:parity');

    expect(listed.map((item) => item.scope).sort()).toEqual(['org', 'team:payments']);
    expect(listed.filter((item) => item.scope === 'org')).toEqual([
      { scope: 'org', role: 'admin' },
    ]);
    expect(recalled.map((item) => item.scope).sort()).toEqual(['org', 'team:payments']);
    expect(agents.text).toContain('Org parity marker');
    expect(agents.text).toContain('Payments parity marker');
    expect(agents.text).not.toContain('Secret parity marker');
  });

  it('uses the same AGENTS.md hash and boolean freshness semantics over REST and MCP', async () => {
    const payments = (await getScopeByRef(pool, { kind: 'team', name: 'payments' }))!;
    const memory = await createMemory(pool, {
      scopeId: payments.id, scopeKind: 'team', type: 'decision',
      title: 'Freshness parity marker', body: 'Current parity body.',
      authorId: principal.id, source: 'manual',
    });
    const restRender = await request(createApp(pool))
      .get('/api/v0/agents-md?team=payments')
      .set('Authorization', 'Bearer entra:user:parity');
    const mcpRender = (await client.callTool({
      name: 'continuum.agents_md', arguments: { team: 'payments' },
    })) as ToolResult;
    const hash = restRender.headers.etag.slice(1, -1);

    expect(mcpRender.content.map((item) => item.text ?? '').join('')).toBe(restRender.text);
    const restFresh = await request(createApp(pool))
      .get('/api/v0/agents-md/freshness')
      .query({ team: 'payments', hash })
      .set('Authorization', 'Bearer entra:user:parity');
    const mcpFresh = toolJson((await client.callTool({
      name: 'continuum.agents_md_fresh', arguments: { team: 'payments', hash },
    })) as ToolResult);
    expect(restFresh.body).toEqual({ fresh: true });
    expect(mcpFresh).toEqual(restFresh.body);

    await pool.query('UPDATE memories SET body = body || $2 WHERE id = $1', [
      memory.id, ' changed',
    ]);
    const restStale = await request(createApp(pool))
      .get('/api/v0/agents-md/freshness')
      .query({ team: 'payments', hash })
      .set('Authorization', 'Bearer entra:user:parity');
    const mcpStale = toolJson((await client.callTool({
      name: 'continuum.agents_md_fresh', arguments: { team: 'payments', hash },
    })) as ToolResult);
    expect(restStale.body).toEqual({ fresh: false });
    expect(mcpStale).toEqual(restStale.body);
  });

  it('grants implicit org reads across REST, MCP, and AGENTS.md', async () => {
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await createMemory(pool, {
      scopeId: org.id, scopeKind: 'org', type: 'fact', title: 'Implicit org marker',
      body: 'Visible without an org membership row.', authorId: principal.id,
      source: 'manual',
    });

    const restRecall = await request(createApp(pool))
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:parity')
      .send({ query: 'implicit org marker', scopes: ['org'] });
    const mcpRecall = toolJson((await client.callTool({
      name: 'continuum.recall',
      arguments: { query: 'implicit org marker', scopes: ['org'] },
    })) as ToolResult) as Array<{ title: string }>;
    const agents = await request(createApp(pool))
      .get('/api/v0/agents-md')
      .set('Authorization', 'Bearer entra:user:parity');

    expect(restRecall.status).toBe(200);
    expect(restRecall.body.results.map((item: { title: string }) => item.title))
      .toContain('Implicit org marker');
    expect(mcpRecall.map((item) => item.title)).toContain('Implicit org marker');
    expect(agents.status).toBe(200);
    expect(agents.text).toContain('Implicit org marker');
  });
});
