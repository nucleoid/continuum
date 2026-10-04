import type pg from 'pg';
import { asEmbeddingRouter, type EmbeddingRouting } from '../embeddings/router.js';
import type { Memory, Principal } from '../types.js';
import { canReadScope } from './access.js';
import { validateCaptureContent } from './capture.js';
import { asServiceError, ServiceError } from './errors.js';
import { getScope } from '../storage/scopes.js';
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';
import { getDecisionHistory, supersedeDecision, SupersedeStorageError } from '../storage/supersede.js';
import { recordRead as recordReadAudit } from '../audit/log.js';

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
  }
}

export async function supersedeForPrincipal(
  pool: pg.Pool, embeddingRouting: EmbeddingRouting, principal: Principal,
  input: SupersedeInput, auditMetadata: Record<string, unknown> = {},
): Promise<SupersedeResult> {
  try {
    const source = input.source ?? 'manual';
    validateCaptureContent({ ...input, source });
    let result;
    try {
      result = await supersedeDecision(pool, { ...input, source, principalId: principal.id, auditMetadata });
    } catch (error) {
      if (error instanceof SupersedeStorageError) throw mapStorageError(error);
      throw error;
    }
    let embedded = false;
    let embedErrorCode: 'EMBEDDING_FAILED' | undefined;
    try {
      await pool.query('DELETE FROM memory_embeddings WHERE memory_id = $1', [result.predecessor.id]);
      const scope = await getScope(pool, result.successor.scopeId);
      if (!scope) throw new Error('superseded decision scope no longer exists');
      const provider = asEmbeddingRouter(embeddingRouting).resolve({
        kind: scope.kind, name: scope.name,
      }).provider;
      if (provider) {
        const [vector] = await provider.embed([`${input.title}\n\n${input.body}`]);
        await storeMemoryEmbeddingVector(pool, result.successor.id, vector, provider);
        embedded = true;
      }
    } catch { embedErrorCode = 'EMBEDDING_FAILED'; }
    return { ...result, embedded, ...(embedErrorCode ? { embedErrorCode } : {}) };
  } catch (error) { throw asServiceError(error); }
}

export async function decisionHistoryForPrincipal(
  pool: pg.Pool, principal: Principal, decisionId: string,
  auditMetadata: Record<string, unknown> = {},
): Promise<{ decisions: Memory[]; currentId: string }> {
  try {
    const history = await getDecisionHistory(pool, decisionId);
    if (!history) throw new ServiceError('MEMORY_NOT_FOUND', 'Memory not found');
    const anchor = history.memories.find((memory) => memory.id === decisionId)!;
    const scope = await getScope(pool, anchor.scopeId);
    if (!scope || !(await canReadScope(pool, principal.id, scope))) {
      throw new ServiceError('FORBIDDEN', 'Principal cannot read this decision');
    }
    if (anchor.type !== 'decision') throw new ServiceError('INVALID_INPUT', 'Memory is not a decision');
    if (history.cycle || history.memories.some((memory) => memory.type !== 'decision' || memory.scopeId !== anchor.scopeId)) {
      throw new ServiceError('INTERNAL', 'An internal error occurred');
    }
    const currentId = history.memories.at(-1)!.id;
    await recordReadAudit(pool, {
      principalId: principal.id,
      metadata: {
        view: 'decision-history', anchor_id: decisionId, current_id: currentId,
        ...auditMetadata,
      },
      memories: history.memories.map((memory, index) => ({
        memoryId: memory.id, scopeId: memory.scopeId, metadata: { rank: index + 1 },
      })),
    });
    return { decisions: history.memories, currentId };
  } catch (error) { throw asServiceError(error); }
}
