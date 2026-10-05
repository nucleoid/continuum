import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createApp } from '../server.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope, getScopeByRef } from '../../storage/scopes.js';
import { addMembership, getMembership } from '../../storage/memberships.js';
import { createMemory } from '../../storage/memories.js';

describe('CLI REST support routes', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => { await pool?.end(); });

  async function seed() {
    const admin = await createPrincipal(pool, {
      externalId: 'token-admin', kind: 'user', displayName: 'Admin',
    });
    const member = await createPrincipal(pool, {
      externalId: 'token-member', kind: 'user', displayName: 'Member',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const project = await createScope(pool, { kind: 'project', name: 'continuum' });
    await addMembership(pool, admin.id, org.id, 'admin');
    await addMembership(pool, admin.id, project.id, 'writer');
    await addMembership(pool, member.id, project.id, 'reader');
    const memory = await createMemory(pool, {
      scopeId: project.id, scopeKind: 'project', type: 'fact', title: 'CLI fact',
      body: 'The CLI uses the REST API.', authorId: admin.id, source: 'manual',
    });
    return { admin, member, org, project, memory };
  }

  it('lists only readable scopes with the caller role', async () => {
    const { project } = await seed();
    const response = await request(createApp(pool))
      .get('/api/v0/scopes')
      .set('Authorization', 'Bearer token-member');
    expect(response.status).toBe(200);
    expect(response.body.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: project.id, scope: 'project:continuum', role: 'reader' }),
      expect.objectContaining({ scope: 'org', role: 'implicit-reader' }),
    ]));
    expect(response.body.scopes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'team:unassigned' }),
    ]));
    const managed = await request(createApp(pool))
      .get('/api/v0/scopes?manage=true')
      .set('Authorization', 'Bearer token-member');
    expect(managed.status).toBe(400);
  });

  it('distinguishes an explicit org reader from implicit org readability', async () => {
    const { member, org } = await seed();
    await addMembership(pool, member.id, org.id, 'reader');
    const response = await request(createApp(pool))
      .get('/api/v0/scopes')
      .set('Authorization', 'Bearer token-member');
    expect(response.status).toBe(200);
    expect(response.body.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: org.id, scope: 'org', role: 'reader' }),
    ]));
  });

  it('exposes promote and verify through the shared lifecycle services', async () => {
    const { memory } = await seed();
    const verify = await request(createApp(pool))
      .post(`/api/v0/memories/${memory.id}/verify`)
      .set('Authorization', 'Bearer token-admin')
      .send({ stillTrue: true, note: 'checked' });
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ id: memory.id, state: 'live' });

    const promote = await request(createApp(pool))
      .post(`/api/v0/memories/${memory.id}/promote`)
      .set('Authorization', 'Bearer token-admin')
      .send({ targetScope: { kind: 'org', name: '' } });
    expect(promote.status).toBe(201);
    expect(promote.body.sourceId).toBe(memory.id);
    expect(promote.body.destinationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not expose REST membership mutation, even to org admins', async () => {
    const { admin, member, org, project } = await seed();
    const app = createApp(pool);
    const grant = await request(app)
      .put(`/api/v0/scopes/${project.id}/members/${member.id}`)
      .set('Authorization', 'Bearer token-admin')
      .send({ role: 'writer' });
    expect(grant.status).toBe(404);
    expect((await getMembership(pool, member.id, project.id))?.role).toBe('reader');

    const revoke = await request(app)
      .delete(`/api/v0/scopes/${org.id}/members/${admin.id}`)
      .set('Authorization', 'Bearer token-admin');
    expect(revoke.status).toBe(404);
    expect((await getMembership(pool, admin.id, org.id))?.role).toBe('admin');

    const audit = await pool.query(
      `SELECT metadata FROM audit_log WHERE principal_id = $1 AND action = 'write' ORDER BY id`,
      [admin.id],
    );
    expect(audit.rows).toEqual([]);
  });
});
