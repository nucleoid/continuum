import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, link, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

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
  now?: Date;
  runId?: string;
  afterExport?: (batch: number) => Promise<void>;
}

interface AuditRow {
  id: string;
  at: Date;
  principal_id: string;
  action: string;
  memory_id: string | null;
  scope_id: string | null;
  query: string | null;
  metadata: unknown;
}

export interface AuditExportResult {
  filename: string;
  sha256: string;
  reused: boolean;
}

export type AuditRetentionResult =
  | { status: 'busy'; cutoff: string; runId: string; batches: 0; deleted: 0 }
  | { status: 'dry-run'; cutoff: string; runId: string; eligible: number; oldestAt: string | null; batches: 0; deleted: 0 }
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

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function serializeRows(rows: AuditRow[]): Buffer {
  const lines = rows.map((row) => JSON.stringify({
    id: row.id,
    at: row.at.toISOString(),
    principal_id: row.principal_id,
    action: row.action,
    memory_id: row.memory_id,
    scope_id: row.scope_id,
    query: row.query,
    metadata: stableValue(row.metadata),
  }));
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

function cutoffLabel(cutoff: Date): string {
  return cutoff.toISOString().replace(/[-:.]/g, '');
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
  cutoff: Date,
  directory: string,
  runId: string,
  batchNumber: number,
): Promise<AuditExportResult> {
  if (rows.length === 0) throw new Error('Cannot export an empty audit batch');
  const bytes = serializeRows(rows);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const first = rows[0];
  const last = rows[rows.length - 1];
  const retrySuffix = `-${first.id}-${last.id}-${sha256}.jsonl`;
  const retryCandidates = (await readdir(directory))
    .filter((name) => name.startsWith('audit-') && name.endsWith(retrySuffix))
    .sort();
  for (const candidate of retryCandidates) {
    const candidatePath = path.join(directory, candidate);
    const candidateInfo = await lstat(candidatePath);
    if (!candidateInfo.isFile() || candidateInfo.isSymbolicLink()) {
      throw new Error(`Refusing unsafe existing audit export: ${candidate}`);
    }
    const existing = await readFile(candidatePath);
    if (!existing.equals(bytes)) {
      throw new Error(`Existing audit export does not match selected rows: ${candidate}`);
    }
    return { filename: candidate, sha256, reused: true };
  }
  const filename = `audit-${cutoffLabel(cutoff)}-${first.id}-${last.id}-${sha256}.jsonl`;
  const finalPath = path.join(directory, filename);
  const runLabel = createHash('sha256').update(runId).digest('hex').slice(0, 16);
  const tempPath = path.join(directory, `.audit-${runLabel}-${batchNumber}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      await link(tempPath, finalPath);
      await unlink(tempPath);
      const directoryHandle = await open(directory, fsConstants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      return { filename, sha256, reused: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const finalInfo = await lstat(finalPath);
      if (!finalInfo.isFile() || finalInfo.isSymbolicLink()) {
        throw new Error(`Refusing unsafe existing audit export: ${filename}`);
      }
      const existing = await readFile(finalPath);
      const existingDigest = createHash('sha256').update(existing).digest('hex');
      if (existingDigest !== sha256 || !existing.equals(bytes)) {
        throw new Error(`Existing audit export does not match selected rows: ${filename}`);
      }
      return { filename, sha256, reused: true };
    }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(tempPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function authorizedPrincipalId(client: pg.PoolClient, externalId: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT p.id
       FROM principals p
       JOIN scope_memberships sm ON sm.principal_id = p.id AND sm.role = 'admin'
       JOIN scopes s ON s.id = sm.scope_id AND s.kind = 'org' AND s.name = ''
      WHERE p.external_id = $1
      FOR KEY SHARE OF p, sm, s`,
    [externalId],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('Configured audit-retention principal is not a current org admin');
  return id;
}

async function selectRows(client: pg.PoolClient, cutoff: Date, limit: number): Promise<AuditRow[]> {
  const result = await client.query<AuditRow>(
    `SELECT id::text, at, principal_id, action, memory_id, scope_id, query, metadata
       FROM audit_log
      WHERE at < $1
      ORDER BY at ASC, id ASC
      LIMIT $2`,
    [cutoff, limit],
  );
  return result.rows;
}

async function deleteBatch(
  client: pg.PoolClient,
  rows: AuditRow[],
  principalExternalId: string,
  cutoff: Date,
  retentionDays: number,
  runId: string,
  batchNumber: number,
  exported: AuditExportResult | undefined,
): Promise<void> {
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    const principalId = await authorizedPrincipalId(client, principalExternalId);
    const deletion = await client.query<{ id: string }>(
      `DELETE FROM audit_log
        WHERE id = ANY($1::bigint[])
          AND at < $2
      RETURNING id::text`,
      [rows.map((row) => row.id), cutoff],
    );
    if (deletion.rowCount !== rows.length) {
      throw new Error('Audit retention delete count did not match the selected batch');
    }
    const first = rows[0];
    const last = rows[rows.length - 1];
    await client.query(
      `INSERT INTO audit_log (principal_id, action, metadata)
       VALUES ($1, 'archive', $2::jsonb)`,
      [principalId, JSON.stringify({
        source: 'audit-retention',
        cutoff: cutoff.toISOString(),
        retention_days: retentionDays,
        first_id: first.id,
        last_id: last.id,
        first_at: first.at.toISOString(),
        last_at: last.at.toISOString(),
        deleted_count: rows.length,
        export_mode: exported ? 'jsonl' : 'none',
        export_filename: exported?.filename ?? null,
        export_sha256: exported?.sha256 ?? null,
        run_id: runId,
        batch_number: batchNumber,
      })],
    );
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroyClient = true;
    }
    if (destroyClient) throw new Error('Audit retention transaction cleanup failed', { cause: error });
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
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new RangeError('now must be a valid date');
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  if (!Number.isFinite(cutoff.getTime())) throw new RangeError('retentionDays produces an invalid cutoff');
  const runId = options.runId ?? randomUUID();
  const exportDirectory = options.exportDirectory === undefined
    ? undefined
    : await validateAuditExportDirectory(options.exportDirectory);
  const client = await pool.connect();
  let lockHeld = false;
  try {
    await authorizedPrincipalId(client, options.principalExternalId);
    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [AUDIT_RETENTION_LOCK_KEY],
    );
    lockHeld = lock.rows[0]?.acquired === true;
    if (!lockHeld) {
      return { status: 'busy', cutoff: cutoff.toISOString(), runId, batches: 0, deleted: 0 };
    }

    if (options.dryRun) {
      await authorizedPrincipalId(client, options.principalExternalId);
      const preview = await client.query<{ eligible: number; oldest_at: Date | null }>(
        `SELECT count(*)::int AS eligible, min(at) AS oldest_at FROM audit_log WHERE at < $1`,
        [cutoff],
      );
      return {
        status: 'dry-run', cutoff: cutoff.toISOString(), runId,
        eligible: preview.rows[0]?.eligible ?? 0,
        oldestAt: preview.rows[0]?.oldest_at?.toISOString() ?? null,
        batches: 0, deleted: 0,
      };
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
      await options.afterExport?.(batchNumber);
      await deleteBatch(
        client, rows, options.principalExternalId, cutoff, retentionDays,
        runId, batchNumber, exported,
      );
      batches += 1;
      deleted += rows.length;
      if (rows.length < limit) {
        exhausted = true;
        break;
      }
    }
    return {
      status: 'completed', cutoff: cutoff.toISOString(), runId, batches, deleted,
      exports, reusedExports, exhausted,
    };
  } finally {
    if (lockHeld) {
      const unlocked = await client.query<{ unlocked: boolean }>(
        'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
        [AUDIT_RETENTION_LOCK_KEY],
      ).catch(() => ({ rows: [{ unlocked: false }] }));
      if (unlocked.rows[0]?.unlocked !== true) {
        client.release(true);
        throw new Error('Audit retention advisory lock cleanup failed');
      }
    }
    client.release();
  }
}
