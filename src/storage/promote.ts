import type pg from 'pg';
import type { Memory, ScopeRef } from '../types.js';
import { getMemory, createMemory } from './memories.js';
import { getScope, getScopeByRef } from './scopes.js';
import { hasRole } from './memberships.js';

export interface PromoteResult {
  source: Memory;
  destination: Memory;
}

export class PromoteError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export async function promoteMemory(
  pool: pg.Pool,
  principalId: string,
  memoryId: string,
  targetScope: ScopeRef,
): Promise<PromoteResult> {
  const source = await getMemory(pool, memoryId);
  if (!source) throw new PromoteError('memory not found', 404);

  const sourceScope = await getScope(pool, source.scopeId);
  if (!sourceScope) throw new PromoteError('source scope missing', 500);
  if (!(await hasRole(pool, principalId, sourceScope.id, 'reader'))) {
    throw new PromoteError('principal cannot read source memory', 403);
  }

  const destScope = await getScopeByRef(pool, targetScope);
  if (!destScope) throw new PromoteError('target scope not found', 404);
  if (destScope.id === sourceScope.id) {
    throw new PromoteError('target scope must differ from source', 400);
  }
  if (!(await hasRole(pool, principalId, destScope.id, 'writer'))) {
    throw new PromoteError('principal lacks writer role on target scope', 403);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const destination = await createMemory(pool, {
      scopeId: destScope.id,
      scopeKind: destScope.kind,
      type: source.type,
      title: source.title,
      body: source.body,
      authorId: principalId,
      source: `promote:${source.source}`,
      sourceRef: source.sourceRef ?? null,
      tags: source.tags,
      metadata: { ...source.metadata, promoted_from: source.id },
    });
    await client.query(
      `UPDATE memories
          SET state = 'promoted',
              promoted_to_id = $2,
              updated_at = now()
        WHERE id = $1`,
      [source.id, destination.id],
    );
    await client.query('COMMIT');
    const refreshed = await getMemory(pool, source.id);
    return { source: refreshed ?? source, destination };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function verifyMemory(
  pool: pg.Pool,
  principalId: string,
  memoryId: string,
  stillTrue: boolean,
): Promise<Memory> {
  const memory = await getMemory(pool, memoryId);
  if (!memory) throw new PromoteError('memory not found', 404);
  if (!(await hasRole(pool, principalId, memory.scopeId, 'reader'))) {
    throw new PromoteError('principal cannot read memory', 403);
  }
  const nextState = stillTrue ? memory.state : 'stale';
  const { rows } = await pool.query(
    `UPDATE memories
        SET state = $2,
            last_verified = now(),
            updated_at = now()
      WHERE id = $1
      RETURNING id, scope_id, type, title, body, metadata, tags, author_id,
                source, source_ref, state, supersedes_id, promoted_to_id,
                created_at, updated_at, expires_at, last_verified`,
    [memory.id, nextState],
  );
  const r = rows[0];
  return {
    id: r.id,
    scopeId: r.scope_id,
    type: r.type,
    title: r.title,
    body: r.body,
    metadata: r.metadata ?? {},
    tags: r.tags ?? [],
    authorId: r.author_id,
    source: r.source,
    sourceRef: r.source_ref ?? null,
    state: r.state,
    supersedesId: r.supersedes_id ?? null,
    promotedToId: r.promoted_to_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at ?? null,
    lastVerified: r.last_verified ?? null,
  };
}
