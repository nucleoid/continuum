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
const BACKFILL_COORDINATION_REPAIR = '-- continuum:backfill-coordination-repair';
const PUBLISHED_MIGRATION_CHECKSUMS = new Map([
  ['0052_offboarding_review_repair.sql',
    '136cbd834277ca4fbfb48162644738ba2f96f7a5705290cc0c585e3ce7c82079'],
  ['0054_coordination_leases.sql',
    'c69b96b7e8f64ce9d64da71b5026a2e8896cdcf6efb7a52107ca6ab062e7619a'],
  ['0055_coordination_review_remediation.sql',
    '478d40c2367f3fa900984767e18110fe5aa377aadcda1387225dc5dea87176fd'],
  ['0056_coordination_final_remediation.sql',
    '034df4cf096603fc895247f05246ca442b604d0df7dc05596e4c7b43af683c27'],
  ['0057_coordination_privacy_race_remediation.sql',
    '7e8d0bbc1f733d76a55c5d9835280880f4254d951d7db41351b4b4ed01d8b3e3'],
  ['0058_coordination_online_prep.sql',
    '56850725814e6385e1c3c5253aeecce6060f2feafe96003de7f19861ede550bf'],
  ['0059_coordination_bounded_privacy.sql',
    '5973bed68dd895df4d49e8603a72e232d696625eff815a89cb00365d7bf35d25'],
  ['0060_coordination_online_finish.sql',
    '97d3c881c44f950a7264ca93b5d0abb0f07a2ee26df14f07316dbbd7190048a7'],
  ['0061_coordination_forward_security_repair.sql',
    'b8cf3529afd40b40ca1b05262bb5425a76cd1def64078cb83ceacbd2b4a4692f'],
  ['0062_coordination_forward_online_finish.sql',
    '8b6de993de4b3e571461368e48ee184eee2be3276bb6091d45f17e2e600fc77f'],
  ['0063_coordination_final_privacy_repair.sql',
    '4e6c13b689cd1ba6d14c37aa58701d6e430c890cdd6dd97aedb5c6c1c5292716'],
  ['0064_coordination_final_online_indexes.sql',
    '4c7ba440652d6fabf94017140e6b7d240f157ba109984438a31dc0ca14ad2109'],
  ['0065_coordination_review_remediation.sql',
    '7b7d0ab26646f7770c8ab93899b6698a39872fc149af3d39e0c869547f0d5030'],
  ['0066_coordination_upgrade_privacy_repair.sql',
    '48223c50b0e39434446f6bebd7d625e51786b4606a70dadce44832b6b65d8bb2'],
  ['0067_coordination_rollout_repair.sql',
    '8f868cbe1bbe19684c0857ef8b110fb55d2565059b3862f1f1585ba893d53fe3'],
  ['0068_coordination_production_repair.sql',
    'b9488db55b8392f9a2d7eb4061dd190e69f3fba9ae230ca8ecee9696706ce390'],
]);
const FORWARD_MIGRATION_REQUIREMENTS = new Map([
  ['0053_offboarding_restore_contract.sql', '0052_offboarding_review_repair.sql'],
  ['0056_coordination_final_remediation.sql', '0055_coordination_review_remediation.sql'],
  ['0057_coordination_privacy_race_remediation.sql',
    '0056_coordination_final_remediation.sql'],
  ['0058_coordination_online_prep.sql',
    '0057_coordination_privacy_race_remediation.sql'],
  ['0059_coordination_bounded_privacy.sql',
    '0058_coordination_online_prep.sql'],
  ['0060_coordination_online_finish.sql',
    '0059_coordination_bounded_privacy.sql'],
  ['0061_coordination_forward_security_repair.sql',
    '0060_coordination_online_finish.sql'],
  ['0062_coordination_forward_online_finish.sql',
    '0061_coordination_forward_security_repair.sql'],
  ['0063_coordination_final_privacy_repair.sql',
    '0062_coordination_forward_online_finish.sql'],
  ['0064_coordination_final_online_indexes.sql',
    '0063_coordination_final_privacy_repair.sql'],
  ['0065_coordination_review_remediation.sql',
    '0064_coordination_final_online_indexes.sql'],
  ['0066_coordination_upgrade_privacy_repair.sql',
    '0065_coordination_review_remediation.sql'],
  ['0067_coordination_rollout_repair.sql',
    '0066_coordination_upgrade_privacy_repair.sql'],
  ['0068_coordination_production_repair.sql',
    '0067_coordination_rollout_repair.sql'],
  ['0069_coordination_independent_review.sql',
    '0068_coordination_production_repair.sql'],
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

function publishedMigrationChecksum(bytes: Buffer): string {
  const checksum = createHash('sha256');
  let chunkStart = 0;

  // Git may materialize tracked text as CRLF on Windows. Canonicalize only
  // that byte pair so the published LF checksum remains authoritative while
  // lone CR bytes and every substantive byte continue to be tamper-evident.
  for (let index = 0; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) {
      checksum.update(bytes.subarray(chunkStart, index));
      chunkStart = index + 1;
    }
  }
  return checksum.update(bytes.subarray(chunkStart)).digest('hex');
}

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
  deferCoordinationBackfill = false,
): Promise<void> {
  if (statement.split(/\r?\n/).some(
    (line) => line.trim() === BACKFILL_COORDINATION_REPAIR,
  )) {
    if (deferCoordinationBackfill) return;
    await client.query("SET statement_timeout = '5s'");
    try {
      for (;;) {
        const result = await client.query<{ completed: boolean }>(
          `SELECT continuum_backfill_coordination_cleanup(1000) AS completed`,
        );
        if (result.rows[0]?.completed === true) return;
      }
    } finally {
      await client.query('RESET statement_timeout');
    }
  }
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
          const actualChecksum = publishedMigrationChecksum(publishedBytes);
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
            await runNonTransactionalStatement(
              client,
              statement,
              file === '0060_coordination_online_finish.sql'
                && files.includes('0061_coordination_forward_security_repair.sql'),
            );
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
