import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
  it('requires explicit operator re-registration while revoking legacy sync authority', async () => {
    const state = await fixture('0047_offboarding_role_boundary.sql');
    const operatorRole = 'upgrade_operator_' + state.suffix;
    const syncRole = 'upgrade_sync_' + state.suffix;
    await createRole(state.admin, operatorRole);
    await createRole(state.admin, syncRole);
    await state.admin.query('ALTER ROLE ' + quoteIdentifier(syncRole) + ' LOGIN');
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
    await expect(runMigrations(state.pool, state.directory))
      .rejects.toThrow(/operator.*provenance|re-register/i);
    expect((await state.pool.query(
      'SELECT count(*)::int AS count FROM continuum_trusted_database_identities',
    )).rows[0].count).toBe(2);
    await state.pool.query(
      'DELETE FROM continuum_trusted_database_identities WHERE can_approve AND NOT can_sync',
    );
    await expect(runMigrations(state.pool, state.directory)).resolves.toEqual([
      expect.objectContaining({ name: '0048_offboarding_independent_review.sql' }),
    ]);
    expect((await state.pool.query(
      'SELECT database_role::text, can_approve, can_sync, database_role_oid IS NOT NULL AS oid_bound FROM continuum_trusted_database_identities ORDER BY database_role',
    )).rows).toEqual([]);
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
    expect((await state.admin.query(
      'SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [syncRole],
    )).rows[0].rolcanlogin).toBe(false);
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

  it('rejects a surviving operator name whose role was dropped and recreated', async () => {
    const state = await fixture('0047_offboarding_role_boundary.sql');
    const operatorRole = 'upgrade_recreated_operator_' + state.suffix;
    await createRole(state.admin, operatorRole);
    await state.pool.query(
      'SELECT continuum_register_trusted_database_identity($1, $2, TRUE, FALSE)',
      [operatorRole, state.operatorPrincipal.id],
    );
    await state.admin.query('DROP ROLE ' + quoteIdentifier(operatorRole));
    roles.splice(roles.indexOf(operatorRole), 1);
    await createRole(state.admin, operatorRole);
    await addMigration(state.directory, '0048_offboarding_independent_review.sql');
    await expect(runMigrations(state.pool, state.directory))
      .rejects.toThrow(/operator.*re-register|provenance|role OID/i);
  }, 60_000);

  it('requires explicit post-0049 registration for an already-recorded 0048 operator', async () => {
    const state = await fixture('0047_offboarding_role_boundary.sql');
    await addMigration(state.directory, '0048_offboarding_independent_review.sql');
    await runMigrations(state.pool, state.directory);
    const operatorRole = 'upgrade_existing_0048_operator_' + state.suffix;
    await createRole(state.admin, operatorRole);
    await state.pool.query(
      'SELECT continuum_register_trusted_database_identity($1, $2, TRUE, FALSE)',
      [operatorRole, state.operatorPrincipal.id],
    );
    await addMigration(state.directory, '0049_offboarding_review_remediation.sql');
    await expect(runMigrations(state.pool, state.directory))
      .rejects.toThrow(/0049.*operator.*provenance|re-register/i);
    await state.pool.query(
      'DELETE FROM continuum_trusted_database_identities WHERE can_approve AND NOT can_sync',
    );
    await expect(runMigrations(state.pool, state.directory)).resolves.toEqual([
      expect.objectContaining({ name: '0049_offboarding_review_remediation.sql' }),
    ]);
    await state.pool.query(
      'SELECT continuum_register_trusted_database_identity($1, $2, TRUE, FALSE)',
      [operatorRole, state.operatorPrincipal.id],
    );
    expect((await state.pool.query(
      `SELECT database_role::text, database_role_oid::oid AS oid
         FROM continuum_trusted_database_identities WHERE can_approve`,
    )).rows).toEqual([{
      database_role: operatorRole,
      oid: expect.any(Number),
    }]);
  }, 60_000);

  it('applies the forward remediation to an already-ledgered 0050 database', async () => {
    const state = await fixture('0050_offboarding_startup_verification_fix.sql');
    await state.pool.query('DROP TRIGGER guard_entra_org_admin_memberships ON scope_memberships');
    await state.pool.query(`
      CREATE OR REPLACE FUNCTION continuum_fail_closed_on_principal_disable()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$
    `);
    await state.pool.query(`
      CREATE OR REPLACE FUNCTION continuum_guard_entra_admin_sources()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$
    `);
    await state.pool.query('DROP INDEX continuum_trusted_database_identities_one_sync');
    await addMigration(state.directory, '0051_offboarding_security_contract.sql');

    await expect(runMigrations(state.pool, state.directory)).resolves.toEqual([
      expect.objectContaining({ name: '0051_offboarding_security_contract.sql' }),
    ]);
    expect((await state.pool.query(
      `SELECT count(*)::int AS count FROM pg_trigger
        WHERE tgrelid = 'scope_memberships'::regclass
          AND tgname = 'guard_entra_org_admin_memberships' AND NOT tgisinternal`,
    )).rows[0].count).toBe(1);
    expect((await state.pool.query(
      `SELECT count(*)::int AS count FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'continuum_trusted_database_identities_one_sync'`,
    )).rows[0].count).toBe(1);
    expect((await state.pool.query(
      `SELECT pg_get_functiondef(
         'continuum_fail_closed_on_principal_disable()'::regprocedure
       ) AS definition`,
    )).rows[0].definition).toMatch(/scope_memberships|guarded_mutations/i);
    expect((await state.pool.query(
      `SELECT pg_get_functiondef('continuum_guard_entra_admin_sources()'::regprocedure)
         AS definition`,
    )).rows[0].definition).toMatch(/source identity are immutable|trusted sync/i);
  }, 60_000);

  it('rejects an ambiguous organization identity while applying the 0052 forward repair', async () => {
    const state = await fixture('0051_offboarding_security_contract.sql');
    await state.pool.query(
      "INSERT INTO scopes (id, kind, name) VALUES (gen_random_uuid(), 'org', 'forged')",
    );
    await addMigration(state.directory, '0052_offboarding_review_repair.sql');
    await expect(runMigrations(state.pool, state.directory))
      .rejects.toThrow(/canonical|organization|singleton|exactly one/i);
    expect((await state.pool.query(
      `SELECT count(*)::int AS count FROM _continuum_migrations
        WHERE name = '0052_offboarding_review_repair.sql'`,
    )).rows[0].count).toBe(0);
  }, 60_000);

  it('forward-repairs drifted 0051 marker shapes and principal/Entra triggers', async () => {
    const state = await fixture('0051_offboarding_security_contract.sql');
    await state.pool.query('DROP TRIGGER protect_last_manual_org_admin_principal ON principals');
    await state.pool.query('DROP TRIGGER guard_entra_binding_approvals ON entra_groups');
    await state.pool.query(`
      DO $drop$
      DECLARE item RECORD;
      BEGIN
        FOR item IN
          SELECT relation.relname, constraint_row.conname
            FROM pg_constraint constraint_row
            JOIN pg_class relation ON relation.oid = constraint_row.conrelid
           WHERE constraint_row.conrelid IN (
             'continuum_entra_guarded_mutations'::regclass,
             'continuum_principal_disable_requests'::regclass)
        LOOP
          EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', item.relname, item.conname);
        END LOOP;
      END
      $drop$;
      ALTER TABLE continuum_entra_guarded_mutations
        ALTER COLUMN authorization_principal_id DROP NOT NULL;
      ALTER TABLE continuum_principal_disable_requests
        ALTER COLUMN authorization_principal_id DROP NOT NULL;
      ALTER TABLE continuum_entra_guarded_mutations
        ADD COLUMN edited_0051_extra TEXT NOT NULL DEFAULT 'legacy';
      ALTER TABLE continuum_principal_disable_requests
        ADD COLUMN edited_0051_extra TEXT NOT NULL DEFAULT 'legacy';
    `);
    await addMigration(state.directory, '0052_offboarding_review_repair.sql');
    await expect(runMigrations(state.pool, state.directory)).resolves.toEqual([
      expect.objectContaining({ name: '0052_offboarding_review_repair.sql' }),
    ]);
    expect((await state.pool.query(`
      SELECT count(*)::int AS count FROM pg_trigger
       WHERE NOT tgisinternal AND (
         (tgrelid = 'principals'::regclass
          AND tgname = 'protect_last_manual_org_admin_principal')
         OR (tgrelid = 'entra_groups'::regclass
          AND tgname = 'guard_entra_binding_approvals'))
    `)).rows[0].count).toBe(2);
    expect((await state.pool.query(`
      SELECT count(*)::int AS count FROM pg_attribute
       WHERE attrelid IN ('continuum_entra_guarded_mutations'::regclass,
                          'continuum_principal_disable_requests'::regclass)
         AND attname = 'authorization_principal_id' AND attnotnull
    `)).rows[0].count).toBe(2);
    expect((await state.pool.query(`
      SELECT count(*)::int AS count FROM pg_constraint
       WHERE conrelid IN ('continuum_entra_guarded_mutations'::regclass,
                          'continuum_principal_disable_requests'::regclass)
    `)).rows[0].count).toBeGreaterThanOrEqual(6);
    expect((await state.pool.query(`
      SELECT count(*)::int AS count FROM pg_attribute
       WHERE attrelid IN ('continuum_entra_guarded_mutations'::regclass,
                          'continuum_principal_disable_requests'::regclass)
         AND attname = 'edited_0051_extra' AND NOT attisdropped
    `)).rows[0].count).toBe(0);
  }, 60_000);

  it('documents and checks migration-owner capabilities before 0051 changes', async () => {
    const migration = await readFile(
      new URL('../../migrations/0051_offboarding_security_contract.sql', import.meta.url), 'utf8',
    );
    expect(migration).toMatch(/preflight/i);
    expect(migration).toMatch(/schema.*owner|owns.*schema/i);
    expect(migration).toMatch(/CREATEROLE|admin_option|ALTER ROLE/i);
    expect(migration.indexOf('preflight')).toBeLessThan(migration.indexOf('CREATE OR REPLACE'));
  });

  it('accepts database-owner inheritance of the PostgreSQL 16 public-schema owner role', async () => {
    const state = await fixture('0050_offboarding_startup_verification_fix.sql');
    const syncRole = 'upgrade_database_owner_sync_' + state.suffix;
    await createRole(state.admin, syncRole);
    await state.pool.query(
      'SELECT continuum_register_trusted_database_identity($1, $2, FALSE, TRUE)',
      [syncRole, state.service.id],
    );
    await state.admin.query(
      `ALTER SCHEMA ${quoteIdentifier(state.schema)} OWNER TO pg_database_owner`,
    );
    await addMigration(state.directory, '0051_offboarding_security_contract.sql');
    await expect(runMigrations(state.pool, state.directory)).resolves.toEqual([
      expect.objectContaining({ name: '0051_offboarding_security_contract.sql' }),
    ]);
    expect((await state.pool.query(
      `SELECT pg_has_role(current_user, nspowner, 'USAGE') AS effective_owner
         FROM pg_namespace WHERE nspname = current_schema()`,
    )).rows[0].effective_owner).toBe(true);
    expect((await state.admin.query(
      'SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [syncRole],
    )).rows[0].rolcanlogin).toBe(false);
  }, 60_000);

  it('does not let an inherited schema-owner role false-pass migration authority', async () => {
    const migration = await readFile(
      new URL('../../migrations/0051_offboarding_security_contract.sql', import.meta.url), 'utf8',
    );
    expect(migration).toMatch(/current_user::regrole::oid[\s\S]*rolsuper[\s\S]*rolcreaterole/i);
    expect(migration).toMatch(/membership\.member\s*=\s*migration_role_oid/i);
    expect(migration).not.toMatch(/SELECT rolsuper, rolcreaterole INTO[\s\S]{0,100}WHERE oid = owner_oid/i);
  });

  it('supports a non-superuser schema owner with scoped CREATEROLE and ADMIN OPTION', async () => {
    const state = await fixture('0050_offboarding_startup_verification_fix.sql');
    const ownerRole = 'upgrade_owner_' + state.suffix;
    const syncRole = 'upgrade_owner_sync_' + state.suffix;
    await createRole(state.admin, syncRole);
    await createRole(state.admin, ownerRole);
    await state.admin.query('ALTER ROLE ' + quoteIdentifier(ownerRole) + ' CREATEROLE');
    await state.pool.query(
      'SELECT continuum_register_trusted_database_identity($1, $2, FALSE, TRUE)',
      [syncRole, state.service.id],
    );
    await state.admin.query(
      'GRANT ' + quoteIdentifier(syncRole) + ' TO ' + quoteIdentifier(ownerRole)
      + ' WITH ADMIN OPTION',
    );
    await state.admin.query('GRANT ' + quoteIdentifier(ownerRole) + ' TO CURRENT_USER');

    const relations = (await state.admin.query<{ name: string; kind: string }>(
      `SELECT relation.relname AS name, relation.relkind AS kind
         FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $1
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')`,
      [state.schema],
    )).rows;
    for (const relation of relations) {
      const objectType = relation.kind === 'v' ? 'VIEW'
          : relation.kind === 'm' ? 'MATERIALIZED VIEW' : 'TABLE';
      await state.admin.query(
        `ALTER ${objectType} ${quoteIdentifier(state.schema)}.${quoteIdentifier(relation.name)} OWNER TO ${quoteIdentifier(ownerRole)}`,
      );
    }
    const functions = (await state.admin.query<{ name: string; arguments: string }>(
      `SELECT function.proname AS name,
              pg_get_function_identity_arguments(function.oid) AS arguments
         FROM pg_proc function JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
        WHERE namespace.nspname = $1`, [state.schema],
    )).rows;
    for (const fn of functions) {
      await state.admin.query(
        `ALTER FUNCTION ${quoteIdentifier(state.schema)}.${quoteIdentifier(fn.name)}(${fn.arguments}) OWNER TO ${quoteIdentifier(ownerRole)}`,
      );
    }
    await state.admin.query(
      `ALTER SCHEMA ${quoteIdentifier(state.schema)} OWNER TO ${quoteIdentifier(ownerRole)}`,
    );
    const ownerPool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 1,
      options: `-c role=${ownerRole} -c search_path=${state.schema},public`,
    });
    pools.push(ownerPool);
    await addMigration(state.directory, '0051_offboarding_security_contract.sql');
    await expect(runMigrations(ownerPool, state.directory)).resolves.toEqual([
      expect.objectContaining({ name: '0051_offboarding_security_contract.sql' }),
    ]);
    expect((await ownerPool.query(
      'SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user',
    )).rows[0]).toEqual({ rolsuper: false, rolcreaterole: true });
    await addMigration(state.directory, '0052_offboarding_review_repair.sql');
    await expect(runMigrations(ownerPool, state.directory)).resolves.toEqual([
      expect.objectContaining({ name: '0052_offboarding_review_repair.sql' }),
    ]);
    await state.admin.query(
      'REVOKE ' + quoteIdentifier(syncRole) + ' FROM ' + quoteIdentifier(ownerRole),
    );
    await expect(ownerPool.query(
      'SELECT continuum_verify_sync_retirement_authority_configuration()',
    )).rejects.toThrow(/CREATEROLE|ADMIN OPTION|retirement/i);
  }, 60_000);

  it('fails owner preflight before creating any 0051 capability object', async () => {
    const state = await fixture('0050_offboarding_startup_verification_fix.sql');
    const foreignOwner = 'upgrade_foreign_owner_' + state.suffix;
    await createRole(state.admin, foreignOwner);
    await state.admin.query(
      `ALTER TABLE ${quoteIdentifier(state.schema)}.audit_log OWNER TO ${quoteIdentifier(foreignOwner)}`,
    );
    try {
      await addMigration(state.directory, '0051_offboarding_security_contract.sql');
      await expect(runMigrations(state.pool, state.directory))
        .rejects.toThrow(/migration owner must own every application/i);
      expect((await state.pool.query(
        `SELECT to_regclass(format('%I.continuum_principal_disable_requests', current_schema()))
                  IS NULL AS absent,
                to_regprocedure(format(
                  '%I.continuum_disable_principal(uuid,uuid)', current_schema()
                )) IS NULL
                  AS function_absent`,
      )).rows[0]).toEqual({ absent: true, function_absent: true });
      expect((await state.pool.query(
        `SELECT count(*)::int AS count FROM _continuum_migrations
          WHERE name = '0051_offboarding_security_contract.sql'`,
      )).rows[0].count).toBe(0);
    } finally {
      await state.admin.query(
        `ALTER TABLE ${quoteIdentifier(state.schema)}.audit_log OWNER TO CURRENT_USER`,
      );
    }
  }, 60_000);
});
