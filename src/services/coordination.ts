import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Principal } from '../types.js';
import { record } from '../audit/log.js';
import {
  canonicalOperationHash,
  validateResourceKey,
  validateTtlSeconds,
  validateUuid,
  type AcquireLeaseInput,
  type AcquireLeaseResult,
  type InspectLeaseInput,
  type InspectLeaseResult,
  type ReleaseLeaseInput,
  type ReleaseLeaseResult,
  type RenewLeaseInput,
  type RenewLeaseResult,
} from '../coordination/model.js';
import {
  CoordinationCancelledError,
  CoordinationDependencyError,
  CoordinationStorageError,
  contentionRetryAfter,
  coordinationAuthorizationIsCurrent,
  createLeaseGeneration,
  discoverLease,
  discoverReceipt,
  ensureAndLockResource,
  getCurrentLease,
  getReceipt,
  inspectCurrentLease,
  insertReceipt,
  lockCoordinationAuthorization,
  lockExistingResource,
  preparePrincipalReceipts,
  releaseLeaseGeneration,
  renewLeaseGeneration,
  resolveScope,
  sampleServerTime,
  withCoordinationTransaction,
  type ReceiptRow,
} from '../storage/coordination.js';
import { parseScopeString } from './scopes.js';
import { ServiceError } from './errors.js';

function requestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ServiceError('COORDINATION_TIMEOUT', 'Coordination request timed out');
  }
}

function safeCoordinationError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof CoordinationCancelledError) {
    return new ServiceError('COORDINATION_TIMEOUT', 'Coordination request timed out');
  }
  if (error instanceof CoordinationDependencyError) {
    return new ServiceError(
      'DEPENDENCY_UNAVAILABLE',
      'A required dependency is unavailable',
      { cause: error.cause },
    );
  }
  if (error instanceof CoordinationStorageError) {
    if (error.kind === 'FENCING_EXHAUSTED') {
      return new ServiceError(
        'FENCING_TOKEN_EXHAUSTED',
        'The fencing token for this resource is exhausted',
      );
    }
    return new ServiceError(
      'COORDINATION_QUOTA_EXCEEDED',
      'Coordination storage quota exceeded',
    );
  }
  const code = (error as { code?: unknown })?.code;
  if (code === '55P03' || code === '57014') {
    return new ServiceError(
      'COORDINATION_TIMEOUT',
      'Coordination request timed out',
      { cause: error },
    );
  }
  if (typeof code === 'string' && (
    code.startsWith('08') || code.startsWith('28') || ['57P01', '57P02', '57P03', '53300'].includes(code)
  )) {
    return new ServiceError(
      'DEPENDENCY_UNAVAILABLE',
      'A required dependency is unavailable',
      { cause: error },
    );
  }
  return new ServiceError('INTERNAL', 'An internal error occurred', { cause: error });
}

function leaseLost(): ServiceError {
  return new ServiceError('LEASE_LOST', 'Lease is no longer held');
}

function idempotencyConflict(): ServiceError {
  return new ServiceError(
    'IDEMPOTENCY_CONFLICT',
    'The request ID was already used with different input',
  );
}

function scopeNotFound(): ServiceError {
  return new ServiceError('SCOPE_NOT_FOUND', 'Scope not found');
}

function resourceAudit(resource: string): { resource_bytes: number; resource_sha256: string } {
  return {
    resource_bytes: Buffer.byteLength(resource, 'utf8'),
    resource_sha256: createHash('sha256').update(resource, 'utf8').digest('hex'),
  };
}

async function requireAuthorization(
  client: pg.PoolClient,
  principalId: string,
  scopeId: string,
  masked: 'scope' | 'lease',
): Promise<void> {
  if (!await lockCoordinationAuthorization(client, principalId, scopeId)) {
    throw masked === 'scope' ? scopeNotFound() : leaseLost();
  }
}

async function requireFinalAuthorization(
  client: pg.PoolClient,
  principalId: string,
  scopeId: string,
  masked: 'scope' | 'lease',
  signal?: AbortSignal,
): Promise<void> {
  requestAborted(signal);
  if (!await coordinationAuthorizationIsCurrent(client, principalId, scopeId)) {
    throw masked === 'scope' ? scopeNotFound() : leaseLost();
  }
  requestAborted(signal);
}

function assertMatchingReceipt(receipt: ReceiptRow, hash: string): void {
  if (receipt.payloadHash !== hash) throw idempotencyConflict();
}

