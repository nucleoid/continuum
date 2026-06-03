import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createApp } from '../server.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope, getScopeByRef } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';
import { record } from '../../audit/log.js';

describe('GET /api/v0/audit', () => {
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

  async function seed(role: 'reader' | 'writer' | 'admin' = 'reader') {
    const alice = await createPrincipal(pool, {
      externalId: 'entra:alice',
      kind: 'user',
      displayName: 'Alice',
    });
    const bob = await createPrincipal(pool, {
      externalId: 'entra:bob',
      kind: 'user',
      displayName: 'Bob',
    });
    const team = await createScope(pool, { kind: 'team', name: 'payments' });
    await addMembership(pool, alice.id, team.id, role);

    await record(pool, { principalId: alice.id, action: 'write', scopeId: team.id });
    await record(pool, { principalId: alice.id, action: 'read', scopeId: team.id });
    await record(pool, { principalId: bob.id, action: 'write', scopeId: team.id });
    return { alice, bob, team };
  }

  it('rejects requests without bearer', async () => {
    const res = await request(app).get('/api/v0/audit');
    expect(res.status).toBe(401);
  });

  it('non-admin principal sees only its own entries even without filter', async () => {
    const { alice } = await seed('reader');
    const res = await request(app)
      .get('/api/v0/audit')
      .set('Authorization', 'Bearer entra:alice');
    expect(res.status).toBe(200);
    expect(res.body.orgAdmin).toBe(false);
    // The audit read itself is logged before the response, so Alice sees
    // her two seeded entries + the meta-audit of this query.
    expect(res.body.entries.length).toBeGreaterThanOrEqual(2);
    for (const e of res.body.entries) {
      expect(e.principalId).toBe(alice.id);
    }
  });

  it('non-admin principal is forbidden from querying another principal', async () => {
    const { bob } = await seed('reader');
    const res = await request(app)
      .get('/api/v0/audit')
      .query({ principalId: bob.id })
      .set('Authorization', 'Bearer entra:alice');
    expect(res.status).toBe(403);
  });

  it('org-admin principal can query any principals audit', async () => {
    const { alice, bob } = await seed('reader');
    const orgScope = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, alice.id, orgScope.id, 'admin');

    const res = await request(app)
      .get('/api/v0/audit')
      .query({ principalId: bob.id })
      .set('Authorization', 'Bearer entra:alice');
    expect(res.status).toBe(200);
    expect(res.body.orgAdmin).toBe(true);
    expect(res.body.entries.length).toBeGreaterThanOrEqual(1);
    for (const e of res.body.entries) {
      expect(e.principalId).toBe(bob.id);
    }
  });

  it('records a meta-audit entry for the query itself', async () => {
    const { alice } = await seed('reader');
    await request(app)
      .get('/api/v0/audit')
      .set('Authorization', 'Bearer entra:alice');

    const { rows } = await pool.query(
      `SELECT metadata FROM audit_log
        WHERE principal_id = $1 AND metadata->>'view' = 'audit'`,
      [alice.id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].metadata.view).toBe('audit');
    expect(rows[0].metadata.orgAdmin).toBe(false);
  });

  it('rejects malformed query params', async () => {
    await seed('reader');
    const res = await request(app)
      .get('/api/v0/audit')
      .query({ principalId: 'not-a-uuid' })
      .set('Authorization', 'Bearer entra:alice');
    expect(res.status).toBe(400);
  });

  it('honors action filter', async () => {
    await seed('reader');
    const res = await request(app)
      .get('/api/v0/audit')
      .query({ action: 'write' })
      .set('Authorization', 'Bearer entra:alice');
    expect(res.status).toBe(200);
    for (const e of res.body.entries) {
      expect(e.action).toBe('write');
    }
  });
});
