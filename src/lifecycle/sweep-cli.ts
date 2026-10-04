import type pg from 'pg';
import { getPool, closePool } from '../storage/pool.js';
import { isDirectEntrypoint } from '../api/entrypoint.js';
import {
  DEFAULT_LIFECYCLE_BATCH_SIZE,
  MAX_LIFECYCLE_BATCH_SIZE,
  previewLifecycle,
  sweepLifecycle,
} from './sweep.js';

export interface SweepCliOptions {
  dryRun: boolean;
  batchSize: number;
}

function parseBatchSize(raw: string, source: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${source} must be an integer from 1 to ${MAX_LIFECYCLE_BATCH_SIZE}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIFECYCLE_BATCH_SIZE) {
    throw new Error(`${source} must be an integer from 1 to ${MAX_LIFECYCLE_BATCH_SIZE}`);
  }
  return parsed;
}

export function parseSweepCliOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): SweepCliOptions {
  let dryRun = false;
  let batchSize = env.CONTINUUM_LIFECYCLE_BATCH_SIZE === undefined
    ? DEFAULT_LIFECYCLE_BATCH_SIZE
    : parseBatchSize(env.CONTINUUM_LIFECYCLE_BATCH_SIZE, 'CONTINUUM_LIFECYCLE_BATCH_SIZE');
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--batch-size') {
      const value = args[index + 1];
      if (value === undefined) throw new Error('--batch-size requires a value');
      batchSize = parseBatchSize(value, '--batch-size');
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { dryRun, batchSize };
}

export async function runSweepCli(
  pool: pg.Pool,
  options: SweepCliOptions,
): Promise<Record<string, unknown>> {
  if (options.dryRun) {
    const preview = await previewLifecycle(pool);
    return { dryRun: true, batches: 0, ...preview };
  }
  const result = await sweepLifecycle(pool, { batchSize: options.batchSize });
  return { dryRun: false, ...result };
}

async function main(): Promise<void> {
  const options = parseSweepCliOptions(process.argv.slice(2));
  const pool = getPool();
  try {
    process.stdout.write(`${JSON.stringify(await runSweepCli(pool, options))}\n`);
  } finally {
    await closePool();
  }
}

if (isDirectEntrypoint(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`continuum-sweep: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
