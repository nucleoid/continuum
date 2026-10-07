import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, link, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { ServiceError } from '../services/errors.js';

export const DEFAULT_AUDIT_RETENTION_BATCH_SIZE = 100;
export const MAX_AUDIT_RETENTION_BATCH_SIZE = 1_000;
export const DEFAULT_AUDIT_RETENTION_MAX_BATCHES = 10;
export const MAX_AUDIT_RETENTION_MAX_BATCHES = 1_000;
export const DEFAULT_AUDIT_RETENTION_MAX_ROWS = 1_000;
export const MAX_AUDIT_RETENTION_MAX_ROWS = 100_000;
export const AUDIT_RETENTION_LOCK_KEY = '33440033001';

export interface AuditRetentionOptions {
  retentionDays: number;
  batchSize?: number;
  maxBatches?: number;
  maxRows?: number;
  principalExternalId: string;
  exportDirectory?: string;
  dryRun?: boolean;
  runId?: string;
  afterCutoff?: (cutoff: string) => Promise<void>;
  afterExport?: (batch: number) => Promise<void>;
}

export interface AuditRow {
  id: string;
  at: string;
  principal_id: string;
  action: string;
  memory_id: string | null;
  scope_id: string | null;
  query: string | null;
  metadata_json: string | null;
}

export interface AuditExportResult {
  filename: string;
  sha256: string;
  reused: boolean;
}

export type AuditRetentionResult =
  | { status: 'busy'; cutoff: string; runId: string; batches: 0; deleted: 0 }
  | {
      status: 'dry-run';
      cutoff: string;
      runId: string;
      eligible: number;
      deletable: number;
      oldestAt: string | null;
      batches: 0;
      deleted: 0;
    }
  | {
      status: 'completed';
      cutoff: string;
      runId: string;
      batches: number;
      deleted: number;
      exports: number;
      reusedExports: number;
      exhausted: boolean;
    };

function checkedInteger(value: number, name: string, maximum?: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || (maximum !== undefined && value > maximum)) {
    const upper = maximum === undefined ? '' : ` to ${maximum}`;
    throw new RangeError(`${name} must be an integer from 1${upper}`);
  }
  return value;
}

function serializeRows(rows: AuditRow[]): Buffer {
  const lines = rows.map((row) => JSON.stringify({
    archive_format: 'continuum-audit-v1',
    id: row.id,
    at: row.at,
    principal_id: row.principal_id,
    action: row.action,
    memory_id: row.memory_id,
    scope_id: row.scope_id,
    query: row.query,
    metadata_json: row.metadata_json,
  }));
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

export function assertAuditExportPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    throw new Error('Durable audit export is not supported on Windows; run without an export directory');
  }
}

async function rejectSymlinkComponents(directory: string): Promise<void> {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const segment of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('Audit export directory must not contain symlinks');
  }
}

export async function validateAuditExportDirectory(directory: string): Promise<string> {
  assertAuditExportPlatform();
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) {
    throw new Error('Audit export directory must be an absolute normalized path');
  }
  await rejectSymlinkComponents(directory);
  const resolved = await realpath(directory);
  if (resolved !== directory) throw new Error('Audit export directory must not use path aliases');
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Audit export directory must be a real directory');
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error('Audit export directory must be owner-only (mode 0700 or stricter)');
  }
  if (process.getuid !== undefined && info.uid !== process.getuid()) {
    throw new Error('Audit export directory must be owned by the current process user');
  }
  const workingDirectory = await realpath(process.cwd());
  if (resolved === workingDirectory || resolved.startsWith(`${workingDirectory}${path.sep}`)) {
    throw new Error('Audit export directory must be outside the application directory');
  }
  return resolved;
}

export async function exportAuditRows(
  rows: AuditRow[],
  _cutoff: string,
  directory: string,
  runId: string,
  batchNumber: number,
): Promise<AuditExportResult> {
  assertAuditExportPlatform();
  if (rows.length === 0) throw new Error('Cannot export an empty audit batch');
  const bytes = serializeRows(rows);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const first = rows[0];
  const last = rows[rows.length - 1];
  const filename = `audit-${first.id}-${last.id}-${sha256}.jsonl`;
  const finalPath = path.join(directory, filename);
  try {
    await verifyAndSyncExistingExport(finalPath, filename, bytes, sha256, directory);
    return { filename, sha256, reused: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const runLabel = createHash('sha256').update(runId).digest('hex').slice(0, 16);
  const tempPath = path.join(directory, `.audit-${runLabel}-${batchNumber}-${randomUUID()}.tmp`);
  let handle;
  let primaryError: unknown;
  try {
    handle = await open(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      await link(tempPath, finalPath);
      await unlink(tempPath);
      await syncDirectory(directory);
      return { filename, sha256, reused: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await verifyAndSyncExistingExport(finalPath, filename, bytes, sha256, directory);
      return { filename, sha256, reused: true };
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(tempPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && primaryError === undefined) throw error;
    });
  }
}

async function verifyAndSyncExistingExport(
  filename: string,
  displayName: string,
  expected: Buffer,
  expectedDigest: string,
  directory: string,
): Promise<void> {
  const pathInfo = await lstat(filename);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
    throw new Error(`Refusing unsafe existing audit export: ${displayName}`);
  }
  const handle = await open(filename, fsConstants.O_RDONLY);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (pathInfo.ino !== 0 && info.ino !== pathInfo.ino)
      || (pathInfo.dev !== 0 && info.dev !== pathInfo.dev)) {
      throw new Error(`Refusing unsafe existing audit export: ${displayName}`);
    }
    const existing = await handle.readFile();
    const existingDigest = createHash('sha256').update(existing).digest('hex');
    if (existingDigest !== expectedDigest || !existing.equals(expected)) {
      throw new Error(`Existing audit export does not match selected rows: ${displayName}`);
    }
    // A reused file is just as deletion-critical as a newly written one.
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
}

