import type pg from 'pg';
import type { Memory, Principal, ScopeRef } from '../types.js';
import {
  promoteMemoryWithAudit,
  type PromoteResult,
  PromoteError,
  StorageDependencyError,
  verifyMemoryWithAudit,
} from '../storage/promote.js';
import {
  asServiceError,
  dependencyUnavailable,
  ServiceError,
} from './errors.js';
import { validateScopeRef } from './scopes.js';

export type { PromoteResult };

export const VERIFICATION_NOTE_MAX_LENGTH = 2000;
const VERIFICATION_NOTE_SAFE_PATTERN = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/;

function containsLoneUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export async function promoteForPrincipal(
  pool: pg.Pool,
  principal: Principal,
  memoryId: string,
  targetScope: ScopeRef,
  auditMetadata: Record<string, unknown> = {},
  promotionWebhookIds: readonly string[] = [],
): Promise<PromoteResult> {
  try {
    validateScopeRef(targetScope);
    return await promoteMemoryWithAudit(
      pool, principal.id, memoryId, targetScope, auditMetadata, promotionWebhookIds,
    );
  } catch (error) {
    throw mapLifecycleError(error);
  }
}

export async function verifyForPrincipal(
  pool: pg.Pool,
  principal: Principal,
  memoryId: string,
  stillTrue: boolean,
  note?: string,
  auditMetadata: Record<string, unknown> = {},
): Promise<Memory> {
  try {
    if (note !== undefined && note.length > VERIFICATION_NOTE_MAX_LENGTH) {
      throw new ServiceError(
        'INVALID_INPUT',
        `Verification note must be ${VERIFICATION_NOTE_MAX_LENGTH} characters or fewer`,
      );
    }
    if (note !== undefined && !VERIFICATION_NOTE_SAFE_PATTERN.test(note)) {
      throw new ServiceError(
        'INVALID_INPUT',
        'Verification note contains unsupported control characters',
      );
    }
    if (note !== undefined && containsLoneUtf16Surrogate(note)) {
      throw new ServiceError(
        'INVALID_INPUT',
        'Verification note contains invalid Unicode',
      );
    }
    return await verifyMemoryWithAudit(
      pool,
      principal.id,
      memoryId,
      stillTrue,
      note,
      auditMetadata,
    );
  } catch (error) {
    throw mapLifecycleError(error);
  }
}

function mapLifecycleError(error: unknown): ServiceError {
  if (error instanceof StorageDependencyError) {
    return dependencyUnavailable(error.cause ?? error);
  }
  if (error instanceof PromoteError) {
    if (error.status === 403) return new ServiceError('FORBIDDEN', error.message);
    if (error.status === 404) {
      const code = error.message === 'memory not found'
        ? 'MEMORY_NOT_FOUND'
        : 'SCOPE_NOT_FOUND';
      return new ServiceError(code, error.message);
    }
    if (error.status === 400) return new ServiceError('INVALID_INPUT', error.message);
    if (error.status === 409) return new ServiceError('CONFLICT', error.message);
  }
  return asServiceError(error);
}
