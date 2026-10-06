import type pg from 'pg';
import type { MemoryType, RecallResult } from '../types.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { vectorSearchMemoryIds } from './embeddings.js';
import { assertEmbeddingVectorDimension } from './schema.js';
import { MEMORY_COLUMNS, rowToMemory } from './memory-row.js';
import type { Queryable } from './queryable.js';

export const DEFAULT_RECALL_EMBEDDING_DEADLINE_MS = 10_000;
export const MAX_RECALL_EMBEDDING_DEADLINE_MS = 30_000;

export interface RecallOptions {
  query: string;
  scopeIds: string[];
  types?: MemoryType[];
  limit: number;
  embeddingProvider?: EmbeddingProvider | null;
  embeddingGroups?: Array<{ scopeIds: string[]; provider: EmbeddingProvider }>;
  onEmbeddingGroupResult?: (result: {
    provider: EmbeddingProvider;
    scopeIds: string[];
    status: 'succeeded' | 'failed';
  }) => void;
  /** One wall-clock budget shared by all routed embedding groups. */
  embeddingDeadlineMs?: number;
}

export type VectorDiagnosticStatus = 'used' | 'disabled' | 'failed' | 'partial';
export type VectorErrorCode = 'EMBEDDING_TIMEOUT' | 'EMBEDDING_FAILED' | 'VECTOR_SEARCH_FAILED';

export interface RecallDiagnostics {
  vector: VectorDiagnosticStatus;
  groups: Array<{
    provider: string;
    dim: number;
    status: 'used' | 'failed';
    errorCode?: VectorErrorCode;
  }>;
}

export interface RecallOutput {
  results: RecallResult[];
  diagnostics: RecallDiagnostics;
}

export class EmbeddingProviderUnavailableError extends Error {
  constructor(cause: unknown) {
    super('embedding provider unavailable', { cause });
    this.name = 'EmbeddingProviderUnavailableError';
  }
}

export function routedEmbeddingDeadlineMs(
  groups: Array<{ provider: EmbeddingProvider }>,
): number {
  const routedTimeouts = groups
    .map((group) => group.provider.timeoutMs)
    .filter((timeout): timeout is number => Number.isSafeInteger(timeout) && timeout! > 0);
  return Math.min(
    MAX_RECALL_EMBEDDING_DEADLINE_MS,
    routedTimeouts.length > 0
      ? Math.max(...routedTimeouts)
      : DEFAULT_RECALL_EMBEDDING_DEADLINE_MS,
  );
}

class VectorSearchTimeoutError extends Error {
  readonly code = 'EMBEDDING_TIMEOUT';
}

function connectable(pool: Queryable): pool is Queryable & Pick<pg.Pool, 'connect'> {
  return typeof (pool as Partial<pg.Pool>).connect === 'function';
}

async function connectBeforeDeadline(
  pool: Queryable & Pick<pg.Pool, 'connect'>,
  deadlineAt: number,
  signal: AbortSignal,
): Promise<pg.PoolClient> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs < 1 || signal.aborted) {
    throw new VectorSearchTimeoutError('Vector search deadline exceeded');
  }
  return new Promise<pg.PoolClient>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new VectorSearchTimeoutError('Vector search deadline exceeded'));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new VectorSearchTimeoutError('Vector search deadline exceeded'));
    }, remainingMs);
    signal.addEventListener('abort', onAbort, { once: true });
    void pool.connect().then(
      (client) => {
        if (settled || signal.aborted || Date.now() >= deadlineAt) {
          client.release();
          if (!settled) {
            settled = true;
            cleanup();
            reject(new VectorSearchTimeoutError('Vector search deadline exceeded'));
          }
          return;
        }
        settled = true;
        cleanup();
        resolve(client);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

async function boundedVectorSearch(
  pool: Queryable,
  deadlineAt: number,
  queryVec: number[],
  scopeIds: string[],
  provider: EmbeddingProvider,
  limit: number,
  types: MemoryType[] | undefined,
  signal: AbortSignal,
): Promise<Array<{ id: string; distance: number }>> {
  let remainingMs = deadlineAt - Date.now();
  if (remainingMs < 1 || signal.aborted) {
    throw new VectorSearchTimeoutError('Vector search deadline exceeded');
  }
  if (!connectable(pool)) {
    return vectorSearchMemoryIds(pool, queryVec, scopeIds, provider, limit, types);
  }
  const client = await connectBeforeDeadline(pool, deadlineAt, signal);
  let transactionStarted = false;
  try {
    remainingMs = deadlineAt - Date.now();
    if (remainingMs < 1 || signal.aborted) {
      throw new VectorSearchTimeoutError('Vector search deadline exceeded');
    }
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query(`SET LOCAL statement_timeout = '${remainingMs}ms'`);
    const hits = await vectorSearchMemoryIds(
      client, queryVec, scopeIds, provider, limit, types,
    );
    await client.query('COMMIT');
    return hits;
  } catch (error) {
    if (transactionStarted) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the search failure */ }
    }
    if ((error as { code?: unknown })?.code === '57014') {
      throw new VectorSearchTimeoutError('Vector search deadline exceeded');
    }
    throw error;
  } finally {
    client.release();
  }
}

