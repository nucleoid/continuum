import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
    options: `-c search_path=${schema},public`,
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
  it('seeds Entra freshness from durable successful-sync evidence, never migration time', async () => {
    const schema = `migrator_entra_freshness_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const migration = await readFile(
      join(process.cwd(), 'migrations/0014_entra_sync_freshness.sql'),
      'utf8',
    );
    const directory = await migrationDirectory(migration);
    try {
      await pool.query(
        `CREATE TABLE scope_memberships (
           source_kind TEXT NOT NULL, active BOOLEAN NOT NULL, synced_at TIMESTAMPTZ
         );
         CREATE TABLE audit_log (
           at TIMESTAMPTZ NOT NULL, metadata JSONB
         );
         INSERT INTO scope_memberships (source_kind, active, synced_at)
         VALUES ('entra', TRUE, now());
         INSERT INTO audit_log (at, metadata)
         VALUES (now() - interval '72 hours', '{"operation":"entra_membership_sync"}')`,
      );

      await runMigrations(pool, directory);

      expect((await pool.query(
        `SELECT last_success_at = (
           SELECT max(at) FROM audit_log
            WHERE metadata->>'operation' = 'entra_membership_sync'
         ) AS derived,
         now() >= last_success_at + max_staleness AS stale
         FROM entra_sync_state WHERE singleton`,
      )).rows).toEqual([{ derived: true, stale: true }]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('ships decision constraints after ingestion with nonblocking validation and indexing', async () => {
    const migrations = (await readdir(join(process.cwd(), 'migrations')))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    expect(migrations).toContain('0007_decision_supersession_constraints.sql');
    expect(migrations).toContain('0008_decision_supersession_validation.sql');
    expect(migrations).toContain('0009_decision_supersession_unique_index.sql');
    expect(migrations.filter((file) => file.startsWith('0005_'))).toEqual([
      '0005_entra_auth.sql',
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

  it('deactivates pre-approval Entra memberships during the approval migration', async () => {
    const schema = `migrator_entra_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const directory = await mkdtemp(join(tmpdir(), 'continuum-entra-migrations-'));
    directories.push(directory);
    const source = new URL('../../migrations/', import.meta.url);
    const files = (await readdir(source)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files.filter((name) => name <= '0005_entra_auth.sql')) {
      await copyFile(new URL(file, source), join(directory, file));
    }

    try {
      await runMigrations(pool, directory);
      const scope = (await pool.query("SELECT id FROM scopes WHERE kind = 'org' AND name = ''")).rows[0].id;
      const principal = (await pool.query(
        "INSERT INTO principals (id, external_id, kind, display_name) VALUES (gen_random_uuid(), 'legacy-user', 'user', 'Legacy') RETURNING id",
      )).rows[0].id;
      const groupId = '22222222-2222-4222-8222-222222222222';
      await pool.query(
        "INSERT INTO entra_groups (external_id, display_name, scope_id, role) VALUES ($1, 'continuum-org-admin', $2, 'admin')",
        [groupId, scope],
      );
      await pool.query(
        "INSERT INTO scope_memberships (principal_id, scope_id, role, source_kind, source_id) VALUES ($1, $2, 'admin', 'entra', $3)",
        [principal, scope, groupId],
      );
      for (const file of files.filter((name) => name > '0005_entra_auth.sql')) {
        await copyFile(new URL(file, source), join(directory, file));
      }
      await runMigrations(pool, directory);
      expect((await pool.query(
        "SELECT active, deactivated_at IS NOT NULL AS deactivated FROM scope_memberships WHERE source_kind = 'entra'",
      )).rows).toEqual([{ active: false, deactivated: true }]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('repairs orphaned active memberships before installing binding guards', async () => {
    const schema = `migrator_binding_guard_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const directory = await mkdtemp(join(tmpdir(), 'continuum-binding-migrations-'));
    directories.push(directory);
    const source = new URL('../../migrations/', import.meta.url);
    const files = (await readdir(source)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files.filter((name) => name <= '0009_lock_entra_binding_invariant.sql')) {
      await copyFile(new URL(file, source), join(directory, file));
    }

    try {
      await runMigrations(pool, directory);
      const scope = (await pool.query(
        "INSERT INTO scopes (id, kind, name) VALUES (gen_random_uuid(), 'team', 'repair') RETURNING id",
      )).rows[0].id;
      const approver = (await pool.query(
        "INSERT INTO principals (id, external_id, kind, display_name) VALUES (gen_random_uuid(), 'approver', 'user', 'Approver') RETURNING id",
      )).rows[0].id;
      const member = (await pool.query(
        "INSERT INTO principals (id, external_id, kind, display_name) VALUES (gen_random_uuid(), 'member', 'user', 'Member') RETURNING id",
      )).rows[0].id;
      const groupId = '22222222-2222-4222-8222-222222222222';
      await pool.query(
        `INSERT INTO entra_groups
           (external_id, display_name, scope_id, role, active, approved_by, approved_at)
         VALUES ($1, 'repair', $2, 'reader', TRUE, $3, now())`,
        [groupId, scope, approver],
      );
      await pool.query(
        `INSERT INTO scope_memberships
           (principal_id, scope_id, role, source_kind, source_id, active)
         VALUES ($1, $2, 'reader', 'entra', $3, TRUE)`,
        [member, scope, groupId],
      );
      await pool.query(
        'UPDATE entra_groups SET active = FALSE, deactivated_at = now() WHERE external_id = $1',
        [groupId],
      );

      for (const file of files.filter((name) => name > '0009_lock_entra_binding_invariant.sql')) {
        await copyFile(new URL(file, source), join(directory, file));
      }
      await runMigrations(pool, directory);

      expect((await pool.query(
        `SELECT active, deactivated_at IS NOT NULL AS deactivated
           FROM scope_memberships WHERE source_kind = 'entra'`,
      )).rows).toEqual([{ active: false, deactivated: true }]);
      await pool.query(
        `UPDATE entra_groups
            SET active = TRUE, deactivated_at = NULL,
                quarantined_at = NULL, quarantine_reason = NULL
          WHERE external_id = $1`,
        [groupId],
      );
      await pool.query(
        `UPDATE scope_memberships SET active = TRUE, deactivated_at = NULL
          WHERE source_kind = 'entra' AND source_id = $1`,
        [groupId],
      );
      await expect(pool.query(
        "UPDATE entra_groups SET role = 'writer' WHERE external_id = $1", [groupId],
      )).rejects.toThrow(/active Entra memberships must match an approved binding/);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('canonicalizes legacy Entra IDs and fail-closed consolidates case collisions', async () => {
    const schema = `migrator_entra_case_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const directory = await mkdtemp(join(tmpdir(), 'continuum-entra-case-migrations-'));
    directories.push(directory);
    const source = new URL('../../migrations/', import.meta.url);
    const files = (await readdir(source)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files.filter((name) => name <= '0010_harden_entra_binding_invariants.sql')) {
      await copyFile(new URL(file, source), join(directory, file));
    }

    try {
      await runMigrations(pool, directory);
      const scope = (await pool.query(
        "INSERT INTO scopes (id, kind, name) VALUES (gen_random_uuid(), 'team', 'case') RETURNING id",
      )).rows[0].id;
      const approver = (await pool.query(
        "INSERT INTO principals (id, external_id, kind, display_name) VALUES (gen_random_uuid(), 'approver', 'user', 'Approver') RETURNING id",
      )).rows[0].id;
      const member = (await pool.query(
        "INSERT INTO principals (id, external_id, kind, display_name) VALUES (gen_random_uuid(), 'member', 'user', 'Member') RETURNING id",
      )).rows[0].id;
      const collision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const ordinary = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      for (const id of [collision, collision.toUpperCase(), ordinary.toUpperCase()]) {
        await pool.query(
          `INSERT INTO entra_groups
             (external_id, display_name, scope_id, role, active, approved_by, approved_at)
           VALUES ($1, $1, $2, 'reader', TRUE, $3, now())`,
          [id, scope, approver],
        );
        await pool.query(
          `INSERT INTO scope_memberships
             (principal_id, scope_id, role, source_kind, source_id, active)
           VALUES ($1, $2, 'reader', 'entra', $3, TRUE)`,
          [member, scope, id],
        );
      }

      for (const file of files.filter((name) => name > '0010_harden_entra_binding_invariants.sql')) {
        await copyFile(new URL(file, source), join(directory, file));
      }
      await runMigrations(pool, directory);

      expect((await pool.query(
        `SELECT external_id, active, quarantine_reason FROM entra_groups ORDER BY external_id`,
      )).rows).toEqual([
        { external_id: collision, active: false, quarantine_reason: 'LEGACY_INACTIVE_REVIEW' },
        { external_id: ordinary, active: true, quarantine_reason: null },
      ]);
      expect((await pool.query(
        `SELECT source_id, active FROM scope_memberships
          WHERE source_kind = 'entra' ORDER BY source_id`,
      )).rows).toEqual([
        { source_id: collision, active: false },
        { source_id: ordinary, active: true },
      ]);
      await expect(pool.query(
        `INSERT INTO entra_groups
           (external_id, display_name, scope_id, role, active, approved_by, approved_at)
         VALUES ($1, 'upper', $2, 'reader', TRUE, $3, now())`,
        ['CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC', scope, approver],
      )).rejects.toThrow();
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('canonicalizes UUID-shaped principal identities and enforces the invariant', async () => {
    const schema = `migrator_principal_case_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const migration = await readFile(
      join(process.cwd(), 'migrations/0013_canonicalize_principal_external_ids.sql'),
      'utf8',
    );
    const directory = await migrationDirectory(migration);
    const lower = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    try {
      await pool.query(
        `CREATE TABLE principals (
           id UUID PRIMARY KEY, external_id TEXT UNIQUE, kind TEXT, display_name TEXT
         )`,
      );
      await pool.query(
        `INSERT INTO principals (id, external_id, kind, display_name) VALUES
         (gen_random_uuid(), $1, 'user', 'UUID'),
         (gen_random_uuid(), 'Service:Opaque', 'service', 'Opaque')`,
        [lower.toUpperCase()],
      );

      await runMigrations(pool, directory);

      expect((await pool.query('SELECT external_id FROM principals ORDER BY external_id')).rows)
        .toEqual([{ external_id: lower }, { external_id: 'Service:Opaque' }]);
      await expect(pool.query(
        `INSERT INTO principals (id, external_id, kind, display_name)
         VALUES (gen_random_uuid(), 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB', 'user', 'Invalid')`,
      )).rejects.toThrow();
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('preflights principal UUID case collisions without changing rows', async () => {
    const schema = `migrator_principal_collision_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const migration = await readFile(
      join(process.cwd(), 'migrations/0013_canonicalize_principal_external_ids.sql'),
      'utf8',
    );
    const directory = await migrationDirectory(migration);
    const lower = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    try {
      await pool.query(
        `CREATE TABLE principals (
           id UUID PRIMARY KEY, external_id TEXT UNIQUE, kind TEXT, display_name TEXT
         )`,
      );
      await pool.query(
        `INSERT INTO principals (id, external_id, kind, display_name) VALUES
         (gen_random_uuid(), $1, 'user', 'Lower'),
         (gen_random_uuid(), $2, 'user', 'Upper')`,
        [lower, lower.toUpperCase()],
      );

      await expect(runMigrations(pool, directory))
        .rejects.toThrow(/collide after lowercase canonicalization/);
      expect((await pool.query('SELECT external_id FROM principals ORDER BY external_id')).rows)
        .toEqual([{ external_id: lower }, { external_id: lower.toUpperCase() }]);
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

  it('destroys the client when lock acquisition fails', async () => {
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
    expect(release).toHaveBeenCalledWith(expect.any(Error));
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
});
