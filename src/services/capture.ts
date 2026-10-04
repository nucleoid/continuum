import type pg from 'pg';
import type { CaptureInput, Memory, Principal } from '../types.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { createMemory } from '../storage/memories.js';
import { getScopeByRef } from '../storage/scopes.js';
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';
import { record as recordAudit } from '../audit/log.js';
import { canWriteScope, canWriteScopeForMutation } from './access.js';
import { asServiceError, dependencyUnavailable, ServiceError } from './errors.js';
import { validateScopeRef } from './scopes.js';
import { isCaptureSource } from '../capture/source.js';

export interface CaptureResult {
  memory: Memory;
  embedded: boolean;
  embedErrorCode?: 'EMBEDDING_FAILED';
}

export async function captureMemory(
  pool: pg.Pool,
  embeddingProvider: EmbeddingProvider | null,
  principal: Principal,
  input: CaptureInput,
  auditMetadata: Record<string, unknown> = {},
): Promise<CaptureResult> {
  try {
    if (!isCaptureSource(input.source)) {
      throw new ServiceError('INVALID_INPUT', 'Unknown capture source');
    }
    validateScopeRef(input.scope);
    const scope = await getScopeByRef(pool, input.scope);
    if (!scope) throw new ServiceError('SCOPE_NOT_FOUND', 'Scope not found');
    if (!(await canWriteScope(pool, principal.id, scope.id))) {
      throw new ServiceError('FORBIDDEN', 'Principal lacks writer role on scope');
    }

    let embeddingVector: number[] | undefined;
    let embedErrorCode: 'EMBEDDING_FAILED' | undefined;
    if (embeddingProvider) {
      try {
        [embeddingVector] = await embeddingProvider.embed([
          `${input.title}\n\n${input.body}`,
        ]);
      } catch {
        embedErrorCode = 'EMBEDDING_FAILED';
      }
    }

    let client: pg.PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      throw dependencyUnavailable(error);
    }
    let destroyClient = false;
    try {
      await client.query('BEGIN');
      const authorizedScope = await getScopeByRef(client, input.scope);
      if (!authorizedScope) throw new ServiceError('SCOPE_NOT_FOUND', 'Scope not found');
      if (!(await canWriteScopeForMutation(client, principal.id, authorizedScope.id))) {
        throw new ServiceError('FORBIDDEN', 'Principal lacks writer role on scope');
      }

      const memory = await createMemory(client, {
        scopeId: authorizedScope.id,
        scopeKind: authorizedScope.kind,
        type: input.type,
        title: input.title,
        body: input.body,
        authorId: principal.id,
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        tags: input.tags,
        metadata: input.metadata,
      });

      let embedded = false;
      if (embeddingProvider && embeddingVector) {
        await client.query('SAVEPOINT capture_embedding');
        try {
          await storeMemoryEmbeddingVector(
            client,
            memory.id,
            embeddingVector,
            embeddingProvider,
          );
          await client.query('RELEASE SAVEPOINT capture_embedding');
          embedded = true;
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT capture_embedding');
          await client.query('RELEASE SAVEPOINT capture_embedding');
          embedErrorCode = 'EMBEDDING_FAILED';
        }
      }

      await recordAudit(client, {
        principalId: principal.id,
        action: 'write',
        memoryId: memory.id,
        scopeId: authorizedScope.id,
        metadata: {
          source: input.source,
          type: input.type,
          embedded,
          ...(embedErrorCode ? { embedding_error_code: embedErrorCode } : {}),
          ...auditMetadata,
        },
      });
      await client.query('COMMIT');
      return { memory, embedded, ...(embedErrorCode ? { embedErrorCode } : {}) };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroyClient = true;
      }
      throw error;
    } finally {
      client.release(destroyClient);
    }
  } catch (error) {
    throw asServiceError(error);
  }
}
