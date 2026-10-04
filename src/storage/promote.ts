import type pg from 'pg';
import type { Memory, ScopeRef } from '../types.js';
import { record as recordAudit } from '../audit/log.js';
import { createMemory } from './memories.js';
import { getScope, getScopeByRef } from './scopes.js';
import {
  canMutateScope,
  hasExplicitRoleForMutation,
} from '../scopes/access.js';
import { MEMORY_COLUMNS, rowToMemory } from './memory-row.js';
import { computeExpiry } from './expiry.js';

export interface PromoteResult {
  source: Memory;
  destination: Memory;
}

export class PromoteError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'PromoteError';
  }
}

export class StorageDependencyError extends Error {
  constructor(cause: unknown) {
    super('storage dependency unavailable', { cause });
    this.name = 'StorageDependencyError';
  }
}

export async function promoteMemory(
  pool: pg.Pool,
  principalId: string,
  memoryId: string,
  targetScope: ScopeRef,
): Promise<PromoteResult> {
  return inTransaction(pool, (client) =>
    promoteOperation(client, principalId, memoryId, targetScope, false),
  );
}

export async function promoteMemoryWithAudit(
  pool: pg.Pool,
  principalId: string,
  memoryId: string,
  targetScope: ScopeRef,
  auditMetadata: Record<string, unknown> = {},
): Promise<PromoteResult> {
  return inTransaction(pool, (client) =>
    promoteOperation(client, principalId, memoryId, targetScope, true, auditMetadata),
  );
}

async function promoteOperation(
  client: pg.PoolClient,
  principalId: string,
  memoryId: string,
  targetScope: ScopeRef,
  audit: boolean,
  auditMetadata: Record<string, unknown> = {},
): Promise<PromoteResult> {
  const source = await getMemoryForUpdate(client, memoryId);
  if (!source) throw new PromoteError('memory not found', 404);
  if (source.state !== 'live' || source.promotedToId !== null) {
    throw new PromoteError('memory has already been promoted or is not live', 409);
  }

  const sourceScope = await getScope(client, source.scopeId);
  if (!sourceScope) throw new PromoteError('source scope missing', 500);
  if (!(await canMutateScope(client, principalId, sourceScope.id))) {
    throw new PromoteError('principal lacks writer role on source scope', 403);
  }

  const destinationScope = await getScopeByRef(client, targetScope);
  if (!destinationScope) throw new PromoteError('target scope not found', 404);
  if (destinationScope.id === sourceScope.id) {
    throw new PromoteError('target scope must differ from source', 400);
  }
  const destinationRole = destinationScope.kind === 'org' ? 'admin' : 'writer';
  if (!(await hasExplicitRoleForMutation(
    client,
    principalId,
    destinationScope.id,
    destinationRole,
  ))) {
    const roleName = destinationScope.kind === 'org' ? 'admin' : 'writer';
    throw new PromoteError(`principal lacks ${roleName} role on target scope`, 403);
  }

  const destinationMetadata = { ...source.metadata };
  delete destinationMetadata.related;
  const destination = await createMemory(client, {
    scopeId: destinationScope.id,
    scopeKind: destinationScope.kind,
    type: source.type,
    title: source.title,
    body: source.body,
    authorId: principalId,
    source: `promote:${source.source}`,
    sourceRef: source.sourceRef ?? null,
    tags: source.tags,
    metadata: { ...destinationMetadata, promoted_from: source.id },
  });
  const { rows } = await client.query(
    `UPDATE memories
        SET state = 'promoted', promoted_to_id = $2, updated_at = now()
      WHERE id = $1
      RETURNING ${MEMORY_COLUMNS}`,
    [source.id, destination.id],
  );
  const updatedSource = rowToMemory(rows[0]);
  if (audit) {
    await recordAudit(client, {
      principalId,
      action: 'promote',
      memoryId: source.id,
      scopeId: destination.scopeId,
      metadata: { destination_id: destination.id, ...auditMetadata },
    });
  }
  return { source: updatedSource, destination };
}

export async function verifyMemory(
  pool: pg.Pool,
  principalId: string,
  memoryId: string,
  stillTrue: boolean,
): Promise<Memory> {
  return inTransaction(pool, (client) =>
    verifyOperation(client, principalId, memoryId, stillTrue),
  );
}

export async function verifyMemoryWithAudit(
  pool: pg.Pool,
  principalId: string,
  memoryId: string,
  stillTrue: boolean,
  note?: string,
  auditMetadata: Record<string, unknown> = {},
): Promise<Memory> {
  return inTransaction(pool, async (client) => {
    const memory = await verifyOperation(client, principalId, memoryId, stillTrue);
    await recordAudit(client, {
      principalId,
      action: 'verify',
      memoryId: memory.id,
      scopeId: memory.scopeId,
      metadata: { still_true: stillTrue, note: note ?? null, ...auditMetadata },
    });
    return memory;
  });
}

async function verifyOperation(
  client: pg.PoolClient,
  principalId: string,
  memoryId: string,
  stillTrue: boolean,
): Promise<Memory> {
  const memory = await getMemoryForUpdate(client, memoryId);
  if (!memory) throw new PromoteError('memory not found', 404);
  const memoryScope = await getScope(client, memory.scopeId);
  if (!memoryScope) throw new PromoteError('source scope missing', 500);
  if (!(await canMutateScope(client, principalId, memoryScope.id))) {
    throw new PromoteError('principal lacks writer role on source scope', 403);
  }
  if (memory.state === 'promoted' || memory.state === 'archived') {
    throw new PromoteError('memory is in a terminal state', 409);
  }
  const { rows: clockRows } = await client.query(
    'SELECT statement_timestamp() AS verified_at',
  );
  const verifiedAt = clockRows[0].verified_at as Date;
  const expiresAt = stillTrue
    ? computeExpiry(memory.type, memoryScope.kind, verifiedAt)
    : memory.expiresAt;
  const nextState = stillTrue ? 'live' : 'stale';
  const { rows } = await client.query(
    `UPDATE memories
        SET state = $2, last_verified = $3, updated_at = $3, expires_at = $4
      WHERE id = $1 AND state IN ('live', 'stale')
      RETURNING ${MEMORY_COLUMNS}`,
    [memory.id, nextState, verifiedAt, expiresAt],
  );
  if (!rows[0]) throw new PromoteError('memory is in a terminal state', 409);
  return rowToMemory(rows[0]);
}

async function getMemoryForUpdate(
  client: pg.PoolClient,
  memoryId: string,
): Promise<Memory | null> {
  const { rows } = await client.query(
    `SELECT ${MEMORY_COLUMNS}
       FROM memories
      WHERE id = $1
      FOR UPDATE`,
    [memoryId],
  );
  return rows[0] ? rowToMemory(rows[0]) : null;
}

async function inTransaction<T>(
  pool: pg.Pool,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw new StorageDependencyError(error);
  }
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroyClient = true;
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
}
