import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { decisionHistoryForPrincipal } from './supersede.js';

describe('decision history service', () => {
  let pool: pg.Pool;
  let reader: Awaited<ReturnType<typeof createPrincipal>>;
  let author: Awaited<ReturnType<typeof createPrincipal>>;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
    reader = await createPrincipal(pool, {
      externalId: 'history-reader', kind: 'user', displayName: 'History Reader',
    });
    author = await createPrincipal(pool, {
      externalId: 'history-author', kind: 'user', displayName: 'History Author',
    });
  });

  afterAll(async () => { await pool?.end(); });

  it('returns an authorized chain oldest-to-newest and audits every delivered decision', async () => {
    const scope = await createScope(pool, { kind: 'project', name: 'readable-history' });
    await addMembership(pool, reader.id, scope.id, 'reader');
    const first = await createMemory(pool, {
      scopeId: scope.id, scopeKind: scope.kind, type: 'decision', title: 'First',
      body: 'First body', authorId: author.id, source: 'manual',
    });
    await pool.query(`UPDATE memories SET state = 'archived' WHERE id = $1`, [first.id]);
    const second = await createMemory(pool, {
      scopeId: scope.id, scopeKind: scope.kind, type: 'decision', title: 'Second',
      body: 'Second body', authorId: author.id, source: 'manual', supersedesId: first.id,
    });

    const result = await decisionHistoryForPrincipal(pool, reader, first.id, {
      transport: 'test',
    });

    expect(result.currentId).toBe(second.id);
    expect(result.decisions.map((decision) => decision.id)).toEqual([first.id, second.id]);
    const { rows } = await pool.query(
      `SELECT memory_id, metadata FROM audit_log ORDER BY id`,
    );
    expect(rows.map((row) => row.memory_id)).toEqual([null, first.id, second.id]);
    expect(rows[0].metadata).toMatchObject({
      view: 'decision-history', anchor_id: first.id, current_id: second.id,
      transport: 'test', record_kind: 'summary',
    });
  });

  it('masks inaccessible and missing decision IDs with the same error and no audit', async () => {
    const hidden = await createScope(pool, { kind: 'project', name: 'hidden-history' });
    const decision = await createMemory(pool, {
      scopeId: hidden.id, scopeKind: hidden.kind, type: 'decision', title: 'Hidden',
      body: 'Private body', authorId: author.id, source: 'manual',
    });
    const missing = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    for (const id of [decision.id, missing]) {
      await expect(decisionHistoryForPrincipal(pool, reader, id)).rejects.toMatchObject({
        code: 'MEMORY_NOT_FOUND', status: 404, publicMessage: 'Memory not found',
      });
    }
    expect((await pool.query('SELECT 1 FROM audit_log')).rowCount).toBe(0);
  });
});
