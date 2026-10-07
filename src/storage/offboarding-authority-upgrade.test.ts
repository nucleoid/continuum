import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runMigrations } from './migrator.js';

const DATABASE_URL = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:continuum@localhost:5433/continuum';
const quoteIdentifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const pools: pg.Pool[] = [];
const directories: string[] = [];
const roles: string[] = [];

async function stagedDirectory(lastMigration: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-authority-upgrade-'));
  directories.push(directory);
  const source = new URL('../../migrations/', import.meta.url);
  const files = (await readdir(source)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files.filter((file) => file <= lastMigration)) {
    await copyFile(new URL(file, source), join(directory, file));
  }
  return directory;
}

async function addMigration(directory: string, migration: string): Promise<void> {
  await copyFile(new URL('../../migrations/' + migration, import.meta.url), join(directory, migration));
}

async function fixture(lastMigration: string) {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const schema = 'authority_upgrade_' + suffix;
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  pools.push(admin);
  await admin.query('CREATE SCHEMA ' + quoteIdentifier(schema));
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    max: 1,
    options: `-c search_path=${schema},public`,
  });
  pools.push(pool);
  const directory = await stagedDirectory(lastMigration);
  await runMigrations(pool, directory);
  const org = (await pool.query("SELECT id FROM scopes WHERE kind = 'org' AND name = ''")).rows[0];
  const operatorPrincipal = (await pool.query(
    "INSERT INTO principals (id, external_id, kind, display_name) VALUES (gen_random_uuid(), $1, 'user', 'Operator') RETURNING id",
    ['upgrade-operator-' + suffix],
  )).rows[0];
  await pool.query(
    "INSERT INTO scope_memberships (principal_id, scope_id, role, source_kind, source_id, active) VALUES ($1, $2, 'admin', 'manual', 'manual', TRUE)",
    [operatorPrincipal.id, org.id],
  );
  const service = (await pool.query(
    "INSERT INTO principals (id, external_id, kind, display_name) VALUES (gen_random_uuid(), $1, 'service', 'Sync') RETURNING id",
    ['upgrade-sync-' + suffix],
  )).rows[0];
  return { admin, pool, directory, schema, suffix, operatorPrincipal, service };
}

async function createRole(admin: pg.Pool, name: string): Promise<void> {
  roles.push(name);
  await admin.query('CREATE ROLE ' + quoteIdentifier(name) + ' NOLOGIN');
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
  const cleanup = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    for (const role of roles.splice(0).reverse()) {
      await cleanup.query('DROP OWNED BY ' + quoteIdentifier(role));
      await cleanup.query('DROP ROLE IF EXISTS ' + quoteIdentifier(role));
    }
    const schemas = (await cleanup.query<{ schema_name: string }>(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'authority_upgrade_%'",
    )).rows;
    for (const { schema_name } of schemas) {
      await cleanup.query('DROP SCHEMA ' + quoteIdentifier(schema_name) + ' CASCADE');
    }
  } finally { await cleanup.end(); }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('0048 trusted database identity upgrade', () => {
  it('preserves operators while deleting and fully revoking the single legacy sync-only identity', async () => {
    const state = await fixture('0047_offboarding_role_boundary.sql');
    const operatorRole = 'upgrade_operator_' + state.suffix;
    const syncRole = 'upgrade_sync_' + state.suffix;
    await createRole(state.admin, operatorRole);
    await createRole(state.admin, syncRole);
    await state.pool.query('SELECT continuum_register_trusted_database_identity($1, $2, TRUE, FALSE)',
      [operatorRole, state.operatorPrincipal.id]);
    await state.pool.query('SELECT continuum_register_trusted_database_identity($1, $2, FALSE, TRUE)',
      [syncRole, state.service.id]);
    await state.pool.query('GRANT ALL ON ALL TABLES IN SCHEMA ' + quoteIdentifier(state.schema)
      + ' TO ' + quoteIdentifier(syncRole));
    await state.pool.query('GRANT ALL ON ALL SEQUENCES IN SCHEMA ' + quoteIdentifier(state.schema)
      + ' TO ' + quoteIdentifier(syncRole));
    await state.pool.query('GRANT CREATE ON SCHEMA ' + quoteIdentifier(state.schema)
      + ' TO ' + quoteIdentifier(syncRole));

    await addMigration(state.directory, '0048_offboarding_independent_review.sql');
    await expect(runMigrations(state.pool, state.directory)).resolves.toEqual([
      expect.objectContaining({ name: '0048_offboarding_independent_review.sql' }),
    ]);
    expect((await state.pool.query(
      'SELECT database_role::text, can_approve, can_sync, database_role_oid IS NOT NULL AS oid_bound FROM continuum_trusted_database_identities ORDER BY database_role',
    )).rows).toEqual([{
      database_role: operatorRole, can_approve: true, can_sync: false, oid_bound: true,
    }]);
    expect((await state.pool.query(
      `SELECT has_schema_privilege($1, current_schema(), 'USAGE') AS schema_usage,
              has_schema_privilege($1, current_schema(), 'CREATE') AS schema_create,
              has_table_privilege($1, 'memories', 'SELECT') AS memory_read,
              has_table_privilege($1, 'entra_groups', 'UPDATE') AS group_update,
              has_sequence_privilege($1, 'audit_log_id_seq', 'USAGE') AS sequence_usage`,
      [syncRole],
    )).rows[0]).toEqual({
      schema_usage: false, schema_create: false, memory_read: false,
      group_update: false, sequence_usage: false,
    });
  }, 60_000);

  it('fails rather than silently rewriting mixed or multiple legacy sync authorities', async () => {
    for (const mode of ['mixed', 'multiple'] as const) {
      const state = await fixture('0046_offboarding_authority_remediation.sql');
      const firstRole = `upgrade_${mode}_first_${state.suffix}`;
      await createRole(state.admin, firstRole);
      await state.pool.query(
        'SELECT continuum_register_trusted_database_identity($1, $2, $3, TRUE)',
        [firstRole, mode === 'mixed' ? state.operatorPrincipal.id : state.service.id, mode === 'mixed'],
      );
      if (mode === 'multiple') {
        const secondRole = `upgrade_${mode}_second_${state.suffix}`;
        await createRole(state.admin, secondRole);
        await state.pool.query(
          'SELECT continuum_register_trusted_database_identity($1, $2, FALSE, TRUE)',
          [secondRole, state.service.id],
        );
      }
      await addMigration(state.directory, '0047_offboarding_role_boundary.sql');
      await runMigrations(state.pool, state.directory);
      await addMigration(state.directory, '0048_offboarding_independent_review.sql');
      await expect(runMigrations(state.pool, state.directory))
        .rejects.toThrow(/mixed|multiple|unsafe|sync authorities/i);
      expect((await state.pool.query(
        'SELECT count(*)::int AS count FROM continuum_trusted_database_identities WHERE can_sync',
      )).rows[0].count).toBe(mode === 'mixed' ? 1 : 2);
    }
  }, 120_000);
});
