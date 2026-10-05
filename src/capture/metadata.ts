import { ServiceError } from '../services/errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_THREAD_KEYS = 50;
const MAX_THREAD_KEY_LENGTH = 500;
const MAX_ACTOR_LENGTH = 200;

function boundedString(value: unknown, name: string, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new ServiceError('INVALID_INPUT', `${name} must be a non-empty string up to ${max} characters`);
  }
}

export function validateCaptureMetadata(metadata: Record<string, unknown> = {}): void {
  const activityKeys = [
    'actor_principal_id', 'actor', 'thread_key', 'closes_thread_keys',
    'merged_by', 'reviewers',
  ];
  if (activityKeys.some((key) => Object.hasOwn(metadata, key))) {
    for (const required of ['actor_principal_id', 'actor', 'thread_key']) {
      if (!Object.hasOwn(metadata, required)) {
        throw new ServiceError(
          'INVALID_INPUT',
          'Activity metadata requires actor_principal_id, actor, and thread_key',
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
