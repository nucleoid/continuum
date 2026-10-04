import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';

describe('tag vocabulary schema', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => { await pool?.end(); });

  it('seeds the stable taxonomy for every scope kind', async () => {
    const { rows } = await pool.query(
      `SELECT scope_kind, count(*)::int AS count, bool_and(is_system) AS all_system,
              bool_and(created_by IS NULL) AS no_fabricated_actor
         FROM tag_vocabularies GROUP BY scope_kind ORDER BY scope_kind`,
    );
    expect(rows).toEqual([
      { scope_kind: 'org', count: 9, all_system: true, no_fabricated_actor: true },
      { scope_kind: 'project', count: 9, all_system: true, no_fabricated_actor: true },
      { scope_kind: 'role', count: 9, all_system: true, no_fabricated_actor: true },
      { scope_kind: 'team', count: 9, all_system: true, no_fabricated_actor: true },
      { scope_kind: 'user', count: 9, all_system: true, no_fabricated_actor: true },
    ]);
  });

  it.each([
    ['uppercase', 'Deploy'],
    ['spaces', 'release ready'],
    ['leading hyphen', '-release'],
    ['too long', 'a'.repeat(65)],
  ])('rejects invalid %s tags at the database boundary', async (_case, tag) => {
    await expect(pool.query(
      `INSERT INTO tag_vocabularies
         (scope_kind, tag, created_by)
       VALUES ('project', $1, '00000000-0000-4000-8000-000000000011')`,
      [tag],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('enforces uniqueness per scope kind', async () => {
    await expect(pool.query(
      `INSERT INTO tag_vocabularies (scope_kind, tag, description, is_system)
       VALUES ('project', 'deploy', 'duplicate', true)`,
    )).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(
      `INSERT INTO tag_vocabularies (scope_kind, tag, description, is_system)
       VALUES ('team', 'deploy', 'duplicate', true)`,
    )).rejects.toMatchObject({ code: '23505' });
  });
});
