import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = resolve(here, '../../migrations');

// This key coordinates every Continuum migrator connected to the same database.
// Changing it would break coordination with replicas running an older version.
const CONTINUUM_MIGRATION_LOCK_ID = '7215328273579717613';
const NO_TRANSACTION_MARKER = '-- continuum:no-transaction';
const DEFAULT_ADVISORY_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

function nonTransactionalStatements(sql: string): string[] {
  const body = sql.trimStart().slice(NO_TRANSACTION_MARKER.length).trim();
  const statements = body
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  if (statements.length === 0) {
    throw new Error('no-transaction migration must contain at least one statement');
  }
  return statements;
}

export interface AppliedMigration {
  name: string;
  appliedAt: Date;
}

export interface MigrationOptions {
  advisoryLockTimeoutMs?: number;
  lockTimeoutMs?: number;
}

function timeout(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 300_000) {
    throw new Error(`${name} must be an integer from 1 to 300000`);
  }
  return selected;
}

async function acquireMigrationLock(client: pg.PoolClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await client.query<{ locked?: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked /* pg_advisory_lock */',
      [CONTINUUM_MIGRATION_LOCK_ID],
    );
    // PostgreSQL always returns a row; lightweight test clients may omit it.
    if (result.rows[0]?.locked !== false) return;
    if (Date.now() >= deadline) {
      throw new Error(`Continuum migration advisory lock timed out after ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  }
}

export async function runMigrations(
  pool: pg.Pool,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
  options: MigrationOptions = {},
): Promise<AppliedMigration[]> {
  const advisoryLockTimeoutMs = timeout(
    options.advisoryLockTimeoutMs, DEFAULT_ADVISORY_LOCK_TIMEOUT_MS, 'advisoryLockTimeoutMs',
  );
  const lockTimeoutMs = timeout(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, 'lockTimeoutMs');
  const client = await pool.connect();
  const applied: AppliedMigration[] = [];
  let lockAcquired = false;
  let runFailed = false;
  let runError: unknown;

  try {
    await acquireMigrationLock(client, advisoryLockTimeoutMs);
    lockAcquired = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS _continuum_migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const { rowCount } = await client.query(
        'SELECT 1 FROM _continuum_migrations WHERE name = $1',
        [file],
      );
      if (rowCount && rowCount > 0) continue;

      const sql = await readFile(join(migrationsDir, file), 'utf8');
      const noTransaction = sql.trimStart().startsWith(NO_TRANSACTION_MARKER);
      let embeddedTransactionOpen = false;
      try {
        if (noTransaction) {
          // CREATE INDEX CONCURRENTLY cannot run in a transaction block. Such
          // migrations use retry-safe statements so a crash before the ledger
          // write can rerun the file.
          for (const statement of nonTransactionalStatements(sql)) {
            await client.query(statement);
            if (/^(?:BEGIN|START\s+TRANSACTION)\b/i.test(statement)) {
              embeddedTransactionOpen = true;
            } else if (/^(?:COMMIT|ROLLBACK)\b/i.test(statement)) {
              embeddedTransactionOpen = false;
            }
          }
          await client.query(
            'INSERT INTO _continuum_migrations (name) VALUES ($1)',
            [file],
          );
        } else {
          await client.query('BEGIN');
          await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
          await client.query(sql);
          await client.query(
            'INSERT INTO _continuum_migrations (name) VALUES ($1)',
            [file],
          );
          await client.query('COMMIT');
        }
        applied.push({ name: file, appliedAt: new Date() });
      } catch (error) {
        const migrationError = new Error(
          `Migration ${file} failed: ${(error as Error).message}`,
          { cause: error },
        );
        try {
          if (!noTransaction || embeddedTransactionOpen) {
            await client.query('ROLLBACK');
          }
        } catch (rollbackError) {
          throw new AggregateError(
            [migrationError, rollbackError],
            `Migration ${file} failed and rollback failed`,
          );
        }
        throw migrationError;
      }
    }
  } catch (error) {
    runFailed = true;
    runError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (lockAcquired) {
    try {
      const unlockResult = await client.query<{ unlocked: boolean }>(
        'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
        [CONTINUUM_MIGRATION_LOCK_ID],
      );
      if (unlockResult.rows[0]?.unlocked !== true) {
        throw new Error('Continuum migration advisory lock was not held');
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  try {
    const unlockError = cleanupErrors[0];
    client.release(
      unlockError instanceof Error
        ? unlockError
        : unlockError === undefined
          ? undefined
          : new Error('Migration advisory lock cleanup failed', {
              cause: unlockError,
            }),
    );
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (runFailed && cleanupErrors.length > 0) {
    throw new AggregateError(
      [runError, ...cleanupErrors],
      'Migration run failed and cleanup failed',
    );
  }
  if (runFailed) throw runError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'Migration cleanup failed');
  }

  return applied;
}
