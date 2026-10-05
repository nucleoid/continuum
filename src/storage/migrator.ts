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

export async function runMigrations(
  pool: pg.Pool,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<AppliedMigration[]> {
  const client = await pool.connect();
  const applied: AppliedMigration[] = [];
  let lockAcquired = false;
  let runFailed = false;
  let runError: unknown;

  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [
      CONTINUUM_MIGRATION_LOCK_ID,
    ]);
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
      try {
        if (sql.trimStart().startsWith(NO_TRANSACTION_MARKER)) {
          // CREATE INDEX CONCURRENTLY cannot run in a transaction block. Such
          // migrations use retry-safe statements so a crash before the ledger
          // write can rerun the file.
          for (const statement of nonTransactionalStatements(sql)) {
            await client.query(statement);
          }
          await client.query(
            'INSERT INTO _continuum_migrations (name) VALUES ($1)',
            [file],
          );
        } else {
          await client.query('BEGIN');
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
          if (!sql.trimStart().startsWith(NO_TRANSACTION_MARKER)) {
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
    const lockError = !lockAcquired && runFailed ? runError : undefined;
    const releaseError = unlockError ?? lockError;
    client.release(
      releaseError instanceof Error
        ? releaseError
        : releaseError === undefined
          ? undefined
          : new Error('Migration advisory lock connection is unsafe', {
              cause: releaseError,
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
