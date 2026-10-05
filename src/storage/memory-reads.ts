import type { Memory, MemoryState, MemoryType } from '../types.js';
import { MEMORY_COLUMNS, rowToMemory } from './memory-row.js';
import type { Queryable } from './queryable.js';

export interface MemoryReadRecord {
  memory: Memory;
  scope: string;
  authorDisplayName: string;
}

export interface ListMemoryFilter {
  scope?: string;
  type?: MemoryType;
  state: MemoryState;
  limit: number;
  offset: number;
}

interface MemoryReadRow extends Record<string, unknown> {
  scope_label: string;
  author_display_name: string;
}

function rowToMemoryReadRecord(row: MemoryReadRow): MemoryReadRecord {
  return {
    memory: rowToMemory(row),
    scope: row.scope_label,
    authorDisplayName: row.author_display_name,
  };
}

const READ_SELECT = `${MEMORY_COLUMNS.split(',').map((column) => `m.${column.trim()}`).join(', ')},
  CASE WHEN s.kind = 'org' THEN 'org' ELSE s.kind || ':' || s.name END AS scope_label,
  p.display_name AS author_display_name`;

export async function getReadableMemory(
  queryable: Queryable,
  principalId: string,
  memoryId: string,
): Promise<MemoryReadRecord | null> {
  const { rows } = await queryable.query<MemoryReadRow>(
    `SELECT ${READ_SELECT}
       FROM memories m
       JOIN scopes s ON s.id = m.scope_id
       JOIN principals p ON p.id = m.author_id
      WHERE m.id = $1
        AND (m.expires_at IS NULL OR m.expires_at > now())
        AND (s.kind = 'org' OR EXISTS (
          SELECT 1 FROM scope_memberships sm
           WHERE sm.principal_id = $2 AND sm.scope_id = m.scope_id AND sm.active
             AND continuum_membership_is_effective(sm.active, sm.source_kind)
        ))`,
    [memoryId, principalId],
  );
  return rows[0] ? rowToMemoryReadRecord(rows[0]) : null;
}

export async function listReadableMemories(
  queryable: Queryable,
  principalId: string,
  filter: ListMemoryFilter,
): Promise<MemoryReadRecord[]> {
  const { rows } = await queryable.query<MemoryReadRow>(
    `SELECT ${READ_SELECT}
       FROM memories m
       JOIN scopes s ON s.id = m.scope_id
       JOIN principals p ON p.id = m.author_id
      WHERE (s.kind = 'org' OR EXISTS (
          SELECT 1 FROM scope_memberships sm
           WHERE sm.principal_id = $1 AND sm.scope_id = m.scope_id AND sm.active
             AND continuum_membership_is_effective(sm.active, sm.source_kind)
        ))
        AND (m.expires_at IS NULL OR m.expires_at > now())
        AND m.state = $2
        AND ($3::text IS NULL OR m.type = $3)
        AND ($4::text IS NULL OR
          CASE WHEN s.kind = 'org' THEN 'org' ELSE s.kind || ':' || s.name END = $4)
      ORDER BY m.updated_at DESC, m.id DESC
      LIMIT $5 OFFSET $6`,
    [principalId, filter.state, filter.type ?? null, filter.scope ?? null,
      filter.limit, filter.offset],
  );
  return rows.map(rowToMemoryReadRecord);
}
