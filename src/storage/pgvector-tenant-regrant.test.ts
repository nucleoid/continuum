import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrator.js';
import { createPrincipal } from './principals.js';
import { getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';

const databaseUrl = process.env.CONTINUUM_TEST_DATABASE_URL ?? 'postgres://continuum:continuum@localhost:5433/continuum';
const name = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const q = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function grants(pool: pg.Pool, schema: string, role: string, actorId?: string) {
  const filename = actorId ? 'grant-operator-role.sql' : 'grant-application-role.sql';
  let source = (await readFile(join(process.cwd(), 'scripts', filename), 'utf8')).split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('\\')).join('\n')
    .replaceAll(':"continuum_schema"', q(schema));
  for (const [key, value] of Object.entries(actorId
    ? { continuum_operator_role: role, continuum_principal_id: actorId }
    : { continuum_app_role: role })) {
    source = source.replaceAll(`:"${key}"`, q(value)).replaceAll(`:'${key}'`, literal(value));
  }
  await pool.query(source);
}

async function isolated(run: (context: {
  admin: pg.Pool; tenant(schema: string): Promise<pg.Pool>; role(): Promise<string>; through79(): Promise<string>;
}) => Promise<void>) {
  const root = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const database = name('provider_regrant');
  const pools: pg.Pool[] = [];
  const roles: string[] = [];
  const directories: string[] = [];
  await root.query(`CREATE DATABASE ${q(database)}`);
  const url = new URL(databaseUrl); url.pathname = `/${database}`;
  const admin = new pg.Pool({ connectionString: url.toString(), max: 1 }); pools.push(admin);
  try {
    await run({ admin,
      async tenant(schema) {
        await admin.query(`CREATE SCHEMA ${q(schema)}`);
        const pool = new pg.Pool({ connectionString: url.toString(), max: 1, options: `-c search_path=${schema}` });
        pools.push(pool); return pool;
      },
      async role() {
        const role = name('provider_role'); roles.push(role);
        await root.query(`CREATE ROLE ${q(role)} NOLOGIN`); return role;
      },
      async through79() {
        const directory = await mkdtemp(join(tmpdir(), 'provider-before80-')); directories.push(directory);
        for (const file of (await readdir(join(process.cwd(), 'migrations')))
          .filter((file) => file.endsWith('.sql') && file <= '0079_coordination_upgrade_scale_remediation.sql')) {
          await copyFile(join(process.cwd(), 'migrations', file), join(directory, file));
        }
        return directory;
      },
    });
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    await root.query(`DROP DATABASE ${q(database)} WITH (FORCE)`);
    for (const role of roles) await root.query(`DROP ROLE ${q(role)}`);
    await root.end();
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  }
}

async function providerAccess(pool: pg.Pool, role: string) {
  return (await pool.query(`SELECT has_schema_privilege($1,'continuum_extensions','USAGE') AS usage,
    bool_and(has_function_privilege($1,function.oid,'EXECUTE')) AS execute
    FROM pg_proc function JOIN pg_depend dependency ON dependency.classid='pg_proc'::regclass
      AND dependency.objid=function.oid AND dependency.refclassid='pg_extension'::regclass AND dependency.deptype='e'
    JOIN pg_extension extension ON extension.oid=dependency.refobjid WHERE extension.extname='vector'`, [role])).rows[0];
}

