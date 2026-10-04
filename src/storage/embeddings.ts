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
): Promise<void> {
  const [vector] = await provider.embed([text]);
  await storeMemoryEmbeddingVector(pool, memoryId, vector, provider);
}

export async function storeMemoryEmbeddingVector(
  pool: Queryable,
  memoryId: string,
  vector: number[],
  provider: Pick<EmbeddingProvider, 'id' | 'dim'>,
): Promise<void> {
  assertEmbeddingVectorDimension(vector, provider);
  await pool.query(
    `INSERT INTO memory_embeddings (memory_id, provider, dim, embedding)
     VALUES ($1, $2, $3, $4::vector)
     ON CONFLICT (memory_id) DO UPDATE
       SET provider = EXCLUDED.provider,
           dim = EXCLUDED.dim,
           embedding = EXCLUDED.embedding,
           embedded_at = now()`,
    [memoryId, provider.id, provider.dim, toPgVector(vector)],
  );
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
    `SELECT m.id, e.embedding <=> $1::vector AS distance
       FROM memory_embeddings e
       JOIN memories m ON m.id = e.memory_id
      WHERE m.scope_id = ANY($2::uuid[])
        AND m.state = 'live'
        AND (m.expires_at IS NULL OR m.expires_at > now())
        AND e.provider = $3
        AND e.dim = $4
        ${typeFilter}
      ORDER BY e.embedding <=> $1::vector
      LIMIT $${limitIdx}`,
    params,
  );
  return rows.map((r) => ({ id: r.id as string, distance: Number(r.distance) }));
}
