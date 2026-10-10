import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from './migrator.js';

const databaseUrl = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:continuum@localhost:5433/continuum';

async function fixture(run: (pool: pg.Pool, directory: string, schema: string) => Promise<void>) {
  const schema = `execution_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1,
    application_name: `${schema}_setup` });
  const directory = await mkdtemp(join(tmpdir(), 'continuum-execution-'));
  let pool: pg.Pool | undefined;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    pool = new pg.Pool({ connectionString: databaseUrl, max: 1,
      application_name: `${schema}_migrator`, options: `-c search_path=${schema}` });
    await run(pool, directory, schema);
  }
  finally {
    try {
      await pool?.end();
      if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function independentlyDigest(sql: string, values: unknown[] = []): string {
  const hash = createHash('sha256');
  for (const value of [sql, JSON.stringify(values)]) {
    const bytes = Buffer.from(value, 'utf8');
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
    hash.update(size); hash.update(bytes);
  }
  return hash.digest('hex');
}

describe('migration execution provenance', () => {
  it('refuses the contract migration before its ledgered provider prerequisite without applying contract DDL', async () => {
    await fixture(async (pool, directory) => {
      await copyFile(join(process.cwd(), 'migrations/0081_coordination_public_contract.sql'),
        join(directory, '0081_coordination_public_contract.sql'));
      await expect(runMigrations(pool, directory)).rejects.toThrow(
        /0081.*requires ledgered prerequisite 0080_pgvector_provider_grants.sql/,
      );
      expect((await pool.query("SELECT to_regclass('coordination_contract_backfill_state') AS relation"))
        .rows[0].relation).toBeNull();
      expect((await pool.query('SELECT 1 FROM _continuum_migrations')).rowCount).toBe(0);
    });
  });

  it('discards the client if rollback fails and retains the original BEGIN error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-execution-discard-'));
    await writeFile(join(directory, '001_probe.sql'), 'SELECT 1;');
    const beginError = new Error('uncertain BEGIN acknowledgement');
    const rollbackError = new Error('rollback transport failed');
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }], rowCount: 1 };
        if (sql === 'BEGIN') throw beginError;
        if (sql === 'ROLLBACK') throw rollbackError;
        return { rows: [], rowCount: 0 };
      }), release: vi.fn(),
    };
    try {
      const error = await runMigrations({ connect: vi.fn(async () => client) } as unknown as pg.Pool, directory)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([beginError, rollbackError]);
      expect((error as Error).cause).toBe(beginError);
      expect(client.release).toHaveBeenCalledExactlyOnceWith(error);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rolls back an uncertain bookkeeping BEGIN before releasing the checked-out client', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-execution-begin-'));
    await writeFile(join(directory, '001_probe.sql'), 'SELECT 1;');
    let transactionOpen = false;
    let releasedOpen: boolean | undefined;
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }], rowCount: 1 };
        if (sql === 'BEGIN') {
          transactionOpen = true;
          throw new Error('BEGIN response lost after server execution');
        }
        if (sql === 'ROLLBACK') transactionOpen = false;
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(() => { releasedOpen = transactionOpen; }),
    };
    try {
      await expect(runMigrations({ connect: vi.fn(async () => client) } as unknown as pg.Pool, directory))
        .rejects.toThrow(/BEGIN response lost/);
      expect(queries).toContain('ROLLBACK');
      expect(client.release).toHaveBeenCalledOnce();
      expect(releasedOpen).toBe(false);
      expect(queries.some((sql) => sql.includes('pg_advisory_unlock'))).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('executes the verified source snapshot when the file changes after verification', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-provenance-race-'));
    const name = '0052_offboarding_review_repair.sql';
    const path = join(directory, name);
    await copyFile(join(process.cwd(), 'migrations', name), path);
    const original = await readFile(path, 'utf8');
    const marker = 'UNVERIFIED_MIGRATION_FILE_REPLACEMENT';
    const submitted: string[] = [];
    let changed = false;
    const client = {
      query: vi.fn(async (sql: string) => {
        submitted.push(sql);
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }], rowCount: 1 };
        if (!changed && sql.includes('CREATE TABLE IF NOT EXISTS _continuum_migrations')) {
          changed = true;
          await writeFile(path, original + `\nSELECT '${marker}';\n`);
        }
        return { rows: [], rowCount: 0 };
      }), release: vi.fn(),
    };
    try {
      await expect(runMigrations({ connect: vi.fn(async () => client) } as unknown as pg.Pool, directory))
        .resolves.toHaveLength(1);
      expect(changed).toBe(true);
      expect(submitted.some((sql) => sql.includes(marker))).toBe(false);
      expect(submitted).toContain(original.replaceAll('\r\n', '\n'));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('atomically records the actual submitted transaction, without persisting SQL', async () => {
    await fixture(async (pool, directory) => {
      const sql = 'CREATE TABLE effect (value text); INSERT INTO effect VALUES (\'private-value\');';
      await writeFile(join(directory, '001_effect.sql'), sql);
      await runMigrations(pool, directory);
      const evidence = (await pool.query(
        `SELECT variant, source_sha256, effective_sql_sha256, executed_sql_sha256,
                statement_count, state FROM _continuum_migration_execution
          WHERE migration_name='001_effect.sql' AND phase='file'`,
      )).rows;
      const sourceHash = createHash('sha256').update(sql).digest('hex');
      expect(evidence).toEqual([{ variant: 'canonical-lf-v1', source_sha256: sourceHash,
        effective_sql_sha256: sourceHash, executed_sql_sha256: independentlyDigest(sql),
        statement_count: 1, state: 'completed' }]);
      expect(JSON.stringify((await pool.query('SELECT * FROM _continuum_migration_execution')).rows))
        .not.toContain('private-value');
      await pool.query(`CREATE FUNCTION reject_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected evidence failure'; END $$;
        CREATE TRIGGER reject_evidence BEFORE INSERT ON _continuum_migration_execution
        FOR EACH ROW EXECUTE FUNCTION reject_evidence()`);
      await writeFile(join(directory, '002_rollback.sql'), 'CREATE TABLE rolled_back (id integer);');
      await expect(runMigrations(pool, directory)).rejects.toThrow(/injected evidence failure/);
      expect((await pool.query("SELECT to_regclass('rolled_back') AS relation")).rows[0].relation).toBeNull();
      expect((await pool.query("SELECT 1 FROM _continuum_migrations WHERE name='002_rollback.sql'")).rowCount).toBe(0);
    });
  });

  it('retains honest interrupted online evidence and commits completion with the ledger on retry', async () => {
    await fixture(async (pool, directory) => {
      const sql = '-- continuum:no-transaction\nCREATE TABLE IF NOT EXISTS online_effect(id integer);\nSELECT 1 / 0;';
      await writeFile(join(directory, '001_online.sql'), sql);
      await expect(runMigrations(pool, directory)).rejects.toThrow();
      expect((await pool.query('SELECT state, executed_sql_sha256 FROM _continuum_migration_execution')).rows)
        .toEqual([{ state: 'started', executed_sql_sha256: null }]);
      expect((await pool.query('SELECT 1 FROM _continuum_migrations')).rowCount).toBe(0);
      // A changed interrupted recipe must not silently reinterpret prior effects.
      await writeFile(join(directory, '001_online.sql'), sql.replace('SELECT 1 / 0', 'SELECT 1'));
      await expect(runMigrations(pool, directory)).rejects.toThrow(/execution recipe.*changed/i);
    });
  });

  it('retries the same online recipe and rolls back the final evidence/ledger pair together', async () => {
    await fixture(async (pool, directory) => {
      await pool.query(`CREATE TABLE online_gate(ready boolean NOT NULL);
        INSERT INTO online_gate VALUES(false);
        CREATE FUNCTION require_online_ready() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
          IF NOT (SELECT ready FROM online_gate) THEN RAISE EXCEPTION 'not ready'; END IF;
        END $$;`);
      const sql = '-- continuum:no-transaction\nCREATE TABLE IF NOT EXISTS online_effect(id integer);\nSELECT require_online_ready();';
      await writeFile(join(directory, '001_online.sql'), sql);
      await expect(runMigrations(pool, directory)).rejects.toThrow(/not ready/);
      await pool.query('UPDATE online_gate SET ready=true');
      await pool.query(`CREATE FUNCTION reject_completed_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.state='completed' THEN RAISE EXCEPTION 'completed evidence failed'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_completed BEFORE UPDATE ON _continuum_migration_execution
        FOR EACH ROW EXECUTE FUNCTION reject_completed_evidence();`);
      await expect(runMigrations(pool, directory)).rejects.toThrow(/completed evidence failed/);
      expect((await pool.query('SELECT 1 FROM _continuum_migrations')).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM _continuum_migration_execution WHERE state='completed'")).rowCount).toBe(0);
      await pool.query('DROP TRIGGER reject_completed ON _continuum_migration_execution');
      await expect(runMigrations(pool, directory)).resolves.toHaveLength(1);
      expect((await pool.query("SELECT state FROM _continuum_migration_execution ORDER BY started_at")).rows)
        .toEqual([{ state: 'started' }, { state: 'started' }, { state: 'completed' }]);
      expect((await pool.query('SELECT 1 FROM _continuum_migrations')).rowCount).toBe(1);
    });
  });

  it('resumes the bounded contract backfill even when its SQL filename was ledgered', async () => {
    await fixture(async (pool, directory) => {
      await pool.query(`CREATE TABLE contract_probe (calls integer NOT NULL DEFAULT 0);
        INSERT INTO contract_probe DEFAULT VALUES;
        CREATE FUNCTION continuum_backfill_coordination_contract(batch_limit integer)
        RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
          IF batch_limit > 1000 THEN RAISE EXCEPTION 'batch too large'; END IF;
          IF current_setting('lock_timeout') <> '1s' OR current_setting('statement_timeout') <> '5s'
          THEN RAISE EXCEPTION 'unbounded call'; END IF;
          UPDATE contract_probe SET calls=calls+1;
          RETURN (SELECT calls>=2 FROM contract_probe);
        END $$;
        CREATE TABLE _continuum_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now());
        INSERT INTO _continuum_migrations(name) VALUES('0081_contract_probe.sql')`);
      await writeFile(join(directory, '0081_contract_probe.sql'),
        '-- continuum:backfill-coordination-contract\nSELECT 1;');
      const applied = await runMigrations(pool, directory);
      expect(applied).toEqual([]);
      expect((await pool.query('SELECT calls FROM contract_probe')).rows[0].calls).toBe(2);
      expect((await pool.query(`SELECT state,phase FROM _continuum_migration_execution
        WHERE phase='contract-backfill'`)).rows).toEqual([{ state: 'completed', phase: 'contract-backfill' }]);
      expect((await pool.query(`SELECT state,executed_sql_sha256 FROM _continuum_migration_execution
        WHERE phase='legacy-history'`)).rows).toEqual([{ state: 'history-unknown', executed_sql_sha256: null }]);
    });
  });

  it('keeps bookkeeping owner-only and refuses an existing broadened table ACL', async () => {
    await fixture(async (pool, directory) => {
      await writeFile(join(directory, '001_effect.sql'), 'SELECT 1;');
      await runMigrations(pool, directory);
      expect((await pool.query(`SELECT privilege.grantee FROM pg_class relation
        CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl,acldefault('r',relation.relowner))) privilege
        WHERE relation.oid='_continuum_migration_execution'::regclass
          AND privilege.grantee<>relation.relowner`)).rows).toEqual([]);
      await pool.query('GRANT SELECT ON _continuum_migration_execution TO PUBLIC');
      await expect(runMigrations(pool, directory)).rejects.toThrow(/provenance.*privilege drift/i);
    });
  });
});
