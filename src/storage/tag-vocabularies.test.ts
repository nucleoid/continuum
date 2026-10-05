import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';
import { runMigrations } from './migrator.js';

const DATABASE_URL = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:***@localhost:5433/continuum';
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

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
      { scope_kind: 'org', count: 10, all_system: true, no_fabricated_actor: true },
      { scope_kind: 'project', count: 10, all_system: true, no_fabricated_actor: true },
      { scope_kind: 'role', count: 10, all_system: true, no_fabricated_actor: true },
      { scope_kind: 'team', count: 10, all_system: true, no_fabricated_actor: true },
      { scope_kind: 'user', count: 10, all_system: true, no_fabricated_actor: true },
    ]);
    const knowledgeGap = await pool.query(
      `SELECT scope_kind FROM tag_vocabularies
        WHERE tag = 'knowledge-gap' ORDER BY scope_kind`,
    );
    expect(knowledgeGap.rows.map((row) => row.scope_kind)).toEqual([
      'org', 'project', 'role', 'team', 'user',
    ]);
  });

  it('keeps only shipped historical tags active and preserves private values in metadata', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const schema = `tag_migration_${suffix}`;
    const first = await mkdtemp(join(tmpdir(), 'continuum-tags-before-'));
    const second = await mkdtemp(join(tmpdir(), 'continuum-tags-after-'));
    const admin = new (await import('pg')).default.Pool({ connectionString: DATABASE_URL });
    const historical = new (await import('pg')).default.Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      for (const name of [
        '0001_init.sql', '0002_lifecycle_principal.sql',
        '0003_lifecycle_expiry_index.sql', '0004_review_queue_index.sql',
      ]) {
        await writeFile(join(first, name), await readFile(join(MIGRATIONS, name), 'utf8'));
      }
      await writeFile(
        join(second, '0005_tag_vocabularies.sql'),
        await readFile(join(MIGRATIONS, '0005_tag_vocabularies.sql'), 'utf8'),
      );
      await runMigrations(historical, first);
      await historical.query(`
        INSERT INTO principals (id, external_id, kind, display_name)
        VALUES ('10000000-0000-4000-8000-000000000001', 'historical:user', 'user', 'Historical');
        INSERT INTO scopes (id, kind, name)
        VALUES ('20000000-0000-4000-8000-000000000001', 'project', 'legacy');
        INSERT INTO memories (id, scope_id, type, title, body, author_id, source, tags)
        VALUES (
          '30000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001',
          'fact', 'Legacy', 'Keep its taxonomy',
          '10000000-0000-4000-8000-000000000001', 'manual',
          ARRAY['decision', ' Customer-Impact ', 'customer-impact', 'legacy label']
        ), (
          '30000000-0000-4000-8000-000000000002',
          '20000000-0000-4000-8000-000000000001',
          'fact', 'Plugin legacy', 'Keep plugin dimensions privately',
          '10000000-0000-4000-8000-000000000001', 'ado-workitem',
          ARRAY['ado', 'private-project', 'System.AreaPath=Secret Team']
        )
      `);

      await expect(runMigrations(historical, second)).resolves.toHaveLength(1);
      const memories = await historical.query(
        `SELECT id, tags, metadata FROM memories
          WHERE id IN (
            '30000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000002'
          )
          ORDER BY id`,
      );
      expect(memories.rows).toEqual([
        {
          id: '30000000-0000-4000-8000-000000000001',
          tags: ['decision'],
          metadata: {
            continuum_legacy_tags: [
              ' Customer-Impact ', 'customer-impact', 'legacy label',
            ],
          },
        },
        {
          id: '30000000-0000-4000-8000-000000000002',
          tags: ['ado'],
          metadata: {
            continuum_legacy_tags: ['private-project', 'System.AreaPath=Secret Team'],
          },
        },
      ]);
      const vocabulary = await historical.query(
        `SELECT tag FROM tag_vocabularies
          WHERE scope_kind = 'project'
            AND tag IN ('customer-impact', 'private-project')
          ORDER BY tag`,
      );
      expect(vocabulary.rows).toEqual([]);
    } finally {
      await historical.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(second, { recursive: true, force: true }),
      ]);
    }
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
