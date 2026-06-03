import type pg from 'pg';
import type { EmbeddingProvider } from '../embeddings/provider.js';

function toPgVector(v: number[]): string {
  return `[${v.join(',')}]`;
}

export async function storeMemoryEmbedding(
  pool: pg.Pool,
  memoryId: string,
  text: string,
  provider: EmbeddingProvider,
): Promise<void> {
  const [vector] = await provider.embed([text]);
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
  pool: pg.Pool,
  queryVector: number[],
  scopeIds: string[],
  limit: number,
): Promise<Array<{ id: string; distance: number }>> {
  if (scopeIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT m.id, e.embedding <=> $1::vector AS distance
       FROM memory_embeddings e
       JOIN memories m ON m.id = e.memory_id
      WHERE m.scope_id = ANY($2::uuid[])
        AND m.state = 'live'
      ORDER BY e.embedding <=> $1::vector
      LIMIT $3`,
    [toPgVector(queryVector), scopeIds, limit],
  );
  return rows.map((r) => ({ id: r.id as string, distance: Number(r.distance) }));
}
