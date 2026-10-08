import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  storeMemoryEmbeddingVector,
  vectorSearchMemoryIds,
  vectorSearchRelatedMemories,
} from './embeddings.js';
import { runMigrations } from './migrator.js';

const DATABASE_URL =
  process.env.CONTINUUM_TEST_DATABASE_URL ??
  'postgres://continuum:continuum@localhost:5433/continuum';

function identifier(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function databaseUrl(database: string): string {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function initDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-pgvector-contract-'));
  await copyFile(
    join(process.cwd(), 'migrations/0001_init.sql'),
    join(directory, '0001_init.sql'),
  );
  return directory;
}

async function withFreshDatabase(
  run: (
    root: pg.Pool,
    target: pg.Pool,
    url: string,
    database: string,
    directory: string,
  ) => Promise<void>,
): Promise<void> {
  const database = identifier('continuum_pgvector');
  const directory = await initDirectory();
  const root = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  let target: pg.Pool | undefined;
  try {
    await root.query(`CREATE DATABASE "${database}"`);
    const url = databaseUrl(database);
    target = new pg.Pool({ connectionString: url, max: 1 });
    await run(root, target, url, database, directory);
  } finally {
    await target?.end().catch(() => undefined);
    await root.query(`DROP DATABASE IF EXISTS "${database}"`)
      .catch(() => undefined);
    await root.end();
    await rm(directory, { recursive: true, force: true });
  }
}

function migrationPool(url: string, searchPath: string, role?: string): pg.Pool {
  const roleOption = role ? ` -c role=${role}` : '';
  return new pg.Pool({
    connectionString: url,
    max: 1,
    options: `-c search_path=${searchPath}${roleOption}`,
  });
}

describe('pgvector schema contract', () => {
  it('uses an existing non-public extension for a fresh custom-schema migration', async () => {
    await withFreshDatabase(async (_root, target, url, _database, directory) => {
      const applicationSchema = identifier('continuum_app');
      const extensionSchema = identifier('continuum_extensions');
      await target.query(`CREATE SCHEMA "${applicationSchema}"`);
      await target.query(`CREATE SCHEMA "${extensionSchema}"`);
      await target.query(`CREATE EXTENSION vector WITH SCHEMA "${extensionSchema}"`);
      const pool = migrationPool(url, applicationSchema);
      try {
        await expect(runMigrations(pool, directory))
          .resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({ name: '0001_init.sql' }),
          ]));
        expect((await pool.query(
          `SELECT atttypid::regtype::text AS type
             FROM pg_attribute
            WHERE attrelid = 'memory_embeddings'::regclass
              AND attname = 'embedding'`,
        )).rows).toEqual([{ type: `${extensionSchema}.vector` }]);
      } finally {
        await pool.end();
      }
    });
  }, 120_000);

  it('does not brick an already-ledgered database with vector outside public', async () => {
    await withFreshDatabase(async (_root, target, url, _database, directory) => {
      const applicationSchema = identifier('continuum_app');
      const extensionSchema = identifier('continuum_extensions');
      await target.query(`CREATE SCHEMA "${applicationSchema}"`);
      await target.query(`CREATE SCHEMA "${extensionSchema}"`);
      await target.query(`CREATE EXTENSION vector WITH SCHEMA "${extensionSchema}"`);
      await target.query(`CREATE TABLE "${applicationSchema}"._continuum_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await target.query(
        `INSERT INTO "${applicationSchema}"._continuum_migrations (name)
         VALUES ('0001_init.sql')`,
      );
      const pool = migrationPool(url, applicationSchema);
      try {
        await expect(runMigrations(pool, directory)).resolves.toEqual([]);
        expect((await target.query(
          `SELECT namespace.nspname AS schema
             FROM pg_extension extension
             JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
            WHERE extension.extname = 'vector'`,
        )).rows).toEqual([{ schema: extensionSchema }]);
      } finally {
        await pool.end();
      }
    });
  });

  it('resolves a public extension while the migration search path omits public', async () => {
    await withFreshDatabase(async (_root, target, url, _database, directory) => {
      const applicationSchema = identifier('continuum_app');
      await target.query(`CREATE SCHEMA "${applicationSchema}"`);
      await target.query('CREATE EXTENSION vector WITH SCHEMA public');
      const pool = migrationPool(url, applicationSchema);
      try {
        await expect(runMigrations(pool, directory)).resolves.toEqual([
          expect.objectContaining({ name: '0001_init.sql' }),
        ]);
        expect((await pool.query(`SHOW search_path`)).rows)
          .toEqual([{ search_path: applicationSchema }]);
      } finally {
        await pool.end();
      }
    });
  });

  it('uses a provider-owned custom extension as a non-superuser schema owner', async () => {
    const role = identifier('continuum_migrator');
    try {
      await withFreshDatabase(async (root, target, url, database, directory) => {
        const applicationSchema = identifier('continuum_app');
        const extensionSchema = identifier('continuum_extensions');
        await root.query(`CREATE ROLE "${role}" NOLOGIN`);
        await target.query(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"`);
        await target.query(`CREATE SCHEMA "${applicationSchema}" AUTHORIZATION "${role}"`);
        await target.query(`CREATE SCHEMA "${extensionSchema}"`);
        await target.query(`CREATE EXTENSION vector WITH SCHEMA "${extensionSchema}"`);
        await target.query(`GRANT USAGE ON SCHEMA "${extensionSchema}" TO "${role}"`);
        expect((await target.query(
          `SELECT has_schema_privilege($1, 'public', 'CREATE') AS allowed`, [role],
        )).rows).toEqual([{ allowed: false }]);
        const pool = migrationPool(url, applicationSchema, role);
        try {
          await expect(runMigrations(pool, directory)).resolves.toEqual([
            expect.objectContaining({ name: '0001_init.sql' }),
          ]);
          expect((await target.query(
            `SELECT namespace.nspname AS schema
               FROM pg_extension extension
               JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
              WHERE extension.extname = 'vector'`,
          )).rows).toEqual([{ schema: extensionSchema }]);
        } finally {
          await pool.end();
        }
      });
    } finally {
      const root = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
      await root.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
      await root.end();
    }
  });

  it('retries safely after a DBA installs vector for a role without database CREATE', async () => {
    const role = identifier('continuum_migrator');
    try {
      await withFreshDatabase(async (root, target, url, _database, directory) => {
        const applicationSchema = identifier('continuum_app');
        const extensionSchema = identifier('continuum_extensions');
        await root.query(`CREATE ROLE "${role}" NOLOGIN`);
        await target.query(`CREATE SCHEMA "${applicationSchema}" AUTHORIZATION "${role}"`);
        const pool = migrationPool(url, applicationSchema, role);
        try {
          await expect(runMigrations(pool, directory))
            .rejects.toMatchObject({ code: '42501' });
          expect((await target.query(
            `SELECT to_regclass($1) IS NOT NULL AS ledger, to_regclass($2) IS NULL AS no_schema`,
            [`${applicationSchema}._continuum_migrations`, `${applicationSchema}.principals`],
          )).rows).toEqual([{ ledger: true, no_schema: true }]);

          await target.query(`CREATE SCHEMA "${extensionSchema}"`);
          await target.query(`CREATE EXTENSION vector WITH SCHEMA "${extensionSchema}"`);
          await target.query(`GRANT USAGE ON SCHEMA "${extensionSchema}" TO "${role}"`);
          await expect(runMigrations(pool, directory)).resolves.toEqual([
            expect.objectContaining({ name: '0001_init.sql' }),
          ]);
        } finally {
          await pool.end();
        }
      });
    } finally {
      const root = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
      await root.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
      await root.end();
    }
  });

  it('stores and searches embeddings with a public-less runtime search path', async () => {
    await withFreshDatabase(async (_root, target, url, _database, directory) => {
      const applicationSchema = identifier('continuum_app');
      await target.query(`CREATE SCHEMA "${applicationSchema}"`);
      await target.query('CREATE EXTENSION vector WITH SCHEMA public');
      const migrator = migrationPool(url, `${applicationSchema},public`);
      const runtime = migrationPool(url, applicationSchema);
      try {
        await runMigrations(migrator, directory);
        const principalId = randomUUID();
        const scopeId = randomUUID();
        const memoryId = randomUUID();
        await runtime.query(
          `INSERT INTO principals (id, external_id, kind, display_name)
           VALUES ($1, 'runtime-vector-user', 'user', 'Runtime vector user')`,
          [principalId],
        );
        await runtime.query(
          `INSERT INTO scopes (id, kind, name) VALUES ($1, 'project', 'runtime-vector')`,
          [scopeId],
        );
        await runtime.query(
          `INSERT INTO memories (id, scope_id, type, title, body, author_id, source)
           VALUES ($1, $2, 'fact', 'Vector contract', 'Public-less path', $3, 'test')`,
          [memoryId, scopeId, principalId],
        );
        const provider = { id: 'test:public-less', dim: 768 };
        const vector = [1, ...Array(767).fill(0)] as number[];
        await expect(storeMemoryEmbeddingVector(runtime, memoryId, vector, provider))
          .resolves.toBeUndefined();
        await expect(vectorSearchMemoryIds(runtime, vector, [scopeId], provider, 5))
          .resolves.toEqual([{ id: memoryId, distance: 0 }]);
        await expect(vectorSearchRelatedMemories(
          runtime,
          vector,
          [scopeId],
          provider,
          { threshold: 0.9, excludeMemoryId: randomUUID(), limit: 5 },
        )).resolves.toEqual([{
          id: memoryId,
          type: 'fact',
          title: 'Vector contract',
          body: 'Public-less path',
          distance: 0,
        }]);
      } finally {
        await runtime.end();
        await migrator.end();
      }
    });
  });
});
