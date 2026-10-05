import type pg from 'pg';
import type { Memory, Scope } from '../types.js';
import { record as recordAudit } from '../audit/log.js';
import { canMutateScope } from '../scopes/access.js';
import { createMemory } from './memories.js';
import { MEMORY_COLUMNS, rowToMemory } from './memory-row.js';
import type { Queryable } from './queryable.js';
import { getScope } from './scopes.js';

export class SupersedeStorageError extends Error {
  constructor(
    readonly kind: 'not_found' | 'forbidden' | 'not_decision' | 'not_live' | 'successor_exists' | 'dependency_unavailable',
    readonly successorId?: string,
  ) { super(kind); this.name = 'SupersedeStorageError'; }
}

export interface SupersedeWriteInput {
  supersededId: string;
  principalId: string;
  title: string;
  body: string;
  tags?: string[];
  source: string;
  sourceRef?: string | null;
  metadata?: Record<string, unknown>;
  auditMetadata?: Record<string, unknown>;
}

export interface SupersedeWriteResult { predecessor: Memory; successor: Memory; scope: Scope; }

export async function supersedeDecision(pool: pg.Pool, input: SupersedeWriteInput): Promise<SupersedeWriteResult> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw new SupersedeStorageError('dependency_unavailable');
  }
  let destroy = false;
  try {
    await client.query('BEGIN');
    const result = await supersedeInTransaction(client, input);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { destroy = true; }
    throw error;
  } finally { client.release(destroy); }
}

async function supersedeInTransaction(client: pg.PoolClient, input: SupersedeWriteInput): Promise<SupersedeWriteResult> {
  const { rows } = await client.query(
    `SELECT ${MEMORY_COLUMNS}
       FROM memories m
      WHERE m.id = $1
        AND EXISTS (
          SELECT 1
            FROM scopes s
           WHERE s.id = m.scope_id
             AND (s.kind = 'org' OR EXISTS (
               SELECT 1
                 FROM scope_memberships sm
                WHERE sm.principal_id = $2 AND sm.scope_id = m.scope_id
             ))
        )
      FOR UPDATE`,
    [input.supersededId, input.principalId],
  );
  if (!rows[0]) throw new SupersedeStorageError('not_found');
  const predecessor = rowToMemory(rows[0]);
  const scope = await getScope(client, predecessor.scopeId);
  if (!scope) throw new Error('memory scope missing');
  if (!(await canMutateScope(client, input.principalId, scope.id))) throw new SupersedeStorageError('forbidden');
  if (predecessor.type !== 'decision') throw new SupersedeStorageError('not_decision');
  const existing = await client.query<{ id: string }>('SELECT id FROM memories WHERE supersedes_id = $1', [predecessor.id]);
  if (existing.rows[0]) throw new SupersedeStorageError('successor_exists', existing.rows[0].id);
  if (predecessor.state !== 'live') throw new SupersedeStorageError('not_live');

  const successor = await createMemory(client, {
    scopeId: scope.id, scopeKind: scope.kind, type: 'decision', title: input.title,
    body: input.body, authorId: input.principalId, source: input.source,
    sourceRef: input.sourceRef, tags: input.tags,
    metadata: { ...input.metadata, related: [] },
    supersedesId: predecessor.id,
  });
  const archived = await client.query(
    `UPDATE memories SET state = 'archived', updated_at = now()
      WHERE id = $1 AND state = 'live' RETURNING ${MEMORY_COLUMNS}`,
    [predecessor.id],
  );
  if (!archived.rows[0]) throw new SupersedeStorageError('not_live');
  await recordAudit(client, {
    principalId: input.principalId, action: 'write', memoryId: successor.id, scopeId: scope.id,
    metadata: {
      source: input.source,
      type: 'decision',
      supersedes_id: predecessor.id,
      embedded: false,
      ...input.auditMetadata,
    },
  });
  await recordAudit(client, {
    principalId: input.principalId, action: 'archive', memoryId: predecessor.id, scopeId: scope.id,
    metadata: { successor_id: successor.id, ...input.auditMetadata },
  });
  return { predecessor: rowToMemory(archived.rows[0]), successor, scope };
}

export async function getDecisionHistory(
  queryable: Queryable,
  principalId: string,
  decisionId: string,
): Promise<{ memories: Memory[]; cycle: boolean } | null> {
  const { rows } = await queryable.query(
    `WITH RECURSIVE anchor AS (
       SELECT m.*
         FROM memories m
         JOIN scopes s ON s.id = m.scope_id
        WHERE m.id = $1
          AND (s.kind = 'org' OR EXISTS (
            SELECT 1 FROM scope_memberships sm
             WHERE sm.principal_id = $2 AND sm.scope_id = m.scope_id
          ))
     ), backward AS (
       SELECT a.*, 0 AS depth, ARRAY[a.id] AS path, false AS cycle FROM anchor a
       UNION ALL
       SELECT p.*, b.depth + 1, b.path || p.id, p.id = ANY(b.path)
         FROM backward b JOIN memories p ON p.id = b.supersedes_id WHERE NOT b.cycle
     ), forward AS (
       SELECT a.*, 0 AS depth, ARRAY[a.id] AS path, false AS cycle FROM anchor a
       UNION ALL
       SELECT s.*, f.depth + 1, f.path || s.id, s.id = ANY(f.path)
         FROM forward f JOIN memories s ON s.supersedes_id = f.id WHERE NOT f.cycle
     )
     SELECT chain.* FROM (
       SELECT b.*, -b.depth AS position FROM backward b
       UNION ALL SELECT f.*, f.depth AS position FROM forward f WHERE f.depth > 0
     ) chain ORDER BY position`, [decisionId, principalId],
  );
  if (!rows[0]) return null;
  return { memories: rows.filter((row) => !row.cycle).map(rowToMemory), cycle: rows.some((row) => row.cycle === true) };
}
