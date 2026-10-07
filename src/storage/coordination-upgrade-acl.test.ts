import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg, { type PoolConfig } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrator.js';
import { makeTestPool } from './test-helpers.js';

const DATABASE_URL = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:***@localhost:5433/continuum';
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const pools: pg.Pool[] = [];
const directories: string[] = [];

async function grantScript(
  pool: pg.Pool, schema: string, filename: string, variables: Record<string, string>,
): Promise<void> {
  const source = await readFile(join(process.cwd(), 'scripts', filename), 'utf8');
  let sql = source.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n').replaceAll(':"continuum_schema"', quote(schema));
  for (const [name, value] of Object.entries(variables)) {
    sql = sql.replaceAll(':"' + name + '"', quote(value));
    sql = sql.replaceAll(":'" + name + "'", "'" + value.replaceAll("'", "''") + "'");
  }
  await pool.query(sql);
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('coordination operator ACL upgrade', () => {
  it('profiles and re-profiles an application role at schema 0064', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const schema = `coord_acl_0064_${suffix}`;
    const role = `coord_acl_0064_app_${suffix}`;
    const base = await makeTestPool();
    pools.push(base);
    const admin = new pg.Pool((base as unknown as { options: PoolConfig }).options);
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    await admin.query(`CREATE ROLE ${quote(role)} NOLOGIN`);
    const pool = new pg.Pool({
      ...(base as unknown as { options: PoolConfig }).options,
      max: 1, options: `-c search_path=${schema},public`,
    });
    pools.push(pool);
    const before = await mkdtemp(join(tmpdir(), 'continuum-0064-acl-'));
    directories.push(before);
    const source = new URL('../../migrations/', import.meta.url);
    const files = (await readdir(source)).filter((name) => name.endsWith('.sql')).sort();
    await Promise.all(files.filter((name) => name <= '0064_coordination_final_online_indexes.sql')
      .map((name) => copyFile(new URL(name, source), join(before, name))));
    try {
      await runMigrations(pool, before);
      await expect(grantScript(pool, schema, 'grant-application-role.sql', {
        continuum_app_role: role,
      })).resolves.toBeUndefined();
      await expect(grantScript(pool, schema, 'grant-application-role.sql', {
        continuum_app_role: role,
      })).resolves.toBeUndefined();
      expect((await pool.query(
        `SELECT
           has_function_privilege($1,
             format('%I.continuum_coordination_reserve_resource_creation(uuid)', $2::text),
             'EXECUTE') AS reserve_execute,
           to_regprocedure(format(
             '%I.continuum_coordination_privacy_state(uuid,uuid)', $2::text
           )) IS NULL AS privacy_not_installed`,
        [role, schema],
      )).rows).toEqual([{ reserve_execute: true, privacy_not_installed: true }]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      await admin.query(`DROP OWNED BY ${quote(role)}`);
      await admin.query(`DROP ROLE ${quote(role)}`);
    }
  }, 60_000);

  it('moves a master-era operator grant to supported v2 and denies the legacy entry point', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const schema = `coord_acl_upgrade_${suffix}`;
    const role = `coord_acl_operator_${suffix}`;
    const base = await makeTestPool();
    pools.push(base);
    const admin = new pg.Pool((base as unknown as { options: PoolConfig }).options);
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    await admin.query(`CREATE ROLE ${quote(role)} NOLOGIN`);
    await admin.query(`GRANT ${quote(role)} TO CURRENT_USER WITH ADMIN OPTION, SET FALSE, INHERIT FALSE`);
    const pool = new pg.Pool({
      ...(base as unknown as { options: PoolConfig }).options,
      max: 1, options: `-c search_path=${schema},public`,
    });
    pools.push(pool);
    const before = await mkdtemp(join(tmpdir(), 'continuum-master-acl-'));
    directories.push(before);
    const source = new URL('../../migrations/', import.meta.url);
    const files = (await readdir(source)).filter((name) => name.endsWith('.sql')).sort();
    await Promise.all(files.filter((name) => name <= '0053_offboarding_restore_contract.sql')
      .map((name) => copyFile(new URL(name, source), join(before, name))));
    try {
      await runMigrations(pool, before);
      const orgId = (await pool.query(
        `SELECT id FROM scopes WHERE kind = 'org' AND name = ''`,
      )).rows[0].id as string;
      const operatorId = (await pool.query(
        `INSERT INTO principals (id, external_id, kind, display_name)
         VALUES (gen_random_uuid(), $1, 'user', 'Upgrade operator') RETURNING id`,
        [`operator:${suffix}`],
      )).rows[0].id as string;
      await pool.query(
        `INSERT INTO scope_memberships (principal_id, scope_id, role)
         VALUES ($1, $2, 'admin')`, [operatorId, orgId],
      );
      await grantScript(pool, schema, 'grant-application-role.sql', { continuum_app_role: role });
      await pool.query(
        `SELECT continuum_register_trusted_database_identity($1::name, $2, TRUE, FALSE)`,
        [role, operatorId],
      );
      await pool.query(
        `GRANT EXECUTE ON FUNCTION ${quote(schema)}.continuum_operator_pseudonymize_scope(UUID, UUID, TEXT) TO ${quote(role)}`,
      );
      expect((await pool.query(
        `SELECT has_function_privilege($1,
          format('%I.continuum_operator_pseudonymize_scope(uuid,uuid,text)', $2::text), 'EXECUTE') AS allowed`,
        [role, schema],
      )).rows).toEqual([{ allowed: true }]);

      await runMigrations(pool, join(process.cwd(), 'migrations'));
      await grantScript(pool, schema, 'grant-application-role.sql', { continuum_app_role: role });
      await expect(grantScript(pool, schema, 'grant-operator-role.sql', {
        continuum_operator_role: role, continuum_principal_id: operatorId,
      })).resolves.toBeUndefined();

      expect((await pool.query(
        `SELECT
          has_function_privilege($1, format('%I.continuum_operator_pseudonymize_scope_v2(uuid,uuid,text)', $2::text), 'EXECUTE') AS supported,
          has_function_privilege($1, format('%I.continuum_operator_pseudonymize_scope_v2_legacy(uuid,uuid,text)', $2::text), 'EXECUTE') AS legacy`,
        [role, schema],
      )).rows).toEqual([{ supported: true, legacy: false }]);
      const userScopeId = (await pool.query(
        `INSERT INTO scopes (id, kind, name) VALUES (gen_random_uuid(), 'user', $1) RETURNING id`,
        [`upgrade-user-${suffix}`],
      )).rows[0].id as string;
      const rolePool = new pg.Pool({
        ...(pool as unknown as { options: PoolConfig }).options,
        max: 1, options: `-c search_path=${schema},public -c role=${role}`,
      });
      pools.push(rolePool);
      await expect(rolePool.query(
        'SELECT continuum_operator_pseudonymize_scope_v2($1, $2, $3)',
        [operatorId, userScopeId, `erased-${suffix}`],
      )).resolves.toBeDefined();
      await expect(rolePool.query(
        'SELECT continuum_operator_pseudonymize_scope_v2_legacy($1, $2, $3)',
        [operatorId, userScopeId, `legacy-${suffix}`],
      )).rejects.toThrow(/permission denied/i);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      await admin.query(`DROP OWNED BY ${quote(role)}`);
      await admin.query(`REVOKE ${quote(role)} FROM CURRENT_USER CASCADE`);
      await admin.query(`DROP ROLE ${quote(role)}`);
    }
  }, 60_000);
});
