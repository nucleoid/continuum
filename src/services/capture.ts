import type pg from 'pg';
import type { CaptureInput, Memory, Principal, Scope } from '../types.js';
import { asEmbeddingRouter, type EmbeddingRouting } from '../embeddings/router.js';
import { createMemoryWithEvent } from '../storage/memories.js';
import { getScopeByRef } from '../storage/scopes.js';
import { record as recordAudit } from '../audit/log.js';
import { canWriteScopeForMutation } from './access.js';
import { asServiceError, ServiceError } from './errors.js';
import { validateScopeRef } from './scopes.js';
import { isCaptureSource } from '../capture/source.js';
import {
  DEFAULT_RELATION_THRESHOLD,
  type RelatedMemory,
  validateRelationThreshold,
} from './relations.js';
import type { Queryable } from '../storage/queryable.js';
import { normalizeTags, validateTagsForScopeKind } from './tag-vocabularies.js';
import { captureExtractionStatus } from './extraction.js';
import type { ExtractionStatus } from '../extraction/model.js';
import { parseEventAnnotation } from '../temporal/model.js';
import { captureReceiptIdentity, initialEmbeddingStatus } from './embedding-jobs.js';
import { evidenceTransaction } from '../storage/evidence.js';
import { getReadableMemory } from '../storage/memory-reads.js';
import { readEventAnnotations } from '../storage/temporal.js';
import { readEmbeddingStatus } from '../storage/embedding-jobs.js';
import type { EmbeddingStatus } from '../storage/embedding-jobs-model.js';
import type { EmbeddingTarget } from '../embeddings/target.js';

export interface CaptureResult {
  embeddingStatus: EmbeddingStatus;
  replayed?: boolean;
  memory: Memory;
  embedded: boolean;
  related: RelatedMemory[];
  extraction?: ExtractionStatus;
  embedErrorCode?: 'EMBEDDING_FAILED';
  relationErrorCode?: 'RELATION_DETECTION_FAILED';
}

export interface CaptureOptions {
  idempotencyKey?: string;
  validateResult?: (result: CaptureResult) => void;
  readBudgetBytes?: number;
  relationThreshold?: number;
}

export const RESERVED_MEMORY_METADATA_KEYS = [
  'related',
  'continuum_legacy_tags',
  'continuum_legacy_metadata',
  'continuum_tag_migration',
  'continuum_tag_rollback_compat',
  'continuum_migration_conflicts',
  '_continuum_activity_provenance', '_continuum_activity_epoch_ms',
  '_continuum_actor_mapping_id', '_continuum_actor_mapping_authority',
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
  if (input.eventAnnotation !== undefined) parseEventAnnotation(input.eventAnnotation);
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

/** Insert and enqueue inside the caller's source/audit transaction. No provider I/O. */
export async function captureOne(
  client: Queryable,
  embeddingRouting: EmbeddingRouting,
  principal: Principal,
  input: CaptureInput,
  auditMetadata: Record<string, unknown> = {},
): Promise<CaptureResult> {
  const { scope, tags } = await prepareCaptureWrite(client, principal, input);
  const router = asEmbeddingRouter(embeddingRouting);
  const route = router.resolve({ kind: scope.kind, name: scope.name });
  const memory = await createMemoryWithEvent(client, {
    scopeId: scope.id, scopeKind: scope.kind, type: input.type, title: input.title,
    body: input.body, authorId: principal.id, source: input.source,
    sourceRef: input.sourceRef ?? null, tags, metadata: { ...input.metadata, related: [] },
  }, input.eventAnnotation);
  let target: EmbeddingTarget | null = null;
  try { target = route.provider?.target ?? null; } catch { /* A malformed provider cannot reject a valid source write. */ }
  const embeddingStatus = (await client.query<{ status: EmbeddingStatus }>(
    'SELECT continuum_embedding_enqueue($1,$2,$3,$4,$5) AS status',
    [principal.id, memory.id, target, router.queuePolicy ?? null, initialEmbeddingStatus(route)],
  )).rows[0].status;
  await recordAudit(client, { principalId: principal.id, action: 'write', memoryId: memory.id, scopeId: scope.id,
    metadata: { ...auditMetadata, source: input.source, type: input.type, embedded: false,
      embedding_status: embeddingStatus,
      ...(route.provider ? { embedding: { provider: route.provider.id, dim: route.provider.dim, status: embeddingStatus } } : {}),
      ...(route.policy === 'local-only-unavailable' ? { embedding_policy: 'local-only-unavailable' } : {}),
    },
  });
  return { memory, embedded: false, embeddingStatus, related: [],
    extraction: await captureExtractionStatus(client, principal.id, memory.id) };
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
    normalizeCapture(input);
    validateRelationThreshold(options.relationThreshold ?? DEFAULT_RELATION_THRESHOLD);
    return await evidenceTransaction(pool, async client => {
      const scope = await getScopeByRef(client, input.scope);
      if (!scope) throw new ServiceError('SCOPE_NOT_FOUND', 'Scope not found');
      const receipt = options.idempotencyKey === undefined ? undefined
        : captureReceiptIdentity(principal.id, scope.id, options.idempotencyKey, input);
      let result: CaptureResult;
      if (receipt) {
        const existing = (await client.query<{ memory: string | null }>(
          'SELECT continuum_embedding_receipt_begin($1,$2,$3,$4,$5) AS memory',
          [principal.id, scope.id, receipt.keyHash, receipt.payloadDigest, input.source],
        )).rows[0].memory;
        if (existing) {
          const record = await getReadableMemory(client, principal.id, existing, options.readBudgetBytes);
          const status = await readEmbeddingStatus(client, principal.id, existing);
          if (!record || !status) throw new ServiceError('MEMORY_NOT_FOUND', 'Memory not found');
          const event = (await readEventAnnotations(client, principal.id, [existing], true, options.readBudgetBytes)).get(existing);
          if (event?.version) record.memory.event = event;
          const extraction = (await client.query<{ result: ExtractionStatus }>(
            'SELECT continuum_embedding_replay_extraction($1,$2) AS result', [principal.id, existing])).rows[0].result;
          result = { memory: record.memory, embedded: status.embedded, embeddingStatus: status.embeddingStatus,
            related: [], replayed: true, extraction };
          options.validateResult?.(result);
          await recordAudit(client, { principalId: principal.id, action: 'read', memoryId: existing, scopeId: scope.id,
            metadata: { ...auditMetadata, operation: 'capture_replay' } });
          return result;
        }
      }
      result = await captureOne(client, embeddingRouting, principal, input, auditMetadata);
      options.validateResult?.(result);
      if (receipt) await client.query('SELECT continuum_embedding_receipt_finish($1,$2,$3,$4,$5)',
        [principal.id, scope.id, receipt.keyHash, receipt.payloadDigest, result.memory.id]);
      return result;
    });
  } catch (error) {
    const message = (error as { message?: unknown })?.message;
    if (message === 'EMBEDDING_CAPTURE_CONFLICT') throw new ServiceError('CONFLICT', 'Idempotency key conflicts with a different capture');
    if (message === 'EMBEDDING_QUEUE_QUOTA_EXCEEDED' || message === 'EMBEDDING_RECEIPT_QUOTA_EXCEEDED') {
      throw new ServiceError(message, 'Embedding admission quota is exhausted');
    }
    if ((error as { code?: unknown })?.code === '42501') throw new ServiceError('FORBIDDEN', 'Capture replay unavailable');
    throw asServiceError(error);
  }
}
