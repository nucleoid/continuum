import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { createApp } from '../server.js';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createPrincipal } from '../../storage/principals.js';
import { getScopeByRef, createScope } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';
import { createMemory } from '../../storage/memories.js';

describe('/api/v0/tag-vocabularies', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
    app = createApp(pool);
  });

  afterAll(async () => { await pool?.end(); });

  async function actor(role?: 'reader' | 'writer' | 'admin') {
    const principal = await createPrincipal(pool, {
      externalId: `entra:tags:${role ?? 'none'}`, kind: 'user', displayName: 'Tag Actor',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    if (role) await addMembership(pool, principal.id, org.id, role);
    return { principal, org };
  }

  it('lets any authenticated principal list deterministic built-in entries', async () => {
    await actor();
    const response = await request(app)
      .get('/api/v0/tag-vocabularies?scopeKind=project')
      .set('Authorization', 'Bearer entra:tags:none');

    expect(response.status).toBe(200);
    expect(response.body.scopeKind).toBe('project');
    expect(response.body.entries.map((entry: { tag: string }) => entry.tag)).toEqual([
      'ado', 'branch', 'decision', 'deploy', 'github', 'merged', 'pr', 'session', 'terminal',
    ]);
    expect(response.body.entries.every((entry: { isSystem: boolean }) => entry.isSystem)).toBe(true);
  });

  it('requires org admin and audits create, update, and delete atomically', async () => {
    const denied = await actor('admin');
    const team = await createScope(pool, { kind: 'team', name: 'admins-only-here' });
    await addMembership(pool, denied.principal.id, denied.org.id, 'reader');
    await addMembership(pool, denied.principal.id, team.id, 'admin');
    const forbidden = await request(app)
      .post('/api/v0/tag-vocabularies')
      .set('Authorization', 'Bearer entra:tags:admin')
      .send({ scopeKind: 'project', tag: 'release-ready' });
    expect(forbidden.status).toBe(403);

    await resetData(pool);
    const { principal } = await actor('admin');
    const created = await request(app)
      .post('/api/v0/tag-vocabularies')
      .set('Authorization', 'Bearer entra:tags:admin')
      .send({ scopeKind: 'project', tag: ' Release-Ready ', description: 'Ready' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      scopeKind: 'project', tag: 'release-ready', description: 'Ready',
      isSystem: false, createdBy: principal.id,
    });

    const updated = await request(app)
      .patch('/api/v0/tag-vocabularies/project/release-ready')
      .set('Authorization', 'Bearer entra:tags:admin')
      .send({ description: 'Approved for release' });
    expect(updated.status).toBe(200);
    expect(updated.body.description).toBe('Approved for release');

    const deleted = await request(app)
      .delete('/api/v0/tag-vocabularies/project/release-ready')
      .set('Authorization', 'Bearer entra:tags:admin');
    expect(deleted.status).toBe(204);

    const audits = await pool.query(
      `SELECT metadata FROM audit_log
        WHERE metadata->>'operation' LIKE '%tag_vocabulary'
        ORDER BY id`,
    );
    expect(audits.rows.map((row) => row.metadata.operation)).toEqual([
      'create_tag_vocabulary', 'update_tag_vocabulary', 'delete_tag_vocabulary',
    ]);
    expect(audits.rows[1].metadata).toMatchObject({
      before: { description: 'Ready' }, after: { description: 'Approved for release' },
    });
  });

  it('returns a deterministic conflict for concurrent duplicate creates', async () => {
    await actor('admin');
    const requests = await Promise.all([
      request(app).post('/api/v0/tag-vocabularies')
        .set('Authorization', 'Bearer entra:tags:admin')
        .send({ scopeKind: 'team', tag: 'incident' }),
      request(app).post('/api/v0/tag-vocabularies')
        .set('Authorization', 'Bearer entra:tags:admin')
        .send({ scopeKind: 'team', tag: 'incident' }),
    ]);
    expect(requests.map((result) => result.status).sort()).toEqual([201, 409]);
  });

  it('refuses to delete a tag used by a memory in the same scope kind', async () => {
    const { principal } = await actor('admin');
    const project = await createScope(pool, { kind: 'project', name: 'continuum' });
    await createMemory(pool, {
      scopeId: project.id, scopeKind: 'project', type: 'fact', title: 'Deploy', body: 'Done',
      authorId: principal.id, source: 'manual', tags: ['deploy'],
    });

    const response = await request(app)
      .delete('/api/v0/tag-vocabularies/project/deploy')
      .set('Authorization', 'Bearer entra:tags:admin');
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT', error: 'Tag is in use by memories in this scope kind',
    });
  });
});
