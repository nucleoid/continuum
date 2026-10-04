import type pg from 'pg';
import type { MemoryType, RecallResult } from '../types.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { vectorSearchMemoryIds } from './embeddings.js';
import { assertEmbeddingVectorDimension } from './schema.js';
import { MEMORY_COLUMNS, rowToMemory } from './memory-row.js';
import type { Queryable } from './queryable.js';

export interface RecallOptions {
  query: string;
  scopeIds: string[];
  types?: MemoryType[];
  limit: number;
  embeddingProvider?: EmbeddingProvider | null;
  embeddingGroups?: Array<{ scopeIds: string[]; provider: EmbeddingProvider }>;
}

export class EmbeddingProviderUnavailableError extends Error {
  constructor(cause: unknown) {
    super('embedding provider unavailable', { cause });
    this.name = 'EmbeddingProviderUnavailableError';
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
        AND (expires_at IS NULL OR expires_at > now())
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
        AND (expires_at IS NULL OR expires_at > now())
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
      };
    });
}

export async function recall(
  pool: Queryable,
  opts: RecallOptions,
): Promise<RecallResult[]> {
  if (opts.scopeIds.length === 0) return [];

  const overFetch = Math.min(opts.limit * 5, 100);
  const fts = await ftsHits(pool, opts.query, opts.scopeIds, opts.types, overFetch);

  const groups = opts.embeddingGroups
    ?? (opts.embeddingProvider
      ? [{ scopeIds: opts.scopeIds, provider: opts.embeddingProvider }]
      : []);
  const vectorLists: Array<Array<{ id: string; rank: number; distance: number }>> = [];
  for (const group of groups) {
    let queryVec: number[];
    try {
      [queryVec] = await group.provider.embed([opts.query]);
      assertEmbeddingVectorDimension(queryVec, group.provider);
    } catch {
      // An outage degrades only this provider group to full-text search.
      vectorLists.push([]);
      continue;
    }
    const hits = await vectorSearchMemoryIds(
      pool, queryVec, group.scopeIds, group.provider, overFetch, opts.types,
    );
    vectorLists.push(hits.map((hit, index) => ({
      id: hit.id, rank: index + 1, distance: hit.distance,
    })));
  }

  const fused = fuse(fts, ...vectorLists);
  const ranked = Array.from(fused.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([id]) => id)
    .slice(0, opts.limit);

  return hydrate(pool, ranked, opts.query, fused, opts.scopeIds, opts.types);
}