function replayAcquire(
  receipt: ReceiptRow,
  scope: string,
): AcquireLeaseResult {
  if (receipt.outcome === 'contended') {
    return {
      acquired: false,
      reason: 'LOCK_HELD',
      scope,
      resource: receipt.resource,
      expiresAt: receipt.expiresAt!,
      retryAfterSeconds: receipt.retryAfterSeconds!,
      serverTime: receipt.serverTime,
    };
  }
  return {
    acquired: true,
    scope,
    resource: receipt.resource,
    leaseId: receipt.leaseId!,
    runId: receipt.runId!,
    fencingToken: receipt.fencingToken!,
    expiresAt: receipt.expiresAt!,
    serverTime: receipt.serverTime,
  };
}

export async function acquireLease(
  pool: pg.Pool,
  principal: Principal,
  input: AcquireLeaseInput,
  options: { signal?: AbortSignal; transport?: 'rest' | 'mcp' } = {},
): Promise<AcquireLeaseResult> {
  try {
    const ref = parseScopeString(input.scope);
    const scopeLabel = ref.kind === 'org' ? 'org' : `${ref.kind}:${ref.name}`;
    const resource = validateResourceKey(input.resource);
    const runId = validateUuid('runId', input.runId);
    const requestId = validateUuid('requestId', input.requestId);
    const ttlSeconds = validateTtlSeconds(input.ttlSeconds);
    const payloadHash = canonicalOperationHash(
      'acquire', [scopeLabel, resource, runId, String(ttlSeconds)],
    );

    return await withCoordinationTransaction(pool, options.signal, async (client) => {
      const scope = await resolveScope(client, ref);
      if (!scope) throw scopeNotFound();
      await requireAuthorization(client, principal.id, scope.id, 'scope');
      await preparePrincipalReceipts(client, principal.id);
      const prior = await getReceipt(client, principal.id, 'acquire', requestId);
      if (prior) {
        assertMatchingReceipt(prior, payloadHash);
        if (prior.outcome === 'acquired') {
          if (!await lockExistingResource(client, scope.id, resource)) throw leaseLost();
          const now = await sampleServerTime(client);
          const current = await getCurrentLease(client, scope.id, resource, now);
          if (!current || current.leaseId !== prior.leaseId
            || current.principalId !== principal.id) throw leaseLost();
        }
        await requireFinalAuthorization(
          client, principal.id, scope.id, 'scope', options.signal,
        );
        return replayAcquire(prior, scopeLabel);
      }

      await ensureAndLockResource(client, scope.id, resource);
      const serverTime = await sampleServerTime(client);
      const current = await getCurrentLease(client, scope.id, resource, serverTime);
      if (current) {
        const retryAfterSeconds = await contentionRetryAfter(
          client, current.expiresAt, serverTime,
        );
        const result: AcquireLeaseResult = {
          acquired: false,
          reason: 'LOCK_HELD',
          scope: scopeLabel,
          resource,
          expiresAt: current.expiresAt,
          retryAfterSeconds,
          serverTime,
        };
        await insertReceipt(client, {
          principalId: principal.id,
          operation: 'acquire',
          requestId,
          payloadHash,
          outcome: 'contended',
          scopeId: scope.id,
          resource,
          expiresAt: current.expiresAt,
          serverTime,
          retryAfterSeconds,
        });
        await record(client, {
          principalId: principal.id,
          action: 'write',
          scopeId: scope.id,
          metadata: {
            operation: 'lock_acquire',
            outcome: 'contended',
            request_id: requestId,
            ...resourceAudit(resource),
            transport: options.transport,
          },
        });
        await requireFinalAuthorization(
          client, principal.id, scope.id, 'scope', options.signal,
        );
        return result;
      }

      const leaseId = randomUUID();
      const generation = await createLeaseGeneration(client, {
        leaseId,
        scopeId: scope.id,
        resource,
        principalId: principal.id,
        runId,
        ttlSeconds,
        serverTime,
      });
      const result: AcquireLeaseResult = {
        acquired: true,
        scope: scopeLabel,
        resource,
        leaseId,
        runId,
        fencingToken: generation.fencingToken,
        expiresAt: generation.expiresAt,
        serverTime,
      };
      await insertReceipt(client, {
        principalId: principal.id,
        operation: 'acquire',
        requestId,
        payloadHash,
        outcome: 'acquired',
        scopeId: scope.id,
        resource,
        leaseId,
        runId,
        fencingToken: generation.fencingToken,
        expiresAt: generation.expiresAt,
        serverTime,
      });
      await record(client, {
        principalId: principal.id,
        action: 'write',
        scopeId: scope.id,
        metadata: {
          operation: 'lock_acquire',
          outcome: 'acquired',
          request_id: requestId,
          run_id: runId,
          lease_id: leaseId,
          fencing_token: generation.fencingToken,
          ...resourceAudit(resource),
          transport: options.transport,
        },
      });
      await requireFinalAuthorization(
        client, principal.id, scope.id, 'scope', options.signal,
      );
      return result;
    });
  } catch (error) {
    throw safeCoordinationError(error);
  }
}

