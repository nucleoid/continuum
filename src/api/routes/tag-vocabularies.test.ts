import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { createApp } from '../server.js';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createPrincipal } from '../../storage/principals.js';
import { getScopeByRef, createScope } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';
import { createMemory } from '../../storage/memories.js';
import { promoteMemory } from '../../storage/promote.js';
import { captureMemory } from '../../services/capture.js';
import { removeTagVocabulary } from '../../services/tag-vocabularies.js';
import { ServiceError } from '../../services/errors.js';

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
      'ado', 'branch', 'decision', 'deploy', 'github', 'knowledge-gap', 'merged', 'pr',
      'session', 'terminal',
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
    await pool.query(
      `INSERT INTO tag_vocabularies (scope_kind, tag, description, created_by)
       VALUES ('project', 'release-ready', 'Custom in-use tag', $1)`,
      [principal.id],
    );
    await createMemory(pool, {
      scopeId: project.id, scopeKind: 'project', type: 'fact', title: 'Deploy', body: 'Done',
      authorId: principal.id, source: 'manual', tags: ['release-ready'],
    });

    const response = await request(app)
      .delete('/api/v0/tag-vocabularies/project/release-ready')
      .set('Authorization', 'Bearer entra:tags:admin');
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT', error: 'Tag is in use by memories in this scope kind',
    });
  });

  it('refuses to delete built-in tags even when they are unused', async () => {
    await actor('admin');

    const response = await request(app)
      .delete('/api/v0/tag-vocabularies/project/knowledge-gap')
      .set('Authorization', 'Bearer entra:tags:admin');

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT', error: 'System tags cannot be deleted',
    });
    const { rows } = await pool.query(
      `SELECT tag FROM tag_vocabularies
        WHERE scope_kind = 'project' AND tag = 'knowledge-gap'`,
    );
    expect(rows).toEqual([{ tag: 'knowledge-gap' }]);
    const audit = await pool.query(
      `SELECT 1 FROM audit_log
        WHERE metadata->>'operation' = 'delete_tag_vocabulary'`,
    );
    expect(audit.rows).toEqual([]);
  });

  it('cannot delete a tag after a concurrent capture has validated it', async () => {
    const { principal } = await actor('admin');
    const project = await createScope(pool, { kind: 'project', name: 'capture-race' });
    await addMembership(pool, principal.id, project.id, 'writer');
    await pool.query(
      `INSERT INTO tag_vocabularies (scope_kind, tag, description, created_by)
       VALUES ('project', 'race-safe', 'Race regression', $1)`,
      [principal.id],
    );
    const validationLocked = deferred<void>();
    const releaseCapture = deferred<void>();
    const capturePool = poolPausingAfterLockedTagValidation(
      pool, validationLocked, releaseCapture,
    );
    const capture = captureMemory(capturePool, null, principal, {
      scope: { kind: 'project', name: 'capture-race' },
      type: 'fact', title: 'Concurrent capture', body: 'Must retain vocabulary.',
      source: 'manual', tags: ['race-safe'],
    });
    await validationLocked.promise;

    const deletePid = deferred<number>();
    const deletion = removeTagVocabulary(
      poolReportingClientPid(pool, deletePid),
      principal,
      { scopeKind: 'project', tag: 'race-safe' },
    );
    await waitForDatabaseLock(pool, await deletePid.promise);
    releaseCapture.resolve();

    await expect(capture).resolves.toMatchObject({ memory: { tags: ['race-safe'] } });
    await expect(deletion).rejects.toMatchObject<ServiceError>({
      code: 'CONFLICT', status: 409,
    });
    const vocabulary = await pool.query(
      `SELECT tag FROM tag_vocabularies
        WHERE scope_kind = 'project' AND tag = 'race-safe'`,
    );
    expect(vocabulary.rows).toEqual([{ tag: 'race-safe' }]);
  });

  it('does not lock unrelated vocabulary rows while capture is in flight', async () => {
    const { principal } = await actor('admin');
    const project = await createScope(pool, { kind: 'project', name: 'narrow-locks' });
    await addMembership(pool, principal.id, project.id, 'writer');
    await pool.query(
      `INSERT INTO tag_vocabularies (scope_kind, tag, description, created_by)
       VALUES ('project', 'capture-tag', 'Used by capture', $1),
              ('project', 'delete-tag', 'Unrelated unused tag', $1)`,
      [principal.id],
    );
    const validationLocked = deferred<void>();
    const releaseCapture = deferred<void>();
    const capturePool = poolPausingAfterLockedTagValidation(
      pool, validationLocked, releaseCapture,
    );
    const capture = captureMemory(capturePool, null, principal, {
      scope: { kind: 'project', name: 'narrow-locks' },
      type: 'fact', title: 'Narrow lock', body: 'Only lock the requested tag.',
      source: 'manual', tags: ['capture-tag'],
    });
    await validationLocked.promise;

    const deletion = removeTagVocabulary(
      pool,
      principal,
      { scopeKind: 'project', tag: 'delete-tag' },
    );
    const outcome = await Promise.race([
      deletion.then(() => 'deleted' as const),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 250)),
    ]);
    releaseCapture.resolve();
    await capture;
    await deletion;

    expect(outcome).toBe('deleted');
  });

  it('does not lock unrelated destination vocabulary rows during promotion', async () => {
    const { principal } = await actor('admin');
    const team = await createScope(pool, { kind: 'team', name: 'promotion-source' });
    const project = await createScope(pool, { kind: 'project', name: 'promotion-target' });
    await addMembership(pool, principal.id, team.id, 'writer');
    await addMembership(pool, principal.id, project.id, 'writer');
    await pool.query(
      `INSERT INTO tag_vocabularies (scope_kind, tag, description, created_by)
       VALUES ('team', 'promote-tag', 'Source tag', $1),
              ('project', 'promote-tag', 'Destination tag', $1),
              ('project', 'delete-tag', 'Unrelated unused tag', $1)`,
      [principal.id],
    );
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: 'team', type: 'decision', title: 'Promote narrowly',
      body: 'Only lock the destination tag being copied.', authorId: principal.id,
      source: 'manual', tags: ['promote-tag'],
    });
    const validationLocked = deferred<void>();
    const releasePromotion = deferred<void>();
    const promotionPool = poolPausingAfterLockedTagValidation(
      pool, validationLocked, releasePromotion,
    );
    const promotion = promoteMemory(
      promotionPool,
      principal.id,
      source.id,
      { kind: 'project', name: 'promotion-target' },
    );
    await validationLocked.promise;

    const deletion = removeTagVocabulary(
      pool,
      principal,
      { scopeKind: 'project', tag: 'delete-tag' },
    );
    const outcome = await Promise.race([
      deletion.then(() => 'deleted' as const),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 250)),
    ]);
    releasePromotion.resolve();
    await promotion;
    await deletion;

    expect(outcome).toBe('deleted');
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function poolPausingAfterLockedTagValidation(
  pool: pg.Pool,
  locked: ReturnType<typeof deferred<void>>,
  releaseValidation: ReturnType<typeof deferred<void>>,
): pg.Pool {
  return {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return async (...args: unknown[]) => {
              const result = await (target.query as (...queryArgs: unknown[]) => Promise<unknown>)(
                ...args,
              );
              const sql = typeof args[0] === 'string' ? args[0] : '';
              if (sql.includes('FROM tag_vocabularies') && sql.includes('FOR KEY SHARE')) {
                locked.resolve();
                await releaseValidation.promise;
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as pg.Pool;
}

function poolReportingClientPid(
  pool: pg.Pool,
  connected: ReturnType<typeof deferred<number>>,
): pg.Pool {
  return {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      connected.resolve(rows[0].pid);
      return client;
    },
  } as unknown as pg.Pool;
}

async function waitForDatabaseLock(pool: pg.Pool, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await pool.query(
      'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid],
    );
    if (rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('tag deletion did not wait for capture validation');
}
