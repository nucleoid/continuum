import { open } from 'node:fs/promises';
import type pg from 'pg';
import type { Principal } from '../types.js';
import { ServiceError } from '../services/errors.js';
import { bindEmbeddingWorker, configureEmbeddingPolicy, configureEmbeddingTarget, controlEmbeddingJobs, embeddingQueueMetrics,
  recoverEmbeddingProcess, embeddingQueueLeases, type EmbeddingControlOperation, type EmbeddingWindowPolicy } from '../services/embedding-jobs.js';
import type { EmbeddingTarget } from '../embeddings/target.js';
import type { BudgetProfile } from '../pipeline/budget.js';

async function configFile(path: string): Promise<Record<string, unknown>> {
  const file = await open(path, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('Not a file');
    const bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 65536) throw new Error('Too large');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Not an object');
    return value as Record<string, unknown>;
  } catch { throw new ServiceError('INVALID_INPUT', 'Embedding configuration must be a JSON object of at most 64 KiB'); }
  finally { await file.close(); }
}

export async function runEmbeddingAdmin(pool: pg.Pool, actor: Principal, operation: string, args: string[]): Promise<unknown> {
  if (operation === 'embedding-metrics' && args.length === 0) return embeddingQueueMetrics(pool, actor);
  if (operation === 'embedding-leases' && args.length <= 2) return embeddingQueueLeases(pool, actor,
    args[0] === undefined || args[0] === 'all' ? null : args[0], args[1] === undefined ? 100 : Number(args[1]));
  if (operation === 'embedding-control' && args.length >= 1 && args.length <= 3) {
    return controlEmbeddingJobs(pool, actor, args[0] as EmbeddingControlOperation, args[1] === undefined || args[1] === 'all' ? null : args[1],
      args[2] === undefined ? 100 : Number(args[2]));
  }
  if (args.length !== 1 || !args[0]) throw new ServiceError('INVALID_INPUT', 'Embedding configuration requires one JSON file');
  const config = await configFile(args[0]);
  if (operation === 'embedding-recover-process') return recoverEmbeddingProcess(pool, actor, config.cohortId as string,
    config.originalOwner as string, config.confirmation as string);
  if (operation === 'embedding-target') {
    await configureEmbeddingTarget(pool, actor, config.target as EmbeddingTarget, config.profile as BudgetProfile,
      config.window as EmbeddingWindowPolicy, config.enabled as boolean);
    return { configured: true };
  }
  if (operation === 'embedding-policy') return configureEmbeddingPolicy(pool, actor, config.routing, config.digest as string);
  if (operation === 'embedding-bind-worker') {
    await bindEmbeddingWorker(pool, actor, config.role as string, config.principalId as string, config.scopeId as string,
      config.target as string, config.enabled as boolean);
    return { configured: true };
  }
  throw new ServiceError('INVALID_INPUT', 'Unknown embedding operation');
}
