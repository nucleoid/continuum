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

export async function promoteForPrincipal(
  pool: pg.Pool,
  principal: Principal,
  memoryId: string,
  targetScope: ScopeRef,
  auditMetadata: Record<string, unknown> = {},
): Promise<PromoteResult> {
  try {
    validateScopeRef(targetScope);
    return await promoteMemoryWithAudit(
      pool, principal.id, memoryId, targetScope, auditMetadata,
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
    if (note !== undefined && note.length > 2000) {
      throw new ServiceError('INVALID_INPUT', 'Verification note must be 2000 characters or fewer');
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
