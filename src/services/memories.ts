import type pg from 'pg';
import { z } from 'zod';
import { recordRead } from '../audit/log.js';
import {
  getReadableMemory,
  listReadableMemories,
  type MemoryReadRecord,
} from '../storage/memory-reads.js';
import type { MemoryState, MemoryType, Principal } from '../types.js';
import { asServiceError, ServiceError } from './errors.js';
import { parseScopeString } from './scopes.js';

export const DEFAULT_MEMORY_LIST_LIMIT = 50;
export const MAX_MEMORY_LIST_LIMIT = 100;
export const MAX_MEMORY_LIST_OFFSET = 10_000;

const UUID = z.string().uuid();
const MEMORY_TYPES = new Set<MemoryType>([
  'fact', 'decision', 'context', 'playbook', 'relationship',
]);
const MEMORY_STATES = new Set<MemoryState>(['live', 'stale', 'archived', 'promoted']);

export interface ListMemoriesInput {
  scope?: string;
  type?: MemoryType;
  state?: MemoryState;
  limit?: number;
  offset?: number;
}

export interface ListMemoriesResult {
  items: MemoryReadRecord[];
  limit: number;
  offset: number;
}

function boundedInteger(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ServiceError('INVALID_INPUT', `${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function canonicalScope(scope: string | undefined): string | undefined {
  if (scope === undefined) return undefined;
  const ref = parseScopeString(scope);
  return ref.kind === 'org' ? 'org' : `${ref.kind}:${ref.name}`;
}

export async function getMemoryForPrincipal(
  pool: pg.Pool,
  principal: Principal,
  memoryId: string,
  auditMetadata: Record<string, unknown> = {},
): Promise<MemoryReadRecord> {
  if (!UUID.safeParse(memoryId).success) {
    throw new ServiceError('INVALID_INPUT', 'memoryId must be a valid UUID');
  }
  let client: pg.PoolClient | undefined;
  let destroyClient = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const recordValue = await getReadableMemory(client, principal.id, memoryId);
    if (!recordValue) {
      throw new ServiceError('MEMORY_NOT_FOUND', 'Memory not found');
    }
    await recordRead(client, {
      principalId: principal.id,
      metadata: { operation: 'get_memory', ...auditMetadata },
      memories: [{
        memoryId: recordValue.memory.id,
        scopeId: recordValue.memory.scopeId,
        metadata: { rank: 1 },
      }],
    });
    await client.query('COMMIT');
    return recordValue;
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroyClient = true;
      }
    }
    throw asServiceError(error);
  } finally {
    client?.release(destroyClient);
  }
}

export async function listMemoriesForPrincipal(
  pool: pg.Pool,
  principal: Principal,
  input: ListMemoriesInput = {},
  auditMetadata: Record<string, unknown> = {},
): Promise<ListMemoriesResult> {
  let client: pg.PoolClient | undefined;
  let destroyClient = false;
  try {
    const limit = boundedInteger(
      'limit', input.limit ?? DEFAULT_MEMORY_LIST_LIMIT, 1, MAX_MEMORY_LIST_LIMIT,
    );
    const offset = boundedInteger('offset', input.offset ?? 0, 0, MAX_MEMORY_LIST_OFFSET);
    const state = input.state ?? 'live';
    if (!MEMORY_STATES.has(state)) {
      throw new ServiceError('INVALID_INPUT', 'Invalid memory state');
    }
    if (input.type !== undefined && !MEMORY_TYPES.has(input.type)) {
      throw new ServiceError('INVALID_INPUT', 'Invalid memory type');
    }
    const scope = canonicalScope(input.scope);
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const items = await listReadableMemories(client, principal.id, {
      scope, type: input.type, state, limit, offset,
    });
    await recordRead(client, {
      principalId: principal.id,
      metadata: {
        operation: 'list_memories',
        state,
        scope_filtered: scope !== undefined,
        type_filter: input.type ?? null,
        limit,
        offset,
        count: items.length,
        ...auditMetadata,
      },
      memories: items.map((item, index) => ({
        memoryId: item.memory.id,
        scopeId: item.memory.scopeId,
        metadata: { rank: index + 1 },
      })),
    });
    await client.query('COMMIT');
    return { items, limit, offset };
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroyClient = true;
      }
    }
    throw asServiceError(error);
  } finally {
    client?.release(destroyClient);
  }
}
