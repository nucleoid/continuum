import { dropIsolatedTestDatabase } from './test-helpers.js';
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  storeMemoryEmbeddingVector,
  vectorSearchMemoryIds,
} from './embeddings.js';
import { runMigrations } from './migrator.js';
import { reconcilePgvectorProviderGrants } from './provider-lifecycle.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';

const DATABASE_URL =
  process.env.CONTINUUM_TEST_DATABASE_URL ??
  'postgres://continuum:***@localhost:5433/continuum';

const pools: pg.Pool[] = [];
const clientClosures: Promise<void>[] = [];
function trackPool(pool: pg.Pool): void {
  pool.on('connect', (client) => {
    clientClosures.push(new Promise<void>((resolve) => client.once('end', () => resolve())));
  });
  pools.push(pool);
}
const directories: string[] = [];
const roles: string[] = [];
const databases = new Set<string>();

function identifier(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function databaseUrl(database: string): string {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

function searchPath(schema: string): string {
  return quoteIdentifier(schema);
}

function migrationPool(url: string, schema: string, role?: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    options: `-c search_path=${searchPath(schema)}${role ? ` -c role=${role}` : ''}`,
  });
  pool.on('error', () => undefined);
  trackPool(pool);
  return pool;
}

async function fullMigrationDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-pgvector-full-chain-'));
  directories.push(directory);
  const source = join(process.cwd(), 'migrations');
  for (const file of (await readdir(source)).filter((name) => name.endsWith('.sql'))) {
    await copyFile(join(source, file), join(directory, file));
  }
  return directory;
}

async function migrationDirectoryThrough(lastName: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-pgvector-partial-chain-'));
  directories.push(directory);
  const source = join(process.cwd(), 'migrations');
  for (const file of (await readdir(source))
    .filter((name) => name.endsWith('.sql') && name <= lastName)) {
    await copyFile(join(source, file), join(directory, file));
  }
  return directory;
}

async function grantApplicationRole(
  pool: pg.Pool,
  schema: string,
  role: string,
): Promise<void> {
  const source = await readFile(
    join(process.cwd(), 'scripts/grant-application-role.sql'), 'utf8',
  );
  const sql = source.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n')
    .replaceAll(':"continuum_schema"', quoteIdentifier(schema))
    .replaceAll(":'continuum_schema'", "'" + schema.replaceAll("'", "''") + "'")
    .replaceAll(':"continuum_app_role"', quoteIdentifier(role))
    .replaceAll(
      ":'continuum_app_role'",
      `'${role.replaceAll("'", "''")}'`,
    );
  await pool.query(sql);
}

async function grantSyncRole(
  pool: pg.Pool,
  schema: string,
  role: string,
  principalId: string,
): Promise<void> {
  const source = await readFile(
    join(process.cwd(), 'scripts/grant-sync-role.sql'), 'utf8',
  );
  const sql = source.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n')
    .replaceAll(':"continuum_schema"', quoteIdentifier(schema))
    .replaceAll(":'continuum_schema'", "'" + schema.replaceAll("'", "''") + "'")
    .replaceAll(':"continuum_sync_role"', quoteIdentifier(role))
    .replaceAll(
      ":'continuum_sync_role'",
      `'${role.replaceAll("'", "''")}'`,
    )
    .replaceAll(":'continuum_principal_id'", `'${principalId}'`);
  await pool.query(sql);
}

async function withFreshDatabase(
  run: (root: pg.Pool, target: pg.Pool, url: string, database: string) => Promise<void>,
): Promise<void> {
  const database = identifier('continuum_pgvector_rollout');
  const root = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  trackPool(root);
  await root.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
  databases.add(database);
  const url = databaseUrl(database);
  const target = new pg.Pool({ connectionString: url, max: 1 });
  target.on('error', () => undefined);
  trackPool(target);
  // Behavior assertions retain their own test deadline. Normal pool/socket
  // drain and disk-backed DROP belong to the separately bounded teardown hook.
  await run(root, target, url, database);
}

