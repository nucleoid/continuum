import type pg from 'pg';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { MemoryType } from '../types.js';
import type { Queryable } from './queryable.js';
import { assertEmbeddingVectorDimension } from './schema.js';

function toPgVector(v: number[]): string {
  return `[${v.join(',')}]`;
}

export async function storeMemoryEmbedding(
  pool: Queryable,
  memoryId: string,
  text: string,
  provider: EmbeddingProvider,
): Promise<boolean> {
  const [vector] = await provider.embed([text]);
  return storeMemoryEmbeddingVector(pool, memoryId, vector, provider);
}

export async function storeMemoryEmbeddingVector(
  pool: Queryable,
  memoryId: string,
  vector: number[],
  provider: Pick<EmbeddingProvider, 'id' | 'dim'>,
): Promise<boolean> {
  assertEmbeddingVectorDimension(vector, provider);
  const result = await pool.query(
    `INSERT INTO memory_embeddings (memory_id, provider, dim, embedding)
     SELECT m.id, $2, $3, $4::vector
       FROM memories m
      WHERE m.id = $1
        AND m.state = 'live'
        AND (m.expires_at IS NULL OR m.expires_at > clock_timestamp())
      FOR SHARE OF m
     ON CONFLICT (memory_id, provider, dim) DO UPDATE
       SET embedding = EXCLUDED.embedding,
           embedded_at = now()
     RETURNING memory_id`,
    [memoryId, provider.id, provider.dim, toPgVector(vector)],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

export async function vectorSearchMemoryIds(
  pool: Queryable,
  queryVector: number[],
  scopeIds: string[],
  provider: Pick<EmbeddingProvider, 'id' | 'dim'>,
  limit: number,
  types?: MemoryType[],
): Promise<Array<{ id: string; distance: number }>> {
  if (scopeIds.length === 0) return [];
  assertEmbeddingVectorDimension(queryVector, provider);
  const params: unknown[] = [
    toPgVector(queryVector),
    scopeIds,
    provider.id,
    provider.dim,
  ];
  let typeFilter = '';
  if (types && types.length > 0) {
    params.push(types);
    typeFilter = ` AND m.type = ANY($${params.length}::text[])`;
  }
  params.push(limit);
  const limitIdx = params.length;
  const { rows } = await pool.query(
    `WITH provider_embeddings AS MATERIALIZED (
       SELECT e.memory_id, e.embedding
         FROM memory_embeddings e
        WHERE e.provider = $3 AND e.dim = $4
     )
     SELECT m.id, e.embedding <=> $1::vector AS distance
       FROM provider_embeddings e
       JOIN memories m ON m.id = e.memory_id
      WHERE m.scope_id = ANY($2::uuid[])
        AND m.state = 'live'
        AND (m.expires_at IS NULL OR m.expires_at > clock_timestamp())
        ${typeFilter}
      ORDER BY e.embedding <=> $1::vector
      LIMIT $${limitIdx}`,
    params,
  );
  return rows.map((r) => ({ id: r.id as string, distance: Number(r.distance) }));
}

export interface RelatedMemorySearchHit {
  id: string;
  type: MemoryType;
  title: string;
  body: string;
  distance: number;
}

export async function vectorSearchRelatedMemories(
  pool: Queryable,
  queryVector: number[],
  scopeIds: string[],
  provider: Pick<EmbeddingProvider, 'id' | 'dim'>,
  options: { threshold: number; excludeMemoryId: string; limit: number },
): Promise<RelatedMemorySearchHit[]> {
  if (scopeIds.length === 0) return [];
  assertEmbeddingVectorDimension(queryVector, provider);
  const { rows } = await pool.query(
    `WITH provider_embeddings AS MATERIALIZED (
       SELECT e.memory_id, e.embedding
         FROM memory_embeddings e
        WHERE e.provider = $3 AND e.dim = $4
     )
     SELECT m.id, m.type, m.title, m.body,
            e.embedding <=> $1::vector AS distance
       FROM provider_embeddings e
       JOIN memories m ON m.id = e.memory_id
      WHERE m.scope_id = ANY($2::uuid[])
        AND m.state = 'live'
        AND (m.expires_at IS NULL OR m.expires_at > clock_timestamp())
        AND m.id <> $5::uuid
        AND 1 - (e.embedding <=> $1::vector) >= $6
      ORDER BY distance ASC, m.id ASC
      LIMIT $7`,
    [
      toPgVector(queryVector), scopeIds, provider.id, provider.dim,
      options.excludeMemoryId, options.threshold, options.limit,
    ],
  );
  return rows.map((row) => ({
    id: row.id as string,
    type: row.type as MemoryType,
    title: row.title as string,
    body: row.body as string,
    distance: Number(row.distance),
  }));
}
