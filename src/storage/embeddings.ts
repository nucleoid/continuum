import { boundedMemoryReadRows } from './memory-reads.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { MemoryType } from '../types.js';
import type { Queryable } from './queryable.js';
import { assertEmbeddingVectorDimension } from './schema.js';
import type { EventWindow } from '../temporal/model.js';
import { eventPredicate } from './temporal.js';
import { createHash } from 'node:crypto';
import type { EmbeddingTarget } from '../embeddings/target.js';

export interface MemoryEmbeddingAdmission {
  memoryId: string;
  generation: string;
  inputHash: string;
  target: EmbeddingTarget;
  policyGeneration: string;
  policyDigest: string;
}
/** Metadata admission before hydration/provider I/O. Never refresh this identity
 * after a provider response, even when the source appears live again. */
export async function admitMemoryEmbedding(pool: Queryable, memoryId: string,
  provider: Pick<EmbeddingProvider, 'id' | 'dim' | 'target'>): Promise<MemoryEmbeddingAdmission | null> {
  if (!provider.target || provider.target.space.provider !== provider.id || provider.target.space.dim !== provider.dim) {
    throw new Error('Embedding vector-space descriptor is unavailable');
  }
  return (await pool.query<{ admission: MemoryEmbeddingAdmission | null }>(
    'SELECT continuum_embedding_admit_vector($1,$2) AS admission', [memoryId, provider.target],
  )).rows[0].admission;
}
export function embeddingInputMatches(admission: MemoryEmbeddingAdmission, text: string): boolean {
  return createHash('sha256').update(text).digest('hex') === admission.inputHash;
}
export async function embeddingTargetIsCurrent(pool: Queryable,
  provider: Pick<EmbeddingProvider, 'id' | 'dim' | 'target'>, scopeIds: string[]): Promise<boolean> {
  if (!provider.target || provider.target.space.provider !== provider.id || provider.target.space.dim !== provider.dim) return false;
  return (await pool.query<{ current: boolean }>('SELECT continuum_embedding_target_is_current($1,$2) AS current',
    [provider.target, scopeIds])).rows[0].current === true;
}

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
  const admission = await admitMemoryEmbedding(pool, memoryId, provider);
  if (!admission || !embeddingInputMatches(admission, text)) return false;
  const [vector] = await provider.embed([text]);
  return storeMemoryEmbeddingVector(pool, memoryId, vector, provider, admission);
}

export async function storeMemoryEmbeddingVector(
  pool: Queryable,
  memoryId: string,
  vector: number[],
  provider: Pick<EmbeddingProvider, 'id' | 'dim'>,
  admission: MemoryEmbeddingAdmission,
): Promise<boolean> {
  assertEmbeddingVectorDimension(vector, provider);
  if (!admission || admission.memoryId !== memoryId || admission.target.space.provider !== provider.id
    || admission.target.space.dim !== provider.dim) throw new TypeError('Original embedding source admission is required');
  return (await pool.query<{ stored: boolean }>('SELECT continuum_embedding_apply_vector($1,$2,$3) AS stored',
    [memoryId, toPgVector(vector), admission])).rows[0].stored;
}

export async function vectorSearchMemoryIds(
  pool: Queryable,
  queryVector: number[],
  scopeIds: string[],
  provider: Pick<EmbeddingProvider, 'id' | 'dim' | 'target'>,
  limit: number,
  types?: MemoryType[],
  eventFilter?: EventWindow,
  actor?: string,
  stableOrder = false,
): Promise<Array<{ id: string; distance: number }>> {
  if (scopeIds.length === 0) return [];
  assertEmbeddingVectorDimension(queryVector, provider);
  if (!await embeddingTargetIsCurrent(pool, provider, scopeIds)) return [];
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
  const temporal = eventPredicate(params, actor, eventFilter);
  params.push(limit);
  const limitIdx = params.length;
  const { distanceOperator, vectorType } = await vectorSqlNames(pool);
  const { rows } = await pool.query(
    `WITH provider_embeddings AS MATERIALIZED (
       SELECT m.id AS memory_id, e.embedding
         FROM memory_embeddings e
         JOIN memories m ON m.id = e.memory_id
        WHERE e.provider = $3 AND e.dim = $4
          AND continuum_embedding_vector_is_current(m.id,e.provider,e.dim)
          AND m.scope_id = ANY($2::uuid[])
          AND m.state = 'live'
          AND (m.expires_at IS NULL OR m.expires_at > pg_catalog.clock_timestamp())
          ${typeFilter}
          ${temporal}
     )
     SELECT e.memory_id AS id, e.embedding ${distanceOperator} $1::${vectorType} AS distance
       FROM provider_embeddings e
      ORDER BY e.embedding ${distanceOperator} $1::${vectorType}${stableOrder ? ', e.memory_id ASC' : ''}
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
  provider: Pick<EmbeddingProvider, 'id' | 'dim' | 'target'>,
  options: { threshold: number; excludeMemoryId: string; limit: number; readBudgetBytes?: number },
): Promise<RelatedMemorySearchHit[]> {
  if (scopeIds.length === 0) return [];
  assertEmbeddingVectorDimension(queryVector, provider);
  if (!await embeddingTargetIsCurrent(pool, provider, scopeIds)) return [];
  const { distanceOperator, vectorType } = await vectorSqlNames(pool);
  if (options.readBudgetBytes !== undefined) {
    const metadataSql = `WITH provider_embeddings AS MATERIALIZED (
       SELECT m.id AS memory_id, e.embedding FROM memory_embeddings e
         JOIN memories m ON m.id=e.memory_id
        WHERE e.provider=$3 AND e.dim=$4 AND continuum_embedding_vector_is_current(m.id,e.provider,e.dim) AND m.scope_id=ANY($2::uuid[])
          AND m.state='live' AND (m.expires_at IS NULL OR m.expires_at>pg_catalog.clock_timestamp())
          AND m.id<>$5::uuid
     ), ranked AS MATERIALIZED (
       SELECT e.memory_id, e.embedding ${distanceOperator} $1::${vectorType} AS distance
         FROM provider_embeddings e
        WHERE 1-(e.embedding ${distanceOperator} $1::${vectorType}) >= $6
        ORDER BY distance ASC, e.memory_id ASC LIMIT $7
     ) SELECT m.id, ranked.distance,
       4096::bigint + octet_length(m.title)::bigint + octet_length(m.body)::bigint AS budget_bytes,
       row_number() OVER (ORDER BY ranked.distance ASC, ranked.memory_id ASC) AS position
       FROM ranked JOIN memories m ON m.id=ranked.memory_id`;
    const rows = await boundedMemoryReadRows(pool, metadataSql,
      [toPgVector(queryVector), scopeIds, provider.id, provider.dim,
        options.excludeMemoryId, options.threshold, options.limit],
      `SELECT m.id, m.type, m.title, m.body, c.distance FROM memories m
         JOIN budget_candidates c ON c.id=m.id ORDER BY c.position`, options.readBudgetBytes);
    return rows.map((row) => ({ id: row.id as string, type: row.type as MemoryType,
      title: row.title as string, body: row.body as string, distance: Number(row.distance) }));
  }
  const { rows } = await pool.query(
    `WITH provider_embeddings AS MATERIALIZED (
       SELECT m.id AS memory_id, e.embedding
         FROM memory_embeddings e
         JOIN memories m ON m.id = e.memory_id
        WHERE e.provider = $3 AND e.dim = $4
          AND continuum_embedding_vector_is_current(m.id,e.provider,e.dim)
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
