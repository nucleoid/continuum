import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { addMembership } from '../../storage/memberships.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope, getScopeByRef } from '../../storage/scopes.js';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createApp } from '../server.js';

describe('offboarding REST administration', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); });
  afterAll(async () => { await pool?.end(); });

  it('requires org admin and exposes mapping, dry-run, and execution', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'admin-rest', kind: 'user', displayName: 'Admin',
    });
    const target = await createPrincipal(pool, {
      externalId: 'target-rest', kind: 'user', displayName: 'Target',
    });
    const outsider = await createPrincipal(pool, {
      externalId: 'outsider-rest', kind: 'user', displayName: 'Outsider',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const personal = await createScope(pool, { kind: 'user', name: 'rest-owned-scope' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    await addMembership(pool, target.id, personal.id, 'writer');
    const app = createApp(pool, { logger: { info() {}, error() {} } });
    const path = `/api/v0/admin/principals/${target.id}`;

    const forbidden = await request(app).put(`${path}/owned-user-scope`)
      .set('Authorization', 'Bearer outsider-rest').send({ scopeId: personal.id });
    expect(forbidden.status).toBe(403);

    const mapped = await request(app).put(`${path}/owned-user-scope`)
      .set('Authorization', 'Bearer admin-rest').send({ scopeId: personal.id });
    expect(mapped.status).toBe(201);
    expect(mapped.body).toMatchObject({ principalId: target.id, scopeId: personal.id, created: true });

    const preview = await request(app).post(`${path}/offboard`)
      .set('Authorization', 'Bearer admin-rest').send({ dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ principalId: target.id, dryRun: true, alreadyOffboarded: false });

    const executed = await request(app).post(`${path}/offboard`)
      .set('Authorization', 'Bearer admin-rest').send({});
    expect(executed.status).toBe(200);
    expect(executed.body).toMatchObject({ principalId: target.id, dryRun: false, alreadyOffboarded: false });
  });

  it('does not expose erased audit free text through GET /audit', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'audit-admin', kind: 'user', displayName: 'Admin',
    });
    const target = await createPrincipal(pool, {
      externalId: 'audit-target', kind: 'user', displayName: 'Target',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const personal = await createScope(pool, { kind: 'user', name: 'private-scope-name' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    await addMembership(pool, target.id, personal.id, 'writer');
    const app = createApp(pool, { logger: { info() {}, error() {} } });
    const path = `/api/v0/admin/principals/${target.id}`;
    await request(app).put(`${path}/owned-user-scope`)
      .set('Authorization', 'Bearer audit-admin').send({ scopeId: personal.id });
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, query, metadata)
       VALUES ($1, 'verify', $2, 'private query',
               '{"note":"private note","scope":"private-scope-name"}')`,
      [target.id, personal.id],
    );
    expect((await request(app).post(`${path}/offboard`)
      .set('Authorization', 'Bearer audit-admin').send({})).status).toBe(200);
    const response = await request(app).get('/api/v0/audit')
      .set('Authorization', 'Bearer audit-admin');
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('private query');
    expect(JSON.stringify(response.body)).not.toContain('private note');
    expect(JSON.stringify(response.body)).not.toContain('private-scope-name');
  });

  it('maps the last-admin offboarding guard to the stable conflict contract', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'only-admin-rest', kind: 'user', displayName: 'Only admin',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const personal = await createScope(pool, { kind: 'user', name: 'only-admin-rest-scope' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    await addMembership(pool, admin.id, personal.id, 'writer');
    const app = createApp(pool, { logger: { info() {}, error() {} } });
    const path = `/api/v0/admin/principals/${admin.id}`;
    expect((await request(app).put(`${path}/owned-user-scope`)
      .set('Authorization', 'Bearer only-admin-rest').send({ scopeId: personal.id })).status).toBe(201);
    const response = await request(app).post(`${path}/offboard`)
      .set('Authorization', 'Bearer only-admin-rest').send({});
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT', error: 'cannot remove the last effective manual org administrator',
    });
  });
});
