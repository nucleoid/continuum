import path from 'node:path';
import type pg from 'pg';
import { isDirectEntrypoint } from '../api/entrypoint.js';
import { closePool, getPool } from '../storage/pool.js';
import {
  DEFAULT_AUDIT_RETENTION_BATCH_SIZE,
  DEFAULT_AUDIT_RETENTION_MAX_BATCHES,
  DEFAULT_AUDIT_RETENTION_MAX_ROWS,
  MAX_AUDIT_RETENTION_BATCH_SIZE,
  MAX_AUDIT_RETENTION_MAX_BATCHES,
  MAX_AUDIT_RETENTION_MAX_ROWS,
  runAuditRetention,
  type AuditRetentionOptions,
  type AuditRetentionResult,
} from './audit-retention.js';

export type AuditRetentionCliOptions = { enabled: false } | ({ enabled: true } & AuditRetentionOptions);

function parsePositiveInteger(raw: string, source: string, maximum?: number): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${source} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (maximum !== undefined && value > maximum)) {
    const suffix = maximum === undefined ? '' : ` no greater than ${maximum}`;
    throw new Error(`${source} must be a positive integer${suffix}`);
  }
  return value;
}

function parseExportDirectory(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!path.isAbsolute(raw) || path.normalize(raw) !== raw) {
    throw new Error('CONTINUUM_AUDIT_RETENTION_EXPORT_DIR must be an absolute normalized path');
  }
  return raw;
}

export function parseAuditRetentionCliOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): AuditRetentionCliOptions {
  let batchSize = env.CONTINUUM_AUDIT_RETENTION_BATCH_SIZE === undefined
    ? DEFAULT_AUDIT_RETENTION_BATCH_SIZE
    : parsePositiveInteger(
      env.CONTINUUM_AUDIT_RETENTION_BATCH_SIZE,
      'CONTINUUM_AUDIT_RETENTION_BATCH_SIZE',
      MAX_AUDIT_RETENTION_BATCH_SIZE,
    );
  let maxBatches = env.CONTINUUM_AUDIT_RETENTION_MAX_BATCHES === undefined
    ? DEFAULT_AUDIT_RETENTION_MAX_BATCHES
    : parsePositiveInteger(
      env.CONTINUUM_AUDIT_RETENTION_MAX_BATCHES,
      'CONTINUUM_AUDIT_RETENTION_MAX_BATCHES',
      MAX_AUDIT_RETENTION_MAX_BATCHES,
    );
  let maxRows = env.CONTINUUM_AUDIT_RETENTION_MAX_ROWS === undefined
    ? DEFAULT_AUDIT_RETENTION_MAX_ROWS
    : parsePositiveInteger(
      env.CONTINUUM_AUDIT_RETENTION_MAX_ROWS,
      'CONTINUUM_AUDIT_RETENTION_MAX_ROWS',
      MAX_AUDIT_RETENTION_MAX_ROWS,
    );
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    if (arg === '--batch-size') {
      batchSize = parsePositiveInteger(value, '--batch-size', MAX_AUDIT_RETENTION_BATCH_SIZE);
    } else if (arg === '--max-batches') {
      maxBatches = parsePositiveInteger(value, '--max-batches', MAX_AUDIT_RETENTION_MAX_BATCHES);
    } else if (arg === '--max-rows') {
      maxRows = parsePositiveInteger(value, '--max-rows', MAX_AUDIT_RETENTION_MAX_ROWS);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
    index += 1;
  }
  const exportDirectory = parseExportDirectory(env.CONTINUUM_AUDIT_RETENTION_EXPORT_DIR);
  const rawDays = env.CONTINUUM_AUDIT_RETENTION_DAYS;
  if (rawDays === undefined || rawDays === '') return { enabled: false };
  const retentionDays = parsePositiveInteger(rawDays, 'CONTINUUM_AUDIT_RETENTION_DAYS');
  const principalExternalId = env.CONTINUUM_AUDIT_RETENTION_PRINCIPAL_EXTERNAL_ID;
  if (!principalExternalId) {
    throw new Error('CONTINUUM_AUDIT_RETENTION_PRINCIPAL_EXTERNAL_ID is required when retention is enabled');
  }
  return {
    enabled: true,
    retentionDays,
    batchSize,
    maxBatches,
    maxRows,
    principalExternalId,
    exportDirectory,
    dryRun,
  };
}

export async function runAuditRetentionCli(
  pool: pg.Pool,
  options: AuditRetentionCliOptions,
): Promise<AuditRetentionResult | { status: 'disabled' }> {
  if (!options.enabled) return { status: 'disabled' };
  const { enabled: _enabled, ...runOptions } = options;
  return runAuditRetention(pool, runOptions);
}

async function main(): Promise<void> {
  const options = parseAuditRetentionCliOptions(process.argv.slice(2));
  if (!options.enabled) {
    process.stdout.write(`${JSON.stringify({ status: 'disabled' })}\n`);
    return;
  }
  const pool = getPool();
  try {
    process.stdout.write(`${JSON.stringify(await runAuditRetentionCli(pool, options))}\n`);
  } finally {
    await closePool();
  }
}

if (isDirectEntrypoint(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ status: 'failed', error: (error as Error).message })}\n`);
    process.exitCode = 1;
  });
}