function buildExcerpt(body: string, query: string): string {
  const max = 200;
  const lower = body.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase().split(/\s+/)[0] ?? '');
  if (idx < 0 || body.length <= max) return body.slice(0, max);
  const start = Math.max(0, idx - 60);
  const end = Math.min(body.length, start + max);
  return (start > 0 ? '...' : '') + body.slice(start, end) + (end < body.length ? '...' : '');
}

interface FtsHit {
  id: string;
  rank: number;
  score: number;
}

async function ftsHits(
  pool: Queryable,
  query: string,
  scopeIds: string[],
  types: MemoryType[] | undefined,
  limit: number,
): Promise<FtsHit[]> {
  if (scopeIds.length === 0) return [];
  const params: unknown[] = [query, scopeIds];
  let typeFilter = '';
  if (types && types.length > 0) {
    params.push(types);
    typeFilter = ` AND type = ANY($${params.length}::text[])`;
  }
  params.push(limit);
  const limitIdx = params.length;
  const { rows } = await pool.query(
    `SELECT id,
            ts_rank(to_tsvector('english', title || ' ' || body),
                    plainto_tsquery('english', $1)) AS score
       FROM memories
      WHERE scope_id = ANY($2::uuid[])
        AND state = 'live'
        AND (expires_at IS NULL OR expires_at > clock_timestamp())
        AND to_tsvector('english', title || ' ' || body) @@ plainto_tsquery('english', $1)
        ${typeFilter}
      ORDER BY score DESC
      LIMIT $${limitIdx}`,
    params,
  );
  return rows.map((r, i) => ({ id: r.id as string, rank: i + 1, score: Number(r.score) }));
}

// Reciprocal Rank Fusion. k=60 is the common default from the RRF paper.
function fuse(...lists: Array<Array<{ id: string; rank: number }>>): Map<string, number> {
  const K = 60;
  const out = new Map<string, number>();
  for (const list of lists) {
    for (const item of list) {
      const cur = out.get(item.id) ?? 0;
      out.set(item.id, cur + 1 / (K + item.rank));
    }
  }
  return out;
}

async function hydrate(
  pool: Queryable,
  ids: string[],
  query: string,
  fusedScores: Map<string, number>,
  scopeIds: string[],
  types: MemoryType[] | undefined,
): Promise<RecallResult[]> {
  if (ids.length === 0) return [];
  const params: unknown[] = [ids, scopeIds];
  let typeFilter = '';
  if (types && types.length > 0) {
    params.push(types);
    typeFilter = ` AND type = ANY($${params.length}::text[])`;
  }
  const { rows } = await pool.query(
    `SELECT ${MEMORY_COLUMNS}
       FROM memories
      WHERE id = ANY($1::uuid[])
        AND scope_id = ANY($2::uuid[])
        AND state = 'live'
        AND (expires_at IS NULL OR expires_at > clock_timestamp())
        ${typeFilter}`,
    params,
  );
  const byId = new Map(rows.map((r) => [r.id as string, rowToMemory(r)]));
  return ids
    .filter((id) => byId.has(id))
    .map((id) => {
      const memory = byId.get(id)!;
      return {
        memory,
        score: fusedScores.get(id) ?? 0,
        excerpt: buildExcerpt(memory.body, query),
        bodyTruncated: memory.body.length > 200,
      };
    });
}

