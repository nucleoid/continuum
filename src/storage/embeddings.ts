import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { MemoryType } from '../types.js';
import type { Queryable } from './queryable.js';
import { assertEmbeddingVectorDimension } from './schema.js';

function toPgVector(v: number[]): string {
  return `[${v.join(',')}]`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function vectorSqlNames(pool: Queryable): Promise<{ distanceOperator: string; vectorType: string }> {
  const { rows } = await pool.query(
    `SELECT namespace.nspname AS schema
       FROM pg_catalog.pg_extension extension
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = extension.extnamespace
      WHERE extension.extname = 'vector'`,
  );
  const schema = rows[0]?.schema as string | undefined;
  if (schema === undefined) {
    throw new Error('The vector extension is not installed');
  }
  return { distanceOperator: `OPERATOR(${quoteIdentifier(schema)}.<=>)`,
    vectorType: `${quoteIdentifier(schema)}.vector` };
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
  const { vectorType } = await vectorSqlNames(pool);
  const result = await pool.query(
    `WITH locked_memory AS MATERIALIZED (
       SELECT m.id,m.state,m.expires_at FROM memories m WHERE m.id=$1::uuid FOR UPDATE OF m
     )
     INSERT INTO memory_embeddings (memory_id, provider, dim, embedding)
     SELECT m.id, $2::text, $3::integer, $4::${vectorType}
       FROM locked_memory m
      WHERE m.state = 'live'
        AND (m.expires_at IS NULL OR m.expires_at > pg_catalog.clock_timestamp())
     ON CONFLICT (memory_id, provider, dim) DO UPDATE
       SET embedding = EXCLUDED.embedding,
           embedded_at = pg_catalog.clock_timestamp()
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
  const { distanceOperator, vectorType } = await vectorSqlNames(pool);
  const { rows } = await pool.query(
    `WITH provider_embeddings AS MATERIALIZED (
       SELECT m.id AS memory_id, e.embedding
         FROM memory_embeddings e
         JOIN memories m ON m.id = e.memory_id
        WHERE e.provider = $3 AND e.dim = $4
          AND m.scope_id = ANY($2::uuid[])
          AND m.state = 'live'
          AND (m.expires_at IS NULL OR m.expires_at > pg_catalog.clock_timestamp())
          ${typeFilter}
     )
     SELECT e.memory_id AS id, e.embedding ${distanceOperator} $1::${vectorType} AS distance
       FROM provider_embeddings e
      ORDER BY e.embedding ${distanceOperator} $1::${vectorType}
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
  const { distanceOperator, vectorType } = await vectorSqlNames(pool);
  const { rows } = await pool.query(
    `WITH provider_embeddings AS MATERIALIZED (
       SELECT m.id AS memory_id, e.embedding
         FROM memory_embeddings e
         JOIN memories m ON m.id = e.memory_id
        WHERE e.provider = $3 AND e.dim = $4
          AND m.scope_id = ANY($2::uuid[])
          AND m.state = 'live'
          AND (m.expires_at IS NULL OR m.expires_at > pg_catalog.clock_timestamp())
          AND m.id <> $5::uuid
     )
     SELECT ranked.memory_id AS id, m.type, m.title, m.body, ranked.distance
       FROM (
         SELECT e.memory_id, e.embedding ${distanceOperator} $1::${vectorType} AS distance
           FROM provider_embeddings e
          WHERE 1 - (e.embedding ${distanceOperator} $1::${vectorType}) >= $6
          ORDER BY distance ASC, e.memory_id ASC
          LIMIT $7
       ) ranked
       JOIN memories m ON m.id = ranked.memory_id
      ORDER BY ranked.distance ASC, ranked.memory_id ASC`,
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
