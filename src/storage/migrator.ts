import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = resolve(here, '../../migrations');

// This key coordinates every Continuum migrator connected to the same database.
// Changing it would break coordination with replicas running an older version.
const CONTINUUM_MIGRATION_LOCK_ID = '7215328273579717613';
const NO_TRANSACTION_MARKER = '-- continuum:no-transaction';
const REPAIR_INVALID_INDEX = '-- continuum:repair-invalid-index ';
const REQUIRE_VALID_INDEX = '-- continuum:require-valid-index ';
const BACKFILL_OFFBOARDING_SELECTORS = '-- continuum:backfill-offboarding-selectors';
const PUBLISHED_MIGRATION_CHECKSUMS = new Map([
  ['0052_offboarding_review_repair.sql',
    '136cbd834277ca4fbfb48162644738ba2f96f7a5705290cc0c585e3ce7c82079'],
]);
const FORWARD_MIGRATION_REQUIREMENTS = new Map([
  ['0053_offboarding_restore_contract.sql', '0052_offboarding_review_repair.sql'],
]);
const REVIEW_ENTRA_MIGRATION_RENAMES = [
  ['0005_entra_auth.sql', '0010_entra_auth.sql'],
  ['0006_entra_binding_approval.sql', '0011_entra_binding_approval.sql'],
  ['0007_entra_binding_revocation.sql', '0012_entra_binding_revocation.sql'],
  ['0008_entra_binding_membership_invariant.sql', '0013_entra_binding_membership_invariant.sql'],
  ['0009_lock_entra_binding_invariant.sql', '0014_lock_entra_binding_invariant.sql'],
  ['0010_harden_entra_binding_invariants.sql', '0015_harden_entra_binding_invariants.sql'],
  ['0011_canonicalize_entra_ids.sql', '0016_canonicalize_entra_ids.sql'],
  ['0012_entra_quarantine_state.sql', '0017_entra_quarantine_state.sql'],
  ['0013_canonicalize_principal_external_ids.sql', '0018_canonicalize_principal_external_ids.sql'],
  ['0014_entra_sync_freshness.sql', '0019_entra_sync_freshness.sql'],
  ['0015_entra_review_hardening.sql', '0020_entra_review_hardening.sql'],
] as const;

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

function directiveIndexName(statement: string, directive: string): string | null {
  const line = statement.split(/\r?\n/).find((candidate) => candidate.trim().startsWith(directive));
  if (!line) return null;
  const name = line.trim().slice(directive.length).trim();
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`invalid no-transaction index directive: ${statement}`);
  }
  return name;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function indexState(
  client: pg.PoolClient, indexName: string,
): Promise<{ schema: string; valid: boolean } | null> {
  const result = await client.query(
    `SELECT n.nspname AS schema, i.indisvalid AS valid
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.oid = to_regclass(format('%I.%I', current_schema(), $1::text))`,
    [indexName],
  );
  return result.rows[0] ?? null;
}

async function runNonTransactionalStatement(
  client: pg.PoolClient, statement: string,
): Promise<void> {
  if (statement.split(/\r?\n/).some(
    (line) => line.trim() === BACKFILL_OFFBOARDING_SELECTORS,
  )) {
    const available = await client.query<{ available: boolean }>(
      `SELECT to_regprocedure(format(
         '%I.continuum_backfill_audit_offboarding_scopes(integer)', current_schema()
       )) IS NOT NULL AS available`,
    );
    // Review-era 0033 installations did not create the bounded backfill
    // function. 0036 installs it and 0037 invokes this same directive, so 0035
    // must finish its retry-safe indexes without resolving another schema's
    // function or failing before the compatibility migration can run.
    if (available.rows[0]?.available !== true) return;
    await client.query("SET statement_timeout = '30s'");
    try {
      for (;;) {
        const result = await client.query<{ completed: boolean }>(
          `SELECT continuum_backfill_audit_offboarding_scopes(1000) AS completed`,
        );
        if (result.rows[0]?.completed === true) return;
      }
    } finally {
      await client.query('RESET statement_timeout');
    }
  }
  const repairName = directiveIndexName(statement, REPAIR_INVALID_INDEX);
  if (repairName) {
    const state = await indexState(client, repairName);
    if (state && !state.valid) {
      await client.query(
        `DROP INDEX CONCURRENTLY ${quoteIdentifier(state.schema)}.${quoteIdentifier(repairName)}`,
      );
    }
    return;
  }
  const requiredName = directiveIndexName(statement, REQUIRE_VALID_INDEX);
  if (requiredName) {
    const state = await indexState(client, requiredName);
    if (!state?.valid) {
      throw new Error(`required index ${requiredName} is missing or invalid in current schema`);
    }
    return;
  }
  await client.query(statement);
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
    for (const [reviewName, publicName] of REVIEW_ENTRA_MIGRATION_RENAMES) {
      if (!files.includes(publicName)) continue;
      await client.query(
        `INSERT INTO _continuum_migrations (name, applied_at)
         SELECT $2, applied_at FROM _continuum_migrations WHERE name = $1
         ON CONFLICT (name) DO NOTHING`,
        [reviewName, publicName],
      );
    }

      const { rowCount } = await client.query(
        'SELECT 1 FROM _continuum_migrations WHERE name = $1',
        [file],
      );
      if (rowCount && rowCount > 0) {
        const publishedChecksum = PUBLISHED_MIGRATION_CHECKSUMS.get(file);
        if (publishedChecksum) {
          const publishedBytes = await readFile(join(migrationsDir, file));
          const actualChecksum = createHash('sha256').update(publishedBytes).digest('hex');
          if (actualChecksum !== publishedChecksum) {
            throw new Error(
              `Published migration ${file} was modified after it was ledgered: `
              + `expected checksum ${publishedChecksum}, received ${actualChecksum}`,
            );
          }
        }
        continue;
      }

      const requiredMigration = FORWARD_MIGRATION_REQUIREMENTS.get(file);
      if (requiredMigration) {
        const prerequisite = await client.query(
          'SELECT 1 FROM _continuum_migrations WHERE name = $1',
          [requiredMigration],
        );
        if (!prerequisite.rowCount) {
          throw new Error(
            `Migration ${file} requires ledgered prerequisite ${requiredMigration}`,
          );
        }
      }

      const sql = await readFile(join(migrationsDir, file), 'utf8');
      try {
        if (sql.trimStart().startsWith(NO_TRANSACTION_MARKER)) {
          // CREATE INDEX CONCURRENTLY cannot run in a transaction block. Such
          // migrations use retry-safe statements so a crash before the ledger
          // write can rerun the file.
          for (const statement of nonTransactionalStatements(sql)) {
            await runNonTransactionalStatement(client, statement);
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
