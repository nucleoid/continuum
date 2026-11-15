import { createHash } from 'node:crypto';
import type { CaptureInput } from '../types.js';
import { parseEventAnnotation } from '../temporal/model.js';
import { normalizeTags } from './tag-vocabularies.js';
import { validateCaptureContent } from './capture.js';
import { ServiceError } from './errors.js';
import type { EmbeddingRoute } from '../embeddings/router.js';
import type { EmbeddingStatus } from '../storage/embedding-jobs-model.js';

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
