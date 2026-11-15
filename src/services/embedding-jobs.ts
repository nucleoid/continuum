import { createHash } from 'node:crypto';
import type { CaptureInput } from '../types.js';
import { parseEventAnnotation } from '../temporal/model.js';
import { normalizeTags } from './tag-vocabularies.js';
import { validateCaptureContent } from './capture.js';
import { ServiceError } from './errors.js';
import type { EmbeddingRoute } from '../embeddings/router.js';
import type { EmbeddingStatus } from '../storage/embedding-jobs-model.js';
import type pg from 'pg';
import type { Principal } from '../types.js';
import type { EmbeddingTarget } from '../embeddings/target.js';
import { checkedProfile, type BudgetProfile } from '../pipeline/budget.js';
import { evidenceTransaction } from '../storage/evidence.js';
import { readEmbeddingStatus } from '../storage/embedding-jobs.js';
import { record as recordAudit } from '../audit/log.js';

export interface EmbeddingWindowPolicy {
  seconds: number; dispatches: number; inputBytes: number; tokens: number; spendMicros: number; rateSchedule: string;
}
async function operatorOperation<T>(pool: pg.Pool, sql: string, values: unknown[]): Promise<T> {
  try { return await evidenceTransaction(pool, async client => (await client.query<{ result: T }>(sql, values)).rows[0].result); }
  catch (error) {
    if (error instanceof ServiceError) throw error;
    const code = (error as { code?: unknown })?.code;
    if (code === '42501') throw new ServiceError('FORBIDDEN', 'Embedding operation requires a bound operator session and current manual org administrator');
    if (code === '23514' || code === 'P0002' || code === '23505') throw new ServiceError('CONFLICT', 'Embedding policy or original work is unavailable');
    throw new ServiceError('DEPENDENCY_UNAVAILABLE', 'Embedding dependency unavailable');
  }
}
/** Current manual org-admin and actual OP session are checked inside the same
 * SQL transaction as configuration/control and its required audit. */
export async function configureEmbeddingTarget(pool: pg.Pool, actor: Principal, target: EmbeddingTarget,
  profile: BudgetProfile, window: EmbeddingWindowPolicy, enabled: boolean): Promise<void> {
  const budget = checkedProfile(profile);
  for (const key of ['seconds', 'dispatches', 'inputBytes', 'tokens', 'spendMicros'] as const) {
    if (!Number.isSafeInteger(window[key]) || window[key] < 0) throw new ServiceError('INVALID_INPUT', 'Invalid embedding window policy');
  }
  if (typeof enabled !== 'boolean') throw new ServiceError('INVALID_INPUT', 'Invalid embedding target enablement');
  await operatorOperation(pool, 'SELECT continuum_operator_embedding_target($1,$2,$3,$4,$5) AS result',
    [actor.id, target, budget, window, enabled]);
}
export async function configureEmbeddingPolicy(pool: pg.Pool, actor: Principal, routing: unknown, digest: string) {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new ServiceError('INVALID_INPUT', 'Invalid embedding policy digest');
  return operatorOperation<{ generation: string; digest: string }>(pool,
    'SELECT continuum_operator_embedding_policy($1,$2,$3) AS result', [actor.id, routing, digest]);
}
export async function bindEmbeddingWorker(pool: pg.Pool, actor: Principal, role: string, principalId: string,
  scopeId: string, target: string, enabled: boolean): Promise<void> {
  uuid(principalId); uuid(scopeId);
  if (!role || Buffer.byteLength(role) > 63 || role.includes('\0') || !/^[0-9a-f]{64}$/.test(target) || typeof enabled !== 'boolean') {
    throw new ServiceError('INVALID_INPUT', 'Invalid embedding worker binding');
  }
  await operatorOperation(pool, 'SELECT continuum_operator_bind_embedding_worker($1,$2,$3,$4,$5,$6) AS result',
    [actor.id, role, principalId, scopeId, target, enabled]);
}
export type EmbeddingControlOperation = 'pause' | 'resume' | 'drain' | 'retry' | 'cancel' | 'reconcile';
export async function controlEmbeddingJobs(pool: pg.Pool, actor: Principal, operation: EmbeddingControlOperation,
  target: string | null = null, limit = 100) {
  if (!['pause','resume','drain','retry','cancel','reconcile'].includes(operation) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000
    || (target !== null && !/^[0-9a-f]{64}$/.test(target))) throw new ServiceError('INVALID_INPUT', 'Invalid embedding control');
  return operatorOperation<Record<string, unknown>>(pool, 'SELECT continuum_operator_embedding_control($1,$2,$3,$4) AS result',
    [actor.id, operation, target, limit]);
}
export async function embeddingQueueMetrics(pool: pg.Pool, actor: Principal) {
  return operatorOperation<unknown[]>(pool, 'SELECT continuum_operator_embedding_metrics($1) AS result', [actor.id]);
}
export async function embeddingQueueLeases(pool: pg.Pool, actor: Principal, target: string | null = null, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || (target !== null && !/^[0-9a-f]{64}$/.test(target))) {
    throw new ServiceError('INVALID_INPUT', 'Invalid embedding lease status bound');
  }
  return operatorOperation<Record<string, unknown>>(pool, 'SELECT continuum_operator_embedding_leases($1,$2,$3) AS result', [actor.id, target, limit]);
}
export async function embeddingStatusForPrincipal(pool: pg.Pool, principal: Principal, memoryId: string,
  auditMetadata: Record<string, unknown> = {}) {
  uuid(memoryId);
  return evidenceTransaction(pool, async client => {
    const result = await readEmbeddingStatus(client, principal.id, memoryId);
    if (!result) return null;
    await recordAudit(client, { principalId: principal.id, action: 'read', memoryId,
      metadata: { ...auditMetadata, operation: 'embedding_status' } });
    return result;
  });
}
export async function recoverEmbeddingProcess(pool: pg.Pool, actor: Principal, cohortId: string, originalOwner: string, confirmation: string) {
  uuid(cohortId); uuid(originalOwner);
  if (confirmation !== 'CONFIRMED ORIGINAL PROCESS EXIT') throw new ServiceError('INVALID_INPUT', 'Embedding recovery requires proved original process exit');
  return operatorOperation<Record<string, unknown>>(pool, 'SELECT continuum_operator_recover_embedding($1,$2,$3,$4) AS result',
    [actor.id, cohortId, originalOwner, confirmation]);
}

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ServiceError('INVALID_INPUT', 'Invalid capture receipt identity');
  }
  return value.toLowerCase();
}