afterEach(async () => {
  const failures: unknown[] = [];
  const closed = await Promise.allSettled(pools.splice(0).map((pool) => pool.end()));
  for (const result of closed) if (result.status === 'rejected') failures.push(result.reason);
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.all(clientClosures.splice(0)), new Promise<never>((_, reject) => {
      closeTimer = setTimeout(() => reject(new Error('Fixture database clients did not close within 5 seconds')), 5_000);
    })]);
  } catch (error) { failures.push(error); }
  finally { if (closeTimer) clearTimeout(closeTimer); }
  const root = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    for (const database of [...databases]) {
      try { await dropIsolatedTestDatabase(root, database); databases.delete(database); }
      catch (error) { failures.push(error); }
    }
    for (const role of roles.splice(0)) {
      try { await root.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`); }
      catch (error) { failures.push(error); }
    }
  } finally {
    try { await root.end(); } catch (error) { failures.push(error); }
  }
  const removed = await Promise.allSettled(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
  for (const result of removed) if (result.status === 'rejected') failures.push(result.reason);
  if (failures.length > 0) throw new AggregateError(failures, 'Provider fixture teardown failed');
}, 120_000);

describe('pgvector rollout remediation', () => {
  it('upgrades existing 0090 APP OP and SYNC profiles through only 0091 and verifies the retained guards on rerun', async () => {
    await withFreshDatabase(async (root, target, url) => {
      const schema = identifier('renewal_upgrade');
      await target.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      const owner = migrationPool(url, schema);
      const partial = await migrationDirectoryThrough('0090_standup_activity.sql');
      expect((await runMigrations(owner, partial)).at(-1)?.name).toBe('0090_standup_activity.sql');
      const actor = await createPrincipal(owner, { externalId: randomUUID(), kind: 'user', displayName: 'Upgrade operator' });
      const sync = await createPrincipal(owner, { externalId: randomUUID(), kind: 'service', displayName: 'Upgrade sync' });
      const org = (await getScopeByRef(owner, { kind: 'org', name: '' }))!;
      await addMembership(owner, actor.id, org.id, 'admin');
      const appRole = identifier('renewal_app'), opRole = identifier('renewal_op'), syncRole = identifier('renewal_sync');
      roles.push(appRole, opRole, syncRole);
      for (const role of [appRole,opRole,syncRole]) await root.query(`CREATE ROLE ${quoteIdentifier(role)} NOLOGIN`);
      await grantApplicationRole(owner, schema, appRole);
      await grantApplicationRole(owner, schema, opRole);
      await grantSyncRole(owner, schema, syncRole, sync.id);
      const opSource = await readFile(join(process.cwd(), 'scripts/grant-operator-role.sql'), 'utf8');
      const newGrant = '  :"continuum_schema".continuum_operator_quarantine_expired_renewal(UUID, UUID, UUID, TEXT, UUID, UUID, BIGINT, UUID, INTEGER, TEXT),';
      expect(opSource.split(newGrant)).toHaveLength(2);
      // Reproduce the existing 0090 profile by omitting only its not-yet-created capability.
      const grantOperator = async (source: string) => {
        const sql = source.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\')).join('\n')
          .replaceAll(':"continuum_schema"',quoteIdentifier(schema)).replaceAll(":'continuum_schema'",quoteLiteral(schema))
          .replaceAll(':"continuum_operator_role"',quoteIdentifier(opRole)).replaceAll(":'continuum_operator_role'",quoteLiteral(opRole))
          .replaceAll(":'continuum_principal_id'",quoteLiteral(actor.id));
        await owner.query(sql);
      };
      await grantOperator(opSource.replace(newGrant, ''));
      const profiles = async () => (await owner.query(`SELECT database_role_oid,profile_kind,provider_schema_oid FROM continuum_pgvector_role_profiles ORDER BY database_role_oid`)).rows;
      const identities = async () => (await owner.query(`SELECT database_role,database_role_oid,principal_id,can_approve,can_sync FROM continuum_trusted_database_identities ORDER BY database_role_oid`)).rows;
      const beforeProfiles = await profiles(), beforeIdentities = await identities();
      expect(beforeProfiles.map((row) => row.profile_kind).sort()).toEqual(['application','operator','sync']);
      expect(beforeIdentities).toHaveLength(2);
      const full = await fullMigrationDirectory();
      expect((await runMigrations(owner, full)).map((entry) => entry.name)).toEqual(['0091_coordination_renewal_quarantine.sql']);
      const signature = `${quoteIdentifier(schema)}.continuum_operator_quarantine_expired_renewal(uuid,uuid,uuid,text,uuid,uuid,bigint,uuid,integer,text)`;
      const allowed = async (role: string) => (await owner.query("SELECT has_function_privilege($1::name,$2::text,'EXECUTE') AS allowed", [role,signature])).rows[0].allowed;
      for (const role of [appRole,opRole,syncRole]) expect(await allowed(role)).toBe(false);
      expect(await profiles()).toEqual(beforeProfiles); expect(await identities()).toEqual(beforeIdentities);
      await grantOperator(opSource);
      await grantApplicationRole(owner, schema, appRole);
      await grantSyncRole(owner, schema, syncRole, sync.id);
      expect(await allowed(opRole)).toBe(true); expect(await allowed(appRole)).toBe(false); expect(await allowed(syncRole)).toBe(false);
      expect(await profiles()).toEqual(beforeProfiles); expect(await identities()).toEqual(beforeIdentities);
      expect(await runMigrations(owner, full)).toEqual([]);
      // Owner-controlled drift is refused, not silently repaired by the ledger skip.
      await owner.query('ALTER TABLE coordination_leases DISABLE TRIGGER quarantine_lease_generation');
      await expect(runMigrations(owner, full)).rejects.toThrow('renewal quarantine trigger drift');
      await owner.query('ALTER TABLE coordination_leases ENABLE TRIGGER quarantine_lease_generation');
      const signature0 = 'continuum_guard_quarantined_renewal_receipt()';
      const originalBody = (await owner.query('SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure',[signature0])).rows[0].prosrc;
      const replaceBody = (body: string) => owner.query(`CREATE OR REPLACE FUNCTION continuum_guard_quarantined_renewal_receipt()
        RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,${quoteIdentifier(schema)},pg_temp AS $body$${body}$body$`);
      await replaceBody('BEGIN RETURN NEW; END;');
      await expect(runMigrations(owner, full)).rejects.toThrow('renewal quarantine function body or trust drift');
      await replaceBody(originalBody);
      await owner.query('GRANT EXECUTE ON FUNCTION continuum_guard_quarantined_renewal_receipt() TO PUBLIC');
      await expect(runMigrations(owner, full)).rejects.toThrow('renewal quarantine function body or trust drift');
      await owner.query('REVOKE ALL ON FUNCTION continuum_guard_quarantined_renewal_receipt() FROM PUBLIC');
      await owner.query('ALTER FUNCTION continuum_guard_quarantined_renewal_receipt() SECURITY INVOKER');
      await expect(runMigrations(owner, full)).rejects.toThrow('renewal quarantine function body or trust drift');
      await owner.query('ALTER FUNCTION continuum_guard_quarantined_renewal_receipt() SECURITY DEFINER');
      await owner.query('ALTER FUNCTION continuum_guard_quarantined_renewal_receipt() SET search_path=pg_catalog');
      await expect(runMigrations(owner, full)).rejects.toThrow('renewal quarantine function body or trust drift');
      await owner.query(`ALTER FUNCTION continuum_guard_quarantined_renewal_receipt() SET search_path=pg_catalog,${quoteIdentifier(schema)},pg_temp`);
      expect(await runMigrations(owner, full)).toEqual([]);
    });
  }, 120_000);

  it('supports PostgreSQL database-owner control of a hardened public app schema', async () => {
    await withFreshDatabase(async (_root, target, url) => {
      const pool = migrationPool(url, 'public');
      await expect(runMigrations(
        pool, await migrationDirectoryThrough('0001_init.sql'),
      )).resolves.toEqual([expect.objectContaining({ name: '0001_init.sql' })]);
      expect((await target.query(`
        SELECT relation.relnamespace::regnamespace::text AS schema,
               type_namespace.nspname AS vector_schema
          FROM pg_class relation
          JOIN pg_attribute attribute
            ON attribute.attrelid = relation.oid AND attribute.attname = 'embedding'
          JOIN pg_type type ON type.oid = attribute.atttypid
          JOIN pg_namespace type_namespace ON type_namespace.oid = type.typnamespace
         WHERE relation.oid = 'public.memory_embeddings'::regclass
      `)).rows).toEqual([{ schema: 'public', vector_schema: 'continuum_extensions' }]);
    });
  });

  it('refuses a foreign-owned default provider schema without leaving fresh state', async () => {
    const foreignOwner = identifier('continuum_provider_owner');
    roles.push(foreignOwner);
    await withFreshDatabase(async (root, target, url) => {
      const applicationSchema = identifier('continuum_app');
      await root.query(`CREATE ROLE ${quoteIdentifier(foreignOwner)} NOLOGIN`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      await target.query(
        `CREATE SCHEMA continuum_extensions AUTHORIZATION ${quoteIdentifier(foreignOwner)}`,
      );
      const pool = migrationPool(url, applicationSchema);
      const directory = await migrationDirectoryThrough('0001_init.sql');

      await expect(runMigrations(pool, directory)).rejects.toThrow(
        /continuum_extensions.*owned.*current migration role|fix ownership/i,
      );
      expect((await target.query(
        `SELECT to_regtype('continuum_extensions.vector') IS NULL AS no_vector,
                to_regclass($1) IS NULL AS no_ledger`,
        [`${applicationSchema}._continuum_migrations`],
      )).rows).toEqual([{ no_vector: true, no_ledger: true }]);
    });
  });

  it('refuses CREATE on the default provider schema granted to a non-owner', async () => {
    const outsider = identifier('continuum_provider_writer');
    roles.push(outsider);
    await withFreshDatabase(async (root, target, url) => {
      const applicationSchema = identifier('continuum_app');
      await root.query(`CREATE ROLE ${quoteIdentifier(outsider)} NOLOGIN`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      await target.query('CREATE SCHEMA continuum_extensions');
      await target.query(
        `GRANT CREATE ON SCHEMA continuum_extensions TO ${quoteIdentifier(outsider)}`,
      );
      const pool = migrationPool(url, applicationSchema);
      const directory = await migrationDirectoryThrough('0001_init.sql');

      await expect(runMigrations(pool, directory)).rejects.toThrow(
        /continuum_extensions.*CREATE.*non-owner|revoke CREATE/i,
      );
      expect((await target.query(
        `SELECT to_regtype('continuum_extensions.vector') IS NULL AS no_vector`,
      )).rows).toEqual([{ no_vector: true }]);
    });
  });

  it('refuses a fresh tenant binding to another Continuum schema provider', async () => {
    const previousCompatibility = process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA;
    delete process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA;
    try {
      await withFreshDatabase(async (_root, target, url) => {
      const firstSchema = identifier('continuum_existing_tenant');
      const secondSchema = identifier('continuum_new_tenant');
      await target.query(`CREATE SCHEMA ${quoteIdentifier(firstSchema)}`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(secondSchema)}`);
      await target.query(
        `CREATE EXTENSION vector WITH SCHEMA ${quoteIdentifier(firstSchema)}`,
      );
      await target.query(`
        CREATE TABLE ${quoteIdentifier(firstSchema)}._continuum_migrations (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        INSERT INTO ${quoteIdentifier(firstSchema)}._continuum_migrations (name)
        VALUES ('0001_init.sql');
      `);
      const pool = migrationPool(url, secondSchema);
      const directory = await migrationDirectoryThrough('0001_init.sql');

      await expect(runMigrations(pool, directory)).rejects.toThrow(
        /another Continuum.*schema|legacy shared.*opt-in|relocat/i,
      );
      expect((await target.query(
        `SELECT to_regclass($1) IS NULL AS no_memories,
                to_regclass($2) IS NULL AS no_ledger`,
        [`${secondSchema}.memories`, `${secondSchema}._continuum_migrations`],
      )).rows).toEqual([{ no_memories: true, no_ledger: true }]);
      });
    } finally {
      if (previousCompatibility === undefined) {
        delete process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA;
      } else {
        process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA = previousCompatibility;
      }
    }
  });

  it('requires and honors the explicit reviewed legacy shared-schema opt-in', async () => {
    await withFreshDatabase(async (_root, target, url) => {
      const firstSchema = identifier('continuum_existing_tenant');
      const secondSchema = identifier('continuum_new_tenant');
      await target.query(`CREATE SCHEMA ${quoteIdentifier(firstSchema)}`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(secondSchema)}`);
      await target.query(
        `CREATE EXTENSION vector WITH SCHEMA ${quoteIdentifier(firstSchema)}`,
      );
      await target.query(`
        CREATE TABLE ${quoteIdentifier(firstSchema)}._continuum_migrations (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        INSERT INTO ${quoteIdentifier(firstSchema)}._continuum_migrations (name)
        VALUES ('0001_init.sql');
      `);
      const pool = migrationPool(url, secondSchema);
      const directory = await migrationDirectoryThrough('0001_init.sql');
      const previous = process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA;
      process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA = '1';
      try {
        await expect(runMigrations(pool, directory)).resolves.toEqual([
          expect.objectContaining({ name: '0001_init.sql' }),
        ]);
      } finally {
        if (previous === undefined) {
          delete process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA;
        } else {
          process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA = previous;
        }
      }
      expect((await target.query(
        `SELECT format_type(attribute.atttypid, attribute.atttypmod) AS type
           FROM pg_attribute attribute
          WHERE attribute.attrelid = $1::regclass
            AND attribute.attname = 'embedding'`,
        [`${secondSchema}.memory_embeddings`],
      )).rows).toEqual([{ type: `${firstSchema}.vector(768)` }]);
    });
  });

  it('rejects an empty migration search_path before creating a ledger', async () => {
    await withFreshDatabase(async (_root, target, url) => {
      const pool = new pg.Pool({
        connectionString: url,
        max: 1,
        options: '-c search_path=',
      });
      pool.on('error', () => undefined);
      trackPool(pool);
      const directory = await migrationDirectoryThrough('0001_init.sql');

      await expect(runMigrations(pool, directory)).rejects.toThrow(
        /search_path.*application schema|empty search_path/i,
      );
      expect((await target.query(
        `SELECT to_regclass('_continuum_migrations') IS NULL AS no_ledger`,
      )).rows).toEqual([{ no_ledger: true }]);
    });
  });

  it('rejects an application-schema vector shadow before 0001', async () => {
    await withFreshDatabase(async (_root, target, url) => {
      const applicationSchema = `${identifier('continuum_app')}"quoted`;
      const providerSchema = identifier('provider_extensions');
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(providerSchema)}`);
      await target.query(
        `CREATE EXTENSION vector WITH SCHEMA ${quoteIdentifier(providerSchema)}`,
      );
      await target.query(
        `CREATE DOMAIN ${quoteIdentifier(applicationSchema)}.vector AS text`,
      );
      const pool = migrationPool(url, applicationSchema);
      const directory = await migrationDirectoryThrough('0001_init.sql');

      await expect(runMigrations(pool, directory)).rejects.toThrow(
        /application schema.*shadows.*vector|remove.*vector.*shadow/i,
      );
      expect((await target.query(
        `SELECT to_regclass($1) IS NULL AS no_memories`,
        [`${applicationSchema}.memories`],
      )).rows).toEqual([{ no_memories: true }]);
    });
  });

  it('restores search_path immediately after 0001 and preserves sibling colliding indexes', async () => {
    await withFreshDatabase(async (_root, target, url) => {
      const applicationSchema = `continuum_app_${randomUUID()}"quoted`;
      const providerSchema = identifier('provider_extensions');
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(providerSchema)}`);
      await target.query(
        `CREATE EXTENSION vector WITH SCHEMA ${quoteIdentifier(providerSchema)}`,
      );
      await target.query(`
        CREATE TABLE ${quoteIdentifier(providerSchema)}.memories (
          expires_at TIMESTAMPTZ,
          id UUID,
          state TEXT,
          type TEXT,
          created_at TIMESTAMPTZ,
          supersedes_id UUID
        );
        CREATE INDEX memories_lifecycle_expiry_idx
          ON ${quoteIdentifier(providerSchema)}.memories (expires_at, id);
        CREATE INDEX memories_review_queue_idx
          ON ${quoteIdentifier(providerSchema)}.memories (state, type, expires_at, created_at, id);
        CREATE UNIQUE INDEX memories_supersedes_unique_idx
          ON ${quoteIdentifier(providerSchema)}.memories (supersedes_id);
      `);
      const migrations = await fullMigrationDirectory();
      const pool = migrationPool(url, applicationSchema);

      await expect(runMigrations(pool, migrations)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: '0001_init.sql' }),
          expect.objectContaining({ name: '0080_pgvector_provider_grants.sql' }),
        ]),
      );
      expect((await target.query(
        `SELECT indexrelid::regclass::text AS name
           FROM pg_index
          WHERE indexrelid = ANY($1::regclass[])
          ORDER BY 1`,
        [[
          `${quoteIdentifier(providerSchema)}.memories_lifecycle_expiry_idx`,
          `${quoteIdentifier(providerSchema)}.memories_review_queue_idx`,
          `${quoteIdentifier(providerSchema)}.memories_supersedes_unique_idx`,
        ]],
      )).rowCount).toBe(3);
      expect((await pool.query('SHOW search_path')).rows)
        .toEqual([{ search_path: searchPath(applicationSchema) }]);
    });
  }, 180_000);

  it('does not expose the provider schema to a migration after 0001 fails', async () => {
    await withFreshDatabase(async (_root, target, url) => {
      const applicationSchema = identifier('continuum_app');
      const providerSchema = identifier('provider_extensions');
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(providerSchema)}`);
      await target.query(
        `CREATE EXTENSION vector WITH SCHEMA ${quoteIdentifier(providerSchema)}`,
      );
      const directory = await mkdtemp(join(tmpdir(), 'continuum-pgvector-failure-'));
      directories.push(directory);
      await copyFile(
        join(process.cwd(), 'migrations/0001_init.sql'),
        join(directory, '0001_init.sql'),
      );
      await writeFile(join(directory, '0002_fail.sql'), `
        DO $$
        BEGIN
          IF ${quoteLiteral(providerSchema)} = ANY(current_schemas(FALSE)) THEN
            RAISE EXCEPTION 'provider schema leaked after 0001';
          END IF;
          RAISE EXCEPTION 'expected later migration failure';
        END
        $$;
      `);
      const pool = migrationPool(url, applicationSchema);

      await expect(runMigrations(pool, directory))
        .rejects.toThrow(/expected later migration failure/);
      expect((await pool.query('SHOW search_path')).rows)
        .toEqual([{ search_path: searchPath(applicationSchema) }]);
      expect((await target.query(
        `SELECT name FROM ${quoteIdentifier(applicationSchema)}._continuum_migrations
          ORDER BY name`,
      )).rows).toEqual([{ name: '0001_init.sql' }]);
    });
  });

  it('auto-installs into a dedicated provider schema independent of app schema teardown', async () => {
    await withFreshDatabase(async (_root, target, url) => {
      const firstSchema = identifier('continuum_first');
      const secondSchema = identifier('continuum_second');
      await target.query(`CREATE SCHEMA ${quoteIdentifier(firstSchema)}`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(secondSchema)}`);
      const directory = await fullMigrationDirectory();
      const first = migrationPool(url, firstSchema);
      const second = migrationPool(url, secondSchema);

      await Promise.all([
        runMigrations(first, directory),
        runMigrations(second, directory),
      ]);
      expect((await target.query(
        `SELECT namespace.nspname AS schema
           FROM pg_extension extension
           JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
          WHERE extension.extname = 'vector'`,
      )).rows).toEqual([{ schema: 'continuum_extensions' }]);

      await target.query(`DROP SCHEMA ${quoteIdentifier(firstSchema)} CASCADE`);
      expect((await target.query(
        `SELECT to_regclass($1) IS NOT NULL AS relation,
                to_regtype($2) IS NOT NULL AS vector_type`,
        [`${secondSchema}.memory_embeddings`, 'continuum_extensions.vector'],
      )).rows).toEqual([{ relation: true, vector_type: true }]);
    });
  }, 240_000);

  it('preserves an already-ledgered non-public app-schema extension during upgrade', async () => {
    await withFreshDatabase(async (_root, target, url) => {
      const applicationSchema = identifier('continuum_legacy');
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      await target.query(
        `CREATE EXTENSION vector WITH SCHEMA ${quoteIdentifier(applicationSchema)}`,
      );
      const initial = await mkdtemp(join(tmpdir(), 'continuum-pgvector-initial-'));
      directories.push(initial);
      await copyFile(
        join(process.cwd(), 'migrations/0001_init.sql'),
        join(initial, '0001_init.sql'),
      );
      const pool = migrationPool(url, applicationSchema);
      await runMigrations(pool, initial);

      const full = await fullMigrationDirectory();
      await expect(runMigrations(pool, full)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: '0080_pgvector_provider_grants.sql' }),
        ]),
      );
      expect((await target.query(
        `SELECT namespace.nspname AS schema
           FROM pg_extension extension
           JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
          WHERE extension.extname = 'vector'`,
      )).rows).toEqual([{ schema: applicationSchema }]);
      expect((await target.query(
        `SELECT to_regnamespace('continuum_extensions') IS NULL AS no_default_provider`,
      )).rows).toEqual([{ no_default_provider: true }]);
    });
  }, 180_000);

  it('grants a least-privilege app role provider access for runtime vector search', async () => {
    const ownerRole = identifier('continuum_owner');
    const appRole = identifier('continuum_app');
    roles.push(appRole, ownerRole);
    await withFreshDatabase(async (root, target, url, database) => {
      const applicationSchema = identifier('continuum_data');
      const providerSchema = identifier('provider_extensions');
      await root.query(`CREATE ROLE ${quoteIdentifier(ownerRole)} NOLOGIN`);
      await root.query(`CREATE ROLE ${quoteIdentifier(appRole)} NOLOGIN`);
      await target.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(ownerRole)}, ${quoteIdentifier(appRole)}`,
      );
      await target.query(
        `CREATE SCHEMA ${quoteIdentifier(applicationSchema)} AUTHORIZATION ${quoteIdentifier(ownerRole)}`,
      );
      await target.query(`CREATE SCHEMA ${quoteIdentifier(providerSchema)}`);
      await target.query(
        `CREATE EXTENSION vector WITH SCHEMA ${quoteIdentifier(providerSchema)}`,
      );
      await target.query(
        `GRANT USAGE ON SCHEMA ${quoteIdentifier(providerSchema)} TO ${quoteIdentifier(ownerRole)} WITH GRANT OPTION`,
      );
      await target.query(
        `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${quoteIdentifier(providerSchema)} FROM PUBLIC`,
      );
      await target.query(
        `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${quoteIdentifier(providerSchema)} TO ${quoteIdentifier(ownerRole)} WITH GRANT OPTION`,
      );
      const directory = await fullMigrationDirectory();
      const owner = migrationPool(url, applicationSchema, ownerRole);
      await runMigrations(owner, directory);
      await grantApplicationRole(owner, applicationSchema, appRole);

      const principalId = randomUUID();
      const scopeId = randomUUID();
      const memoryId = randomUUID();
      await owner.query(
        `INSERT INTO principals (id, external_id, kind, display_name)
         VALUES ($1, 'least-privilege-user', 'user', 'Least privilege user')`,
        [principalId],
      );
      await owner.query(
        `INSERT INTO scopes (id, kind, name) VALUES ($1, 'project', 'least-privilege')`,
        [scopeId],
      );
      await owner.query(
        `INSERT INTO memories (id, scope_id, type, title, body, author_id, source)
         VALUES ($1, $2, 'fact', 'Vector contract', 'Provider schema', $3, 'test')`,
        [memoryId, scopeId, principalId],
      );
      const vector = [1, ...Array(767).fill(0)] as number[];
      const provider = { id: 'test:least-privilege', dim: 768 };
      await storeMemoryEmbeddingVector(owner, memoryId, vector, provider);

      const runtime = migrationPool(url, applicationSchema, appRole);
      expect((await runtime.query(
        `SELECT has_schema_privilege(current_user, $1, 'USAGE') AS usage`,
        [providerSchema],
      )).rows).toEqual([{ usage: true }]);
      expect((await runtime.query(
        `SELECT bool_and(has_function_privilege(current_user, function.oid, 'EXECUTE'))
                AS executable
           FROM pg_proc function
           JOIN pg_depend dependency
             ON dependency.classid = 'pg_proc'::regclass
            AND dependency.objid = function.oid
            AND dependency.refclassid = 'pg_extension'::regclass
            AND dependency.deptype = 'e'
           JOIN pg_extension extension ON extension.oid = dependency.refobjid
          WHERE extension.extname = 'vector'`,
      )).rows).toEqual([{ executable: true }]);
      await expect(vectorSearchMemoryIds(runtime, vector, [scopeId], provider, 5))
        .resolves.toEqual([{ id: memoryId, distance: 0 }]);
    });
  }, 180_000);

  it('reports the exact grant when a migrator cannot use a preinstalled provider schema', async () => {
    const ownerRole = identifier('continuum_owner');
    roles.push(ownerRole);
    await withFreshDatabase(async (root, target, url, database) => {
      const applicationSchema = identifier('continuum_data');
      const providerSchema = identifier('provider_extensions');
      await root.query(`CREATE ROLE ${quoteIdentifier(ownerRole)} NOLOGIN`);
      await target.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(ownerRole)}`,
      );
      await target.query(
        `CREATE SCHEMA ${quoteIdentifier(applicationSchema)} AUTHORIZATION ${quoteIdentifier(ownerRole)}`,
      );
      await target.query(`CREATE SCHEMA ${quoteIdentifier(providerSchema)}`);
      await target.query(
        `CREATE EXTENSION vector WITH SCHEMA ${quoteIdentifier(providerSchema)}`,
      );
      const directory = await fullMigrationDirectory();
      const owner = migrationPool(url, applicationSchema, ownerRole);

      await expect(runMigrations(owner, directory)).rejects.toThrow(
        new RegExp(`GRANT USAGE ON SCHEMA.*${providerSchema}.*TO.*${ownerRole}`),
      );
    });
  });

  it('upgrades only exact application profiles and ignores a SELECT-only outsider', async () => {
    const appRole = identifier('continuum_app');
    const outsider = identifier('continuum_reporter');
    roles.push(outsider, appRole);
    await withFreshDatabase(async (root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      const providerSchema = identifier('provider_extensions');
      await root.query(`CREATE ROLE ${quoteIdentifier(appRole)} NOLOGIN`);
      await root.query(`CREATE ROLE ${quoteIdentifier(outsider)} NOLOGIN`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(providerSchema)}`);
      await target.query(
        `CREATE EXTENSION vector WITH SCHEMA ${quoteIdentifier(providerSchema)}`,
      );
      const before0080 = await migrationDirectoryThrough(
        '0079_coordination_upgrade_scale_remediation.sql',
      );
      const pool = migrationPool(url, applicationSchema);
      await runMigrations(pool, before0080);
      await grantApplicationRole(pool, applicationSchema, appRole);
      await pool.query(`GRANT SELECT ON memories TO ${quoteIdentifier(outsider)}`);
      await target.query(
        `REVOKE USAGE ON SCHEMA ${quoteIdentifier(providerSchema)} FROM PUBLIC`,
      );
      await target.query(
        `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${quoteIdentifier(providerSchema)} FROM PUBLIC`,
      );
      const full = await fullMigrationDirectory();

      await expect(runMigrations(pool, full)).resolves.toEqual([
        expect.objectContaining({ name: '0080_pgvector_provider_grants.sql' }),
        expect.objectContaining({ name: '0081_coordination_public_contract.sql' }),
        expect.objectContaining({ name: '0082_coordination_linkable_audit_v7_index.sql' }),
        expect.objectContaining({ name: '0083_tag_vocabularies.sql' }),
        expect.objectContaining({ name: '0084_provider_embeddings_backfill.sql' }),
        expect.objectContaining({ name: '0085_embedding_backfill_failures.sql' }),
        expect.objectContaining({ name: '0086_embedding_backfill_failure_disposition.sql' }),
        expect.objectContaining({ name: '0087_embedding_provider_scan_index.sql' }),
        expect.objectContaining({ name: '0088_embedding_provider_scan_index_rebuild.sql' }),
        expect.objectContaining({ name: '0089_promotion_outbox.sql' }),
        expect.objectContaining({ name: '0090_standup_activity.sql' }),
        expect.objectContaining({ name: '0091_coordination_renewal_quarantine.sql' }),
      ]);
      await grantApplicationRole(pool, applicationSchema, appRole);
      await expect(pool.query(
        'SELECT continuum_assert_application_vector_profile($1::name)', [appRole],
      )).resolves.toBeDefined();
      expect((await target.query(
        `SELECT has_schema_privilege($1, $2, 'USAGE') AS app_usage,
                has_schema_privilege($3, $2, 'USAGE') AS outsider_usage`,
        [appRole, providerSchema, outsider],
      )).rows).toEqual([{ app_usage: true, outsider_usage: false }]);
    });
  }, 240_000);

  it('supports a hardened public provider without letting an outsider block 0080', async () => {
    const appRole = identifier('continuum_app');
    const outsider = identifier('continuum_backup');
    roles.push(outsider, appRole);
    await withFreshDatabase(async (root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      await root.query(`CREATE ROLE ${quoteIdentifier(appRole)} NOLOGIN`);
      await root.query(`CREATE ROLE ${quoteIdentifier(outsider)} NOLOGIN`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      await target.query('CREATE EXTENSION vector WITH SCHEMA public');
      const pool = migrationPool(url, applicationSchema);
      await runMigrations(pool, await migrationDirectoryThrough(
        '0079_coordination_upgrade_scale_remediation.sql',
      ));
      await grantApplicationRole(pool, applicationSchema, appRole);
      await pool.query(`GRANT SELECT ON memories TO ${quoteIdentifier(outsider)}`);
      await target.query('REVOKE USAGE ON SCHEMA public FROM PUBLIC');
      await target.query('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC');

      await expect(runMigrations(pool, await fullMigrationDirectory())).resolves.toEqual([
        expect.objectContaining({ name: '0080_pgvector_provider_grants.sql' }),
        expect.objectContaining({ name: '0081_coordination_public_contract.sql' }),
        expect.objectContaining({ name: '0082_coordination_linkable_audit_v7_index.sql' }),
        expect.objectContaining({ name: '0083_tag_vocabularies.sql' }),
        expect.objectContaining({ name: '0084_provider_embeddings_backfill.sql' }),
        expect.objectContaining({ name: '0085_embedding_backfill_failures.sql' }),
        expect.objectContaining({ name: '0086_embedding_backfill_failure_disposition.sql' }),
        expect.objectContaining({ name: '0087_embedding_provider_scan_index.sql' }),
        expect.objectContaining({ name: '0088_embedding_provider_scan_index_rebuild.sql' }),
        expect.objectContaining({ name: '0089_promotion_outbox.sql' }),
        expect.objectContaining({ name: '0090_standup_activity.sql' }),
        expect.objectContaining({ name: '0091_coordination_renewal_quarantine.sql' }),
      ]);
      await grantApplicationRole(pool, applicationSchema, appRole);
      await expect(pool.query(
        'SELECT continuum_assert_application_vector_profile($1::name)', [appRole],
      )).resolves.toBeDefined();
      expect((await target.query(
        `SELECT has_schema_privilege($1, 'public', 'USAGE') AS app_usage,
                has_schema_privilege($2, 'public', 'USAGE') AS outsider_usage`,
        [appRole, outsider],
      )).rows).toEqual([{ app_usage: true, outsider_usage: false }]);
    });
  }, 240_000);

  it('repairs target provider grants while retaining PUBLIC policy and failing closed on profile drift', async () => {
    const appRole = identifier('continuum_app');
    const outsider = identifier('continuum_reporter');
    roles.push(outsider, appRole);
    await withFreshDatabase(async (root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      await root.query(`CREATE ROLE ${quoteIdentifier(appRole)} NOLOGIN`);
      await root.query(`CREATE ROLE ${quoteIdentifier(outsider)} NOLOGIN`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      const pool = migrationPool(url, applicationSchema);
      await runMigrations(pool, await fullMigrationDirectory());
      await grantApplicationRole(pool, applicationSchema, appRole);

      await expect(pool.query(
        'SELECT continuum_assert_application_vector_profile($1::name)', [appRole],
      )).resolves.toBeDefined();
      expect((await pool.query(`
        SELECT has_schema_privilege('public', 'continuum_extensions', 'USAGE')
                 AS public_usage,
               bool_or(privilege.grantee = 0) FILTER (
                 WHERE upper(privilege.privilege_type) = 'EXECUTE'
               ) AS public_execute
          FROM pg_proc function
          JOIN pg_depend dependency
            ON dependency.classid = 'pg_proc'::regclass
           AND dependency.objid = function.oid
           AND dependency.refclassid = 'pg_extension'::regclass
           AND dependency.deptype = 'e'
          JOIN pg_extension extension ON extension.oid = dependency.refobjid
          CROSS JOIN LATERAL aclexplode(COALESCE(
            function.proacl, acldefault('f', function.proowner))) privilege
         WHERE extension.extname = 'vector'
      `)).rows).toEqual([{ public_usage: false, public_execute: true }]);

      await pool.query(
        `GRANT CREATE ON SCHEMA continuum_extensions TO ${quoteIdentifier(appRole)}`,
      );
      await expect(pool.query(
        'SELECT continuum_assert_application_vector_profile($1::name)', [appRole],
      )).rejects.toThrow(/forbidden CREATE/i);
      await expect(pool.query(
        'SELECT continuum_grant_application_vector_functions($1::name)', [appRole],
      )).rejects.toThrow(/forbidden CREATE/i);
      expect((await pool.query(
        `SELECT has_schema_privilege($1,'continuum_extensions','CREATE') AS forbidden_create`,
        [appRole],
      )).rows).toEqual([{ forbidden_create: true }]);
      await pool.query(
        `REVOKE CREATE ON SCHEMA continuum_extensions FROM ${quoteIdentifier(appRole)}`,
      );

      await pool.query(
        `REVOKE USAGE ON SCHEMA continuum_extensions FROM ${quoteIdentifier(appRole)}`,
      );
      await expect(pool.query(
        'SELECT continuum_assert_application_vector_profile($1::name)', [appRole],
      )).rejects.toThrow(/missing effective USAGE/i);
      await pool.query('SELECT continuum_grant_application_vector_functions($1::name)', [appRole]);
      await pool.query('SELECT continuum_grant_application_vector_functions($1::name)', [appRole]);
      await expect(pool.query(
        'SELECT continuum_assert_application_vector_profile($1::name)', [appRole],
      )).resolves.toBeDefined();

      // Provider ACL revocation is an explicit owner action, never a regrant side effect.
      await target.query(`
        REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA continuum_extensions FROM PUBLIC;
        REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA continuum_extensions FROM ${quoteIdentifier(appRole)};
      `);
      await expect(pool.query(
        'SELECT continuum_assert_application_vector_profile($1::name)', [appRole],
      )).rejects.toThrow(/missing effective EXECUTE/i);
      await grantApplicationRole(pool, applicationSchema, appRole);
      await expect(pool.query(
        'SELECT continuum_assert_application_vector_profile($1::name)', [appRole],
      )).resolves.toBeDefined();

      await pool.query(`
        GRANT SELECT ON memories TO ${quoteIdentifier(outsider)};
        GRANT USAGE ON SCHEMA continuum_extensions TO ${quoteIdentifier(outsider)};
      `);
      await expect(pool.query(
        'SELECT continuum_assert_application_vector_profile($1::name)', [appRole],
      )).resolves.toBeDefined();
      await pool.query('SELECT continuum_grant_application_vector_functions()');
      expect((await pool.query(
        `SELECT has_schema_privilege($1, 'continuum_extensions', 'USAGE') AS usage`,
        [outsider],
      )).rows).toEqual([{ usage: true }]);

      await pool.query(`REVOKE SELECT ON memories FROM ${quoteIdentifier(appRole)}`);
      await expect(pool.query(
        'SELECT continuum_grant_application_vector_functions($1::name)', [appRole],
      )).rejects.toThrow(/exact.*profile|approved reporting/i);
      await pool.query('SELECT continuum_grant_application_vector_functions()');
      expect((await pool.query(
        `SELECT has_schema_privilege($1, 'continuum_extensions', 'USAGE') AS usage,
                EXISTS (
                  SELECT 1 FROM continuum_pgvector_role_profiles
                   WHERE database_role_oid = $1::regrole::oid
                ) AS registered`,
        [appRole],
      )).rows).toEqual([{ usage: true, registered: true }]);
      await expect(reconcilePgvectorProviderGrants(pool)).rejects.toThrow(/exact|profile/i);
      // Restore the approved application profile explicitly, without pruning outsiders.
      await grantApplicationRole(pool, applicationSchema, appRole);
      await expect(reconcilePgvectorProviderGrants(pool)).resolves.toBeUndefined();
      expect((await pool.query(
        `SELECT has_schema_privilege($1,'continuum_extensions','USAGE') AS usage`, [outsider],
      )).rows).toEqual([{ usage: true }]);
    });
  }, 240_000);

  it('documents the practical old-runtime search_path compatibility boundary', async () => {
    await withFreshDatabase(async (_root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      const pool = migrationPool(url, applicationSchema);
      await runMigrations(pool, await fullMigrationDirectory());

      await expect(pool.query(
        `SELECT '[1,0]'::vector <=> '[1,0]'::vector AS distance`,
      )).rejects.toThrow(/type "vector" does not exist|operator does not exist/i);
      await pool.query(
        `SELECT set_config('search_path', format('%I, %I', $1::text, $2::text), FALSE)`,
        [applicationSchema, 'continuum_extensions'],
      );
      expect((await pool.query(
        `SELECT '[1,0]'::vector <=> '[1,0]'::vector AS distance`,
      )).rows).toEqual([{ distance: 0 }]);
    });
  }, 180_000);

  it('preserves legitimate application-schema USAGE when pgvector is application-local', async () => {
    const appRole = identifier('continuum_app');
    const reporterRole = identifier('continuum_reporter');
    roles.push(reporterRole, appRole);
    await withFreshDatabase(async (root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      await root.query(`CREATE ROLE ${quoteIdentifier(appRole)} NOLOGIN`);
      await root.query(`CREATE ROLE ${quoteIdentifier(reporterRole)} NOLOGIN`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      await target.query(
        `CREATE EXTENSION vector WITH SCHEMA ${quoteIdentifier(applicationSchema)}`,
      );
      const pool = migrationPool(url, applicationSchema);
      await runMigrations(pool, await migrationDirectoryThrough(
        '0079_coordination_upgrade_scale_remediation.sql',
      ));
      await grantApplicationRole(pool, applicationSchema, appRole);
      await pool.query(`
        GRANT USAGE ON SCHEMA ${quoteIdentifier(applicationSchema)}
          TO ${quoteIdentifier(reporterRole)};
        GRANT SELECT ON memories TO ${quoteIdentifier(reporterRole)};
      `);

      await expect(runMigrations(pool, await fullMigrationDirectory())).resolves.toEqual([
        expect.objectContaining({ name: '0080_pgvector_provider_grants.sql' }),
        expect.objectContaining({ name: '0081_coordination_public_contract.sql' }),
        expect.objectContaining({ name: '0082_coordination_linkable_audit_v7_index.sql' }),
        expect.objectContaining({ name: '0083_tag_vocabularies.sql' }),
        expect.objectContaining({ name: '0084_provider_embeddings_backfill.sql' }),
        expect.objectContaining({ name: '0085_embedding_backfill_failures.sql' }),
        expect.objectContaining({ name: '0086_embedding_backfill_failure_disposition.sql' }),
        expect.objectContaining({ name: '0087_embedding_provider_scan_index.sql' }),
        expect.objectContaining({ name: '0088_embedding_provider_scan_index_rebuild.sql' }),
        expect.objectContaining({ name: '0089_promotion_outbox.sql' }),
        expect.objectContaining({ name: '0090_standup_activity.sql' }),
        expect.objectContaining({ name: '0091_coordination_renewal_quarantine.sql' }),
      ]);
      await grantApplicationRole(pool, applicationSchema, appRole);
      await expect(pool.query(
        'SELECT continuum_assert_application_vector_profile($1::name)', [appRole],
      )).resolves.toBeDefined();
      expect((await target.query(
        `SELECT has_schema_privilege($1, $2, 'USAGE') AS reporter_usage,
                has_table_privilege($1, format('%I.memories', $2), 'SELECT') AS reporter_read`,
        [reporterRole, applicationSchema],
      )).rows).toEqual([{ reporter_usage: true, reporter_read: true }]);
    });
  }, 240_000);

  it('accepts sufficient provider-owner direct pregrants without delegation authority', async () => {
    const ownerRole = identifier('continuum_owner');
    const appRole = identifier('continuum_app');
    roles.push(appRole, ownerRole);
    await withFreshDatabase(async (root, target, url, database) => {
      const applicationSchema = identifier('continuum_data');
      const providerSchema = identifier('provider_extensions');
      await root.query(`CREATE ROLE ${quoteIdentifier(ownerRole)} NOLOGIN`);
      await root.query(`CREATE ROLE ${quoteIdentifier(appRole)} NOLOGIN`);
      await target.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(ownerRole)}`,
      );
      await target.query(
        `CREATE SCHEMA ${quoteIdentifier(applicationSchema)} AUTHORIZATION ${quoteIdentifier(ownerRole)}`,
      );
      await target.query(`CREATE SCHEMA ${quoteIdentifier(providerSchema)}`);
      await target.query(
        `CREATE EXTENSION vector WITH SCHEMA ${quoteIdentifier(providerSchema)}`,
      );
      await target.query(
        `GRANT USAGE ON SCHEMA ${quoteIdentifier(providerSchema)} TO ${quoteIdentifier(ownerRole)}`,
      );
      const owner = migrationPool(url, applicationSchema, ownerRole);
      await runMigrations(owner, await migrationDirectoryThrough(
        '0079_coordination_upgrade_scale_remediation.sql',
      ));
      await grantApplicationRole(owner, applicationSchema, appRole);
      await target.query(`
        REVOKE USAGE ON SCHEMA ${quoteIdentifier(providerSchema)} FROM PUBLIC;
        REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${quoteIdentifier(providerSchema)} FROM PUBLIC;
        GRANT USAGE ON SCHEMA ${quoteIdentifier(providerSchema)} TO ${quoteIdentifier(appRole)};
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${quoteIdentifier(providerSchema)}
          TO ${quoteIdentifier(appRole)};
      `);

      await expect(runMigrations(owner, await fullMigrationDirectory())).resolves.toEqual([
        expect.objectContaining({ name: '0080_pgvector_provider_grants.sql' }),
        expect.objectContaining({ name: '0081_coordination_public_contract.sql' }),
        expect.objectContaining({ name: '0082_coordination_linkable_audit_v7_index.sql' }),
        expect.objectContaining({ name: '0083_tag_vocabularies.sql' }),
        expect.objectContaining({ name: '0084_provider_embeddings_backfill.sql' }),
        expect.objectContaining({ name: '0085_embedding_backfill_failures.sql' }),
        expect.objectContaining({ name: '0086_embedding_backfill_failure_disposition.sql' }),
        expect.objectContaining({ name: '0087_embedding_provider_scan_index.sql' }),
        expect.objectContaining({ name: '0088_embedding_provider_scan_index_rebuild.sql' }),
        expect.objectContaining({ name: '0089_promotion_outbox.sql' }),
        expect.objectContaining({ name: '0090_standup_activity.sql' }),
        expect.objectContaining({ name: '0091_coordination_renewal_quarantine.sql' }),
      ]);
      await grantApplicationRole(owner, applicationSchema, appRole);
      await expect(owner.query(
        'SELECT continuum_assert_application_vector_profile($1::name)', [appRole],
      )).resolves.toBeDefined();
    });
  }, 240_000);

  it.each(['application','reporting'] as const)(
    'requires actionable provider delegation for %s when plain owner USAGE cannot grant target USAGE', async(kind)=>{
      const ownerRole=identifier('plain_usage_owner');
      const appRole=identifier('plain_usage_app');
      const reportingRole=identifier('plain_usage_reporter');
      roles.push(ownerRole,appRole,reportingRole);
      await withFreshDatabase(async(root,target,url,database)=>{
        const applicationSchema=identifier('plain_usage_app_schema');
        const providerSchema=identifier('plain_usage_provider');
        await root.query(`CREATE ROLE ${quoteIdentifier(ownerRole)} NOLOGIN;
          CREATE ROLE ${quoteIdentifier(appRole)} NOLOGIN;
          CREATE ROLE ${quoteIdentifier(reportingRole)} NOLOGIN`);
        await target.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(ownerRole)};
          CREATE SCHEMA ${quoteIdentifier(applicationSchema)} AUTHORIZATION ${quoteIdentifier(ownerRole)};
          CREATE SCHEMA ${quoteIdentifier(providerSchema)};
          CREATE EXTENSION vector WITH SCHEMA ${quoteIdentifier(providerSchema)};
          REVOKE USAGE ON SCHEMA ${quoteIdentifier(providerSchema)} FROM PUBLIC;
          GRANT USAGE ON SCHEMA ${quoteIdentifier(providerSchema)} TO ${quoteIdentifier(ownerRole)},${quoteIdentifier(appRole)}`);
        const owner=migrationPool(url,applicationSchema,ownerRole);
        await runMigrations(owner,await migrationDirectoryThrough('0079_coordination_upgrade_scale_remediation.sql'));
        await grantApplicationRole(owner,applicationSchema,appRole);
        await runMigrations(owner,await fullMigrationDirectory());
        await grantApplicationRole(owner,applicationSchema,appRole);
        await owner.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(applicationSchema)} TO ${quoteIdentifier(reportingRole)};
          GRANT SELECT ON memories TO ${quoteIdentifier(reportingRole)}`);
        const targetRole=kind==='application'?appRole:reportingRole;
        await target.query(`REVOKE USAGE ON SCHEMA ${quoteIdentifier(providerSchema)} FROM ${quoteIdentifier(targetRole)}`);
        expect((await target.query(`SELECT
          has_schema_privilege($1,$2,'USAGE') AS owner_usage,
          has_schema_privilege($1,$2,'USAGE WITH GRANT OPTION') AS owner_delegation,
          has_schema_privilege($3,$2,'USAGE') AS target_usage`,
          [ownerRole,providerSchema,targetRole])).rows)
          .toEqual([{owner_usage:true,owner_delegation:false,target_usage:false}]);
        const refresh=()=>owner.query(kind==='reporting'
          ? 'SELECT continuum_register_pgvector_reporting_profile($1::name,TRUE)'
          : 'SELECT continuum_grant_application_vector_functions($1::name)',[targetRole]);
        await expect(refresh()).rejects.toThrow(/provider owner must GRANT USAGE.*WITH GRANT OPTION/i);
        expect((await target.query(`SELECT has_schema_privilege($1,$2,'USAGE') AS usage`,
          [targetRole,providerSchema])).rows).toEqual([{usage:false}]);
        if(kind==='reporting') {
          expect((await owner.query(`SELECT profile_kind FROM continuum_pgvector_role_profiles
            WHERE database_role_oid=(SELECT oid FROM pg_roles WHERE rolname=$1)`,[targetRole])).rows)
            .toEqual([]);
        }
        // A DBA/provider-owner direct grant is sufficient; the tenant owner
        // still has no grant option and no ownership transfer is required.
        await target.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(providerSchema)} TO ${quoteIdentifier(targetRole)}`);
        await expect(refresh()).resolves.toBeDefined();
        expect((await owner.query(`SELECT profile_kind FROM continuum_pgvector_role_profiles
          WHERE database_role_oid=(SELECT oid FROM pg_roles WHERE rolname=$1)`,[targetRole])).rows)
          .toEqual([{profile_kind:kind}]);
        expect((await target.query(`SELECT
          has_schema_privilege($1,$2,'USAGE WITH GRANT OPTION') AS owner_delegation,
          has_schema_privilege($3,$2,'USAGE') AS target_usage`,
          [ownerRole,providerSchema,targetRole])).rows)
          .toEqual([{owner_delegation:false,target_usage:true}]);
        if(kind==='application') {
          await expect(owner.query('SELECT continuum_assert_application_vector_profile($1::name)',[targetRole]))
            .resolves.toBeDefined();
        } else {
          const reporter=migrationPool(url,applicationSchema,targetRole);
          await expect(reconcilePgvectorProviderGrants(reporter,{expectedSchema:applicationSchema}))
            .resolves.toBeUndefined();
        }
      });
    },180_000,
  );

  it('refuses an unreviewed public provider before creating the tenant ledger', async () => {
    const previous = process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA;
    delete process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA;
    try {
      await withFreshDatabase(async (_root, target, url) => {
        const applicationSchema = identifier('continuum_data');
        await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
        await target.query('CREATE EXTENSION vector WITH SCHEMA public');
        await target.query(`
          CREATE TABLE public._continuum_migrations (
            name TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          INSERT INTO public._continuum_migrations (name) VALUES ('0001_init.sql');
        `);
        const pool = migrationPool(url, applicationSchema);

        await expect(runMigrations(
          pool, await migrationDirectoryThrough('0001_init.sql'),
        )).rejects.toThrow(/public.*shared.*provider|compatibility.*opt-in/i);
        expect((await target.query(
          `SELECT to_regclass($1) IS NULL AS no_ledger,
                  to_regclass($2) IS NULL AS no_memories`,
          [`${applicationSchema}._continuum_migrations`, `${applicationSchema}.memories`],
        )).rows).toEqual([{ no_ledger: true, no_memories: true }]);
      });
    } finally {
      if (previous === undefined) {
        delete process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA;
      } else {
        process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA = previous;
      }
    }
  });

  it('supports a DBA-owned dedicated provider for a second tenant without grant option', async () => {
    const ownerRole = identifier('continuum_owner');
    roles.push(ownerRole);
    await withFreshDatabase(async (root, target, url, database) => {
      const firstSchema = identifier('continuum_first');
      const secondSchema = identifier('continuum_second');
      await root.query(`CREATE ROLE ${quoteIdentifier(ownerRole)} NOLOGIN`);
      await target.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(ownerRole)}`,
      );
      await target.query('CREATE SCHEMA continuum_extensions');
      await target.query('CREATE EXTENSION vector WITH SCHEMA continuum_extensions');
      await target.query(
        `GRANT USAGE ON SCHEMA continuum_extensions TO ${quoteIdentifier(ownerRole)}`,
      );
      await target.query(
        `CREATE SCHEMA ${quoteIdentifier(firstSchema)} AUTHORIZATION ${quoteIdentifier(ownerRole)}`,
      );
      await target.query(
        `CREATE SCHEMA ${quoteIdentifier(secondSchema)} AUTHORIZATION ${quoteIdentifier(ownerRole)}`,
      );
      const first = migrationPool(url, firstSchema, ownerRole);
      const second = migrationPool(url, secondSchema, ownerRole);
      const directory = await migrationDirectoryThrough('0001_init.sql');

      await expect(runMigrations(first, directory)).resolves.toEqual([
        expect.objectContaining({ name: '0001_init.sql' }),
      ]);
      await expect(runMigrations(second, directory)).resolves.toEqual([
        expect.objectContaining({ name: '0001_init.sql' }),
      ]);
      expect((await target.query(
        `SELECT to_regclass($1) IS NOT NULL AS first_tenant,
                to_regclass($2) IS NOT NULL AS second_tenant`,
        [`${firstSchema}.memories`, `${secondSchema}.memories`],
      )).rows).toEqual([{ first_tenant: true, second_tenant: true }]);
    });
  });

  it('rejects a planted leading search_path entry before ledger DDL', async () => {
    await withFreshDatabase(async (_root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      const plantedSchema = identifier('continuum_planted');
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      const pool = new pg.Pool({
        connectionString: url,
        max: 1,
        options: `-c search_path=${searchPath(plantedSchema)},${searchPath(applicationSchema)}`,
      });
      pool.on('error', () => undefined);
      trackPool(pool);

      await expect(runMigrations(
        pool, await migrationDirectoryThrough('0001_init.sql'),
      )).rejects.toThrow(/search_path.*first.*exist|planted.*search_path/i);
      expect((await target.query(
        `SELECT to_regclass($1) IS NULL AS no_ledger`,
        [`${applicationSchema}._continuum_migrations`],
      )).rows).toEqual([{ no_ledger: true }]);
    });
  });

  it('verifies provider profiles at runtime startup without coupling them to privacy erasure', async () => {
    const [api, mcp, sync, offboarding] = await Promise.all([
      readFile(join(process.cwd(), 'src/api/server.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src/api/mcp.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src/identity/sync-runner.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src/services/offboarding.ts'), 'utf8'),
    ]);
    for (const source of [api, mcp, sync]) {
      expect(source).toMatch(/reconcilePgvectorProviderGrants\s*\(/);
    }
    expect(offboarding).not.toMatch(/reconcilePgvectorProviderGrants\s*\(/);
  });

  it('makes non-owner lifecycle startup enforce the registered exact profile', async () => {
    const appRole = identifier('continuum_app');
    roles.push(appRole);
    await withFreshDatabase(async (root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      await root.query(`CREATE ROLE ${quoteIdentifier(appRole)} NOLOGIN`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      const owner = migrationPool(url, applicationSchema);
      await runMigrations(owner, await fullMigrationDirectory());
      await grantApplicationRole(owner, applicationSchema, appRole);
      const runtime = migrationPool(url, applicationSchema, appRole);

      expect((await runtime.query(
        `SELECT has_function_privilege(
           current_user,
           'continuum_assert_current_pgvector_profile()'::regprocedure,
           'EXECUTE'
         ) AS executable`,
      )).rows).toEqual([{ executable: true }]);
      await expect(reconcilePgvectorProviderGrants(runtime)).resolves.toBeUndefined();

      await owner.query(
        'DELETE FROM continuum_pgvector_role_profiles WHERE database_role_oid = $1::regrole::oid',
        [appRole],
      );
      await expect(reconcilePgvectorProviderGrants(runtime)).rejects.toThrow(
        /grant\/profile drift|exact role grant profile/i,
      );
    });
  }, 240_000);

  it('accepts inherited provider EXECUTE for a registered reporting profile', async () => {
    const reporterRole = identifier('continuum_reporter');
    const providerGroup = identifier('continuum_vector_group');
    roles.push(reporterRole, providerGroup);
    await withFreshDatabase(async (root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      await root.query(`CREATE ROLE ${quoteIdentifier(providerGroup)} NOLOGIN`);
      await root.query(`CREATE ROLE ${quoteIdentifier(reporterRole)} NOLOGIN`);
      await root.query(
        `GRANT ${quoteIdentifier(providerGroup)} TO ${quoteIdentifier(reporterRole)}`,
      );
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      const owner = migrationPool(url, applicationSchema);
      await runMigrations(owner, await fullMigrationDirectory());
      await owner.query(
        `GRANT USAGE ON SCHEMA ${quoteIdentifier(applicationSchema)}
           TO ${quoteIdentifier(reporterRole)}`,
      );
      await owner.query(
        'SELECT continuum_register_pgvector_reporting_profile($1::name, TRUE)',
        [reporterRole],
      );
      await owner.query(`
        REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA continuum_extensions FROM PUBLIC;
        REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA continuum_extensions
          FROM ${quoteIdentifier(reporterRole)};
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA continuum_extensions
          TO ${quoteIdentifier(providerGroup)};
      `);
      const runtime = migrationPool(url, applicationSchema, reporterRole);

      await expect(runtime.query(
        'SELECT continuum_assert_current_pgvector_profile()',
      )).resolves.toBeDefined();
    });
  }, 240_000);

  it('preserves unrelated DBA reporting grants and permits post-0080 registration', async () => {
    const appRole = identifier('continuum_app');
    const reporterRole = identifier('continuum_reporter');
    roles.push(appRole, reporterRole);
    await withFreshDatabase(async (root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      const providerSchema = identifier('provider_extensions');
      await root.query(`CREATE ROLE ${quoteIdentifier(appRole)} NOLOGIN`);
      await root.query(`CREATE ROLE ${quoteIdentifier(reporterRole)} NOLOGIN`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(providerSchema)}`);
      await target.query(
        `CREATE EXTENSION vector WITH SCHEMA ${quoteIdentifier(providerSchema)}`,
      );
      const owner = migrationPool(url, applicationSchema);
      await runMigrations(owner, await migrationDirectoryThrough(
        '0079_coordination_upgrade_scale_remediation.sql',
      ));
      await grantApplicationRole(owner, applicationSchema, appRole);
      await owner.query(`GRANT SELECT ON memories TO ${quoteIdentifier(reporterRole)}`);
      await target.query(`
        GRANT USAGE ON SCHEMA ${quoteIdentifier(providerSchema)}
          TO ${quoteIdentifier(reporterRole)};
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${quoteIdentifier(providerSchema)}
          TO ${quoteIdentifier(reporterRole)};
      `);

      await expect(runMigrations(owner, await fullMigrationDirectory())).resolves.toEqual([
        expect.objectContaining({ name: '0080_pgvector_provider_grants.sql' }),
        expect.objectContaining({ name: '0081_coordination_public_contract.sql' }),
        expect.objectContaining({ name: '0082_coordination_linkable_audit_v7_index.sql' }),
        expect.objectContaining({ name: '0083_tag_vocabularies.sql' }),
        expect.objectContaining({ name: '0084_provider_embeddings_backfill.sql' }),
        expect.objectContaining({ name: '0085_embedding_backfill_failures.sql' }),
        expect.objectContaining({ name: '0086_embedding_backfill_failure_disposition.sql' }),
        expect.objectContaining({ name: '0087_embedding_provider_scan_index.sql' }),
        expect.objectContaining({ name: '0088_embedding_provider_scan_index_rebuild.sql' }),
        expect.objectContaining({ name: '0089_promotion_outbox.sql' }),
        expect.objectContaining({ name: '0090_standup_activity.sql' }),
        expect.objectContaining({ name: '0091_coordination_renewal_quarantine.sql' }),
      ]);
      await grantApplicationRole(owner, applicationSchema, appRole);
      await expect(owner.query(
        'SELECT continuum_assert_application_vector_profile($1::name)', [appRole],
      )).resolves.toBeDefined();
      expect((await target.query(
        `SELECT has_schema_privilege($1, $2, 'USAGE') AS usage,
                bool_and(has_function_privilege($1, function.oid, 'EXECUTE')) AS executable
           FROM pg_proc function
           JOIN pg_depend dependency
             ON dependency.classid = 'pg_proc'::regclass
            AND dependency.objid = function.oid
            AND dependency.refclassid = 'pg_extension'::regclass
            AND dependency.deptype = 'e'
           JOIN pg_extension extension ON extension.oid = dependency.refobjid
          WHERE extension.extname = 'vector'`,
        [reporterRole, providerSchema],
      )).rows).toEqual([{ usage: true, executable: true }]);
      await expect(owner.query(
        'SELECT continuum_register_pgvector_reporting_profile($1::name, TRUE)',
        [reporterRole],
      )).resolves.toBeDefined();
      expect((await target.query(
        `SELECT has_schema_privilege($1, $2, 'USAGE') AS usage,
                bool_and(has_function_privilege($1, function.oid, 'EXECUTE')) AS executable
           FROM pg_proc function
           JOIN pg_depend dependency
             ON dependency.classid = 'pg_proc'::regclass
            AND dependency.objid = function.oid
            AND dependency.refclassid = 'pg_extension'::regclass
            AND dependency.deptype = 'e'
           JOIN pg_extension extension ON extension.oid = dependency.refobjid
          WHERE extension.extname = 'vector'`,
        [reporterRole, providerSchema],
      )).rows).toEqual([{ usage: true, executable: true }]);
    });
  }, 240_000);

  it('runs the owner preflight as a real mixed-case login despite a distinct lowercase role', async () => {
    const ownerRole=identifier('Mixed_TenantOwner'); const collision=ownerRole.toLowerCase();
    const password=randomUUID(); roles.push(ownerRole,collision);
    await withFreshDatabase(async(root,target,url)=>{
      const schema=identifier('quoted_preflight');
      await root.query(`CREATE ROLE ${quoteIdentifier(ownerRole)} LOGIN PASSWORD ${quoteLiteral(password)};
        CREATE ROLE ${quoteIdentifier(collision)} NOLOGIN`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(schema)} AUTHORIZATION ${quoteIdentifier(ownerRole)};
        CREATE SCHEMA continuum_extensions; CREATE EXTENSION vector WITH SCHEMA continuum_extensions;
        GRANT USAGE ON SCHEMA continuum_extensions TO ${quoteIdentifier(ownerRole)};
        GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(collision)}`);
      const ownerUrl=new URL(url); ownerUrl.username=ownerRole; ownerUrl.password=password;
      const owner=migrationPool(ownerUrl.toString(),schema);
      await runMigrations(owner,await migrationDirectoryThrough('0001_init.sql'));
      expect((await owner.query('SELECT session_user AS role,current_user AS effective')).rows)
        .toEqual([{role:ownerRole,effective:ownerRole}]);
      const script=(await readFile(join(process.cwd(),'scripts/preflight-pgvector-role-profiles.sql'),'utf8'))
        .split(/\r?\n/).filter(line=>!line.trimStart().startsWith('\\')).join('\n')
        .replaceAll(":'continuum_schema'",quoteLiteral(schema));
      await expect(owner.query(script)).resolves.toBeDefined();
      const wrongOwner=migrationPool(url,schema,collision);
      await expect(wrongOwner.query(script)).rejects.toThrow(/requires the tenant migration owner/i);
    });
  },60_000);

  it('reports raised and lowered pre81 quotas and stored legacy totals without changing them', async () => {
    await withFreshDatabase(async(_root,target,url)=>{
      const schema=identifier('quota_report'); await target.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      const owner=migrationPool(url,schema);
      await runMigrations(owner,await migrationDirectoryThrough('0079_coordination_upgrade_scale_remediation.sql'));
      const actor=await createPrincipal(owner,{externalId:randomUUID(),kind:'user',displayName:'Quota admin'});
      const lower=await createPrincipal(owner,{externalId:randomUUID(),kind:'service',displayName:'Lowered quota'});
      const raised=await createPrincipal(owner,{externalId:randomUUID(),kind:'service',displayName:'Raised quota'});
      const org=(await getScopeByRef(owner,{kind:'org',name:''}))!;
      const scope=await createScope(owner,{kind:'project',name:'quota-report'});
      await addMembership(owner,actor.id,org.id,'admin');
      await owner.query('SELECT continuum_operator_set_coordination_principal_quota($1,$2,100,2000)',[actor.id,lower.id]);
      await owner.query('SELECT continuum_operator_set_coordination_principal_quota($1,$2,50000,5000)',[actor.id,raised.id]);
      await owner.query('SELECT continuum_operator_set_coordination_scope_quota($1,$2,50000)',[actor.id,scope.id]);
      // Valid pre81 stored rows go through the installed counter/retention
      // triggers; no counter values, constraints or triggers are manufactured.
      // The old INSERT counter purges already-expired acquire receipts before
      // each insert. Insert the live row first so the final expired row remains
      // physically stored without bypassing that published cleanup behavior.
      await owner.query("INSERT INTO coordination_resources(scope_id,resource) VALUES($1,'legacy')",[scope.id]);
      await owner.query(`WITH moment AS MATERIALIZED(SELECT clock_timestamp() AS at), times AS (
        SELECT CASE WHEN value=1 THEN moment.at-interval '1 hour' ELSE moment.at END AS at
        FROM moment CROSS JOIN generate_series(1,2) value)
        INSERT INTO coordination_operation_receipts(principal_id,operation,request_id,payload_hash,outcome,
          scope_id,resource,expires_at,retry_after_seconds,server_time,retain_until)
        SELECT $1,'acquire',gen_random_uuid(),decode(repeat('a',64),'hex'),'contended',$2,'legacy',
          at+interval '1 hour',1,at,at+interval '90 seconds' FROM times ORDER BY at DESC`,[lower.id,scope.id]);
      const physicalBefore=(await owner.query(`SELECT count(*)::int AS stored_rows,
        count(*) FILTER(WHERE outcome='contended')::int AS contended_rows,
        count(*) FILTER(WHERE retain_until<=clock_timestamp()
          AND server_time>clock_timestamp()-interval '24 hours')::int AS recent_expired_rows
        FROM coordination_operation_receipts WHERE principal_id=$1`,[lower.id])).rows;
      expect(physicalBefore).toEqual([{stored_rows:2,contended_rows:2,recent_expired_rows:1}]);
      const before=(await owner.query('SELECT to_jsonb(usage) AS value FROM coordination_principal_usage usage ORDER BY principal_id')).rows;
      const receiptsBefore=(await owner.query(`SELECT to_jsonb(receipt) AS value
        FROM coordination_operation_receipts receipt ORDER BY principal_id,operation,request_id`)).rows;
      const source=await readFile(join(process.cwd(),'scripts/preflight-coordination-contract.sql'),'utf8');
      const sql=source.split(/\r?\n/).filter(line=>!line.trimStart().startsWith('\\')).join('\n')
        .replaceAll(":'continuum_schema'",quoteLiteral(schema))
        .replaceAll(":'continuum_preflight_limit'","'100'")
        .replaceAll(":'continuum_after_principal_id'","''")
        .replaceAll(":'continuum_after_scope_id'","''");
      const client=await owner.connect(); const reports:Record<string,unknown>[]=[];
      const notice=(message:{message?:string})=>{
        if(message.message?.startsWith('{')) reports.push(JSON.parse(message.message));
      };
      client.on('notice',notice);
      try { await client.query(sql); }
      finally { client.removeListener('notice',notice); client.release(); }
      expect(reports.find(row=>row.report==='principal'&&row.principal_id===lower.id)).toMatchObject({
        configured_acquire_limit:100,legacy_contended_limit:2000,proposed_combined_limit:100,
        stored_rows:2,contended_rows:2,recent_expired_rows:1});
      expect(reports.find(row=>row.report==='principal'&&row.principal_id===raised.id)).toMatchObject({
        configured_acquire_limit:50000,legacy_contended_limit:5000,proposed_combined_limit:10000});
      expect(reports.find(row=>row.report==='scope'&&row.scope_id===scope.id)).toMatchObject({
        configured_resource_limit:50000,proposed_resource_limit:10000,stored_keys:1});
      expect((await owner.query('SELECT to_jsonb(usage) AS value FROM coordination_principal_usage usage ORDER BY principal_id')).rows)
        .toEqual(before);
      expect((await owner.query(`SELECT to_jsonb(receipt) AS value
        FROM coordination_operation_receipts receipt ORDER BY principal_id,operation,request_id`)).rows)
        .toEqual(receiptsBefore);
      expect((await owner.query("SELECT name FROM _continuum_migrations WHERE name='0081_coordination_public_contract.sql'")).rows)
        .toEqual([]);
    });
  },120_000);

  it('provider review: inventories non-profile readers without granting application authority', async () => {
    const readerRole = identifier('continuum_reader_preflight');
    roles.push(readerRole);
    await withFreshDatabase(async (root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      await root.query(`CREATE ROLE ${quoteIdentifier(readerRole)} NOLOGIN`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      const owner = migrationPool(url, applicationSchema);
      await runMigrations(owner, await fullMigrationDirectory());
      await owner.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(applicationSchema)} TO ${quoteIdentifier(readerRole)}`);
      await owner.query(`GRANT SELECT ON memories TO ${quoteIdentifier(readerRole)}`);
      const source = await readFile(
        join(process.cwd(), 'scripts/preflight-pgvector-role-profiles.sql'), 'utf8',
      );
      const sql = source.split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith('\\')).join('\n')
        .replaceAll(":'continuum_schema'", quoteLiteral(applicationSchema));
      const client = await owner.connect();
      const messages: string[] = [];
      const onNotice = (notice: { message?: string }) => { messages.push(notice.message ?? ''); };
      client.on('notice', onNotice);
      try {
        await client.query(sql);
      } finally {
        client.removeListener('notice', onNotice);
        client.release();
      }
      expect(messages.some((message) => message.includes(readerRole)
        && message.includes('lacks an exact'))).toBe(true);
      expect((await owner.query(
        `SELECT has_table_privilege($1, 'memories', 'INSERT') AS write,
                has_schema_privilege($1, 'continuum_extensions', 'USAGE') AS provider_usage,
                EXISTS (SELECT 1 FROM continuum_pgvector_role_profiles
                         WHERE database_role_oid = $1::regrole::oid) AS registered`,
        [readerRole],
      )).rows).toEqual([{ write: false, provider_usage: false, registered: false }]);
    });
  }, 240_000);

  it('provider review: preserves pre-0080 sync identities without a regrant', async () => {
    const syncRole = identifier('continuum_sync_upgrade');
    const syncPassword = randomUUID();
    roles.push(syncRole);
    await withFreshDatabase(async (root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      const principalId = randomUUID();
      await root.query(`CREATE ROLE ${quoteIdentifier(syncRole)} LOGIN PASSWORD ${quoteLiteral(syncPassword)}`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      const owner = migrationPool(url, applicationSchema);
      await runMigrations(owner, await migrationDirectoryThrough(
        '0079_coordination_upgrade_scale_remediation.sql',
      ));
      await owner.query(
        `INSERT INTO principals (id, external_id, kind, display_name)
         VALUES ($1, $2, 'service', 'Pre-upgrade sync')`,
        [principalId, `sync-${principalId}`],
      );
      await owner.query(
        'SELECT continuum_register_trusted_database_identity($1::name, $2::uuid, FALSE, TRUE)',
        [syncRole, principalId],
      );
      await runMigrations(owner, await fullMigrationDirectory());
      // The sync trust boundary requires a real role-authenticated session;
      // a superuser connection using SET ROLE intentionally does not qualify.
      const syncUrl = new URL(url);
      syncUrl.username = syncRole;
      syncUrl.password = syncPassword;
      const runtime = migrationPool(syncUrl.toString(), applicationSchema);
      await expect(reconcilePgvectorProviderGrants(runtime)).resolves.toBeUndefined();
      expect((await owner.query(
        `SELECT profile_kind FROM continuum_pgvector_role_profiles
          WHERE database_role_oid = $1::regrole::oid`, [syncRole],
      )).rows).toEqual([{ profile_kind: 'sync' }]);
      await expect(runtime.query(
        'SELECT continuum_verify_sync_database_identity($1::uuid)', [principalId],
      )).resolves.toBeDefined();
    });
  }, 240_000);

  it('provider review: keeps the LOGIN guard on the installed sync function', async () => {
    const syncRole = identifier('continuum_sync_nologin');
    roles.push(syncRole);
    await withFreshDatabase(async (root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      const principalId = randomUUID();
      await root.query(`CREATE ROLE ${quoteIdentifier(syncRole)} NOLOGIN`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      const owner = migrationPool(url, applicationSchema);
      await runMigrations(owner, await fullMigrationDirectory());
      await owner.query(
        `INSERT INTO principals (id, external_id, kind, display_name)
         VALUES ($1, $2, 'service', 'Invalid sync')`,
        [principalId, `sync-${principalId}`],
      );
      await expect(owner.query(
        'SELECT continuum_register_trusted_database_identity($1::name, $2::uuid, FALSE, TRUE)',
        [syncRole, principalId],
      )).rejects.toThrow(/LOGIN-capable/i);
      expect((await owner.query(
        'SELECT count(*)::int AS count FROM continuum_trusted_database_identities',
      )).rows).toEqual([{ count: 0 }]);
    });
  }, 240_000);

  it('provider review: owner startup detects drift without revoking live provider grants', async () => {
    const appRole = identifier('continuum_app_drift');
    roles.push(appRole);
    await withFreshDatabase(async (root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      await root.query(`CREATE ROLE ${quoteIdentifier(appRole)} NOLOGIN`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      const owner = migrationPool(url, applicationSchema);
      await runMigrations(owner, await fullMigrationDirectory());
      await grantApplicationRole(owner, applicationSchema, appRole);
      await owner.query(`REVOKE SELECT ON memories FROM ${quoteIdentifier(appRole)}`);
      await expect(reconcilePgvectorProviderGrants(owner)).rejects.toThrow(/exact|profile/i);
      expect((await owner.query(
        `SELECT has_schema_privilege($1, 'continuum_extensions', 'USAGE') AS usage,
                EXISTS (SELECT 1 FROM continuum_pgvector_role_profiles
                         WHERE database_role_oid = $1::regrole::oid) AS registered`,
        [appRole],
      )).rows).toEqual([{ usage: true, registered: true }]);
    });
  }, 240_000);

  it('provider review: owner startup fails fast behind an online migrator', async () => {
    await withFreshDatabase(async (_root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      const owner = migrationPool(url, applicationSchema);
      await runMigrations(owner, await fullMigrationDirectory());
      const startup = migrationPool(url, applicationSchema);
      const blocker = await owner.connect();
      try {
        await blocker.query('SELECT pg_advisory_lock(7215328273579717613::bigint)');
        // An existing server timeout bounds the RED test too. A correct gate
        // rejects immediately with lock_not_available, before that timer fires.
        await startup.query("SET statement_timeout = '250ms'");
        await expect(reconcilePgvectorProviderGrants(startup)).rejects.toMatchObject({
          code: '55P03',
        });
        await blocker.query(`CREATE INDEX CONCURRENTLY provider_review_live_memory_idx
                             ON memories (id) WHERE state = 'live'`);
      } finally {
        await blocker.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
        blocker.release();
      }
    });
  }, 240_000);

  it('keeps sync profile registration across owner reconciliation', async () => {
    const syncRole = identifier('continuum_sync');
    roles.push(syncRole);
    await withFreshDatabase(async (root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      const principalId = randomUUID();
      await root.query(`CREATE ROLE ${quoteIdentifier(syncRole)} LOGIN`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      const owner = migrationPool(url, applicationSchema);
      await runMigrations(owner, await fullMigrationDirectory());
      await owner.query(
        `INSERT INTO principals (id, external_id, kind, display_name)
         VALUES ($1, $2, 'service', 'Sync lifecycle test')`,
        [principalId, `sync-${principalId}`],
      );
      await grantSyncRole(owner, applicationSchema, syncRole, principalId);

      await expect(owner.query(
        'SELECT continuum_grant_application_vector_functions()',
      )).resolves.toBeDefined();
      expect((await owner.query(
        `SELECT profile_kind FROM continuum_pgvector_role_profiles
          WHERE database_role_oid = $1::regrole::oid`,
        [syncRole],
      )).rows).toEqual([{ profile_kind: 'sync' }]);
      const runtime = migrationPool(url, applicationSchema, syncRole);
      expect((await runtime.query(
        `SELECT has_function_privilege(
           current_user,
           'continuum_assert_current_pgvector_profile()'::regprocedure,
           'EXECUTE'
         ) AS executable`,
      )).rows).toEqual([{ executable: true }]);
      await expect(reconcilePgvectorProviderGrants(runtime)).resolves.toBeUndefined();
    });
  }, 240_000);

  it('resolves an existing default $user schema before ledger creation', async () => {
    const ownerRole = identifier('continuum_owner');
    roles.push(ownerRole);
    await withFreshDatabase(async (root, target, url, database) => {
      await root.query(`CREATE ROLE ${quoteIdentifier(ownerRole)} NOLOGIN`);
      await target.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(ownerRole)}`,
      );
      await target.query(
        `CREATE SCHEMA ${quoteIdentifier(ownerRole)} AUTHORIZATION ${quoteIdentifier(ownerRole)}`,
      );
      await target.query(`
        CREATE SCHEMA continuum_extensions;
        CREATE EXTENSION vector WITH SCHEMA continuum_extensions;
        GRANT USAGE ON SCHEMA continuum_extensions TO ${quoteIdentifier(ownerRole)};
      `);
      const pool = new pg.Pool({
        connectionString: url,
        max: 1,
        options: `-c search_path=\"$user\",public -c role=${ownerRole}`,
      });
      pool.on('error', () => undefined);
      trackPool(pool);

      await expect(runMigrations(
        pool, await migrationDirectoryThrough('0001_init.sql'),
      )).resolves.toEqual([expect.objectContaining({ name: '0001_init.sql' })]);
      expect((await target.query(
        `SELECT to_regclass($1) IS NOT NULL AS ledger`,
        [`${ownerRole}._continuum_migrations`],
      )).rows).toEqual([{ ledger: true }]);
    });
  }, 180_000);

  it('rejects an attacker-owned leading schema even for a superuser migrator', async () => {
    const attackerRole = identifier('continuum_attacker');
    roles.push(attackerRole);
    await withFreshDatabase(async (root, target, url) => {
      const plantedSchema = identifier('continuum_planted');
      const applicationSchema = identifier('continuum_data');
      await root.query(`CREATE ROLE ${quoteIdentifier(attackerRole)} NOLOGIN`);
      await target.query(
        `CREATE SCHEMA ${quoteIdentifier(plantedSchema)} AUTHORIZATION ${quoteIdentifier(attackerRole)}`,
      );
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      const pool = new pg.Pool({
        connectionString: url,
        max: 1,
        options: `-c search_path=${searchPath(plantedSchema)},${searchPath(applicationSchema)}`,
      });
      pool.on('error', () => undefined);
      trackPool(pool);

      await expect(runMigrations(
        pool, await migrationDirectoryThrough('0001_init.sql'),
      )).rejects.toThrow(/owner-controlled|attacker-owned|search_path/i);
      expect((await target.query(
        `SELECT to_regclass($1) IS NULL AS planted_ledger,
                to_regclass($2) IS NULL AS application_ledger`,
        [`${plantedSchema}._continuum_migrations`, `${applicationSchema}._continuum_migrations`],
      )).rows).toEqual([{ planted_ledger: true, application_ledger: true }]);
    });
  });

  it('rejects an already-ledgered attacker-owned leading schema on upgrade', async () => {
    const attackerRole = identifier('continuum_attacker');
    roles.push(attackerRole);
    await withFreshDatabase(async (root, target, url) => {
      const plantedSchema = identifier('continuum_planted');
      await root.query(`CREATE ROLE ${quoteIdentifier(attackerRole)} NOLOGIN`);
      await target.query(
        `CREATE SCHEMA ${quoteIdentifier(plantedSchema)} AUTHORIZATION ${quoteIdentifier(attackerRole)}`,
      );
      await target.query(`
        SET ROLE ${quoteIdentifier(attackerRole)};
        CREATE TABLE ${quoteIdentifier(plantedSchema)}._continuum_migrations (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        INSERT INTO ${quoteIdentifier(plantedSchema)}._continuum_migrations (name)
        VALUES ('0001_init.sql');
        RESET ROLE;
      `);
      const pool = new pg.Pool({
        connectionString: url,
        max: 1,
        options: `-c search_path=${searchPath(plantedSchema)},public`,
      });
      pool.on('error', () => undefined);
      trackPool(pool);

      await expect(runMigrations(pool, await fullMigrationDirectory()))
        .rejects.toThrow(/owner-controlled|attacker-owned|search_path/i);
      expect((await target.query(
        `SELECT array_agg(name ORDER BY name) AS names,
                to_regclass($1) IS NULL AS no_principals
           FROM ${quoteIdentifier(plantedSchema)}._continuum_migrations`,
        [`${plantedSchema}.principals`],
      )).rows).toEqual([{ names: ['0001_init.sql'], no_principals: true }]);
    });
  });

  it('skips owner provider catalog reconciliation before 0080 is ledgered', async () => {
    await withFreshDatabase(async (_root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      const owner = migrationPool(url, applicationSchema);
      await runMigrations(owner, await migrationDirectoryThrough(
        '0079_coordination_upgrade_scale_remediation.sql',
      ));

      await expect(reconcilePgvectorProviderGrants(owner)).resolves.toBeUndefined();
    });
  }, 240_000);

  it('refuses owner startup verification while a migration holds the advisory lock', async () => {
    await withFreshDatabase(async (_root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      await target.query(`CREATE SCHEMA ${quoteIdentifier(applicationSchema)}`);
      const owner = migrationPool(url, applicationSchema);
      const startup = migrationPool(url, applicationSchema);
      await runMigrations(owner, await fullMigrationDirectory());
      const blocker = await owner.connect();
      try {
        await blocker.query('SELECT pg_advisory_lock(7215328273579717613::bigint)');
        await expect(reconcilePgvectorProviderGrants(startup)).rejects.toMatchObject({
          code: '55P03',
        });
        await blocker.query('SELECT pg_advisory_unlock(7215328273579717613::bigint)');
        await expect(reconcilePgvectorProviderGrants(startup)).resolves.toBeUndefined();
      } finally {
        await blocker.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
        blocker.release();
      }
    });
  }, 240_000);

  it('refuses a second tenant binding to a self-bootstrapped provider after its tenant owner loses superuser', async () => {
    const firstRole=identifier('bootstrap_tenant_owner');
    const secondRole=identifier('bootstrap_second_owner'); roles.push(firstRole,secondRole);
    await withFreshDatabase(async(root,target,url,database)=>{
      const firstSchema=identifier('bootstrap_first'); const secondSchema=identifier('bootstrap_second');
      await root.query(`CREATE ROLE ${quoteIdentifier(firstRole)} NOLOGIN SUPERUSER;
        CREATE ROLE ${quoteIdentifier(secondRole)} NOLOGIN`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(firstSchema)} AUTHORIZATION ${quoteIdentifier(firstRole)};
        CREATE SCHEMA ${quoteIdentifier(secondSchema)} AUTHORIZATION ${quoteIdentifier(secondRole)};
        GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(firstRole)},${quoteIdentifier(secondRole)}`);
      const first=migrationPool(url,firstSchema,firstRole);
      const second=migrationPool(url,secondSchema,secondRole);
      const directory=await migrationDirectoryThrough('0001_init.sql');
      await runMigrations(first,directory);
      expect((await target.query(`SELECT extension.extowner=role.oid AS extension_owned,
        namespace.nspowner=role.oid AS schema_owned FROM pg_extension extension
        JOIN pg_namespace namespace ON namespace.oid=extension.extnamespace
        JOIN pg_roles role ON role.rolname=$1 WHERE extension.extname='vector'`,[firstRole])).rows)
        .toEqual([{extension_owned:true,schema_owned:true}]);
      await root.query(`ALTER ROLE ${quoteIdentifier(firstRole)} NOSUPERUSER`);
      await target.query(`GRANT USAGE ON SCHEMA continuum_extensions TO ${quoteIdentifier(secondRole)}`);
      expect((await target.query('SELECT rolsuper FROM pg_roles WHERE rolname=$1',[firstRole])).rows)
        .toEqual([{rolsuper:false}]);
      await expect(runMigrations(second,directory)).rejects.toThrow(/provider.*owner.*another Continuum|another Continuum.*provider.*owner/i);
      expect((await target.query("SELECT to_regclass(format('%I._continuum_migrations',$1::text)) AS ledger",[secondSchema])).rows)
        .toEqual([{ledger:null}]);
      const previous=process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA;
      process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA='1';
      try { await expect(runMigrations(second,directory)).resolves.toHaveLength(1); }
      finally {
        if(previous===undefined) delete process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA;
        else process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA=previous;
      }
    });
  },60_000);

  it('rejects non-owner CREATE drift on an existing ledger before provenance or migration DDL', async () => {
    const writer=identifier('schema_create_drift'); roles.push(writer);
    await withFreshDatabase(async(root,target,url)=>{
      const schema=identifier('existing_create_drift');
      await root.query(`CREATE ROLE ${quoteIdentifier(writer)} NOLOGIN`);
      await target.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      const owner=migrationPool(url,schema);
      const directory=await migrationDirectoryThrough('0001_init.sql');
      await runMigrations(owner,directory);
      await target.query(`GRANT CREATE ON SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(writer)}`);
      const submitted:string[]=[]; const connect=owner.connect.bind(owner);
      const wrapped={connect:async()=>{
        const client=await connect(); const query=client.query.bind(client);
        return {query:async(sql:string,values?:unknown[])=>{submitted.push(sql); return query(sql,values);},
          release:(discard?:boolean)=>client.release(discard)};
      }} as unknown as pg.Pool;
      await expect(runMigrations(wrapped,directory)).rejects.toThrow(/revoke.*CREATE.*owner.*retry/i);
      expect(submitted.some(sql=>/CREATE TABLE|ALTER TABLE|CREATE FUNCTION|DO \$trust\$/i.test(sql))).toBe(false);
      expect((await target.query(`SELECT privilege_type FROM pg_namespace namespace
        CROSS JOIN LATERAL aclexplode(namespace.nspacl) privilege
        WHERE namespace.nspname=$1 AND privilege.grantee=(SELECT oid FROM pg_roles WHERE rolname=$2)
          AND privilege.privilege_type='CREATE'`,[schema,writer])).rows).toHaveLength(1);
    });
  },60_000);

  it('keeps a second tenant live while separate owners and apps cross 0080', async () => {
    const firstOwnerRole = identifier('continuum_owner_a');
    const secondOwnerRole = identifier('continuum_owner_b');
    const firstAppRole = identifier('continuum_app_a');
    const secondAppRole = identifier('continuum_app_b');
    roles.push(firstAppRole, secondAppRole, firstOwnerRole, secondOwnerRole);
    await withFreshDatabase(async (root, target, url, database) => {
      const firstSchema = identifier('continuum_tenant_a');
      const secondSchema = identifier('continuum_tenant_b');
      await root.query(`
        CREATE ROLE ${quoteIdentifier(firstOwnerRole)} NOLOGIN;
        CREATE ROLE ${quoteIdentifier(secondOwnerRole)} NOLOGIN;
        CREATE ROLE ${quoteIdentifier(firstAppRole)} NOLOGIN;
        CREATE ROLE ${quoteIdentifier(secondAppRole)} NOLOGIN;
      `);
      await target.query(`
        GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO
          ${quoteIdentifier(firstOwnerRole)}, ${quoteIdentifier(secondOwnerRole)},
          ${quoteIdentifier(firstAppRole)}, ${quoteIdentifier(secondAppRole)};
        CREATE SCHEMA ${quoteIdentifier(firstSchema)} AUTHORIZATION ${quoteIdentifier(firstOwnerRole)};
        CREATE SCHEMA ${quoteIdentifier(secondSchema)} AUTHORIZATION ${quoteIdentifier(secondOwnerRole)};
        CREATE SCHEMA continuum_extensions AUTHORIZATION ${quoteIdentifier(firstOwnerRole)};
        CREATE EXTENSION vector WITH SCHEMA continuum_extensions;
        GRANT USAGE ON SCHEMA continuum_extensions TO PUBLIC;
      `);
      await target.query(`
        DO $ownership$
        DECLARE member RECORD;
        BEGIN
          FOR member IN
            SELECT format('%I.%I(%s)', namespace.nspname, function.proname,
                          pg_get_function_identity_arguments(function.oid)) AS signature
              FROM pg_proc function
              JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
              JOIN pg_depend dependency
                ON dependency.classid = 'pg_proc'::regclass
               AND dependency.objid = function.oid
               AND dependency.refclassid = 'pg_extension'::regclass
               AND dependency.deptype = 'e'
              JOIN pg_extension extension ON extension.oid = dependency.refobjid
             WHERE extension.extname = 'vector'
          LOOP
            EXECUTE format('ALTER FUNCTION %s OWNER TO %I',
              member.signature, ${quoteLiteral(firstOwnerRole)});
          END LOOP;
        END
        $ownership$;
      `);
      const firstOwner = migrationPool(url, firstSchema, firstOwnerRole);
      const secondOwner = migrationPool(url, secondSchema, secondOwnerRole);
      const through0079 = await migrationDirectoryThrough(
        '0079_coordination_upgrade_scale_remediation.sql',
      );
      await runMigrations(firstOwner, through0079);
      await target.query(`
        GRANT USAGE ON SCHEMA continuum_extensions
          TO ${quoteIdentifier(secondOwnerRole)} WITH GRANT OPTION;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA continuum_extensions
          TO ${quoteIdentifier(secondOwnerRole)} WITH GRANT OPTION;
      `);
      // This deliberately tenant-owned provider is a reviewed legacy topology;
      // ordinary shared installations use an independent provider owner.
      const previousShared=process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA;
      process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA='1';
      try { await runMigrations(secondOwner, through0079); }
      finally {
        if(previousShared===undefined) delete process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA;
        else process.env.CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA=previousShared;
      }
      await grantApplicationRole(firstOwner, firstSchema, firstAppRole);
      await grantApplicationRole(secondOwner, secondSchema, secondAppRole);

      const firstIds = {
        principal: randomUUID(), scope: randomUUID(), memory: randomUUID(),
      };
      const secondIds = {
        principal: randomUUID(), scope: randomUUID(), memory: randomUUID(),
      };
      for (const [pool, ids, suffix] of [
        [firstOwner, firstIds, 'a'],
        [secondOwner, secondIds, 'b'],
      ] as const) {
        await pool.query(
          `INSERT INTO principals (id, external_id, kind, display_name)
           VALUES ($1, $2, 'user', $2)`,
          [ids.principal, `tenant-${suffix}`],
        );
        await pool.query(
          `INSERT INTO scopes (id, kind, name) VALUES ($1, 'project', $2)`,
          [ids.scope, `tenant-${suffix}`],
        );
        await pool.query(
          `INSERT INTO memories (id, scope_id, type, title, body, author_id, source)
           VALUES ($1, $2, 'fact', $3, 'shared provider', $4, 'test')`,
          [ids.memory, ids.scope, `Tenant ${suffix}`, ids.principal],
        );
        // This deliberate pre-0080 window retains the single-memory key.
        // Seed through its compatible INSERT and the normal live-memory trigger;
        // exercise the current composite-key writer only after the full upgrade.
        await pool.query(`INSERT INTO memory_embeddings(memory_id,provider,dim,embedding)
          VALUES($1::uuid,'test:shared-provider',768,$2::continuum_extensions.vector)`,
        [ids.memory, `[${[1, ...Array(767).fill(0)].join(',')}]`]);
      }
      const secondRuntime = new pg.Pool({
        connectionString: url,
        max: 1,
        options: `-c search_path=${searchPath(secondSchema)},continuum_extensions -c role=${secondAppRole}`,
      });
      secondRuntime.on('error', () => undefined);
      trackPool(secondRuntime);
      await expect(vectorSearchMemoryIds(
        secondRuntime, [1, ...Array(767).fill(0)], [secondIds.scope],
        { id: 'test:shared-provider', dim: 768 }, 5,
      )).resolves.toEqual([{ id: secondIds.memory, distance: 0 }]);

      await runMigrations(firstOwner, await fullMigrationDirectory());
      await expect(vectorSearchMemoryIds(
        secondRuntime, [1, ...Array(767).fill(0)], [secondIds.scope],
        { id: 'test:shared-provider', dim: 768 }, 5,
      )).resolves.toEqual([{ id: secondIds.memory, distance: 0 }]);

      await runMigrations(secondOwner, await fullMigrationDirectory());
      const firstRuntime = migrationPool(url, firstSchema, firstAppRole);
      for (const [runtime, ids] of [[firstRuntime, firstIds], [secondRuntime, secondIds]] as const) {
        await expect(storeMemoryEmbeddingVector(runtime, ids.memory, [1, ...Array(767).fill(0)],
          { id: 'test:shared-provider', dim: 768 })).resolves.toBe(true);
      }
      await expect(vectorSearchMemoryIds(
        firstRuntime, [1, ...Array(767).fill(0)], [firstIds.scope],
        { id: 'test:shared-provider', dim: 768 }, 5,
      )).resolves.toEqual([{ id: firstIds.memory, distance: 0 }]);
      await expect(vectorSearchMemoryIds(
        secondRuntime, [1, ...Array(767).fill(0)], [secondIds.scope],
        { id: 'test:shared-provider', dim: 768 }, 5,
      )).resolves.toEqual([{ id: secondIds.memory, distance: 0 }]);
    });
  }, 360_000);
});
