import type pg from 'pg';
import type { Memory, MemoryType, RecallResult } from '../types.js';

export interface RecallOptions {
  query: string;
  scopeIds: string[];
  types?: MemoryType[];
  limit: number;
}

function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    id: row.id as string,
    scopeId: row.scope_id as string,
    type: row.type as MemoryType,
    title: row.title as string,
    body: row.body as string,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    tags: (row.tags as string[]) ?? [],
    authorId: row.author_id as string,
    source: row.source as string,
    sourceRef: (row.source_ref as string | null) ?? null,
    state: row.state as Memory['state'],
    supersedesId: (row.supersedes_id as string | null) ?? null,
    promotedToId: (row.promoted_to_id as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    expiresAt: (row.expires_at as Date | null) ?? null,
    lastVerified: (row.last_verified as Date | null) ?? null,
  };
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

// v0 retrieval: FTS only. Embedding-based search wires in alongside this
// once an EmbeddingProvider is configured (task: EmbeddingProvider impl).
export async function recallByFts(
  pool: pg.Pool,
  opts: RecallOptions,
): Promise<RecallResult[]> {
  if (opts.scopeIds.length === 0) return [];
  const params: unknown[] = [opts.query, opts.scopeIds];
  let typeFilter = '';
  if (opts.types && opts.types.length > 0) {
    params.push(opts.types);
    typeFilter = ` AND type = ANY($${params.length}::text[])`;
  }
  params.push(opts.limit);
  const limitIdx = params.length;
  const { rows } = await pool.query(
    `SELECT id, scope_id, type, title, body, metadata, tags, author_id,
            source, source_ref, state, supersedes_id, promoted_to_id,
            created_at, updated_at, expires_at, last_verified,
            ts_rank(to_tsvector('english', title || ' ' || body), plainto_tsquery('english', $1)) AS score
       FROM memories
      WHERE scope_id = ANY($2::uuid[])
        AND state = 'live'
        AND to_tsvector('english', title || ' ' || body) @@ plainto_tsquery('english', $1)
        ${typeFilter}
      ORDER BY score DESC
      LIMIT $${limitIdx}`,
    params,
  );
  return rows.map((row) => {
    const memory = rowToMemory(row);
    return {
      memory,
      score: Number(row.score),
      excerpt: buildExcerpt(memory.body, opts.query),
    };
  });
}
