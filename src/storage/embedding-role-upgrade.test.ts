import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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
const execFileAsync = promisify(execFile);
const compiledCli = fileURLToPath(new URL('../../dist/maintenance/embed-backfill-cli.js', import.meta.url));

it('adds embedding state grants to live application and operator profiles without granting sync or reporting access', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const schema = `embedding_roles_${suffix}`;
  const roles = ['app', 'operator', 'sync', 'report'].map((kind) => `embedding_${kind}_${suffix}`);
  const [applicationRole, operatorRole, syncRole, reportingRole] = roles;
  const administrator = randomUUID();
  const syncPrincipal = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'continuum-embedding-roles-'));
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
      if (/^\d{4}_.+\.sql$/.test(file) && Number(file.slice(0, 4)) <= 83) {
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

    const additions = (await readdir(migrations)).filter((file) => /^008[4-8]_.*\.sql$/.test(file)).sort();
    for (const file of additions) await copyFile(new URL(file, migrations), join(directory, file));
    expect((await runMigrations(owner, directory)).map((entry) => entry.name)).toEqual(additions);
    expect(additions).toHaveLength(5);
    expect((await owner.query(
      `SELECT database_role_oid,profile_kind,provider_schema_oid FROM continuum_pgvector_role_profiles ORDER BY database_role_oid`,
    )).rows).toEqual(profileIdentities);
    for (const role of [applicationRole, operatorRole]) {
      for (const table of ['embedding_backfill_checkpoints', 'embedding_backfill_failures']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          expect((await owner.query('SELECT pg_catalog.has_table_privilege($1::name,$2::text,$3::text) AS allowed',
            [role, `${schema}.${table}`, privilege])).rows).toEqual([{ allowed: true }]);
        }
      }
    }
    for (const role of [syncRole, reportingRole]) {
      for (const table of ['embedding_backfill_checkpoints', 'embedding_backfill_failures']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          expect((await owner.query('SELECT pg_catalog.has_table_privilege($1::name,$2::text,$3::text) AS allowed',
            [role, `${schema}.${table}`, privilege])).rows).toEqual([{ allowed: false }]);
        }
      }
    }
    for (const role of roles) {
      expect((await owner.query('SELECT pg_catalog.has_table_privilege($1::name,$2::text,\'UPDATE\') AS allowed',
        [role, `${schema}.continuum_tag_write_policy`])).rows).toEqual([{ allowed: false }]);
    }
    await owner.query('SELECT continuum_assert_application_role_allowlist($1::name,FALSE)', [applicationRole]);
    await owner.query('SELECT continuum_assert_operator_role_allowlist($1::name)', [operatorRole]);
    await owner.query('SELECT continuum_assert_sync_role_allowlist($1::name,$2::uuid)', [syncRole, syncPrincipal]);
    await owner.query('SELECT continuum_assert_current_pgvector_profile()');
    const failureMemory = randomUUID();
    await owner.query(`INSERT INTO memories(id,scope_id,author_id,type,title,body,source)
      SELECT $1::uuid,id,$2::uuid,'fact','Failure reference','Small body','manual'
      FROM scopes WHERE kind='org' AND name=''`, [failureMemory, administrator]);
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
        await connection.query(`INSERT INTO embedding_backfill_checkpoints(provider,dim,scope_filter,cursor)
          VALUES($1::text,768,'*',NULL)`, [role]);
        await connection.query('UPDATE embedding_backfill_checkpoints SET updated_at=pg_catalog.clock_timestamp() WHERE provider=$1::text', [role]);
        expect((await connection.query('SELECT provider FROM embedding_backfill_checkpoints WHERE provider=$1::text', [role])).rows)
          .toEqual([{ provider: role }]);
        await connection.query('DELETE FROM embedding_backfill_checkpoints WHERE provider=$1::text', [role]);
        await connection.query(`INSERT INTO embedding_backfill_failures(memory_id,provider,dim)
          VALUES($1::uuid,$2::text,768)`, [failureMemory, role]);
        await connection.query(`UPDATE embedding_backfill_failures SET reason='EMBEDDING_REQUEST_FAILED'
          WHERE memory_id=$1::uuid AND provider=$2::text`, [failureMemory, role]);
        expect((await connection.query(`SELECT disposition,reason FROM embedding_backfill_failures
          WHERE memory_id=$1::uuid AND provider=$2::text`, [failureMemory, role])).rows)
          .toEqual([{ disposition: 'durable', reason: 'EMBEDDING_REQUEST_FAILED' }]);
        await connection.query('DELETE FROM embedding_backfill_failures WHERE memory_id=$1::uuid AND provider=$2::text',
          [failureMemory, role]);
      } else {
        await connection.query('SELECT continuum_assert_current_pgvector_profile()');
        for (const table of ['embedding_backfill_checkpoints', 'embedding_backfill_failures']) {
          await expect(connection.query(`SELECT * FROM ${table} LIMIT 1`))
            .rejects.toMatchObject({ code: '42501' });
        }
      }
    }
    async function runCompiledCli(role: string, expectedSchema = schema) {
      const url = new URL(databaseUrl);
      url.username = role; url.password = passwords.get(role)!;
      url.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=1000`);
      const env = { ...process.env, PGOPTIONS: '', CONTINUUM_DATABASE_URL: url.toString(),
        CONTINUUM_APPLICATION_SCHEMA: expectedSchema, CONTINUUM_DB_POOL_MAX: '1',
        CONTINUUM_DB_CONNECTION_TIMEOUT_MS: '1000', CONTINUUM_EMBEDDING_PROVIDER: 'ollama',
        CONTINUUM_EMBEDDING_DIM: '768', CONTINUUM_EMBEDDING_MODEL: 'test-count',
        CONTINUUM_EMBEDDING_TIMEOUT_MS: '1000', CONTINUUM_OLLAMA_URL: 'http://127.0.0.1:9' };
      delete (env as NodeJS.ProcessEnv).CONTINUUM_EMBEDDING_CONFIG;
      return execFileAsync(process.execPath, [compiledCli, '--count', '--max-rows', '1'], {
        env, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      }).then((result) => ({ code: 0, ...result }),
        (error: unknown) => error as { code: number; stdout: string; stderr: string });
    }
    for (const role of [applicationRole, operatorRole]) {
      const result = await runCompiledCli(role);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ countOnly: true, providers: 1, completed: true });
      expect(result.stderr).toBe('');
    }
    const wrongSchema = await runCompiledCli(applicationRole, 'public');
    expect(wrongSchema.code).toBe(1);
    expect(wrongSchema.stdout).toBe('');
    expect(wrongSchema.stderr).toMatch(/Runtime application schema is not trusted/);
    await owner.query(`GRANT SELECT ON continuum_tag_write_policy TO ${quote(applicationRole)}`);
    try {
      const drifted = await runCompiledCli(applicationRole);
      expect(drifted.code).toBe(1);
      expect(drifted.stdout).toBe('');
      expect(drifted.stderr).toMatch(/^continuum-embed-backfill:/);
      expect(drifted.stderr).toMatch(/exact.*profile|profile.*drift/i);
      expect((await owner.query('SELECT pg_catalog.has_table_privilege($1::name,$2::text,\'SELECT\') AS allowed',
        [applicationRole, `${schema}.continuum_tag_write_policy`])).rows).toEqual([{ allowed: true }]);
    } finally {
      await owner.query(`REVOKE SELECT ON continuum_tag_write_policy FROM ${quote(applicationRole)}`);
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
