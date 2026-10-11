import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from './migrator.js';
import { reconcilePgvectorProviderGrants, requireCoordinationContractReady } from './provider-lifecycle.js';

const databaseUrl = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:continuum@localhost:5433/continuum';
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';

it('adds tag grants to live application and operator profiles without granting sync or reporting access', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const schema = `tag_roles_${suffix}`;
  const roles = ['app', 'operator', 'sync', 'report'].map((kind) => `tag_${kind}_${suffix}`);
  const [applicationRole, operatorRole, syncRole, reportingRole] = roles;
  const administrator = randomUUID();
  const syncPrincipal = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'continuum-tag-roles-'));
  const migrations = new URL('../../migrations/', import.meta.url);
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const owner = new pg.Pool({ connectionString: databaseUrl,
    options: `-c search_path=${schema},public -c statement_timeout=60000 -c lock_timeout=5000` });
  const createdRoles: string[] = [];
  const passwords = new Map<string, string>();
  const authenticatedPools: pg.Pool[] = [];
  try {
    await maintenance.query(`CREATE SCHEMA ${quote(schema)}`);
    for (const file of (await readdir(migrations)).sort()) {
      if (/^\d{4}_.+\.sql$/.test(file) && Number(file.slice(0, 4)) <= 82) {
        await copyFile(new URL(file, migrations), join(directory, file));
      }
    }
    await runMigrations(owner, directory);
    await owner.query(
      `INSERT INTO principals(id,external_id,kind,display_name)
       VALUES($1::uuid,$1::uuid::text,'user','Administrator'),($2::uuid,$2::uuid::text,'service','Sync')`,
      [administrator, syncPrincipal],
    );
    await owner.query(
      `INSERT INTO scope_memberships(principal_id,scope_id,role,source_kind,source_id,active)
       SELECT $1::uuid,id,'admin','manual','manual',TRUE FROM scopes WHERE kind='org' AND name=''`,
      [administrator],
    );
    for (const role of roles) {
      const password = randomUUID();
      await owner.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}'`);
      passwords.set(role, password);
      createdRoles.push(role);
    }
    async function grant(filename: string, variables: Record<string, string>) {
      let source = (await readFile(join(process.cwd(), 'scripts', filename), 'utf8'))
        .split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\')).join('\n');
      for (const [name, value] of Object.entries({ continuum_schema: schema, ...variables })) {
        source = source.replaceAll(':"' + name + '"', quote(value))
          .replaceAll(":'" + name + "'", "'" + value.replaceAll("'", "''") + "'");
      }
      const client = await owner.connect();
      let discard = false;
      try { await client.query(source); }
      catch (error) { try { await client.query('ROLLBACK'); } catch { discard = true; } throw error; }
      finally { client.release(discard); }
    }
    await grant('grant-application-role.sql', { continuum_app_role: applicationRole });
    await grant('grant-application-role.sql', { continuum_app_role: operatorRole });
    await grant('grant-operator-role.sql', { continuum_operator_role: operatorRole, continuum_principal_id: administrator });
    await grant('grant-sync-role.sql', { continuum_sync_role: syncRole, continuum_principal_id: syncPrincipal });
    await owner.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(reportingRole)};
      GRANT SELECT ON TABLE memories TO ${quote(reportingRole)}`);
    await owner.query('SELECT continuum_register_pgvector_reporting_profile($1::name,TRUE)', [reportingRole]);
    await owner.query('SELECT continuum_grant_application_vector_functions($1::name)', [reportingRole]);
    const profileIdentities = (await owner.query(
      `SELECT database_role_oid,profile_kind,provider_schema_oid FROM continuum_pgvector_role_profiles ORDER BY database_role_oid`,
    )).rows;

    await copyFile(new URL('0083_tag_vocabularies.sql', migrations), join(directory, '0083_tag_vocabularies.sql'));
    expect((await runMigrations(owner, directory)).map((entry) => entry.name)).toEqual(['0083_tag_vocabularies.sql']);
    expect((await owner.query(
      `SELECT database_role_oid,profile_kind,provider_schema_oid FROM continuum_pgvector_role_profiles ORDER BY database_role_oid`,
    )).rows).toEqual(profileIdentities);
    for (const role of [applicationRole, operatorRole]) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect((await owner.query('SELECT pg_catalog.has_table_privilege($1::name,$2::text,$3::text) AS allowed',
          [role, `${schema}.tag_vocabularies`, privilege])).rows).toEqual([{ allowed: true }]);
      }
    }
    for (const role of [syncRole, reportingRole]) {
      expect((await owner.query('SELECT pg_catalog.has_table_privilege($1::name,$2::text,\'SELECT\') AS allowed',
        [role, `${schema}.tag_vocabularies`])).rows).toEqual([{ allowed: false }]);
    }
    for (const role of roles) {
      expect((await owner.query('SELECT pg_catalog.has_table_privilege($1::name,$2::text,\'UPDATE\') AS allowed',
        [role, `${schema}.continuum_tag_write_policy`])).rows).toEqual([{ allowed: false }]);
    }
    await owner.query('SELECT continuum_assert_application_role_allowlist($1::name,FALSE)', [applicationRole]);
    await owner.query('SELECT continuum_assert_operator_role_allowlist($1::name)', [operatorRole]);
    await owner.query('SELECT continuum_assert_sync_role_allowlist($1::name,$2::uuid)', [syncRole, syncPrincipal]);
    await owner.query('SELECT continuum_assert_current_pgvector_profile()');
    for (const role of roles) {
      const url = new URL(databaseUrl);
      url.username = role; url.password = passwords.get(role)!;
      const connection = new pg.Pool({ connectionString: url.toString(), max: 1,
        options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=1000` });
      authenticatedPools.push(connection);
      expect((await connection.query('SELECT current_user AS role')).rows).toEqual([{ role }]);
      if (role === applicationRole || role === operatorRole) {
        await reconcilePgvectorProviderGrants(connection, { expectedSchema: schema });
        await requireCoordinationContractReady(connection, { expectedSchema: schema });
      } else {
        await connection.query('SELECT continuum_assert_current_pgvector_profile()');
        await expect(connection.query('SELECT tag FROM tag_vocabularies LIMIT 1'))
          .rejects.toMatchObject({ code: '42501' });
      }
    }
    // Reapplying the shipped scripts must preserve the same identities and
    // additive rights rather than reinstalling an older permission list.
    await grant('grant-application-role.sql', { continuum_app_role: applicationRole });
    await grant('grant-operator-role.sql', { continuum_operator_role: operatorRole, continuum_principal_id: administrator });
    await owner.query('SELECT continuum_assert_current_pgvector_profile()');
  } finally {
    await Promise.all(authenticatedPools.map((pool) => pool.end()));
    await owner.end();
    await maintenance.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    for (const role of createdRoles.reverse()) {
      await maintenance.query(`DROP OWNED BY ${quote(role)}; DROP ROLE ${quote(role)}`);
    }
    await maintenance.end();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
