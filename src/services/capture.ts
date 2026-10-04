import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { CaptureInput, Memory, Principal } from '../types.js';
import { asEmbeddingRouter, type EmbeddingRouting } from '../embeddings/router.js';
import { createMemory, updateMemoryMetadata } from '../storage/memories.js';
import { getScopeByRef } from '../storage/scopes.js';
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';
import { assertEmbeddingVectorDimension } from '../storage/schema.js';
import { record as recordAudit } from '../audit/log.js';
import { canWriteScope, canWriteScopeForMutation } from './access.js';
import { asServiceError, dependencyUnavailable, ServiceError } from './errors.js';
import { validateScopeRef } from './scopes.js';
import { isCaptureSource } from '../capture/source.js';
import {
  DEFAULT_RELATION_THRESHOLD,
  detectRelatedMemories,
  type RelatedMemory,
  validateRelationThreshold,
} from './relations.js';

export interface CaptureResult {
  memory: Memory;
  embedded: boolean;
  related: RelatedMemory[];
  embedErrorCode?: 'EMBEDDING_FAILED';
  relationErrorCode?: 'RELATION_DETECTION_FAILED';
}

export interface CaptureOptions {
  relationThreshold?: number;
}

export async function captureMemory(
  pool: pg.Pool,
  embeddingRouting: EmbeddingRouting,
  principal: Principal,
  input: CaptureInput,
  auditMetadata: Record<string, unknown> = {},
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  try {
    const relationThreshold = validateRelationThreshold(
      options.relationThreshold ?? DEFAULT_RELATION_THRESHOLD,
    );
    if (input.metadata && Object.hasOwn(input.metadata, 'related')) {
      throw new ServiceError('INVALID_INPUT', 'metadata.related is reserved by Continuum');
    }
    if (!isCaptureSource(input.source)) {
      throw new ServiceError('INVALID_INPUT', 'Unknown capture source');
    }
    validateScopeRef(input.scope);
    const scope = await getScopeByRef(pool, input.scope);
    if (!scope) throw new ServiceError('SCOPE_NOT_FOUND', 'Scope not found');
    if (!(await canWriteScope(pool, principal.id, scope.id))) {
      throw new ServiceError('FORBIDDEN', 'Principal lacks writer role on scope');
    }

    const memoryId = randomUUID();
    const route = asEmbeddingRouter(embeddingRouting).resolve({
      kind: scope.kind, name: scope.name,
    });
    const embeddingProvider = route.provider;
    let embeddingVector: number[] | undefined;
    let related: RelatedMemory[] = [];
    let embedErrorCode: 'EMBEDDING_FAILED' | undefined;
    let relationErrorCode: 'RELATION_DETECTION_FAILED' | undefined;
    if (embeddingProvider) {
      try {
        [embeddingVector] = await embeddingProvider.embed([
          `${input.title}\n\n${input.body}`,
        ]);
        assertEmbeddingVectorDimension(embeddingVector, embeddingProvider);
      } catch {
        embedErrorCode = 'EMBEDDING_FAILED';
      }
    }

    if (embeddingProvider && embeddingVector) {
      try {
        const org = scope.kind === 'org'
          ? scope
          : await getScopeByRef(pool, { kind: 'org', name: '' });
        const familyScopeIds = org && org.id !== scope.id
          ? [scope.id, org.id]
          : [scope.id];
        related = await detectRelatedMemories(
          pool,
          embeddingVector,
          familyScopeIds,
          embeddingProvider,
          input,
          memoryId,
          relationThreshold,
        );
      } catch {
        related = [];
        relationErrorCode = 'RELATION_DETECTION_FAILED';
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

      let memory = await createMemory(client, {
        id: memoryId,
        scopeId: authorizedScope.id,
        scopeKind: authorizedScope.kind,
        type: input.type,
        title: input.title,
        body: input.body,
        authorId: principal.id,
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        tags: input.tags,
        metadata: { ...input.metadata, related: [] },
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

      if (embedded && !relationErrorCode) {
        await client.query('SAVEPOINT capture_relations');
        try {
          const updatedMemory = await updateMemoryMetadata(client, memory.id, {
            ...memory.metadata,
            related,
          });
          await client.query('RELEASE SAVEPOINT capture_relations');
          memory = updatedMemory;
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT capture_relations');
          await client.query('RELEASE SAVEPOINT capture_relations');
          related = [];
          relationErrorCode = 'RELATION_DETECTION_FAILED';
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
          ...(relationErrorCode ? { relation_error_code: relationErrorCode } : {}),
          ...(route.policy === 'local-only-unavailable'
            ? { embedding_policy: 'local-only-unavailable' }
            : {}),
          ...auditMetadata,
        },
      });
      await client.query('COMMIT');
      return {
        memory,
        embedded,
        related: embedded ? related : [],
        ...(embedErrorCode ? { embedErrorCode } : {}),
        ...(relationErrorCode ? { relationErrorCode } : {}),
      };
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
