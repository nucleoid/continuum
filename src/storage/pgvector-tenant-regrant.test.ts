import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrator.js';
import { reconcilePgvectorProviderGrants } from './provider-lifecycle.js';
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
    .replaceAll(':"continuum_schema"', q(schema))
    .replaceAll(":'continuum_schema'", literal(schema));
  for (const [key, value] of Object.entries(actorId
    ? { continuum_operator_role: role, continuum_principal_id: actorId }
    : { continuum_app_role: role })) {
    source = source.replaceAll(`:"${key}"`, q(value)).replaceAll(`:'${key}'`, literal(value));
  }
  const client = await pool.connect();
  try {
    await client.query(source);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function isolated(run: (context: {
  admin: pg.Pool; tenant(schema: string): Promise<pg.Pool>; role(): Promise<string>; through79(): Promise<string>;
}) => Promise<void>) {
  const root = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const database = name('provider_regrant');
  const pools: pg.Pool[] = [];
  const clientClosures: Promise<void>[] = [];
  const track = (pool: pg.Pool) => {
    pool.on('connect', (client) => {
      clientClosures.push(new Promise<void>((resolve) => client.once('end', () => resolve())));
    });
    pools.push(pool);
    return pool;
  };
  const roles: string[] = [];
  const directories: string[] = [];
  await root.query(`CREATE DATABASE ${q(database)}`);
  const url = new URL(databaseUrl); url.pathname = `/${database}`;
  const admin = track(new pg.Pool({ connectionString: url.toString(), max: 1 }));
  try {
    await run({ admin,
      async tenant(schema) {
        await admin.query(`CREATE SCHEMA IF NOT EXISTS ${q(schema)}`);
        const pool = new pg.Pool({ connectionString: url.toString(), max: 1, options: `-c search_path=${schema}` });
        return track(pool);
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
    // pg-pool ending is distinct from the underlying client's end event.
    // Wait for the fixture's actual sockets before removing its database;
    // FORCE could terminate an ending idle client and emit uncaught 57P01.
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(clientClosures), new Promise<never>((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error('Fixture database clients did not close within 5 seconds')), 5_000);
      })]);
    } finally { if (closeTimer) clearTimeout(closeTimer); }
    await root.query("SET statement_timeout='1s'");
    const drainDeadline = Date.now() + 5_000;
    for (;;) {
      const sessions = (await root.query<{ sessions: number }>(
        'SELECT count(*)::int AS sessions FROM pg_catalog.pg_stat_activity WHERE datname=$1', [database],
      )).rows[0].sessions;
      if (sessions === 0) break;
      if (Date.now() >= drainDeadline) throw new Error(`Fixture database still has ${sessions} sessions after client shutdown`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await root.query("SET statement_timeout='5s'");
    await root.query(`DROP DATABASE ${q(database)}`);
    for (const role of roles) await root.query(`DROP ROLE IF EXISTS ${q(role)}`);
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
  it.each([
    ['application', true], ['application', false],
    ['operator', true], ['operator', false], ['sync', true], ['sync', false],
  ] as const)('preserves %s identity when reporting registration enabled=%s', async (kind, enabled) => {
    await isolated(async ({ admin, tenant, role }) => {
      const schema = name('tenant_kind'); const owner = await tenant(schema); await runMigrations(owner);
      const target = await role();
      if (kind === 'sync') {
        await admin.query(`ALTER ROLE ${q(target)} LOGIN`);
        const actor = await createPrincipal(owner, { externalId: name('sync_kind'), kind: 'service', displayName: 'Sync' });
        await owner.query('SELECT continuum_register_trusted_database_identity($1::name,$2::uuid,FALSE,TRUE)', [target, actor.id]);
      } else {
        await grants(owner, schema, target);
        if (kind === 'operator') {
          const actor = await createPrincipal(owner, { externalId: name('operator_kind'), kind: 'user', displayName: 'Operator' });
          const org = (await getScopeByRef(owner, { kind: 'org', name: '' }))!;
          await addMembership(owner, actor.id, org.id, 'admin');
          await grants(owner, schema, target, actor.id);
        }
      }
      const before = (await owner.query(`SELECT profile_kind, provider_schema_oid, refreshed_at
        FROM continuum_pgvector_role_profiles WHERE database_role_oid=$1::regrole::oid`, [target])).rows;
      {
        await expect(owner.query('SELECT continuum_register_pgvector_reporting_profile($1::name,$2)', [target, enabled]))
          .rejects.toThrow(/role is already registered with a non-reporting profile/i);
        expect((await owner.query(`SELECT profile_kind,provider_schema_oid,refreshed_at
          FROM continuum_pgvector_role_profiles WHERE database_role_oid=$1::regrole::oid`, [target])).rows).toEqual(before);
        expect((await owner.query(`SELECT has_function_privilege($1,
          'continuum_assert_current_pgvector_profile()','EXECUTE') AS gate`, [target])).rows).toEqual([{ gate: true }]);
      }
    });
  }, 180_000);

  it('disables only reporting metadata idempotently without changing provider ACLs', async () => {
    await isolated(async ({ admin, tenant, role }) => {
      const schema = name('tenant_reporting'); const owner = await tenant(schema); await runMigrations(owner);
      const target = await role();
      await owner.query(`GRANT USAGE ON SCHEMA ${q(schema)} TO ${q(target)}; GRANT SELECT ON memories TO ${q(target)}`);
      await owner.query('SELECT continuum_register_pgvector_reporting_profile($1::name,TRUE)', [target]);
      const before = await providerAccess(admin, target);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await owner.query('SELECT continuum_register_pgvector_reporting_profile($1::name,FALSE)', [target]);
        expect(await providerAccess(admin, target)).toEqual(before);
        expect((await owner.query(`SELECT profile_kind FROM continuum_pgvector_role_profiles
          WHERE database_role_oid=$1::regrole::oid`, [target])).rows).toEqual([]);
      }
    });
  }, 180_000);

  it.each(['dedicated', 'legacy-public'])('accepts sync startup with preserved PUBLIC provider USAGE in %s layout', async (layout) => {
    await isolated(async ({ admin, tenant, role }) => {
      const provider = layout === 'dedicated' ? 'continuum_extensions' : 'public';
      if (provider !== 'public') await admin.query(`CREATE SCHEMA ${q(provider)}`);
      await admin.query(`CREATE EXTENSION vector WITH SCHEMA ${q(provider)}`);
      await admin.query(`GRANT USAGE ON SCHEMA ${q(provider)} TO PUBLIC`);
      await admin.query(`REVOKE CREATE ON SCHEMA ${q(provider)} FROM PUBLIC`);
      const schema = name('tenant_sync_public'); const pool = await tenant(schema);
      const previous = process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA;
      try {
        if (layout === 'legacy-public') process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA = '1';
        await runMigrations(pool);
      } finally {
        if (previous === undefined) delete process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA;
        else process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA = previous;
      }
      const sync = await role(); await admin.query(`ALTER ROLE ${q(sync)} LOGIN`);
      const actor = await createPrincipal(pool, { externalId: name('sync_public'), kind: 'service', displayName: 'Sync' });
      await pool.query('SELECT continuum_register_trusted_database_identity($1::name,$2::uuid,FALSE,TRUE)', [sync, actor.id]);
      const client = await pool.connect();
      try {
        await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${q(sync)}`);
        await expect(client.query('SELECT continuum_assert_current_pgvector_profile()')).resolves.toBeDefined();
        expect((await client.query(`SELECT has_schema_privilege(current_user,$1,'USAGE') AS usage,
          has_schema_privilege(current_user,$1,'CREATE') AS create,
          has_table_privilege(current_user,'memories','SELECT') AS memory_read`, [provider])).rows)
          .toEqual([{ usage: true, create: false, memory_read: false }]);
      } finally { await client.query('ROLLBACK'); client.release(); }
      await expect(reconcilePgvectorProviderGrants(pool)).resolves.toBeUndefined();
      await admin.query(`GRANT USAGE ON SCHEMA ${q(provider)} TO ${q(sync)}`);
      await expect(reconcilePgvectorProviderGrants(pool)).rejects.toThrow(/sync profile drift/i);
    });
  }, 180_000);

  it('lets owner startup share verification while still excluding a migration writer', async () => {
    await isolated(async ({ tenant }) => {
      const schema = name('tenant_concurrent'); const owner = await tenant(schema);
      await runMigrations(owner); const startup = await tenant(schema);
      const blocker = await owner.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT pg_advisory_xact_lock_shared(7215328273579717613::bigint)');
        await expect(reconcilePgvectorProviderGrants(startup)).resolves.toBeUndefined();
        await blocker.query('COMMIT');
        await blocker.query('BEGIN');
        await blocker.query('SELECT pg_advisory_xact_lock(7215328273579717613::bigint)');
        await expect(reconcilePgvectorProviderGrants(startup)).rejects.toMatchObject({ code: '55P03' });
      } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    });
  }, 180_000);

  it('ignores dropped-role profiles read-only while rejecting live profile drift', async () => {
    await isolated(async ({ admin, tenant, role }) => {
      const schema = name('tenant_orphan'); const owner = await tenant(schema); await runMigrations(owner);
      const retired = await role(); const live = await role();
      await grants(owner, schema, retired); await grants(owner, schema, live);
      const retiredOid = (await admin.query('SELECT oid FROM pg_roles WHERE rolname=$1', [retired])).rows[0].oid;
      await admin.query(`DROP OWNED BY ${q(retired)}`); await admin.query(`DROP ROLE ${q(retired)}`);
      await expect(reconcilePgvectorProviderGrants(owner)).resolves.toBeUndefined();
      expect((await owner.query('SELECT profile_kind FROM continuum_pgvector_role_profiles WHERE database_role_oid=$1', [retiredOid])).rows)
        .toEqual([{ profile_kind: 'application' }]);
      await admin.query(`REVOKE USAGE ON SCHEMA continuum_extensions FROM ${q(live)}`);
      await expect(reconcilePgvectorProviderGrants(owner)).rejects.toThrow(/missing effective USAGE|profile drift/i);
      expect((await admin.query(`SELECT has_schema_privilege($1,'continuum_extensions','USAGE') AS usage`, [live])).rows)
        .toEqual([{ usage: false }]);
    });
  }, 180_000);

  it.each(['public', 'custom'])('keeps new sync registration grants on the target role in a %s schema', async (layout) => {
    await isolated(async ({ admin, tenant, role }) => {
      const schema = layout === 'public' ? 'public' : name('tenant_sync');
      const pool = await tenant(schema); await runMigrations(pool);
      const sync = await role(); await admin.query(`ALTER ROLE ${q(sync)} LOGIN`);
      const actor = await createPrincipal(pool, { externalId: name('sync_actor'), kind: 'service', displayName: 'Sync' });
      await expect(pool.query('SELECT continuum_register_trusted_database_identity($1::name,$2::uuid,FALSE,TRUE)', [sync, actor.id]))
        .resolves.toBeDefined();
      await expect(pool.query('SELECT continuum_assert_sync_role_allowlist($1::name,$2::uuid)', [sync, actor.id]))
        .resolves.toBeDefined();
      for (const table of ['scopes', 'principals', 'entra_groups', 'scope_memberships', 'entra_sync_state']) {
        expect((await pool.query(`SELECT has_table_privilege($1,$2,'SELECT') AS sync_read,
          has_table_privilege('public',$2,'SELECT') AS public_read`, [sync, `${q(schema)}.${q(table)}`])).rows)
          .toEqual([{ sync_read: true, public_read: false }]);
      }
      expect((await pool.query(`SELECT has_function_privilege($1,$2,'EXECUTE') AS execute`,
        [sync, `${q(schema)}.continuum_assert_current_pgvector_profile()`])).rows).toEqual([{ execute: true }]);
    });
  }, 180_000);

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
      await admin.query(`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${q(schema)} FROM PUBLIC`);
      const app = await role(); await grants(pool, schema, app);
      expect((await admin.query(`SELECT has_schema_privilege($1,$2,'USAGE') AS usage,
        has_function_privilege($1,$3,'EXECUTE') AS execute`,
      [app, schema, `${q(schema)}.vector_dims(${q(schema)}.vector)`])).rows)
        .toEqual([{ usage: true, execute: true }]);
      await admin.query(`GRANT ${q(app)} TO CURRENT_USER WITH ADMIN OPTION, SET TRUE, INHERIT FALSE`);
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${q(app)}`);
        expect((await client.query(`SELECT ${q(schema)}.vector_dims('[1,2]'::${q(schema)}.vector) AS dimensions`)).rows)
          .toEqual([{ dimensions: 2 }]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  }, 180_000);
});
