import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createApp } from '../server.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope, getScopeByRef } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';
import { createMemory } from '../../storage/memories.js';
import type { EmbeddingProvider } from '../../embeddings/provider.js';
import { EmbeddingRegistry, ScopeEmbeddingRouter } from '../../embeddings/router.js';
import { OllamaEmbeddingProvider } from '../../embeddings/ollama.js';

describe('POST /api/v0/recall', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
    app = createApp(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function seedWorld() {
    const me = await createPrincipal(pool, {
      externalId: 'entra:user:recall',
      kind: 'user',
      displayName: 'Me',
    });
    const other = await createPrincipal(pool, {
      externalId: 'svc:author',
      kind: 'service',
      displayName: 'Author',
    });
    const teamPayments = await createScope(pool, { kind: 'team', name: 'payments' });
    const teamSecret = await createScope(pool, { kind: 'team', name: 'secret-team' });
    // org scope is seeded by the migration; resolve it
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, me.id, teamPayments.id, 'reader');
    // Note: me is NOT a member of secret-team
    await addMembership(pool, other.id, teamPayments.id, 'writer');
    await addMembership(pool, other.id, teamSecret.id, 'writer');
    await addMembership(pool, other.id, org.id, 'admin');

    await createMemory(pool, {
      scopeId: teamPayments.id,
      scopeKind: 'team',
      type: 'decision',
      title: 'Checkout retry policy',
      body: 'Retry checkout requests with exponential backoff capped at 30 seconds.',
      authorId: other.id,
      source: 'manual',
    });
    await createMemory(pool, {
      scopeId: teamSecret.id,
      scopeKind: 'team',
      type: 'fact',
      title: 'Secret checkout pricing',
      body: 'Internal pricing rules for checkout that should never leak.',
      authorId: other.id,
      source: 'manual',
    });
    await createMemory(pool, {
      scopeId: org.id,
      scopeKind: 'org',
      type: 'fact',
      title: 'Workflow tracker',
      body: 'ExampleOrg uses Azure DevOps exclusively for work tracking.',
      authorId: other.id,
      source: 'manual',
    });
    await createMemory(pool, {
      scopeId: teamPayments.id,
      scopeKind: 'team',
      type: 'context',
      title: 'sprint status',
      body: 'shipping checkout v2 this week',
      authorId: other.id,
      source: 'manual',
    });
    return { me, other, teamPayments, teamSecret, org };
  }

  it('returns matches across accessible scopes by default', async () => {
    await seedWorld();
    const res = await request(app)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:recall')
      .send({ query: 'checkout' });
    expect(res.status).toBe(200);
    const titles = res.body.results.map((r: { title: string }) => r.title);
    // Accessible scopes = team:payments + org. NOT secret-team.
    expect(titles).toContain('Checkout retry policy');
    expect(titles).toContain('sprint status');
    expect(titles).not.toContain('Secret checkout pricing');
  });

  it('also returns org-scope hits to any authenticated principal', async () => {
    await seedWorld();
    const res = await request(app)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:recall')
      .send({ query: 'Azure DevOps' });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { title: string }) => r.title)).toContain(
      'Workflow tracker',
    );
  });

  it('drops requested scopes the caller cannot read', async () => {
    await seedWorld();
    const res = await request(app)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:recall')
      .send({ query: 'checkout', scopes: ['team:secret-team'] });
    expect(res.status).toBe(200);
    // No accessible scopes intersected, so no results
    expect(res.body.results).toEqual([]);
  });

  it('filters by type when given', async () => {
    await seedWorld();
    const res = await request(app)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:recall')
      .send({ query: 'checkout', types: ['decision'] });
    expect(res.status).toBe(200);
    const types = new Set(res.body.results.map((r: { type: string }) => r.type));
    expect(types).toEqual(new Set(['decision']));
  });

  it('omits expired FTS matches while retaining future and non-expiring matches', async () => {
    const { other, teamPayments } = await seedWorld();
    const expired = await createMemory(pool, {
      scopeId: teamPayments.id,
      scopeKind: 'team',
      type: 'fact',
      title: 'Expired expiry sentinel',
      body: 'expiry sentinel full text match',
      authorId: other.id,
      source: 'manual',
    });
    const future = await createMemory(pool, {
      scopeId: teamPayments.id,
      scopeKind: 'team',
      type: 'fact',
      title: 'Future expiry sentinel',
      body: 'expiry sentinel full text match',
      authorId: other.id,
      source: 'manual',
    });
    const nonExpiring = await createMemory(pool, {
      scopeId: teamPayments.id,
      scopeKind: 'team',
      type: 'decision',
      title: 'Null expiry sentinel',
      body: 'expiry sentinel full text match',
      authorId: other.id,
      source: 'manual',
    });
    await pool.query(
      `UPDATE memories
          SET expires_at = CASE id
            WHEN $1 THEN now() - interval '1 second'
            WHEN $2 THEN now() + interval '1 hour'
          END
        WHERE id = ANY($3::uuid[])`,
      [expired.id, future.id, [expired.id, future.id]],
    );

    const res = await request(app)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:recall')
      .send({ query: 'expiry sentinel', limit: 10 });

    expect(res.status).toBe(200);
    const ids = res.body.results.map((result: { id: string }) => result.id);
    expect(ids).not.toContain(expired.id);
    expect(ids).toContain(future.id);
    expect(ids).toContain(nonExpiring.id);
  });

  it('writes one summary plus safe ranked identity rows for exactly the returned memories', async () => {
    const { me } = await seedWorld();
    const res = await request(app)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:recall')
      .send({ query: 'checkout', limit: 2 });
    const { rows } = await pool.query(
      `SELECT action, memory_id, scope_id, query, metadata
         FROM audit_log
        WHERE principal_id = $1 AND action = 'read'
        ORDER BY id`,
      [me.id],
    );
    expect(rows).toHaveLength(1 + res.body.results.length);
    expect(rows[0].query).toBe('checkout');
    expect(rows[0].metadata).toMatchObject({
      hits: res.body.results.length,
      record_kind: 'summary',
      transport: 'rest',
      request_id: expect.any(String),
    });
    expect(rows.slice(1).map((row) => row.memory_id)).toEqual(
      res.body.results.map((result: { id: string }) => result.id),
    );
    expect(rows.slice(1).map((row) => row.metadata.rank)).toEqual([1, 2]);
    expect(rows.slice(1).every((row) => row.scope_id !== null)).toBe(true);
    expect(rows.slice(1).every((row) => row.query === null)).toBe(true);
    expect(rows.slice(1).every((row) =>
      row.metadata.request_id === rows[0].metadata.request_id
      && row.metadata.record_kind === 'result'
      && row.metadata.transport === 'rest'
      && typeof row.metadata.score === 'number')).toBe(true);
    expect(JSON.stringify(rows.slice(1))).not.toContain('checkout');
  });

  it('preserves one request audit row when recall returns zero hits', async () => {
    const { me } = await seedWorld();
    const res = await request(app)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:recall')
      .send({ query: 'term-that-does-not-exist-anywhere' });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);

    const { rows } = await pool.query(
      `SELECT memory_id, query, metadata FROM audit_log
        WHERE principal_id = $1 AND action = 'read'`,
      [me.id],
    );
    expect(rows).toEqual([{
      memory_id: null,
      query: 'term-that-does-not-exist-anywhere',
      metadata: expect.objectContaining({ hits: 0, record_kind: 'summary' }),
    }]);
  });

  it('rejects malformed input', async () => {
    await seedWorld();
    const res = await request(app)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:recall')
      .send({ limit: 'huge' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: 'INVALID_INPUT', error: 'Invalid request', requestId: expect.any(String),
    });
  });

  it('degrades provider failures to audited full-text recall without leaking details', async () => {
    const privateMessage = 'provider endpoint private-provider-host';
    const failingProvider: EmbeddingProvider = {
      id: 'test:failing', dim: 768,
      async embed() { throw new Error(privateMessage); },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    app = createApp(pool, { embeddingProvider: failingProvider, logger });
    await seedWorld();

    const res = await request(app)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:recall')
      .send({ query: 'checkout' });

    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThan(0);
    expect(res.body.diagnostics).toEqual({
      vector: 'failed',
      groups: [{ provider: 'test:failing', dim: 768, status: 'failed', errorCode: 'EMBEDDING_FAILED' }],
    });
    expect(JSON.stringify(res.body)).not.toContain(privateMessage);
    const { rows } = await pool.query(
      `SELECT metadata::text AS metadata
         FROM audit_log
        WHERE action = 'read' AND query = 'checkout' AND memory_id IS NULL`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toContain('test:failing');
    expect(JSON.parse(rows[0].metadata)).toMatchObject({
      embedded: false,
      embedding_groups: [{ provider: 'test:failing', dim: 768, scopes: expect.any(Number), status: 'failed' }],
      vector_status: 'failed',
    });
    expect(rows[0].metadata).not.toContain(privateMessage);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'embedding_recall_fallback', vectorStatus: 'failed', failedGroups: 1,
    }));
  });

  it('audits local-only unavailability as degraded rather than not-requested', async () => {
    const router = new ScopeEmbeddingRouter(
      new EmbeddingRegistry([]),
      { default: 'local-only', rules: [] },
    );
    app = createApp(pool, { embeddingProvider: router });
    const { me } = await seedWorld();

    await request(app)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:recall')
      .send({ query: 'checkout' })
      .expect(200);

    const { rows } = await pool.query(
      `SELECT metadata FROM audit_log
        WHERE principal_id = $1 AND action = 'read' AND memory_id IS NULL
        ORDER BY id DESC LIMIT 1`,
      [me.id],
    );
    expect(rows[0].metadata).toMatchObject({
      embedded: false,
      embedding_status: 'degraded',
      local_only_unavailable_scopes: expect.any(Number),
    });
  });

  it('degrades recall promptly when Ollama stalls after response headers', async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal as AbortSignal;
      return {
        ok: true,
        json: async () => new Promise((_resolve, reject) => {
          observedSignal?.addEventListener('abort', () => reject(observedSignal?.reason), { once: true });
        }),
      } as Response;
    });
    app = createApp(pool, { embeddingProvider: new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434', model: 'm', dim: 768, timeoutMs: 20, fetchImpl,
    }) });
    await seedWorld();

    await request(app)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:recall')
      .send({ query: 'checkout' })
      .expect(200);

    expect(observedSignal?.aborted).toBe(true);
  });
});
