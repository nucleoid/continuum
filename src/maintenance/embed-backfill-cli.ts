import type pg from 'pg';
import { isDirectEntrypoint } from '../api/entrypoint.js';
import { makeEmbeddingRouterFromEnv } from '../embeddings/factory.js';
import { parseScopeString } from '../services/scopes.js';
import { closePool, getPool } from '../storage/pool.js';
import type { ScopeRef } from '../types.js';
import {
  runEmbeddingBackfill,
  type EmbeddingBackfillOptions,
  type EmbeddingBackfillReport,
} from './embed-backfill.js';

export interface EmbedBackfillCliOptions extends EmbeddingBackfillOptions {
  dryRun: boolean;
  countOnly: boolean;
  batchSize: number;
  maxRows: number;
  maxRetries: number;
  retryBaseMs: number;
  maxErrors: number;
}

function bounded(raw: string | undefined, name: string, minimum: number, maximum: number): number {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function valueAfter(args: string[], index: number): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${args[index]} requires a value`);
  return value;
}

export function parseEmbedBackfillCliOptions(args: string[]): EmbedBackfillCliOptions {
  const options: EmbedBackfillCliOptions = {
    dryRun: false, countOnly: false, batchSize: 32, maxRows: 1_000,
    maxRetries: 2, retryBaseMs: 100, maxErrors: 25,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--count') options.countOnly = true;
    else if (arg === '--batch-size') options.batchSize = bounded(valueAfter(args, index++), arg, 1, 1_000);
    else if (arg === '--max-rows') options.maxRows = bounded(valueAfter(args, index++), arg, 1, 1_000_000);
    else if (arg === '--max-retries') options.maxRetries = bounded(valueAfter(args, index++), arg, 0, 10);
    else if (arg === '--retry-base-ms') options.retryBaseMs = bounded(valueAfter(args, index++), arg, 1, 60_000);
    else if (arg === '--max-errors') options.maxErrors = bounded(valueAfter(args, index++), arg, 1, 10_000);
    else if (arg === '--provider') options.providerId = valueAfter(args, index++);
    else if (arg === '--cursor') {
      const cursor = valueAfter(args, index++);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor)) {
        throw new Error('--cursor must be a UUID');
      }
      options.cursor = cursor;
    } else if (arg === '--scope') {
      try { options.scope = parseScopeString(valueAfter(args, index++)) as ScopeRef; }
      catch { throw new Error('--scope must be org or kind:name'); }
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.dryRun && options.countOnly) throw new Error('--dry-run and --count are mutually exclusive');
  if (options.cursor && !options.providerId) throw new Error('--cursor requires --provider');
  return options;
}

export async function runEmbedBackfillCli(
  pool: pg.Pool,
  options: EmbedBackfillCliOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EmbeddingBackfillReport> {
  return runEmbeddingBackfill(pool, makeEmbeddingRouterFromEnv(env), options);
}

async function main(): Promise<void> {
  const options = parseEmbedBackfillCliOptions(process.argv.slice(2));
  const pool = getPool();
  try {
    process.stdout.write(`${JSON.stringify(await runEmbedBackfillCli(pool, options))}\n`);
  } finally {
    await closePool();
  }
}

if (isDirectEntrypoint(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`continuum-embed-backfill: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
