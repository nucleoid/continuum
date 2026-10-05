import type pg from 'pg';
import type { MemoryType } from '../types.js';

export interface StandupMemory {
  id: string;
  scopeId: string;
  scope: string;
  type: MemoryType;
  title: string;
  source: string;
  sourceRef: string | null;
  threadKey: string;
  actor: string;
  createdAt: Date;
}

interface StandupRow {
  id: string;
  scope_id: string;
  scope_label: string;
  type: MemoryType;
  title: string;
  source: string;
  source_ref: string | null;
  thread_key: string;
  actor: string;
  created_at: Date;
}

function mapRow(row: StandupRow): StandupMemory {
  return {
    id: row.id,
    scopeId: row.scope_id,
    scope: row.scope_label,
    type: row.type,
    title: row.title,
    source: row.source,
    sourceRef: row.source_ref,
    threadKey: row.thread_key,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

const AUTHORIZED_ACTIVITY = `
  m.metadata->>'actor_principal_id' = $1::text
  AND (
    (s.kind = 'user' AND s.owner_principal_id = $1::uuid)
    OR (s.kind = 'project' AND EXISTS (
      SELECT 1 FROM scope_memberships sm
       WHERE sm.scope_id = s.id AND sm.principal_id = $1::uuid
    ))
  )`;

export async function listStandupActivity(
  pool: pg.Pool,
  principalId: string,
  start: Date,
  end: Date,
  limit: number,
  offset: number,
): Promise<StandupMemory[]> {
  const { rows } = await pool.query<StandupRow>(
    `SELECT m.id, m.scope_id,
            left(CASE WHEN s.kind = 'org' THEN 'org' ELSE s.kind || ':' || s.name END, 500) AS scope_label,
            m.type, left(m.title, 500) AS title, left(m.source, 100) AS source,
            left(m.source_ref, 2000) AS source_ref,
            left(m.metadata->>'thread_key', 500) AS thread_key,
            left(m.metadata->>'actor', 200) AS actor,
            m.created_at
       FROM memories m
       JOIN scopes s ON s.id = m.scope_id
      WHERE ${AUTHORIZED_ACTIVITY}
        AND m.metadata ? 'thread_key'
        AND m.metadata ? 'actor'
        AND m.state IN ('live', 'stale')
        AND (m.expires_at IS NULL OR m.expires_at > now())
        AND m.created_at >= $2 AND m.created_at < $3
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT $4 OFFSET $5`,
    [principalId, start, end, limit, offset],
  );
  return rows.map(mapRow);
}

export async function listOpenStandupThreads(
  pool: pg.Pool,
  principalId: string,
  before: Date,
  notBefore: Date,
  asOf: Date,
  limit: number,
): Promise<StandupMemory[]> {
  const { rows } = await pool.query<StandupRow>(
    `SELECT m.id, m.scope_id,
            left(CASE WHEN s.kind = 'org' THEN 'org' ELSE s.kind || ':' || s.name END, 500) AS scope_label,
            m.type, left(m.title, 500) AS title, left(m.source, 100) AS source,
            left(m.source_ref, 2000) AS source_ref,
            left(m.metadata->>'thread_key', 500) AS thread_key,
            left(m.metadata->>'actor', 200) AS actor,
            m.created_at
       FROM memories m
       JOIN scopes s ON s.id = m.scope_id
      WHERE COALESCE(
              m.metadata->>'thread_owner_principal_id',
              m.metadata->>'actor_principal_id'
            ) = $1::text
        AND (
          (s.kind = 'user' AND s.owner_principal_id = $1::uuid)
          OR (s.kind = 'project' AND EXISTS (
            SELECT 1 FROM scope_memberships sm
             WHERE sm.scope_id = s.id AND sm.principal_id = $1::uuid
          ))
        )
        AND m.type = 'context' AND m.state = 'live'
        AND (m.expires_at IS NULL OR m.expires_at > now())
        AND m.metadata ? 'thread_key' AND m.metadata ? 'actor'
        AND m.created_at < $2 AND m.created_at >= $3
        AND NOT EXISTS (
          SELECT 1
            FROM memories closing
            JOIN scopes closing_scope ON closing_scope.id = closing.scope_id
           WHERE COALESCE(
                   closing.metadata->>'thread_owner_principal_id',
                   closing.metadata->>'actor_principal_id'
                 ) = COALESCE(
                   m.metadata->>'thread_owner_principal_id',
                   m.metadata->>'actor_principal_id'
                 )
             AND closing.created_at >= m.created_at
             AND closing.created_at < $4
             AND (
               (closing_scope.kind = 'user' AND closing_scope.owner_principal_id = $1::uuid)
               OR (closing_scope.kind = 'project' AND EXISTS (
                 SELECT 1 FROM scope_memberships closing_sm
                  WHERE closing_sm.scope_id = closing_scope.id
                    AND closing_sm.principal_id = $1::uuid
               ))
             )
             AND COALESCE(closing.metadata->'closes_thread_keys', '[]'::jsonb)
                   @> to_jsonb(ARRAY[m.metadata->>'thread_key'])
        )
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT $5`,
    [principalId, before, notBefore, asOf, limit],
  );
  return rows.map(mapRow);
}