export async function recall(
  pool: Queryable,
  opts: RecallOptions,
): Promise<RecallOutput> {
  if (opts.scopeIds.length === 0) {
    return { results: [], diagnostics: { vector: 'disabled', groups: [] } };
  }

  const overFetch = Math.min(opts.limit * 5, 100);
  const fts = await ftsHits(pool, opts.query, opts.scopeIds, opts.types, overFetch);

  const groups = opts.embeddingGroups
    ?? (opts.embeddingProvider
      ? [{ scopeIds: opts.scopeIds, provider: opts.embeddingProvider }]
      : []);
  const deadlineMs = opts.embeddingDeadlineMs ?? routedEmbeddingDeadlineMs(groups);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1
    || deadlineMs > MAX_RECALL_EMBEDDING_DEADLINE_MS) {
    throw new Error(`embeddingDeadlineMs must be an integer from 1 to ${MAX_RECALL_EMBEDDING_DEADLINE_MS}`);
  }
  type GroupResult = {
    list: Array<{ id: string; rank: number; distance: number }>;
    diagnostic: RecallDiagnostics['groups'][number];
  };
  const controller = new AbortController();
  const deadlineAt = Date.now() + deadlineMs;
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    deadlineTimer = setTimeout(() => {
      controller.abort(new Error('Embedding recall deadline exceeded'));
      resolve('deadline');
    }, deadlineMs);
  });
  const tasks = groups.map(async (group): Promise<GroupResult> => {
    const work = (async (): Promise<GroupResult> => {
      let queryVec: number[];
      try {
        [queryVec] = await group.provider.embed([opts.query], { signal: controller.signal });
        assertEmbeddingVectorDimension(queryVec, group.provider);
      } catch (error) {
        return {
          list: [],
          diagnostic: {
            provider: group.provider.id, dim: group.provider.dim, status: 'failed',
            errorCode: (error as { code?: unknown })?.code === 'EMBEDDING_TIMEOUT'
              || controller.signal.aborted
              ? 'EMBEDDING_TIMEOUT'
              : 'EMBEDDING_FAILED',
          },
        };
      }
      try {
        const hits = await boundedVectorSearch(
          pool, deadlineAt, queryVec, group.scopeIds,
          group.provider, overFetch, opts.types, controller.signal,
        );
        return {
          list: hits.map((hit, index) => ({
            id: hit.id, rank: index + 1, distance: hit.distance,
          })),
          diagnostic: {
            provider: group.provider.id, dim: group.provider.dim, status: 'used',
          },
        };
      } catch (error) {
        return {
          list: [],
          diagnostic: {
            provider: group.provider.id, dim: group.provider.dim,
            status: 'failed',
            errorCode: (error as { code?: unknown })?.code === 'EMBEDDING_TIMEOUT'
              ? 'EMBEDDING_TIMEOUT'
              : 'VECTOR_SEARCH_FAILED',
          },
        };
      }
    })();
    const settled = await Promise.race([work, deadline]);
    if (settled === 'deadline') {
      return {
        list: [],
        diagnostic: {
          provider: group.provider.id, dim: group.provider.dim,
          status: 'failed', errorCode: 'EMBEDDING_TIMEOUT',
        },
      };
    }
    return settled;
  });
  const settledGroups = await Promise.all(tasks);
  if (deadlineTimer) clearTimeout(deadlineTimer);
  const vectorLists = settledGroups.map((result) => result.list);
  const diagnosticGroups = settledGroups.map((result, index) => {
    const group = groups[index]!;
    opts.onEmbeddingGroupResult?.({
      provider: group.provider,
      scopeIds: group.scopeIds,
      status: result.diagnostic.status === 'used' ? 'succeeded' : 'failed',
    });
    return result.diagnostic;
  });

  const fused = fuse(fts, ...vectorLists);
  const ranked = Array.from(fused.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([id]) => id)
    .slice(0, opts.limit);

  const used = diagnosticGroups.filter((group) => group.status === 'used').length;
  const failed = diagnosticGroups.length - used;
  const vector: VectorDiagnosticStatus = diagnosticGroups.length === 0
    ? 'disabled'
    : failed === 0
      ? 'used'
      : used === 0 ? 'failed' : 'partial';
  return {
    results: await hydrate(pool, ranked, opts.query, fused, opts.scopeIds, opts.types),
    diagnostics: { vector, groups: diagnosticGroups },
  };
}
