import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createApp } from '../server.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';

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
