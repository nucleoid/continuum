import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { CaptureInput, Memory, Principal, Scope } from '../types.js';
import { asEmbeddingRouter, type EmbeddingRouting } from '../embeddings/router.js';
import { createMemory, updateMemoryMetadata } from '../storage/memories.js';
import { getScope, getScopeByRef } from '../storage/scopes.js';
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
import type { Queryable } from '../storage/queryable.js';
import { normalizeTags, validateTagsForScopeKind } from './tag-vocabularies.js';

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

export const RESERVED_MEMORY_METADATA_KEYS = [
  'related',
  'continuum_legacy_tags',
  'continuum_legacy_metadata',
  'continuum_tag_migration',
  'continuum_tag_rollback_compat',
  'continuum_migration_conflicts',
] as const;

export function validateCaptureContent(input: Pick<CaptureInput,
  'title' | 'body' | 'tags' | 'source' | 'sourceRef' | 'metadata'>): void {
  if (input.title.length === 0 || input.title.length > 500 || input.body.length === 0) {
    throw new ServiceError('INVALID_INPUT', 'Invalid memory content');
  }
  for (const key of RESERVED_MEMORY_METADATA_KEYS) {
    if (input.metadata && Object.hasOwn(input.metadata, key)) {
      throw new ServiceError(
        'INVALID_INPUT',
        `metadata.${key} is reserved by Continuum`,
      );
    }
  }
  if (!isCaptureSource(input.source)) {
    throw new ServiceError('INVALID_INPUT', 'Unknown capture source');
  }
  if (input.tags && input.tags.some((tag) => typeof tag !== 'string')) {
    throw new ServiceError('INVALID_INPUT', 'Invalid memory tags');
  }
  if (input.metadata && (Array.isArray(input.metadata) || input.metadata === null)) {
    throw new ServiceError('INVALID_INPUT', 'Invalid memory metadata');
  }
}

function normalizeCapture(input: CaptureInput): string[] {
  validateCaptureContent(input);
  validateScopeRef(input.scope);
  return normalizeTags(input.tags);
}

async function prepareCaptureWrite(
  client: Queryable,
  principal: Principal,
  input: CaptureInput,
): Promise<{ scope: Scope; tags: string[] }> {
  const tags = normalizeCapture(input);
  const scope = await getScopeByRef(client, input.scope);
  if (!scope) throw new ServiceError('SCOPE_NOT_FOUND', 'Scope not found');
  if (!(await canWriteScopeForMutation(client, principal.id, scope.id))) {
    throw new ServiceError('FORBIDDEN', 'Principal lacks writer role on scope');
  }
  await validateTagsForScopeKind(client, scope.kind, tags, true);
  return { scope, tags };
}

/** Insert one capture into a caller-owned transaction. */
export async function captureOne(
  client: Queryable,
  embeddingRouting: EmbeddingRouting,
  principal: Principal,
  input: CaptureInput,
  auditMetadata: Record<string, unknown> = {},
): Promise<CaptureResult> {
  const { scope, tags } = await prepareCaptureWrite(client, principal, input);

  const route = asEmbeddingRouter(embeddingRouting).resolve(input.scope);
  const memory = await createMemory(client, {
    scopeId: scope.id,
    scopeKind: scope.kind,
    type: input.type,
    title: input.title,
    body: input.body,
    authorId: principal.id,
    source: input.source,
    sourceRef: input.sourceRef ?? null,
    tags,
    metadata: { ...input.metadata, related: [] },
  });

  await recordAudit(client, {
    principalId: principal.id,
    action: 'write',
    memoryId: memory.id,
    scopeId: scope.id,
    metadata: {
      source: input.source,
      type: input.type,
      embedded: false,
      ...(route.provider ? {
        embedding: {
          provider: route.provider.id,
          dim: route.provider.dim,
          status: 'failed',
        },
        embedding_error_code: 'EMBEDDING_FAILED',
      } : {}),
      ...(route.policy === 'local-only-unavailable'
        ? { embedding_policy: 'local-only-unavailable' }
        : {}),
      ...auditMetadata,
    },
  });
  return {
    memory,
    embedded: false,
    related: [],
    ...(route.provider ? { embedErrorCode: 'EMBEDDING_FAILED' as const } : {}),
  };
}

