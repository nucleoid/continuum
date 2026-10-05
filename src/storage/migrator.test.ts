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
           '{"operation":"embedding_backfill","provider":"ollama:model","dim":768}'),
          ('2026-01-01T00:00:00Z', 'write', '${memoryId}',
           '{"operation":"embedding_backfill","provider":"ollama:model","dim":768}'),
          ('2026-01-01T00:00:00Z', 'write', '${memoryId}',
           '{"operation":"embedding_backfill","provider":"ollama:model","dim":"invalid"}'),
          ('2026-01-01T00:00:00Z', 'read', '${memoryId}',
           '{"operation":"embedding_backfill","provider":"ignored","dim":768}');
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
