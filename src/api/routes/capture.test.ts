import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createApp } from '../server.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';
import type { EmbeddingProvider } from '../../embeddings/provider.js';
import { OllamaEmbeddingProvider } from '../../embeddings/ollama.js';
import { captureSources } from '../../capture/source.js';

describe('POST /api/v0/capture', () => {
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

  async function seedActor(role: 'reader' | 'writer' | 'admin' = 'writer') {
    const principal = await createPrincipal(pool, {
      externalId: 'entra:user:capture',
      kind: 'user',
      displayName: 'Test User',
    });
    const scope = await createScope(pool, { kind: 'team', name: 'payments' });
    await addMembership(pool, principal.id, scope.id, role);
    return { principal, scope };
  }

  it('rejects requests without bearer token', async () => {
    const res = await request(app)
      .post('/api/v0/capture')
      .send({});
    expect(res.status).toBe(401);
  });

  it('rejects unknown bearer principal', async () => {
    const res = await request(app)
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer nope')
      .send({});
    expect(res.status).toBe(401);
  });

  it('rejects malformed body', async () => {
    await seedActor();
    const res = await request(app)
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:capture')
      .send({ title: 'oops' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: 'INVALID_INPUT', error: 'Invalid request', requestId: expect.any(String),
    });
  });

  it.each(captureSources)('accepts registered capture source %s', async (source) => {
    await seedActor();
    const res = await request(app)
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:capture')
      .send({
        scope: { kind: 'team', name: 'payments' },
        type: 'fact',
        title: `Captured by ${source}`,
        body: 'Known provenance.',
        source,
      });

    expect(res.status).toBe(201);
    const stored = await pool.query('SELECT source FROM memories WHERE id = $1', [res.body.id]);
    expect(stored.rows).toEqual([{ source }]);
  });

  it('rejects an unknown source before embedding or persistence', async () => {
    const embed = vi.fn(async () => [[0.1, 0.2, 0.3]]);
    app = createApp(pool, {
      embeddingProvider: { id: 'test:source-validation', dim: 768, embed },
    });
    await seedActor();

    const res = await request(app)
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:capture')
      .send({
        scope: { kind: 'team', name: 'payments' },
        type: 'fact',
        title: 'Forged provenance',
        body: 'Must not persist.',
        source: 'unregistered-plugin',
        sourceRef: 'https://example.test/forged',
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: 'INVALID_INPUT', error: 'Unknown capture source', requestId: expect.any(String),
    });
    expect(embed).not.toHaveBeenCalled();
    const sideEffects = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM memories) AS memories,
         (SELECT count(*)::int FROM memory_embeddings) AS embeddings,
         (SELECT count(*)::int FROM audit_log) AS audits`,
    );
    expect(sideEffects.rows[0]).toEqual({ memories: 0, embeddings: 0, audits: 0 });
  });

  it('prevents user callers from attributing activity to another principal', async () => {
    const { principal } = await seedActor();
    const other = await createPrincipal(pool, {
      externalId: 'entra:user:capture-other', kind: 'user', displayName: 'Other User',
    });
    const response = await request(app)
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:capture')
      .send({
        scope: { kind: 'team', name: 'payments' }, type: 'context',
        title: 'Forged activity', body: 'Must not persist.', source: 'manual',
        metadata: {
          actor_principal_id: other.id, actor: 'other-user', thread_key: 'manual:forged',
        },
      });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
    expect(principal.id).not.toBe(other.id);
    expect((await pool.query("SELECT 1 FROM memories WHERE title = 'Forged activity'")).rowCount)
      .toBe(0);
  });

  it('adds activity provenance only after self-attribution authorization', async () => {
    const { principal } = await seedActor();
    const response = await request(app)
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:capture')
      .send({
        scope: { kind: 'team', name: 'payments' }, type: 'context',
        title: 'Authorized activity', body: 'Trusted after authorization.', source: 'manual',
        metadata: {
          actor_principal_id: principal.id, actor: 'self', thread_key: 'manual:self',
        },
      });
    expect(response.status).toBe(201);
    const stored = await pool.query('SELECT metadata FROM memories WHERE id = $1', [response.body.id]);
    expect(stored.rows[0].metadata._continuum_activity_provenance).toBe('capture-v1');

    const forgedMarker = await request(app)
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:capture')
      .send({
        scope: { kind: 'team', name: 'payments' }, type: 'context',
        title: 'Caller marker', body: 'Must be rejected.', source: 'manual',
        metadata: { _continuum_activity_provenance: 'capture-v1' },
      });
    expect(forgedMarker.status).toBe(400);
    expect(forgedMarker.body.code).toBe('INVALID_INPUT');
  });

  it.each([
    ['actor attribution', (userId: string) => ({
      actor_principal_id: userId, actor: 'forged-user', thread_key: 'manual:actor',
    })],
    ['thread closure', (userId: string) => ({
      actor_principal_id: userId, actor: 'forged-user',
      thread_owner_principal_id: userId, thread_key: 'manual:closure',
      closes_thread_keys: ['terminal-session:victim'],
    })],
  ])('prevents a service from forging user %s through raw capture', async (_label, metadata) => {
    const service = await createPrincipal(pool, {
      externalId: 'svc:raw-capture', kind: 'service', displayName: 'Raw capture service',
    });
    const user = await createPrincipal(pool, {
      externalId: 'entra:user:victim', kind: 'user', displayName: 'Victim user',
    });
    const scope = await createScope(pool, { kind: 'project', name: 'raw-capture-project' });
    await addMembership(pool, service.id, scope.id, 'writer');

    const response = await request(createApp(pool))
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer svc:raw-capture')
      .send({
        scope: { kind: 'project', name: 'raw-capture-project' }, type: 'context',
        title: 'Forged service activity', body: 'Must not persist.', source: 'manual',
        metadata: metadata(user.id),
      });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
    expect((await pool.query(
      "SELECT 1 FROM memories WHERE title = 'Forged service activity'",
    )).rowCount).toBe(0);
  });

  it('commits memory and sanitized audit when the embedding provider fails', async () => {
    const privateMessage = 'provider token private-provider-value';
    const provider: EmbeddingProvider = {
      id: 'test:failing',
      dim: 768,
      async embed() {
        throw new Error(privateMessage);
      },
    };
    app = createApp(pool, { embeddingProvider: provider });
    await seedActor();

    const res = await request(app)
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:capture')
      .send({
        scope: { kind: 'team', name: 'payments' },
        type: 'fact',
        title: 'Provider fallback',
        body: 'private-rest-memory-text',
        source: 'manual',
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      scopeId: expect.any(String),
      expiresAt: expect.any(String),
      embedded: false,
      related: [],
    });
    expect(JSON.stringify(res.body)).not.toContain(privateMessage);
    const { rows } = await pool.query(
      'SELECT metadata::text AS metadata FROM audit_log WHERE memory_id = $1',
      [res.body.id],
    );
    expect(rows[0].metadata).toContain('EMBEDDING_FAILED');
    expect(rows[0].metadata).not.toContain(privateMessage);
    expect(rows[0].metadata).not.toContain('private-rest-memory-text');
  });

  it('audits provider identity and outcome without captured content', async () => {
    const provider: EmbeddingProvider = {
      id: 'ollama:audit-safe', dim: 768, local: true,
      async embed() { throw new Error('private captured body'); },
    };
    app = createApp(pool, { embeddingProvider: provider });
    await seedActor();

    const res = await request(app)
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:capture')
      .send({
        scope: { kind: 'team', name: 'payments' }, type: 'fact',
        title: 'private title', body: 'private captured body', source: 'manual',
      })
      .expect(201);
    const { rows } = await pool.query(
      'SELECT metadata FROM audit_log WHERE memory_id = $1', [res.body.id],
    );
    expect(rows[0].metadata).toMatchObject({
      embedding: { provider: 'ollama:audit-safe', dim: 768, status: 'failed' },
    });
    expect(JSON.stringify(rows[0].metadata)).not.toContain('private captured body');
    expect(JSON.stringify(rows[0].metadata)).not.toContain('private title');
  });

  it('degrades capture promptly when Ollama stalls after response headers', async () => {
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
    await seedActor();

    await request(app)
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:capture')
      .send({ scope: { kind: 'team', name: 'payments' }, type: 'fact',
        title: 'stalled', body: 'private', source: 'manual' })
      .expect(201);

    expect(observedSignal?.aborted).toBe(true);
  });

  it('rejects writes to a scope that does not exist', async () => {
    await seedActor();
    const res = await request(app)
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:capture')
      .send({
        scope: { kind: 'team', name: 'ghost' },
        type: 'fact',
        title: 'x',
        body: 'y',
        source: 'manual',
      });
    expect(res.status).toBe(404);
  });

  it('rejects writes when principal lacks writer role', async () => {
    await seedActor('reader');
    const res = await request(app)
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:capture')
      .send({
        scope: { kind: 'team', name: 'payments' },
        type: 'fact',
        title: 'x',
        body: 'y',
        source: 'manual',
      });
    expect(res.status).toBe(403);
  });

  it('writes a memory and an audit entry on success', async () => {
    const { principal, scope } = await seedActor('writer');
    const res = await request(app)
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:capture')
      .send({
        scope: { kind: 'team', name: 'payments' },
        type: 'decision',
        title: 'Use ADO not Jira',
        body: 'ExampleOrg uses Azure DevOps exclusively for work tracking.',
        source: 'manual',
        tags: ['tooling'],
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.scopeId).toBe(scope.id);
    expect(res.body.expiresAt).toBeNull();
    expect(res.body.related).toEqual([]);

    const audit = await pool.query(
      'SELECT action, memory_id, scope_id FROM audit_log WHERE principal_id = $1',
      [principal.id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].action).toBe('write');
    expect(audit.rows[0].memory_id).toBe(res.body.id);
    expect(audit.rows[0].scope_id).toBe(scope.id);
  });

  it('computes expires_at for context memories in team scope (60 days)', async () => {
    await seedActor('writer');
    const before = Date.now();
    const res = await request(app)
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:capture')
      .send({
        scope: { kind: 'team', name: 'payments' },
        type: 'context',
        title: 'sprint status',
        body: 'shipping checkout v2',
        source: 'manual',
      });
    expect(res.status).toBe(201);
    const expiresAtMs = new Date(res.body.expiresAt).getTime();
    const expected = before + 60 * 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresAtMs - expected)).toBeLessThan(5_000);
  });
});
