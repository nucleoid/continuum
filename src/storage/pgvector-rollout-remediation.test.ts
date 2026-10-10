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
      ]);
      expect((await target.query(
        `SELECT has_schema_privilege($1, 'public', 'USAGE') AS app_usage,
                has_schema_privilege($2, 'public', 'USAGE') AS outsider_usage`,
        [appRole, outsider],
      )).rows).toEqual([{ app_usage: true, outsider_usage: false }]);
    });
  }, 240_000);

  it('reconciles exact provider grants across drift, rerun, and role revocation', async () => {
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
      `)).rows).toEqual([{ public_usage: false, public_execute: false }]);

      await pool.query(
        `GRANT CREATE ON SCHEMA continuum_extensions TO ${quoteIdentifier(appRole)}`,
      );
      await expect(pool.query(
        'SELECT continuum_assert_application_vector_profile($1::name)', [appRole],
      )).rejects.toThrow(/forbidden CREATE/i);
      await pool.query(
        `REVOKE CREATE ON SCHEMA continuum_extensions FROM ${quoteIdentifier(appRole)}`,
      );

      await pool.query(
        `REVOKE USAGE ON SCHEMA continuum_extensions FROM ${quoteIdentifier(appRole)}`,
      );
      await expect(pool.query(
        'SELECT continuum_assert_application_vector_profile($1::name)', [appRole],
      )).rejects.toThrow(/missing effective USAGE/i);
      await pool.query('SELECT continuum_grant_application_vector_functions()');
      await pool.query('SELECT continuum_grant_application_vector_functions()');

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
      await pool.query('SELECT continuum_grant_application_vector_functions()');
      expect((await pool.query(
        `SELECT has_schema_privilege($1, 'continuum_extensions', 'USAGE') AS usage,
                EXISTS (
                  SELECT 1 FROM continuum_pgvector_role_profiles
                   WHERE database_role_oid = $1::regrole::oid
                ) AS registered`,
        [appRole],
      )).rows).toEqual([{ usage: false, registered: false }]);
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
      ]);
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
      ]);
      await expect(owner.query(
        'SELECT continuum_assert_application_vector_profile($1::name)', [appRole],
      )).resolves.toBeDefined();
    });
  }, 240_000);

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
      pools.push(pool);

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
      ]);
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
    roles.push(syncRole);
    await withFreshDatabase(async (root, target, url) => {
      const applicationSchema = identifier('continuum_data');
      const principalId = randomUUID();
      await root.query(`CREATE ROLE ${quoteIdentifier(syncRole)} LOGIN`);
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
      const runtime = migrationPool(url, applicationSchema, syncRole);
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
      pools.push(pool);

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
      pools.push(pool);

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
      pools.push(pool);

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
      await runMigrations(secondOwner, through0079);
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
        await storeMemoryEmbeddingVector(
          pool, ids.memory, [1, ...Array(767).fill(0)],
          { id: 'test:shared-provider', dim: 768 },
        );
      }
      const secondRuntime = new pg.Pool({
        connectionString: url,
        max: 1,
        options: `-c search_path=${searchPath(secondSchema)},continuum_extensions -c role=${secondAppRole}`,
      });
      secondRuntime.on('error', () => undefined);
      pools.push(secondRuntime);
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
