import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createApp } from '../server.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope, getScopeByRef } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';
import { createMemory } from '../../storage/memories.js';
import type { EmbeddingProvider } from '../../embeddings/provider.js';

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

  it('writes an audit entry per recall', async () => {
    const { me } = await seedWorld();
    await request(app)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:recall')
      .send({ query: 'checkout' });
    const { rows } = await pool.query(
      `SELECT action, query FROM audit_log WHERE principal_id = $1 AND action = 'read'`,
      [me.id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].query).toBe('checkout');
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

  it('maps provider failures to a safe dependency error', async () => {
    const privateMessage = 'provider endpoint private-provider-host';
    const failingProvider: EmbeddingProvider = {
      id: 'test:failing', dim: 768,
      async embed() { throw new Error(privateMessage); },
    };
    app = createApp(pool, { embeddingProvider: failingProvider });
    await seedWorld();

    const res = await request(app)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:recall')
      .send({ query: 'checkout' });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      code: 'DEPENDENCY_UNAVAILABLE',
      error: 'A required dependency is unavailable',
      requestId: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toContain(privateMessage);
  });
});