async function syncDirectory(directory: string): Promise<void> {
  const directoryHandle = await open(directory, fsConstants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

const AUDIT_TIMESTAMP_SQL = `CASE
  WHEN at = '-infinity'::timestamptz THEN '-infinity'
  WHEN at = 'infinity'::timestamptz THEN 'infinity'
  WHEN extract(year FROM at AT TIME ZONE 'UTC') < 1
    THEN to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z" BC')
  ELSE to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
END`;

async function authorizedPrincipalId(client: pg.PoolClient, externalId: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT p.id
       FROM principals p
       JOIN scope_memberships sm ON sm.principal_id = p.id
        AND sm.role = 'admin' AND sm.active
        AND continuum_membership_is_effective(sm.active, sm.source_kind)
        AND sm.scope_id = continuum_org_scope_id()
      WHERE p.external_id = $1
        AND p.disabled_at IS NULL
      FOR KEY SHARE OF p
      FOR SHARE OF sm`,
    [externalId],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('Configured audit-retention principal is not a current org admin');
  return id;
}

async function selectRows(client: pg.PoolClient, cutoff: string, limit: number): Promise<AuditRow[]> {
  const result = await client.query<AuditRow>(
    `SELECT id::text,
            ${AUDIT_TIMESTAMP_SQL} AS at,
            principal_id, action, memory_id, scope_id, query, metadata::text AS metadata_json
       FROM audit_log
      WHERE at < $1
      ORDER BY at ASC, id ASC
      LIMIT $2`,
    [cutoff, limit],
  );
  return result.rows;
}

class UnusableAuditRetentionConnectionError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Audit retention transaction failed', { cause });
  }
}

async function deleteBatch(
  client: pg.PoolClient,
  rows: AuditRow[],
  principalExternalId: string,
  cutoff: string,
  retentionDays: number,
  runId: string,
  batchNumber: number,
  exported: AuditExportResult | undefined,
  afterExport?: (batchNumber: number) => Promise<void>,
): Promise<void> {
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    const principalId = await authorizedPrincipalId(client, principalExternalId);
    await afterExport?.(batchNumber);
    const deletion = await client.query<{ deleted_count: number }>(
      `SELECT continuum_operator_apply_audit_retention(
         $1::uuid, $2::timestamptz, $3::integer, $4::uuid, $5::integer,
         $6::jsonb, $7::text, $8::text
       ) AS deleted_count`,
      [principalId, cutoff, retentionDays, runId, batchNumber,
        JSON.stringify(rows), exported ? 'jsonl' : 'none', exported?.sha256 ?? null],
    );
    if (Number(deletion.rows[0]?.deleted_count) !== rows.length) {
      throw new Error('Audit retention delete count did not match the selected batch');
    }
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroyClient = true;
    }
    if (destroyClient) throw new UnusableAuditRetentionConnectionError(error);
    throw error;
  }
}

export async function runAuditRetention(
  pool: pg.Pool,
  options: AuditRetentionOptions,
): Promise<AuditRetentionResult> {
  const retentionDays = checkedInteger(options.retentionDays, 'retentionDays');
  const batchSize = checkedInteger(
    options.batchSize ?? DEFAULT_AUDIT_RETENTION_BATCH_SIZE,
    'batchSize',
    MAX_AUDIT_RETENTION_BATCH_SIZE,
  );
  const maxBatches = checkedInteger(
    options.maxBatches ?? DEFAULT_AUDIT_RETENTION_MAX_BATCHES,
    'maxBatches',
    MAX_AUDIT_RETENTION_MAX_BATCHES,
  );
  const maxRows = checkedInteger(
    options.maxRows ?? DEFAULT_AUDIT_RETENTION_MAX_ROWS,
    'maxRows',
    MAX_AUDIT_RETENTION_MAX_ROWS,
  );
  if (!options.principalExternalId) throw new Error('principalExternalId is required');
  const runId = options.runId ?? randomUUID();
  const exportDirectory = options.exportDirectory === undefined
    ? undefined
    : await validateAuditExportDirectory(options.exportDirectory);
  const client = await pool.connect();
  let lockHeld = false;
  let destroyClient = false;
  let primaryError: unknown;
  try {
    let cutoff: string;
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      const authorizationPrincipalId = await authorizedPrincipalId(
        client, options.principalExternalId,
      );
      await client.query(
        'SELECT continuum_operator_authorize_audit_retention($1::uuid)',
        [authorizationPrincipalId],
      );
      const policy = await client.query<{ minimum_days: number }>(
        `SELECT continuum_audit_retention_minimum_days()::int AS minimum_days`,
      );
      const minimumDays = Number(policy.rows[0]?.minimum_days);
      if (!Number.isSafeInteger(minimumDays) || retentionDays < minimumDays) {
        throw new RangeError(
          `retentionDays must satisfy the database minimum of ${minimumDays} days`,
        );
      }
      const lock = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        [AUDIT_RETENTION_LOCK_KEY],
      );
      lockHeld = lock.rows[0]?.acquired === true;
      const cutoffResult = await client.query<{ cutoff: string }>(
        `SELECT to_char(
           (transaction_timestamp() - ($1::int * interval '24 hours')) AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS cutoff`,
        [retentionDays],
      );
      cutoff = cutoffResult.rows[0].cutoff;
      await options.afterCutoff?.(cutoff);

      if (!lockHeld) {
        await client.query('COMMIT');
        return { status: 'busy', cutoff, runId, batches: 0, deleted: 0 };
      }

      if (options.dryRun) {
        const preview = await client.query<{ eligible: number; oldest_at: string | null }>(
          `SELECT count(*)::int AS eligible,
                  CASE
                    WHEN min(at) = '-infinity'::timestamptz THEN '-infinity'
                    WHEN min(at) = 'infinity'::timestamptz THEN 'infinity'
                    ELSE to_char(min(at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                  END AS oldest_at
             FROM audit_log WHERE at < $1`,
          [cutoff],
        );
        await client.query('COMMIT');
        const eligible = preview.rows[0]?.eligible ?? 0;
        return {
          status: 'dry-run', cutoff, runId,
          eligible,
          deletable: Math.min(eligible, maxRows, batchSize * maxBatches),
          oldestAt: preview.rows[0]?.oldest_at ?? null,
          batches: 0, deleted: 0,
        };
      }
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroyClient = true;
      }
      throw error;
    }

    let batches = 0;
    let deleted = 0;
    let exports = 0;
    let reusedExports = 0;
    let exhausted = false;
    while (batches < maxBatches && deleted < maxRows) {
      await authorizedPrincipalId(client, options.principalExternalId);
      const limit = Math.min(batchSize, maxRows - deleted);
      const rows = await selectRows(client, cutoff, limit);
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      const batchNumber = batches + 1;
      const exported = exportDirectory === undefined
        ? undefined
        : await exportAuditRows(rows, cutoff, exportDirectory, runId, batchNumber);
      if (exported) {
        exports += 1;
        if (exported.reused) reusedExports += 1;
      }
      await deleteBatch(
        client, rows, options.principalExternalId, cutoff, retentionDays,
        runId, batchNumber, exported, options.afterExport,
      );
      batches += 1;
      deleted += rows.length;
      if (rows.length < limit) {
        exhausted = true;
        break;
      }
    }
    return {
      status: 'completed', cutoff, runId, batches, deleted,
      exports, reusedExports, exhausted,
    };
  } catch (error) {
    if (error instanceof UnusableAuditRetentionConnectionError) destroyClient = true;
    primaryError = error;
    const databaseError = error as { code?: string; message?: string };
    if (databaseError.code === '42501'
      || /(?:DB|role-name\/OID)-bound trusted approve identity|operator session/i
        .test(databaseError.message ?? '')) {
      throw new ServiceError(
        'FORBIDDEN', 'audit retention requires a DB-bound operator session',
        { cause: error },
      );
    }
    throw error;
  } finally {
    let unlockFailed = false;
    if (lockHeld) {
      const unlocked = await client.query<{ unlocked: boolean }>(
        'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
        [AUDIT_RETENTION_LOCK_KEY],
      ).catch(() => ({ rows: [{ unlocked: false }] }));
      if (unlocked.rows[0]?.unlocked !== true) {
        destroyClient = true;
        unlockFailed = true;
      }
    }
    client.release(destroyClient);
    if (unlockFailed && primaryError === undefined) {
      throw new Error('Audit retention advisory lock cleanup failed');
    }
  }
}