/** Plain JSON only, deterministic key order, finite traversal. No getters,
 * toJSON, sparse arrays, undefined values or nonfinite-number collisions. */
function canonicalJson(value: unknown): string {
  const path = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 10_000 || depth > 32) throw new ServiceError('INVALID_INPUT', 'Capture receipt payload is too complex');
    if (item === null || typeof item === 'string' || typeof item === 'boolean'
      || (typeof item === 'number' && Number.isFinite(item))) return JSON.stringify(item);
    if (typeof item !== 'object' || path.has(item) || Object.getOwnPropertySymbols(item).length
      || (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) {
      throw new ServiceError('INVALID_INPUT', 'Capture receipt requires plain JSON');
    }
    path.add(item);
    if (Array.isArray(item) && item.length > 10_000) throw new ServiceError('INVALID_INPUT', 'Capture receipt payload is too complex');
    const keys = Array.isArray(item) ? Array.from({ length: item.length }, (_, i) => String(i)) : Object.keys(item).sort();
    if (keys.length > 10_000) throw new ServiceError('INVALID_INPUT', 'Capture receipt payload is too complex');
    const values = keys.map(key => {
      const field = Object.getOwnPropertyDescriptor(item, key);
      if (!field || !('value' in field)) throw new ServiceError('INVALID_INPUT', 'Capture receipt requires plain JSON');
      return (Array.isArray(item) ? '' : `${JSON.stringify(key)}:`) + visit(field.value, depth + 1);
    });
    path.delete(item);
    return Array.isArray(item) ? `[${values.join(',')}]` : `{${values.join(',')}}`;
  };
  return visit(value, 0);
}

/** Call after resolving the actual scope UUID, before receipt admission. This is
 * normalization only: replay still requires current identity, source restriction
 * and memory read authority in its transaction. No raw key/body is returned. */
export function captureReceiptIdentity(principalId: string, scopeId: string, key: string, input: CaptureInput): {
  principalId: string; scopeId: string; operation: 'capture.v1'; keyHash: string; payloadDigest: string;
} {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) {
    throw new ServiceError('INVALID_INPUT', 'Idempotency key must contain 1 to 128 visible ASCII characters');
  }
  validateCaptureContent(input);
  const actor = uuid(principalId), scope = uuid(scopeId);
  const tags = normalizeTags(input.tags).sort();
  const event = input.eventAnnotation === undefined ? null : parseEventAnnotation(input.eventAnnotation);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  return { principalId: actor, scopeId: scope, operation: 'capture.v1',
    keyHash: hash(canonicalJson(['continuum.capture-key.v1', actor, scope, key])),
    payloadDigest: hash(canonicalJson(['continuum.capture-payload.v1', actor, scope,
      input.type, input.title, input.body, input.source, input.sourceRef ?? null,
      tags, input.metadata ?? {}, event])) };
}

/** Acknowledgement intent only, not an enqueue or current durable policy check.
 * Callers must commit the corresponding admitted job/status with source/audit. */
export function initialEmbeddingStatus(route: EmbeddingRoute): EmbeddingStatus {
  if (route.policy === 'disabled') return 'not_configured';
  if (route.policy === 'local-only-unavailable') return 'blocked_policy';
  return route.provider ? 'queued' : 'blocked_policy';
}