async function discoverMutationTarget(
  client: pg.PoolClient,
  principalId: string,
  operation: 'renew' | 'release',
  leaseId: string,
  requestId: string,
): Promise<{ scopeId: string; resource: string }> {
  const lease = await discoverLease(client, leaseId);
  if (lease) return lease;
  const receipt = await discoverReceipt(client, principalId, operation, requestId);
  if (receipt?.leaseId === leaseId) return receipt;
  throw leaseLost();
}

export async function renewLease(
  pool: pg.Pool,
  principal: Principal,
  input: RenewLeaseInput,
  options: { signal?: AbortSignal; transport?: 'rest' | 'mcp' } = {},
): Promise<RenewLeaseResult> {
  try {
    const leaseId = validateUuid('leaseId', input.leaseId);
    const runId = validateUuid('runId', input.runId);
    const requestId = validateUuid('requestId', input.requestId);
    const ttlSeconds = validateTtlSeconds(input.ttlSeconds);
    const payloadHash = canonicalOperationHash(
      'renew', [leaseId, runId, String(ttlSeconds)],
    );

    return await withCoordinationTransaction(pool, options.signal, async (client) => {
      const target = await discoverMutationTarget(
        client, principal.id, 'renew', leaseId, requestId,
      );
      await requireAuthorization(client, principal.id, target.scopeId, 'lease');
      await preparePrincipalReceipts(client, principal.id);
      const prior = await getReceipt(client, principal.id, 'renew', requestId);
      if (prior) {
        assertMatchingReceipt(prior, payloadHash);
        if (!await lockExistingResource(client, target.scopeId, target.resource)) {
          throw leaseLost();
        }
        const now = await sampleServerTime(client);
        const current = await getCurrentLease(client, target.scopeId, target.resource, now);
        if (!current || current.leaseId !== leaseId
          || current.principalId !== principal.id || current.runId !== runId) {
          throw leaseLost();
        }
        await requireFinalAuthorization(
          client, principal.id, target.scopeId, 'lease', options.signal,
        );
        return {
          renewed: true,
          leaseId: prior.leaseId!,
          runId: prior.runId!,
          fencingToken: prior.fencingToken!,
          expiresAt: prior.expiresAt!,
          serverTime: prior.serverTime,
        };
      }

      if (!await lockExistingResource(client, target.scopeId, target.resource)) {
        throw leaseLost();
      }
      const serverTime = await sampleServerTime(client);
      const current = await getCurrentLease(
        client, target.scopeId, target.resource, serverTime,
      );
      if (!current || current.leaseId !== leaseId
        || current.principalId !== principal.id || current.runId !== runId) {
        throw leaseLost();
      }
      const expiresAt = await renewLeaseGeneration(
        client, leaseId, ttlSeconds, serverTime,
      );
      const result: RenewLeaseResult = {
        renewed: true,
        leaseId,
        runId,
        fencingToken: current.fencingToken,
        expiresAt,
        serverTime,
      };
      await insertReceipt(client, {
        principalId: principal.id,
        operation: 'renew',
        requestId,
        payloadHash,
        outcome: 'renewed',
        scopeId: target.scopeId,
        resource: target.resource,
        leaseId,
        runId,
        fencingToken: current.fencingToken,
        expiresAt,
        serverTime,
      });
      await record(client, {
        principalId: principal.id,
        action: 'write',
        scopeId: target.scopeId,
        metadata: {
          operation: 'lock_renew',
          outcome: 'renewed',
          request_id: requestId,
          run_id: runId,
          lease_id: leaseId,
          fencing_token: current.fencingToken,
          ...resourceAudit(target.resource),
          transport: options.transport,
        },
      });
      await requireFinalAuthorization(
        client, principal.id, target.scopeId, 'lease', options.signal,
      );
      return result;
    });
  } catch (error) {
    throw safeCoordinationError(error);
  }
}

