import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from './migrator.js';

const DATABASE_URL =
  process.env.CONTINUUM_TEST_DATABASE_URL ??
  'postgres://continuum:continuum@localhost:5433/continuum';

const pools: pg.Pool[] = [];
const directories: string[] = [];

async function migrationDirectory(sql: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-migrator-'));
  directories.push(directory);
  await writeFile(join(directory, '001_test.sql'), sql);
  return directory;
}

function schemaPool(schema: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    max: 1,
    options: `-c search_path=${schema}`,
  });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('runMigrations', () => {
  it('ships the embedding key swap as concurrent attachable DDL and seeds failed audits only', async () => {
    const keySwap = await readFile(
      join(process.cwd(), 'migrations/0010_provider_embeddings_backfill.sql'),
      'utf8',
    );
    expect(keySwap.trimStart()).toMatch(/^-- continuum:no-transaction/);
    expect(keySwap).toMatch(/CREATE UNIQUE INDEX CONCURRENTLY/i);
    expect(keySwap).toMatch(/PRIMARY KEY\s+USING INDEX/i);
    expect(keySwap).toMatch(/BEGIN;[\s\S]*DROP CONSTRAINT[\s\S]*ADD CONSTRAINT[\s\S]*COMMIT;/i);

    const failureSeed = await readFile(
      join(process.cwd(), 'migrations/0011_embedding_backfill_failures.sql'),
      'utf8',
    );
    expect(failureSeed).toMatch(/metadata->>'embedded'\s*=\s*'false'/i);
    expect(failureSeed).toMatch(/metadata->>'embedding_error_code'\s*=\s*'EMBEDDING_FAILED'/i);
    expect(failureSeed).toMatch(/CREATE INDEX CONCURRENTLY/i);
    expect(failureSeed).toMatch(/disposition/i);
    expect(failureSeed).toMatch(/reason/i);
  });

  it('bounds advisory-lock acquisition', async () => {
    const release = vi.fn();
    const client = {
      query: vi.fn(async (query: string) => {
        if (query.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release,
    };
    const directory = await migrationDirectory('SELECT 42;');

    await expect(runMigrations(
      { connect: vi.fn(async () => client) } as unknown as pg.Pool,
      directory,
      { advisoryLockTimeoutMs: 20, lockTimeoutMs: 50 },
    )).rejects.toThrow(/migration advisory lock.*20 ms/i);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_try_advisory_lock'),
      expect.any(Array),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('ships decision constraints after ingestion with nonblocking validation and indexing', async () => {
    const migrations = (await readdir(join(process.cwd(), 'migrations')))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    expect(migrations).toContain('0007_decision_supersession_constraints.sql');
    expect(migrations).toContain('0008_decision_supersession_validation.sql');
    expect(migrations).toContain('0009_decision_supersession_unique_index.sql');
    expect(migrations.filter((file) => file.startsWith('0005_'))).toEqual([
      '0005_webhook_ingestion.sql',
    ]);

    const constraints = await readFile(
      join(process.cwd(), 'migrations/0007_decision_supersession_constraints.sql'),
      'utf8',
    );
    expect(constraints).toMatch(/ADD CONSTRAINT memories_supersedes_not_self[\s\S]+NOT VALID/i);
    expect(constraints).not.toMatch(/VALIDATE CONSTRAINT memories_supersedes_not_self/i);
    expect(constraints).not.toMatch(/CREATE\s+UNIQUE\s+INDEX/i);

    const validation = await readFile(
      join(process.cwd(), 'migrations/0008_decision_supersession_validation.sql'),
      'utf8',
    );
    expect(validation).toMatch(/VALIDATE CONSTRAINT memories_supersedes_not_self/i);
    expect(validation).not.toMatch(/ADD CONSTRAINT/i);
    expect(validation).not.toMatch(/CREATE\s+UNIQUE\s+INDEX/i);

    const uniqueIndex = await readFile(
      join(process.cwd(), 'migrations/0009_decision_supersession_unique_index.sql'),
      'utf8',
    );
    expect(uniqueIndex.trimStart()).toMatch(/^-- continuum:no-transaction/);
    expect(uniqueIndex).toMatch(/CREATE UNIQUE INDEX CONCURRENTLY memories_supersedes_unique_idx/i);
  });

  it('deduplicates provider rows before restoring the rollback memory key', async () => {
    const schema = `migrator_embedding_rollback_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const rollbackSql = await readFile(
      new URL('../../scripts/rollback-embedding-provider-key.sql', import.meta.url),
      'utf8',
    );
    const directory = await migrationDirectory(rollbackSql);
    const memoryId = '22222222-2222-4222-8222-222222222222';
    try {
      await pool.query(`
        CREATE TABLE memory_embeddings (
          memory_id UUID NOT NULL,
          provider TEXT NOT NULL,
          dim INT NOT NULL,
          embedded_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (memory_id, provider, dim)
        );
        INSERT INTO memory_embeddings VALUES
          ('${memoryId}', 'older', 2, '2026-01-01T00:00:00Z'),
          ('${memoryId}', 'newer', 2, '2026-01-02T00:00:00Z');
      `);

      await expect(runMigrations(pool, directory)).resolves.toHaveLength(1);
      expect((await pool.query(
        'SELECT provider FROM memory_embeddings WHERE memory_id = $1', [memoryId],
      )).rows).toEqual([{ provider: 'newer' }]);
      await expect(pool.query(
        `INSERT INTO memory_embeddings VALUES ($1, 'duplicate', 3, clock_timestamp())`,
        [memoryId],
      )).rejects.toMatchObject({ code: '23505' });
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('runs marked concurrent-index migrations outside a transaction', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (query: string) => {
        queries.push(query.trim());
        if (query.includes('SELECT 1 FROM _continuum_migrations')) {
          return { rowCount: 0, rows: [] };
        }
        if (query.includes('pg_advisory_unlock')) {
          return { rowCount: 1, rows: [{ unlocked: true }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const directory = await migrationDirectory(
      '-- continuum:no-transaction\nDROP INDEX CONCURRENTLY IF EXISTS test_idx;\nCREATE INDEX CONCURRENTLY test_idx ON test_table (id);',
    );

    await runMigrations({ connect: vi.fn(async () => client) } as unknown as pg.Pool, directory);

    expect(queries).not.toContain('BEGIN');
    expect(queries).not.toContain('COMMIT');
    expect(queries).not.toContain('ROLLBACK');
    const index = queries.findIndex((query) => query.includes('CREATE INDEX CONCURRENTLY'));
    const drop = queries.findIndex((query) => query.includes('DROP INDEX CONCURRENTLY'));
    const ledger = queries.findIndex((query) => query.includes('INSERT INTO _continuum_migrations'));
    expect(drop).toBeGreaterThan(-1);
    expect(index).toBeGreaterThan(drop);
    expect(ledger).toBeGreaterThan(index);
  });

  it('repairs the provider scan index when the original 0010 was already recorded', async () => {
    const schema = `migrator_embedding_scan_repair_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const directory = await mkdtemp(join(tmpdir(), 'continuum-migrator-upgrade-'));
    directories.push(directory);
    const originalMigration = '0010_provider_embeddings_backfill.sql';
    const repairMigration = '0013_embedding_provider_scan_index.sql';
    const repairSql = await readFile(
      new URL(`../../migrations/${repairMigration}`, import.meta.url),
      'utf8',
    );
    await writeFile(join(directory, originalMigration), 'SELECT 1;');
    await writeFile(join(directory, repairMigration), repairSql);

    try {
      await pool.query(`
        CREATE TABLE memory_embeddings (
          memory_id UUID NOT NULL,
          provider TEXT NOT NULL,
          dim INT NOT NULL,
          PRIMARY KEY (memory_id, provider, dim)
        );
        CREATE TABLE _continuum_migrations (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        INSERT INTO _continuum_migrations (name) VALUES ('${originalMigration}');
      `);

      const applied = await runMigrations(pool, directory);
      expect(applied.map(({ name }) => name)).toEqual([repairMigration]);
      const indexes = await pool.query<{ indexname: string; indexdef: string }>(`
        SELECT indexname, indexdef
          FROM pg_indexes
         WHERE schemaname = current_schema()
           AND tablename = 'memory_embeddings'
           AND indexname = 'memory_embeddings_provider_dim_memory_idx'
      `);
      expect(indexes.rows).toHaveLength(1);
      expect(indexes.rows[0].indexdef).toMatch(/\(provider, dim, memory_id\)$/i);
      await expect(runMigrations(pool, directory)).resolves.toHaveLength(0);

      // Simulate a crash after the retry-safe DDL but before its ledger write.
      await pool.query('DELETE FROM _continuum_migrations WHERE name = $1', [repairMigration]);
      await expect(runMigrations(pool, directory)).resolves.toHaveLength(1);
      expect((await pool.query(`
        SELECT count(*)::int AS count
          FROM pg_indexes
         WHERE schemaname = current_schema()
           AND indexname = 'memory_embeddings_provider_dim_memory_idx'
      `)).rows[0].count).toBe(1);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('uses one dedicated client and locks before inspecting the ledger', async () => {
    const queries: string[] = [];
    const release = vi.fn();
    const client = {
      query: vi.fn(async (query: string) => {
        queries.push(query.trim());
        if (query.includes('SELECT 1 FROM _continuum_migrations')) {
          return { rowCount: 0, rows: [] };
        }
        if (query.includes('pg_advisory_unlock')) {
          return { rowCount: 1, rows: [{ unlocked: true }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release,
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(() => {
        throw new Error('pool.query must not be used during migrations');
      }),
    };
    const directory = await migrationDirectory('SELECT 42;');

    const applied = await runMigrations(pool as unknown as pg.Pool, directory);

    expect(applied).toHaveLength(1);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(queries[0]).toContain('pg_advisory_lock');
    expect(queries[1]).toContain('CREATE TABLE IF NOT EXISTS _continuum_migrations');
    expect(queries.at(-1)).toContain('pg_advisory_unlock');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the client when lock acquisition fails', async () => {
    const release = vi.fn();
    const client = {
      query: vi.fn(async () => {
        throw new Error('lock unavailable');
      }),
      release,
    };
    const pool = { connect: vi.fn(async () => client) };
    const directory = await migrationDirectory('SELECT 42;');

    await expect(
      runMigrations(pool as unknown as pg.Pool, directory),
    ).rejects.toThrow('lock unavailable');
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('preserves migration and unlock errors while still releasing the client', async () => {
    const release = vi.fn();
    const client = {
      query: vi.fn(async (query: string) => {
        if (query.includes('SELECT 1 FROM _continuum_migrations')) {
          return { rowCount: 0, rows: [] };
        }
        if (query === 'SELECT 42;') throw new Error('migration exploded');
        if (query.includes('pg_advisory_unlock')) {
          throw new Error('unlock exploded');
        }
        return { rowCount: 1, rows: [] };
      }),
      release,
    };
    const pool = { connect: vi.fn(async () => client) };
    const directory = await migrationDirectory('SELECT 42;');

    const error = await runMigrations(
      pool as unknown as pg.Pool,
      directory,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as AggregateError).errors[0]).toMatchObject({
      message: 'Migration 001_test.sql failed: migration exploded',
    });
    expect((error as AggregateError).errors[1]).toMatchObject({
      message: 'unlock exploded',
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });

  it('serializes concurrent runners so a migration executes exactly once', async () => {
    const schema = `migrator_concurrent_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const firstPool = schemaPool(schema);
    const secondPool = schemaPool(schema);
    const directory = await migrationDirectory(`
      SELECT pg_sleep(0.25);
      CREATE TABLE migration_effects (id integer PRIMARY KEY);
      INSERT INTO migration_effects (id) VALUES (1);
    `);

    try {
      const results = await Promise.all([
        runMigrations(firstPool, directory),
        runMigrations(secondPool, directory),
      ]);

      expect(results.map((result) => result.length).sort()).toEqual([0, 1]);
      const effect = await admin.query(
        `SELECT count(*)::int AS count FROM ${schema}.migration_effects`,
      );
      expect(effect.rows[0].count).toBe(1);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('releases the lock after failure so another runner can retry', async () => {
    const schema = `migrator_retry_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const failingPool = schemaPool(schema);
    const retryPool = schemaPool(schema);
    const directory = await migrationDirectory(
      "DO $$ BEGIN RAISE EXCEPTION 'expected failure'; END $$;",
    );

    try {
      await expect(runMigrations(failingPool, directory)).rejects.toThrow(
        'Migration 001_test.sql failed: expected failure',
      );

      await writeFile(
        join(directory, '001_test.sql'),
        'CREATE TABLE retry_succeeded (id integer PRIMARY KEY);',
      );
      await retryPool.query('SET statement_timeout = 2000');

      await expect(runMigrations(retryPool, directory)).resolves.toHaveLength(1);
      const ledger = await admin.query(
        `SELECT name FROM ${schema}._continuum_migrations`,
      );
      expect(ledger.rows).toEqual([{ name: '001_test.sql' }]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('migrates valid historical poison audits into durable backfill state', async () => {
    const schema = `migrator_backfill_failures_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const migrationSql = await readFile(
      new URL('../../migrations/0011_embedding_backfill_failures.sql', import.meta.url),
      'utf8',
    );
    const directory = await migrationDirectory(migrationSql);
    const memoryId = '11111111-1111-4111-8111-111111111111';

    try {
      await pool.query(`
        CREATE TABLE memories (id UUID PRIMARY KEY);
        CREATE TABLE audit_log (
          at TIMESTAMPTZ NOT NULL,
          action TEXT NOT NULL,
          memory_id UUID,
          metadata JSONB
        );
        INSERT INTO memories (id) VALUES ('${memoryId}');
        INSERT INTO audit_log (at, action, memory_id, metadata) VALUES
          ('2026-01-02T00:00:00Z', 'write', '${memoryId}',
           '{"operation":"embedding_backfill","provider":"ollama:model","dim":768,"embedded":false,"embedding_error_code":"EMBEDDING_FAILED"}'),
          ('2026-01-01T00:00:00Z', 'write', '${memoryId}',
           '{"operation":"embedding_backfill","provider":"ollama:model","dim":768,"embedded":false,"embedding_error_code":"EMBEDDING_FAILED"}'),
          ('2026-01-01T00:00:00Z', 'write', '${memoryId}',
           '{"operation":"embedding_backfill","provider":"ollama:model","dim":"invalid","embedded":false,"embedding_error_code":"EMBEDDING_FAILED"}'),
          ('2025-12-31T00:00:00Z', 'write', '${memoryId}',
           '{"operation":"embedding_backfill","provider":"successful:model","dim":768,"embedded":true}'),
          ('2026-01-01T00:00:00Z', 'read', '${memoryId}',
           '{"operation":"embedding_backfill","provider":"ignored","dim":768,"embedded":false,"embedding_error_code":"EMBEDDING_FAILED"}');
      `);

      await expect(runMigrations(pool, directory)).resolves.toHaveLength(1);
      await expect(runMigrations(pool, directory)).resolves.toHaveLength(0);
      const failures = await pool.query(
        `SELECT memory_id, provider, dim, failed_at
           FROM embedding_backfill_failures`,
      );
      expect(failures.rows).toEqual([{
        memory_id: memoryId,
        provider: 'ollama:model',
        dim: 768,
        failed_at: new Date('2026-01-01T00:00:00Z'),
      }]);

      await pool.query('DELETE FROM memories WHERE id = $1', [memoryId]);
      expect((await pool.query(
        'SELECT count(*)::int AS count FROM embedding_backfill_failures',
      )).rows[0].count).toBe(0);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });
});
