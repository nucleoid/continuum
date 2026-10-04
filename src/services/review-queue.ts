import type pg from 'pg';
import type { MemoryType, Principal } from '../types.js';
import { recordRead as recordReadAudit } from '../audit/log.js';
import {
  listReviewQueue,
  type ReviewQueueItem,
} from '../storage/review-queue.js';
import { asServiceError, ServiceError } from './errors.js';
import { parseScopeString } from './scopes.js';

export const DEFAULT_REVIEW_HORIZON_DAYS = 14;
export const MAX_REVIEW_HORIZON_DAYS = 365;
export const DEFAULT_REVIEW_QUEUE_LIMIT = 50;
export const MAX_REVIEW_QUEUE_LIMIT = 100;
export const MAX_REVIEW_QUEUE_OFFSET = 10_000;

export interface ReviewQueueInput {
  scopes?: string[];
  types?: MemoryType[];
  limit?: number;
  offset?: number;
  horizonDays?: number;
}

export interface ReviewQueueResult {
  items: ReviewQueueItem[];
  limit: number;
  offset: number;
  horizonDays: number;
}

function boundedInteger(
  name: string,
  value: number,
  min: number,
  max: number,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ServiceError('INVALID_INPUT', `${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export async function reviewQueueForPrincipal(
  pool: pg.Pool,
  principal: Principal,
  input: ReviewQueueInput = {},
  options: {
    now?: Date;
    defaultHorizonDays?: number;
    auditMetadata?: Record<string, unknown>;
  } = {},
): Promise<ReviewQueueResult> {
  try {
    const limit = boundedInteger(
      'limit', input.limit ?? DEFAULT_REVIEW_QUEUE_LIMIT, 1, MAX_REVIEW_QUEUE_LIMIT,
    );
    const offset = boundedInteger('offset', input.offset ?? 0, 0, MAX_REVIEW_QUEUE_OFFSET);
    const horizonDays = boundedInteger(
      'horizonDays',
      input.horizonDays ?? options.defaultHorizonDays ?? DEFAULT_REVIEW_HORIZON_DAYS,
      0,
      MAX_REVIEW_HORIZON_DAYS,
    );
    const scopes = input.scopes?.map((scope) => {
      const ref = parseScopeString(scope);
      return ref.kind === 'org' ? 'org' : `${ref.kind}:${ref.name}`;
    });
    const items = await listReviewQueue(pool, principal.id, {
      now: options.now,
      horizonDays,
      scopeLabels: scopes,
      types: input.types,
      limit,
      offset,
    });

    // Required read auditing: no queue identities are returned if this fails.
    await recordReadAudit(pool, {
      principalId: principal.id,
      metadata: {
        view: 'review-queue',
        hits: items.length,
        horizon_days: horizonDays,
        scope_filters: scopes?.length ?? 0,
        type_filters: input.types?.length ?? 0,
        ...options.auditMetadata,
      },
      memories: items.map((item, index) => ({
        memoryId: item.id,
        scopeId: item.scopeId,
        metadata: { rank: index + 1 },
      })),
    });
    return { items, limit, offset, horizonDays };
  } catch (error) {
    throw asServiceError(error);
  }
}

export function configuredReviewHorizonDays(
  raw = process.env.CONTINUUM_REVIEW_HORIZON_DAYS,
): number {
  if (raw === undefined) return DEFAULT_REVIEW_HORIZON_DAYS;
  if (!/^\d+$/.test(raw)) {
    throw new Error('CONTINUUM_REVIEW_HORIZON_DAYS must be an integer from 0 to 365');
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_REVIEW_HORIZON_DAYS) {
    throw new Error('CONTINUUM_REVIEW_HORIZON_DAYS must be an integer from 0 to 365');
  }
  return parsed;
}