export async function releaseLease(
  pool: pg.Pool,
  principal: Principal,
  input: ReleaseLeaseInput,
  options: { signal?: AbortSignal; transport?: 'rest' | 'mcp' } = {},
): Promise<ReleaseLeaseResult> {
  try {
    const leaseId = validateUuid('leaseId', input.leaseId);
    const runId = validateUuid('runId', input.runId);
    const requestId = validateUuid('requestId', input.requestId);
    const payloadHash = canonicalOperationHash('release', [leaseId, runId]);

    return await withCoordinationTransaction(pool, options.signal, async (client) => {
      const target = await discoverMutationTarget(
        client, principal.id, 'release', leaseId, requestId,
      );
      await requireAuthorization(client, principal.id, target.scopeId, 'lease');
      await preparePrincipalReceipts(client, principal.id);
      const prior = await getReceipt(client, principal.id, 'release', requestId);
      if (prior) {
        assertMatchingReceipt(prior, payloadHash);
        await requireFinalAuthorization(
          client, principal.id, target.scopeId, 'lease', options.signal,
        );
        return { released: true, alreadyReleased: true };
      }

      if (!await lockExistingResource(client, target.scopeId, target.resource)) {
        throw leaseLost();
      }
      const serverTime = await sampleServerTime(client);
      const current = await getCurrentLease(
        client, target.scopeId, target.resource, serverTime,
      );
      if (!current || current.leaseId !== leaseId
        || current.principalId !== principal.id || current.runId !== runId) {
        throw leaseLost();
      }
      await releaseLeaseGeneration(
        client, target.scopeId, target.resource, leaseId, serverTime,
      );
      await insertReceipt(client, {
        principalId: principal.id,
        operation: 'release',
        requestId,
        payloadHash,
        outcome: 'released',
        scopeId: target.scopeId,
        resource: target.resource,
        leaseId,
        runId,
        fencingToken: current.fencingToken,
        serverTime,
      });
      await record(client, {
        principalId: principal.id,
        action: 'write',
        scopeId: target.scopeId,
        metadata: {
          operation: 'lock_release',
          outcome: 'released',
          request_id: requestId,
          run_id: runId,
          lease_id: leaseId,
          fencing_token: current.fencingToken,
          ...resourceAudit(target.resource),
          transport: options.transport,
        },
      });
      await requireFinalAuthorization(
        client, principal.id, target.scopeId, 'lease', options.signal,
      );
      return { released: true };
    });
  } catch (error) {
    throw safeCoordinationError(error);
  }
}

export async function inspectLease(
  pool: pg.Pool,
  principal: Principal,
  input: InspectLeaseInput,
  options: { signal?: AbortSignal; transport?: 'rest' | 'mcp' } = {},
): Promise<InspectLeaseResult> {
  try {
    const ref = parseScopeString(input.scope);
    const scopeLabel = ref.kind === 'org' ? 'org' : `${ref.kind}:${ref.name}`;
    const resource = validateResourceKey(input.resource);
    return await withCoordinationTransaction(pool, options.signal, async (client) => {
      const scope = await resolveScope(client, ref);
      if (!scope) throw scopeNotFound();
      await requireAuthorization(client, principal.id, scope.id, 'scope');
      const serverTime = await sampleServerTime(client);
      const current = await inspectCurrentLease(client, scope.id, resource, serverTime);
      const result: InspectLeaseResult = {
        held: Boolean(current),
        scope: scopeLabel,
        resource,
        serverTime,
      };
      if (current) {
        result.expiresAt = current.expiresAt;
        if (current.principalId === principal.id) {
          result.leaseId = current.leaseId;
          result.runId = current.runId;
          result.fencingToken = current.fencingToken;
        }
      }
      await record(client, {
        principalId: principal.id,
        action: 'read',
        scopeId: scope.id,
        metadata: {
          operation: 'lock_inspect',
          outcome: current ? 'held' : 'available',
          own_lease: current?.principalId === principal.id,
          ...(current?.principalId === principal.id ? {
            lease_id: current.leaseId,
            run_id: current.runId,
            fencing_token: current.fencingToken,
          } : {}),
          ...resourceAudit(resource),
          transport: options.transport,
        },
      });
      await requireFinalAuthorization(
        client, principal.id, scope.id, 'scope', options.signal,
      );
      return result;
    });
  } catch (error) {
    throw safeCoordinationError(error);
  }
}
