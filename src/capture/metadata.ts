import { ServiceError } from '../services/errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_THREAD_KEYS = 50;
const MAX_THREAD_KEY_LENGTH = 500;
const MAX_ACTOR_LENGTH = 200;
export const ACTIVITY_PROVENANCE_KEY = '_continuum_activity_provenance';
export const ACTIVITY_PROVENANCE_VALUE = 'capture-v1';
export const ACTIVITY_EPOCH_MS_KEY = '_continuum_activity_epoch_ms';
export const ACTOR_MAPPING_ID_KEY = '_continuum_actor_mapping_id';
export const ACTOR_MAPPING_AUTHORITY_KEY = '_continuum_actor_mapping_authority';
export const TRUSTED_ACTIVITY_METADATA_KEYS = [
  'actor',
  'actor_principal_id',
  'thread_owner_principal_id',
  'thread_key',
  'closes_thread_keys',
  ACTIVITY_PROVENANCE_KEY,
  ACTIVITY_EPOCH_MS_KEY,
  ACTOR_MAPPING_ID_KEY,
  ACTOR_MAPPING_AUTHORITY_KEY,
] as const;

function boundedString(value: unknown, name: string, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new ServiceError('INVALID_INPUT', `${name} must be a non-empty string up to ${max} characters`);
  }
}

export function validateCaptureMetadata(metadata: Record<string, unknown> = {}): void {
  if (Object.hasOwn(metadata, ACTIVITY_PROVENANCE_KEY)
      || Object.hasOwn(metadata, ACTIVITY_EPOCH_MS_KEY)
      || Object.hasOwn(metadata, ACTOR_MAPPING_ID_KEY)
      || Object.hasOwn(metadata, ACTOR_MAPPING_AUTHORITY_KEY)) {
    throw new ServiceError(
      'INVALID_INPUT',
      'Continuum activity provenance metadata is reserved',
    );
  }
  if (Object.hasOwn(metadata, 'actor_principal_id')) {
    for (const required of ['thread_key']) {
      if (!Object.hasOwn(metadata, required)) {
        throw new ServiceError(
          'INVALID_INPUT',
          'Activity metadata requires actor_principal_id and thread_key',
        );
      }
    }
  }
  if (Object.hasOwn(metadata, 'actor_principal_id')) {
    boundedString(metadata.actor_principal_id, 'metadata.actor_principal_id', 36);
    if (!UUID.test(metadata.actor_principal_id)) {
      throw new ServiceError('INVALID_INPUT', 'metadata.actor_principal_id must be a UUID');
    }
  }
  if (Object.hasOwn(metadata, 'actor')) {
    boundedString(metadata.actor, 'metadata.actor', MAX_ACTOR_LENGTH);
  }
  if (Object.hasOwn(metadata, 'source_actor_label')) {
    boundedString(metadata.source_actor_label, 'metadata.source_actor_label', MAX_ACTOR_LENGTH);
  }
  if (Object.hasOwn(metadata, 'thread_owner_principal_id')) {
    boundedString(metadata.thread_owner_principal_id, 'metadata.thread_owner_principal_id', 36);
    if (!UUID.test(metadata.thread_owner_principal_id)) {
      throw new ServiceError(
        'INVALID_INPUT', 'metadata.thread_owner_principal_id must be a UUID',
      );
    }
    if (!Object.hasOwn(metadata, 'thread_key')) {
      throw new ServiceError(
        'INVALID_INPUT', 'metadata.thread_owner_principal_id requires thread_key',
      );
    }
  }
  if (Object.hasOwn(metadata, 'thread_key')) {
    boundedString(metadata.thread_key, 'metadata.thread_key', MAX_THREAD_KEY_LENGTH);
  }
  if (Object.hasOwn(metadata, 'closes_thread_keys')) {
    const keys = metadata.closes_thread_keys;
    if (!Array.isArray(keys) || keys.length > MAX_THREAD_KEYS) {
      throw new ServiceError(
        'INVALID_INPUT',
        `metadata.closes_thread_keys must contain at most ${MAX_THREAD_KEYS} strings`,
      );
    }
    const seen = new Set<string>();
    for (const key of keys) {
      boundedString(key, 'metadata.closes_thread_keys item', MAX_THREAD_KEY_LENGTH);
      if (seen.has(key)) {
        throw new ServiceError('INVALID_INPUT', 'metadata.closes_thread_keys must be unique');
      }
      seen.add(key);
    }
  }
  if (Object.hasOwn(metadata, 'reviewers')) {
    const reviewers = metadata.reviewers;
    if (!Array.isArray(reviewers) || reviewers.length > 50) {
      throw new ServiceError('INVALID_INPUT', 'metadata.reviewers must contain at most 50 strings');
    }
    for (const reviewer of reviewers) {
      boundedString(reviewer, 'metadata.reviewers item', MAX_ACTOR_LENGTH);
    }
  }
  if (Object.hasOwn(metadata, 'merged_by') && metadata.merged_by !== null) {
    boundedString(metadata.merged_by, 'metadata.merged_by', MAX_ACTOR_LENGTH);
  }
}

export function markTrustedActivityMetadata(
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return typeof metadata.actor_principal_id === 'string'
      && typeof metadata.thread_key === 'string'
    ? { ...metadata, [ACTIVITY_PROVENANCE_KEY]: ACTIVITY_PROVENANCE_VALUE }
    : metadata;
}

export function stripTrustedActivityMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = { ...metadata };
  for (const key of TRUSTED_ACTIVITY_METADATA_KEYS) delete sanitized[key];
  return sanitized;
}

export function hasTrustedActivityMetadata(metadata: Record<string, unknown> = {}): boolean {
  return TRUSTED_ACTIVITY_METADATA_KEYS.some((key) => Object.hasOwn(metadata, key));
}

export function activityMetadataForPromotion(
  metadata: Record<string, unknown>,
  createdAt: Date,
): Record<string, unknown> {
  const sanitized = stripTrustedActivityMetadata(metadata);
  if (metadata[ACTIVITY_PROVENANCE_KEY] !== ACTIVITY_PROVENANCE_VALUE) return sanitized;
  for (const key of TRUSTED_ACTIVITY_METADATA_KEYS) {
    if (key !== ACTIVITY_EPOCH_MS_KEY && Object.hasOwn(metadata, key)) {
      sanitized[key] = metadata[key];
    }
  }
  const inheritedEpoch = metadata[ACTIVITY_EPOCH_MS_KEY];
  sanitized[ACTIVITY_EPOCH_MS_KEY] = typeof inheritedEpoch === 'number'
      && Number.isSafeInteger(inheritedEpoch) && inheritedEpoch >= 0
    ? inheritedEpoch
    : createdAt.getTime();
  return sanitized;
}
