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

const DATABASE_URL =
  process.env.CONTINUUM_TEST_DATABASE_URL ??
  'postgres://continuum:***@localhost:5433/continuum';

const pools: pg.Pool[] = [];
const directories: string[] = [];
const roles: string[] = [];

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
  pools.push(pool);
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
    .replaceAll(':"continuum_app_role"', quoteIdentifier(role))
    .replaceAll(
      ":'continuum_app_role'",
      `'${role.replaceAll("'", "''")}'`,
    );
  await pool.query(sql);
}

async function withFreshDatabase(
  run: (root: pg.Pool, target: pg.Pool, url: string, database: string) => Promise<void>,
): Promise<void> {
  const database = identifier('continuum_pgvector_rollout');
  const root = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  pools.push(root);
  await root.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
  const url = databaseUrl(database);
  const target = new pg.Pool({ connectionString: url, max: 1 });
  target.on('error', () => undefined);
  pools.push(target);
  try {
    await run(root, target, url, database);
  } finally {
    const databasePools = pools.filter((pool) => pool !== root && pool !== target);
    await Promise.all(databasePools.map((pool) => pool.end().catch(() => undefined)));
    for (const pool of databasePools) pools.splice(pools.indexOf(pool), 1);
    await target.end().catch(() => undefined);
    pools.splice(pools.indexOf(target), 1);
    await root.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`);
  }
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end().catch(() => undefined)));
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
  if (roles.length > 0) {
    const root = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    try {
      for (const role of roles.splice(0)) {
        await root.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
      }
    } finally {
      await root.end();
    }
  }
});

describe('pgvector rollout remediation', () => {
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
  });

  it('rejects an empty migration search_path before creating a ledger', async () => {
    await withFreshDatabase(async (_root, target, url) => {
      const pool = new pg.Pool({
        connectionString: url,
        max: 1,
        options: '-c search_path=',
      });
      pool.on('error', () => undefined);
      pools.push(pool);
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
      ]);
      expect((await target.query(
        `SELECT has_schema_privilege($1, $2, 'USAGE') AS app_usage,
                has_schema_privilege($3, $2, 'USAGE') AS outsider_usage`,
        [appRole, providerSchema, outsider],
      )).rows).toEqual([{ app_usage: true, outsider_usage: false }]);
    });
  }, 240_000);
});
