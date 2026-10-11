import { createHash } from 'node:crypto';
import { ServiceError } from '../services/errors.js';

export const DEFAULT_TTL_SECONDS = 300;
export const MIN_TTL_SECONDS = 30;
export const MAX_TTL_SECONDS = 900;
export const RESOURCE_QUOTA = 10_000;
export const RECEIPT_QUOTA = 10_000;
export const RECEIPT_RETENTION_HOURS = 24;
export const RECEIPT_CLEANUP_BATCH = 100;
export const MAX_FENCING_TOKEN = '9223372036854775807';

export type CoordinationOperation = 'acquire' | 'renew' | 'release';

export interface AcquireLeaseInput {
  scope: string;
  resource: string;
  runId: string;
  requestId: string;
  ttlSeconds?: number;
}

export interface RenewLeaseInput {
  leaseId: string;
  runId: string;
  requestId: string;
  ttlSeconds?: number;
}

export interface ReleaseLeaseInput {
  leaseId: string;
  runId: string;
  requestId: string;
}

export interface InspectLeaseInput {
  scope: string;
  resource: string;
}

export interface AcquireSuccess {
  acquired: true;
  scope: string;
  resource: string;
  leaseId: string;
  runId: string;
  fencingToken: string;
  expiresAt: string;
  serverTime: string;
}

export interface AcquireContention {
  acquired: false;
  reason: 'LOCK_HELD';
  scope: string;
  resource: string;
  expiresAt: string;
  retryAfterSeconds: number;
  serverTime: string;
}

export type AcquireLeaseResult = AcquireSuccess | AcquireContention;

export interface RenewLeaseResult {
  renewed: true;
  leaseId: string;
  runId: string;
  fencingToken: string;
  expiresAt: string;
  serverTime: string;
}

export interface ReleaseLeaseResult {
  released: true;
  alreadyReleased?: true;
}

export interface InspectLeaseResult {
  held: boolean;
  scope: string;
  resource: string;
  serverTime: string;
  expiresAt?: string;
  leaseId?: string;
  runId?: string;
  fencingToken?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL_TOKEN_PATTERN = /^(?:0|[1-9][0-9]*)$/;

function invalid(message: string): never {
  throw new ServiceError('INVALID_INPUT', message);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function validateResourceKey(value: unknown): string {
  if (typeof value !== 'string') invalid('resource must be a string');
  if (hasUnpairedSurrogate(value)) invalid('resource must be well-formed Unicode');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 1 || bytes > 512) invalid('resource must be 1 to 512 UTF-8 bytes');
  if (/\p{Cc}/u.test(value)) invalid('resource must not contain control characters');
  if (/^\s|\s$/u.test(value)) invalid('resource must not have edge whitespace');
  return value;
}

export function validateTtlSeconds(value: unknown): number {
  const ttl = value === undefined ? DEFAULT_TTL_SECONDS : value;
  if (!Number.isInteger(ttl) || (ttl as number) < MIN_TTL_SECONDS || (ttl as number) > MAX_TTL_SECONDS) {
    invalid(`ttlSeconds must be an integer from ${MIN_TTL_SECONDS} to ${MAX_TTL_SECONDS}`);
  }
  return ttl as number;
}

export function validateUuid(name: string, value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    invalid(`${name} must be a valid UUID`);
  }
  return value.toLowerCase();
}

export function validateDecimalFencingToken(value: unknown): string {
  if (typeof value !== 'string' || !DECIMAL_TOKEN_PATTERN.test(value)) {
    invalid('fencing token must be a canonical decimal string');
  }
  if (value.length > MAX_FENCING_TOKEN.length
    || (value.length === MAX_FENCING_TOKEN.length && value > MAX_FENCING_TOKEN)) {
    invalid('fencing token exceeds PostgreSQL BIGINT');
  }
  return value;
}

export function canonicalOperationHash(
  operation: CoordinationOperation,
  normalizedFields: readonly string[],
): string {
  const hash = createHash('sha256');
  for (const field of [operation, ...normalizedFields]) {
    const bytes = Buffer.from(field, 'utf8');
    hash.update(String(bytes.length));
    hash.update(':');
    hash.update(bytes);
    hash.update(';');
  }
  return hash.digest('hex');
}