/** Finish provider work only after the atomic webhook delivery commits. */
export async function embedCapturedMemory(
  pool: pg.Pool,
  embeddingRouting: EmbeddingRouting,
  result: CaptureResult,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const relationThreshold = validateRelationThreshold(
    options.relationThreshold ?? DEFAULT_RELATION_THRESHOLD,
  );
  const scope = await getScope(pool, result.memory.scopeId);
  if (!scope) return result;
  const route = asEmbeddingRouter(embeddingRouting).resolve({ kind: scope.kind, name: scope.name });
  const provider = route.provider;
  if (!provider) return result;
  let vector: number[];
  try {
    [vector] = await provider.embed([
      `${result.memory.title}\n\n${result.memory.body}`,
    ]);
    assertEmbeddingVectorDimension(vector, provider);
  } catch {
    return result;
  }

  let related: RelatedMemory[] = [];
  let relationErrorCode: 'RELATION_DETECTION_FAILED' | undefined;
  try {
    const org = scope.kind === 'org'
      ? scope
      : await getScopeByRef(pool, { kind: 'org', name: '' });
    const familyScopeIds = org && org.id !== scope.id
      ? [scope.id, org.id]
      : [scope.id];
    related = await detectRelatedMemories(
      pool,
      vector,
      familyScopeIds,
      provider,
      result.memory,
      result.memory.id,
      relationThreshold,
    );
  } catch {
    relationErrorCode = 'RELATION_DETECTION_FAILED';
  }

  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch {
    return result;
  }
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    await client.query('SAVEPOINT ingest_embedding');
    try {
      await storeMemoryEmbeddingVector(client, result.memory.id, vector, provider);
      await client.query('RELEASE SAVEPOINT ingest_embedding');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT ingest_embedding');
      await client.query('RELEASE SAVEPOINT ingest_embedding');
      await client.query('COMMIT');
      return result;
    }

    let memory = result.memory;
    if (!relationErrorCode) {
      await client.query('SAVEPOINT ingest_relations');
      try {
        memory = await updateMemoryMetadata(client, memory.id, {
          ...memory.metadata,
          related,
        });
        await client.query('RELEASE SAVEPOINT ingest_relations');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT ingest_relations');
        await client.query('RELEASE SAVEPOINT ingest_relations');
        related = [];
        relationErrorCode = 'RELATION_DETECTION_FAILED';
      }
    }

    await recordAudit(client, {
      principalId: memory.authorId,
      action: 'write',
      memoryId: memory.id,
      scopeId: memory.scopeId,
      metadata: {
        record_kind: 'embedding',
        source: memory.source,
        type: memory.type,
        embedded: true,
        embedding: { provider: provider.id, dim: provider.dim, status: 'succeeded' },
        ...(relationErrorCode ? { relation_error_code: relationErrorCode } : {}),
      },
    });
    await client.query('COMMIT');
    return {
      memory,
      embedded: true,
      related: relationErrorCode ? [] : related,
      ...(relationErrorCode ? { relationErrorCode } : {}),
    };
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroyClient = true;
    }
    return result;
  } finally {
    client.release(destroyClient);
  }
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
    const tags = normalizeCapture(input);
    const scope = await getScopeByRef(pool, input.scope);
    if (!scope) throw new ServiceError('SCOPE_NOT_FOUND', 'Scope not found');
    if (!(await canWriteScope(pool, principal.id, scope.id))) {
      throw new ServiceError('FORBIDDEN', 'Principal lacks writer role on scope');
    }
    await validateTagsForScopeKind(pool, scope.kind, tags);

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
      const prepared = await prepareCaptureWrite(client, principal, input);
      const authorizedScope = prepared.scope;

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
        tags: prepared.tags,
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
          ...(embeddingProvider ? {
            embedding: {
              provider: embeddingProvider.id,
              dim: embeddingProvider.dim,
              status: embedded ? 'succeeded' : 'failed',
            },
          } : {}),
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