describe('pgvector tenant-scoped explicit regrant', () => {
  it('does not evict a different registered role awaiting the new coordination helper grant', async () => {
    await isolated(async ({ admin, tenant, role }) => {
      const schema = name('tenant'); const pool = await tenant(schema);
      await runMigrations(pool);
      const first = await role(); const pending = await role();
      await grants(pool, schema, first); await grants(pool, schema, pending);
      await pool.query(`REVOKE EXECUTE ON FUNCTION continuum_coordination_lock_principal_usage(UUID) FROM ${q(pending)}`);
      expect(await providerAccess(admin, pending)).toEqual({ usage: true, execute: true });
      await grants(pool, schema, first);
      expect(await providerAccess(admin, pending)).toEqual({ usage: true, execute: true });
      expect((await pool.query(`SELECT profile_kind FROM continuum_pgvector_role_profiles
        WHERE database_role_oid=(SELECT oid FROM pg_roles WHERE rolname=$1)`, [pending])).rows)
        .toEqual([{ profile_kind: 'application' }]);
    });
  }, 180_000);

  it('restores provider access when an existing operator profile is regranted after ACL drift', async () => {
    await isolated(async ({ admin, tenant, role }) => {
      const schema = name('tenant'); const pool = await tenant(schema);
      await runMigrations(pool);
      const operator = await role();
      const actor = await createPrincipal(pool, { externalId: name('actor'), kind: 'user', displayName: 'Operator' });
      const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
      await addMembership(pool, actor.id, org.id, 'admin');
      await grants(pool, schema, operator); await grants(pool, schema, operator, actor.id);
      await admin.query(`REVOKE USAGE ON SCHEMA continuum_extensions FROM ${q(operator)}`);
      await admin.query(`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA continuum_extensions FROM ${q(operator)}`);
      await grants(pool, schema, operator, actor.id);
      await expect(pool.query('SELECT continuum_assert_application_vector_profile($1::name)', [operator])).resolves.toBeDefined();
      expect(await providerAccess(admin, operator)).toEqual({ usage: true, execute: true });
    });
  }, 180_000);

  it('does not revoke another tenant application access when a local reporting registration is disabled', async () => {
    await isolated(async ({ admin, tenant, role }) => {
      const firstSchema = name('tenant_a'); const first = await tenant(firstSchema); await runMigrations(first);
      const secondSchema = name('tenant_b'); const second = await tenant(secondSchema); await runMigrations(second);
      const shared = await role();
      await grants(second, secondSchema, shared);
      await first.query(`GRANT USAGE ON SCHEMA ${q(firstSchema)} TO ${q(shared)}`);
      await first.query(`GRANT SELECT ON memories TO ${q(shared)}`);
      await first.query('SELECT continuum_register_pgvector_reporting_profile($1::name,TRUE)', [shared]);
      expect(await providerAccess(admin, shared)).toEqual({ usage: true, execute: true });
      await first.query('SELECT continuum_register_pgvector_reporting_profile($1::name,FALSE)', [shared]);
      expect(await providerAccess(admin, shared)).toEqual({ usage: true, execute: true });
      await expect(second.query('SELECT continuum_assert_application_vector_profile($1::name)', [shared])).resolves.toBeDefined();
    });
  }, 240_000);

  it.each([
    ['halfvec', 'CREATE TABLE outside.half_inputs(value continuum_extensions.halfvec(3))'],
    ['sparsevec', 'CREATE TABLE outside.sparse_inputs(value continuum_extensions.sparsevec(3))'],
    ['domain', 'CREATE DOMAIN outside.embedding AS continuum_extensions.vector'],
    ['function', `CREATE FUNCTION outside.embedding_dimensions(value continuum_extensions.vector) RETURNS INTEGER
      LANGUAGE sql BEGIN ATOMIC SELECT continuum_extensions.vector_dims(value); END`],
  ])('preserves existing provider PUBLIC grants used by an outside %s dependency', async (_kind, sql) => {
    await isolated(async ({ admin, tenant }) => {
      await admin.query('CREATE SCHEMA continuum_extensions');
      await admin.query('CREATE EXTENSION vector WITH SCHEMA continuum_extensions');
      await admin.query('GRANT USAGE ON SCHEMA continuum_extensions TO PUBLIC');
      await admin.query('CREATE SCHEMA outside'); await admin.query(sql);
      expect(await providerAccess(admin, 'public')).toEqual({ usage: true, execute: true });
      const pool = await tenant(name('tenant')); await runMigrations(pool);
      expect(await providerAccess(admin, 'public')).toEqual({ usage: true, execute: true });
    });
  }, 180_000);

  it('keeps legacy helper delegation working when the current script profiles a pre80 schema', async () => {
    await isolated(async ({ admin, tenant, role, through79 }) => {
      const schema = name('tenant'); const pool = await tenant(schema);
      await admin.query(`CREATE EXTENSION vector WITH SCHEMA ${q(schema)}`);
      await runMigrations(pool, await through79());
      const app = await role(); await grants(pool, schema, app);
      expect((await admin.query(`SELECT has_schema_privilege($1,$2,'USAGE') AS usage,
        has_function_privilege($1,$3,'EXECUTE') AS execute`,
      [app, schema, `${q(schema)}.vector_dims(${q(schema)}.vector)`])).rows)
        .toEqual([{ usage: true, execute: true }]);
    });
  }, 180_000);
});
