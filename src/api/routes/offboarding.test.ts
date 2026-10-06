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
});
