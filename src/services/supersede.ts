import type pg from 'pg';
import { asEmbeddingRouter, type EmbeddingRouting } from '../embeddings/router.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { Memory, Principal } from '../types.js';
import { validateCaptureContent } from './capture.js';
import { asServiceError, dependencyUnavailable, ServiceError } from './errors.js';
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';
import {
  getDecisionHistory,
  supersedeDecision,
  SupersedeStorageError,
  type SupersedeWriteResult,
} from '../storage/supersede.js';
import { record as recordAudit, recordRead as recordReadAudit } from '../audit/log.js';

export interface SupersedeInput {
  supersededId: string; title: string; body: string; tags?: string[]; source?: string;
  sourceRef?: string; metadata?: Record<string, unknown>;
}
export interface SupersedeResult {
  predecessor: Memory; successor: Memory; embedded: boolean; embedErrorCode?: 'EMBEDDING_FAILED';
}

function mapStorageError(error: SupersedeStorageError): ServiceError {
  switch (error.kind) {
    case 'not_found': return new ServiceError('MEMORY_NOT_FOUND', 'Memory not found');
    case 'forbidden': return new ServiceError('FORBIDDEN', 'Principal lacks writer role on scope');
    case 'not_decision': return new ServiceError('INVALID_INPUT', 'Only decisions can be superseded');
    case 'not_live': return new ServiceError('CONFLICT', 'Decision is not live');
    case 'successor_exists': return new ServiceError('CONFLICT', 'Decision has already been superseded', {
      details: error.successorId ? { successorId: error.successorId } : undefined,
    });
    case 'dependency_unavailable': return dependencyUnavailable(error);
  }
}

async function recordEmbeddingOutcome(
  queryable: pg.Pool | pg.PoolClient,
  result: SupersedeWriteResult,
  provider: Pick<EmbeddingProvider, 'id' | 'dim'>,
  status: 'succeeded' | 'failed',
): Promise<void> {
  await recordAudit(queryable, {
    principalId: result.successor.authorId,
    action: 'write',
    memoryId: result.successor.id,
    scopeId: result.successor.scopeId,
    metadata: {
      record_kind: 'embedding',
      source: result.successor.source,
      type: result.successor.type,
      embedded: status === 'succeeded',
      embedding: { provider: provider.id, dim: provider.dim, status },
      ...(status === 'failed' ? { embedding_error_code: 'EMBEDDING_FAILED' } : {}),
    },
  });
}

async function tryRecordEmbeddingOutcome(
  queryable: pg.Pool | pg.PoolClient,
  result: SupersedeWriteResult,
  provider: Pick<EmbeddingProvider, 'id' | 'dim'>,
  status: 'succeeded' | 'failed',
): Promise<void> {
  try {
    await recordEmbeddingOutcome(queryable, result, provider, status);
  } catch {
    // Supersession is already committed. Derived observability is best-effort.
  }
}

async function tryRecordEmbeddingPolicy(
  pool: pg.Pool,
  result: SupersedeWriteResult,
  policy: 'local-only-unavailable',
): Promise<void> {
  try {
    await recordAudit(pool, {
      principalId: result.successor.authorId,
      action: 'write',
      memoryId: result.successor.id,
      scopeId: result.successor.scopeId,
      metadata: {
        record_kind: 'embedding',
        source: result.successor.source,
        type: result.successor.type,
        embedded: false,
        embedding_policy: policy,
      },
    });
  } catch {
    // Supersession is already committed. Derived observability is best-effort.
  }
}

async function embedSuccessor(
  pool: pg.Pool,
  embeddingRouting: EmbeddingRouting,
  result: SupersedeWriteResult,
): Promise<{ embedded: boolean; embedErrorCode?: 'EMBEDDING_FAILED' }> {
  const route = asEmbeddingRouter(embeddingRouting).resolve({
    kind: result.scope.kind,
    name: result.scope.name,
  });
  const provider = route.provider;
  if (!provider) {
    if (route.policy === 'local-only-unavailable') {
      await tryRecordEmbeddingPolicy(pool, result, route.policy);
    }
    return { embedded: false };
  }

  let vector: number[];
  try {
    [vector] = await provider.embed([
      `${result.successor.title}\n\n${result.successor.body}`,
    ]);
  } catch {
    await tryRecordEmbeddingOutcome(pool, result, provider, 'failed');
    return { embedded: false, embedErrorCode: 'EMBEDDING_FAILED' };
  }

  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch {
    return { embedded: false, embedErrorCode: 'EMBEDDING_FAILED' };
  }
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    await storeMemoryEmbeddingVector(client, result.successor.id, vector, provider);
    await client.query('DELETE FROM memory_embeddings WHERE memory_id = $1', [result.predecessor.id]);
    await recordEmbeddingOutcome(client, result, provider, 'succeeded');
    await client.query('COMMIT');
    return { embedded: true };
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroyClient = true;
    }
    await tryRecordEmbeddingOutcome(pool, result, provider, 'failed');
    return { embedded: false, embedErrorCode: 'EMBEDDING_FAILED' };
  } finally {
    client.release(destroyClient);
  }
}

export async function supersedeForPrincipal(
  pool: pg.Pool, embeddingRouting: EmbeddingRouting, principal: Principal,
  input: SupersedeInput, auditMetadata: Record<string, unknown> = {},
  allowedSource?: string,
): Promise<SupersedeResult> {
  try {
    const source = input.source ?? 'manual';
    if (allowedSource !== undefined && source !== allowedSource) {
      throw new ServiceError('FORBIDDEN', 'credential is not allowed for this source');
    }
    validateCaptureContent({ ...input, source });
    let result;
    try {
      result = await supersedeDecision(pool, { ...input, source, principalId: principal.id, auditMetadata });
    } catch (error) {
      if (error instanceof SupersedeStorageError) throw mapStorageError(error);
      throw error;
    }
    const embedding = await embedSuccessor(pool, embeddingRouting, result);
    return { predecessor: result.predecessor, successor: result.successor, ...embedding };
  } catch (error) { throw asServiceError(error); }
}

export async function decisionHistoryForPrincipal(
  pool: pg.Pool, principal: Principal, decisionId: string,
  auditMetadata: Record<string, unknown> = {},
): Promise<{ decisions: Memory[]; currentId: string }> {
  let client: pg.PoolClient | undefined;
  let destroyClient = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const history = await getDecisionHistory(client, principal.id, decisionId);
    if (!history) throw new ServiceError('MEMORY_NOT_FOUND', 'Memory not found');
    const anchor = history.memories.find((memory) => memory.id === decisionId)!;
    if (anchor.type !== 'decision') throw new ServiceError('INVALID_INPUT', 'Memory is not a decision');
    if (history.cycle || history.memories.some((memory) => memory.type !== 'decision' || memory.scopeId !== anchor.scopeId)) {
      throw new ServiceError('INTERNAL', 'An internal error occurred');
    }
    const currentId = history.memories.at(-1)!.id;
    await recordReadAudit(client, {
      principalId: principal.id,
      metadata: {
        view: 'decision-history', anchor_id: decisionId, current_id: currentId,
        ...auditMetadata,
      },
      memories: history.memories.map((memory, index) => ({
        memoryId: memory.id, scopeId: memory.scopeId, metadata: { rank: index + 1 },
      })),
    });
    await client.query('COMMIT');
    return { decisions: history.memories, currentId };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { destroyClient = true; }
    }
    if (!client) throw dependencyUnavailable(error);
    throw asServiceError(error);
  } finally {
    client?.release(destroyClient);
  }
}
