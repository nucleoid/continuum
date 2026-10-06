import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';
import { runMigrations } from './migrator.js';
import { updateTagVocabulary } from './tag-vocabularies.js';

const DATABASE_URL = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:***@localhost:5433/continuum';
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

async function waitForTableLock(
  admin: pg.Pool,
  relation: string,
  mode: string,
  granted: boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await admin.query<{ found: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_locks
          WHERE relation = $1::regclass
            AND mode = $2
            AND granted = $3
       ) AS found`,
      [relation, mode, granted],
    );
    if (rows[0]?.found) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${mode} on ${relation}`);
}

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
        join(second, '0010_tag_vocabularies.sql'),
        await readFile(join(MIGRATIONS, '0010_tag_vocabularies.sql'), 'utf8'),
      );
      await runMigrations(historical, first);
      await historical.query(`
        INSERT INTO principals (id, external_id, kind, display_name)
        VALUES ('10000000-0000-4000-8000-000000000001', 'historical:user', 'user', 'Historical');
        INSERT INTO scopes (id, kind, name)
        VALUES ('20000000-0000-4000-8000-000000000001', 'project', 'legacy');
        INSERT INTO memories (
          id, scope_id, type, title, body, author_id, source, tags, metadata
        )
        VALUES (
          '30000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001',
          'fact', 'Legacy', 'Keep its taxonomy',
          '10000000-0000-4000-8000-000000000001', 'manual',
          ARRAY['decision', ' Customer-Impact ', 'customer-impact', 'legacy label'],
          '{}'::jsonb
        ), (
          '30000000-0000-4000-8000-000000000002',
          '20000000-0000-4000-8000-000000000001',
          'fact', 'Plugin legacy', 'Keep plugin dimensions privately',
          '10000000-0000-4000-8000-000000000001', 'ado-workitem',
          ARRAY['ado', 'private-project', 'System.AreaPath=Secret Team'],
          '{"continuum_legacy_tags":"pre-existing","continuum_legacy_metadata":{"forged":true},"continuum_tag_migration":{"version":999},"continuum_tag_rollback_compat":{"version":999},"continuum_migration_conflicts":"forged","keep":"yes"}'::jsonb
        ), (
          '30000000-0000-4000-8000-000000000003',
          '20000000-0000-4000-8000-000000000001',
          'fact', 'Non-object metadata', 'Preserve manually inserted metadata',
          '10000000-0000-4000-8000-000000000001', 'manual',
          ARRAY['private-array'],
          '[1,2]'::jsonb
        ), (
          '30000000-0000-4000-8000-000000000004',
          '20000000-0000-4000-8000-000000000001',
          'fact', 'Null legacy metadata', 'Do not invent an extra legacy value',
          '10000000-0000-4000-8000-000000000001', 'manual',
          ARRAY['PR', 'pr', NULL, 'x']::text[],
          '{"continuum_legacy_tags":null,"keep":"yes"}'::jsonb
        ), (
          '30000000-0000-4000-8000-000000000005',
          '20000000-0000-4000-8000-000000000001',
          'fact', 'Already canonical', 'Do not rewrite this row',
          '10000000-0000-4000-8000-000000000001', 'manual',
          ARRAY['decision'], '{"keep":"unchanged"}'::jsonb
        )
      `);
      const beforeXmin = await historical.query(
        `SELECT xmin::text AS xmin FROM memories
          WHERE id = '30000000-0000-4000-8000-000000000005'`,
      );

      await expect(runMigrations(historical, second)).resolves.toHaveLength(1);
      const memories = await historical.query(
        `SELECT id, tags, metadata FROM memories
          WHERE id IN (
            '30000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000002',
            '30000000-0000-4000-8000-000000000003',
            '30000000-0000-4000-8000-000000000004'
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
            continuum_tag_migration: {
              version: 1,
              original_tags: [
                'decision', ' Customer-Impact ', 'customer-impact', 'legacy label',
              ],
            },
          },
        },
        {
          id: '30000000-0000-4000-8000-000000000002',
          tags: ['ado'],
          metadata: {
            continuum_legacy_tags: ['private-project', 'System.AreaPath=Secret Team'],
            continuum_tag_migration: {
              version: 1,
              original_tags: ['ado', 'private-project', 'System.AreaPath=Secret Team'],
            },
            continuum_migration_conflicts: [
              { key: 'continuum_legacy_tags', value: 'pre-existing' },
              { key: 'continuum_legacy_metadata', value: { forged: true } },
              { key: 'continuum_tag_migration', value: { version: 999 } },
              { key: 'continuum_tag_rollback_compat', value: { version: 999 } },
              { key: 'continuum_migration_conflicts', value: 'forged' },
            ],
            keep: 'yes',
          },
        },
        {
          id: '30000000-0000-4000-8000-000000000003',
          tags: [],
          metadata: {
            continuum_legacy_metadata: [1, 2],
            continuum_legacy_tags: ['private-array'],
            continuum_tag_migration: {
              version: 1,
              original_tags: ['private-array'],
            },
          },
        },
        {
          id: '30000000-0000-4000-8000-000000000004',
          tags: ['pr'],
          metadata: {
            continuum_legacy_tags: [null, 'x'],
            continuum_migration_conflicts: [
              { key: 'continuum_legacy_tags', value: null },
            ],
            continuum_tag_migration: {
              version: 1,
              original_tags: ['PR', 'pr', null, 'x'],
            },
            keep: 'yes',
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
      const unchanged = await historical.query(
        `SELECT xmin::text AS xmin, tags, metadata FROM memories
          WHERE id = '30000000-0000-4000-8000-000000000005'`,
      );
      expect(unchanged.rows).toEqual([{
        xmin: beforeXmin.rows[0].xmin,
        tags: ['decision'],
        metadata: { keep: 'unchanged' },
      }]);
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

  it('drains FOR UPDATE-first writers without deadlock while reads continue', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const schema = `tag_migration_race_${suffix}`;
    const first = await mkdtemp(join(tmpdir(), 'continuum-tags-race-before-'));
    const second = await mkdtemp(join(tmpdir(), 'continuum-tags-race-after-'));
    const PgPool = (await import('pg')).default.Pool;
    const admin = new PgPool({ connectionString: DATABASE_URL });
    const writers = new PgPool({
      connectionString: DATABASE_URL,
      max: 3,
      options: `-c search_path=${schema},public`,
    });
    const migrator = new PgPool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    let priorWriter: pg.PoolClient | undefined;
    let queuedWriter: pg.PoolClient | undefined;
    let priorWriterOpen = false;
    let migration: Promise<unknown> | undefined;
    let queuedInsert: Promise<{ error?: { code?: string }; inserted?: boolean }> | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      for (const name of [
        '0001_init.sql', '0002_lifecycle_principal.sql',
        '0003_lifecycle_expiry_index.sql', '0004_review_queue_index.sql',
      ]) {
        await writeFile(join(first, name), await readFile(join(MIGRATIONS, name), 'utf8'));
      }
      const migrationSql = await readFile(join(MIGRATIONS, '0010_tag_vocabularies.sql'), 'utf8');
      await writeFile(
        join(second, '0010_tag_vocabularies.sql'),
        migrationSql.replace(
          /LOCK TABLE memories IN [A-Z ]+ MODE;/,
          (lock) => `${lock}\nSELECT pg_sleep(0.5);`,
        ),
      );
      await runMigrations(writers, first);
      await writers.query(`
        INSERT INTO principals (id, external_id, kind, display_name)
        VALUES ('10000000-0000-4000-8000-000000000020', 'race:writer', 'user', 'Old Writer');
        INSERT INTO scopes (id, kind, name)
        VALUES ('20000000-0000-4000-8000-000000000020', 'project', 'migration-race');
        INSERT INTO memories (
          id, scope_id, type, title, body, author_id, source, tags
        ) VALUES (
          '30000000-0000-4000-8000-000000000020',
          '20000000-0000-4000-8000-000000000020',
          'fact', 'Before migration', 'Updated by an old writer',
          '10000000-0000-4000-8000-000000000020', 'manual', ARRAY['decision']
        )
      `);

      priorWriter = await writers.connect();
      await priorWriter.query('BEGIN');
      priorWriterOpen = true;
      await priorWriter.query(`
        SELECT id FROM memories
         WHERE id = '30000000-0000-4000-8000-000000000020'
         FOR UPDATE
      `);

      migration = runMigrations(migrator, second);
      await waitForTableLock(
        admin, `${schema}.memories`, 'ExclusiveLock', false,
      );

      await priorWriter.query(`
        UPDATE memories
           SET tags = ARRAY['private-during-rollout']
         WHERE id = '30000000-0000-4000-8000-000000000020'
      `);
      await priorWriter.query('COMMIT');
      priorWriterOpen = false;
      await waitForTableLock(admin, `${schema}.memories`, 'ExclusiveLock', true);

      const readDuringMigration = await writers.query(
        `SELECT title FROM memories
          WHERE id = '30000000-0000-4000-8000-000000000020'`,
      );
      expect(readDuringMigration.rows).toEqual([{ title: 'Before migration' }]);

      queuedWriter = await writers.connect();
      queuedInsert = queuedWriter.query(`
        INSERT INTO memories (
          id, scope_id, type, title, body, author_id, source, tags
        ) VALUES (
          '30000000-0000-4000-8000-000000000021',
          '20000000-0000-4000-8000-000000000020',
          'fact', 'Queued writer', 'Must meet the installed trigger',
          '10000000-0000-4000-8000-000000000020', 'manual', ARRAY['unchecked-after-scan']
        )
      `).then(
        () => ({ inserted: true }),
        (error: { code?: string }) => ({ error }),
      );
      await waitForTableLock(admin, `${schema}.memories`, 'RowExclusiveLock', false);

      await migration;
      expect(await queuedInsert).toMatchObject({ error: { code: '23514' } });

      const { rows } = await writers.query(
        `SELECT tags, metadata FROM memories
          WHERE id = '30000000-0000-4000-8000-000000000020'`,
      );
      expect(rows).toEqual([{
        tags: [],
        metadata: {
          continuum_legacy_tags: ['private-during-rollout'],
          continuum_tag_migration: {
            version: 1,
            original_tags: ['private-during-rollout'],
          },
        },
      }]);
    } finally {
      if (priorWriterOpen) await priorWriter?.query('ROLLBACK').catch(() => undefined);
      await migration?.catch(() => undefined);
      await queuedInsert?.catch(() => undefined);
      priorWriter?.release();
      queuedWriter?.release();
      await Promise.all([writers.end(), migrator.end()]);
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(second, { recursive: true, force: true }),
      ]);
    }
  });

  it('bounds lock acquisition and EXCLUSIVE-lock work before taking the migration lock', async () => {
    const sql = await readFile(join(MIGRATIONS, '0010_tag_vocabularies.sql'), 'utf8');
    const timeout = sql.indexOf("SET LOCAL lock_timeout = '5s';");
    const statementTimeout = sql.indexOf("SET LOCAL statement_timeout = '60s';");
    const lock = sql.indexOf('LOCK TABLE memories IN EXCLUSIVE MODE;');
    expect(timeout).toBeGreaterThan(-1);
    expect(sql.slice(0, timeout).replace(/--[^\n]*(?:\n|$)/g, '').trim()).toBe('');
    expect(statementTimeout).toBeGreaterThan(timeout);
    expect(statementTimeout).toBeLessThan(lock);
    expect(lock).toBeGreaterThan(timeout);
    expect(sql).not.toContain('LOCK TABLE memories IN SHARE ROW EXCLUSIVE MODE;');
  });

  it('uses one materialized grouped pass for the historical rewrite', async () => {
    const sql = await readFile(join(MIGRATIONS, '0010_tag_vocabularies.sql'), 'utf8');
    expect(sql.match(/UPDATE memories AS memory/g)).toHaveLength(1);
    expect(sql).toMatch(/WITH expanded AS MATERIALIZED/i);
    expect(sql).toMatch(/row_number\(\) OVER/i);
  });

  it('bounds the principals foreign-key lock wait before any migration DDL', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const schema = `tag_migration_principal_timeout_${suffix}`;
    const first = await mkdtemp(join(tmpdir(), 'continuum-tags-principal-before-'));
    const second = await mkdtemp(join(tmpdir(), 'continuum-tags-principal-after-'));
    const PgPool = (await import('pg')).default.Pool;
    const admin = new PgPool({ connectionString: DATABASE_URL });
    const writerPool = new PgPool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    const migrator = new PgPool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    let writer: pg.PoolClient | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      for (const name of [
        '0001_init.sql', '0002_lifecycle_principal.sql',
        '0003_lifecycle_expiry_index.sql', '0004_review_queue_index.sql',
      ]) {
        await writeFile(join(first, name), await readFile(join(MIGRATIONS, name), 'utf8'));
      }
      const migrationSql = await readFile(join(MIGRATIONS, '0010_tag_vocabularies.sql'), 'utf8');
      await writeFile(
        join(second, '0010_tag_vocabularies.sql'),
        migrationSql.replace("SET LOCAL lock_timeout = '5s';", "SET LOCAL lock_timeout = '150ms';"),
      );
      await runMigrations(writerPool, first);
      writer = await writerPool.connect();
      await writer.query('BEGIN');
      await writer.query('LOCK TABLE principals IN ACCESS EXCLUSIVE MODE');

      const started = Date.now();
      await expect(runMigrations(migrator, second)).rejects.toThrow(/lock timeout/i);
      expect(Date.now() - started).toBeLessThan(2_000);
      const rollback = await writerPool.query(
        `SELECT to_regclass('${schema}.tag_vocabularies') AS vocabulary`,
      );
      expect(rollback.rows).toEqual([{ vocabulary: null }]);
    } finally {
      await writer?.query('ROLLBACK').catch(() => undefined);
      writer?.release();
      await Promise.all([writerPool.end(), migrator.end()]);
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(second, { recursive: true, force: true }),
      ]);
    }
  });

  it('rolls back cleanly when the bounded table-lock wait expires', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const schema = `tag_migration_timeout_${suffix}`;
    const first = await mkdtemp(join(tmpdir(), 'continuum-tags-timeout-before-'));
    const second = await mkdtemp(join(tmpdir(), 'continuum-tags-timeout-after-'));
    const PgPool = (await import('pg')).default.Pool;
    const admin = new PgPool({ connectionString: DATABASE_URL });
    const writerPool = new PgPool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    const migrator = new PgPool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    let writer: pg.PoolClient | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      for (const name of [
        '0001_init.sql', '0002_lifecycle_principal.sql',
        '0003_lifecycle_expiry_index.sql', '0004_review_queue_index.sql',
      ]) {
        await writeFile(join(first, name), await readFile(join(MIGRATIONS, name), 'utf8'));
      }
      const migrationSql = await readFile(join(MIGRATIONS, '0010_tag_vocabularies.sql'), 'utf8');
      await writeFile(
        join(second, '0010_tag_vocabularies.sql'),
        migrationSql.replace("SET LOCAL lock_timeout = '5s';", "SET LOCAL lock_timeout = '150ms';"),
      );
      await runMigrations(writerPool, first);
      await writerPool.query(`
        INSERT INTO principals (id, external_id, kind, display_name)
        VALUES ('10000000-0000-4000-8000-000000000040', 'timeout:writer', 'user', 'Writer');
        INSERT INTO scopes (id, kind, name)
        VALUES ('20000000-0000-4000-8000-000000000040', 'project', 'timeout');
        INSERT INTO memories (
          id, scope_id, type, title, body, author_id, source, tags
        ) VALUES (
          '30000000-0000-4000-8000-000000000040',
          '20000000-0000-4000-8000-000000000040',
          'fact', 'Locked', 'Hold a row lock',
          '10000000-0000-4000-8000-000000000040', 'manual', ARRAY['decision']
        )
      `);
      writer = await writerPool.connect();
      await writer.query('BEGIN');
      await writer.query(`
        SELECT id FROM memories
         WHERE id = '30000000-0000-4000-8000-000000000040'
         FOR UPDATE
      `);

      const started = Date.now();
      await expect(runMigrations(migrator, second)).rejects.toThrow(/lock timeout/i);
      expect(Date.now() - started).toBeLessThan(2_000);

      const rollback = await writerPool.query(
        `SELECT to_regclass('${schema}.tag_vocabularies') AS vocabulary,
                EXISTS (
                  SELECT 1 FROM _continuum_migrations
                   WHERE name = '0010_tag_vocabularies.sql'
                ) AS recorded`,
      );
      expect(rollback.rows).toEqual([{ vocabulary: null, recorded: false }]);
    } finally {
      await writer?.query('ROLLBACK').catch(() => undefined);
      writer?.release();
      await Promise.all([writerPool.end(), migrator.end()]);
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

  it('rejects unknown tags at the database boundary during rolling deploys', async () => {
    await pool.query(`
      INSERT INTO principals (id, external_id, kind, display_name)
      VALUES ('10000000-0000-4000-8000-000000000010', 'rolling:writer', 'user', 'Old Writer');
      INSERT INTO scopes (id, kind, name)
      VALUES ('20000000-0000-4000-8000-000000000010', 'project', 'rolling');
    `);

    await expect(pool.query(`
      INSERT INTO memories (
        id, scope_id, type, title, body, author_id, source, tags
      ) VALUES (
        '30000000-0000-4000-8000-000000000010',
        '20000000-0000-4000-8000-000000000010',
        'fact', 'Old writer', 'Must fail closed',
        '10000000-0000-4000-8000-000000000010', 'manual', ARRAY['not-in-vocabulary']
      )
    `)).rejects.toMatchObject({ code: '23514' });

    await expect(pool.query(`
      INSERT INTO memories (
        id, scope_id, type, title, body, author_id, source, tags
      ) VALUES (
        '30000000-0000-4000-8000-000000000011',
        '20000000-0000-4000-8000-000000000010',
        'fact', 'Old writer', 'Known tags still work',
        '10000000-0000-4000-8000-000000000010', 'manual', ARRAY['deploy']
      )
    `)).resolves.toMatchObject({ rowCount: 1 });

    await expect(pool.query(`
      INSERT INTO memories (
        id, scope_id, type, title, body, author_id, source, tags
      ) VALUES (
        '30000000-0000-4000-8000-000000000012',
        '20000000-0000-4000-8000-000000000010',
        'fact', 'Old writer', 'Duplicate canonical tags fail closed',
        '10000000-0000-4000-8000-000000000010', 'manual', ARRAY['deploy', 'deploy']
      )
    `)).rejects.toMatchObject({ code: '23514' });
  });

  it('uses a no-key update lock for description-only changes', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        scope_kind: 'project', tag: 'deploy', description: 'Before', created_by: null,
        is_system: true, created_at: new Date(0), updated_at: new Date(0),
      }] })
      .mockResolvedValueOnce({ rows: [{
        scope_kind: 'project', tag: 'deploy', description: 'After', created_by: null,
        is_system: true, created_at: new Date(0), updated_at: new Date(1),
      }] });

    await updateTagVocabulary({ query } as never, 'project', 'deploy', 'After');

    expect(query.mock.calls[0][0]).toContain('FOR NO KEY UPDATE');
    expect(query.mock.calls[0][0]).not.toContain('FOR UPDATE');
  });
});
