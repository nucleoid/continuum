import type pg from 'pg';
import type { AuditAction } from '../types.js';

export interface AuditRecord {
  id: number;
  at: Date;
  principalId: string;
  action: AuditAction;
  memoryId: string | null;
  scopeId: string | null;
  query: string | null;
  metadata: Record<string, unknown> | null;
}

export interface AuditQuery {
  principalId?: string;
  scopeId?: string;
  memoryId?: string;
  action?: AuditAction;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

function rowToRecord(row: Record<string, unknown>): AuditRecord {
  return {
    id: Number(row.id),
    at: row.at as Date,
    principalId: row.principal_id as string,
    action: row.action as AuditAction,
    memoryId: (row.memory_id as string | null) ?? null,
    scopeId: (row.scope_id as string | null) ?? null,
    query: (row.query as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
  };
}

export async function queryAudit(
  pool: pg.Pool,
  filter: AuditQuery,
): Promise<AuditRecord[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (filter.principalId !== undefined) {
    where.push(`principal_id = $${i++}`);
    values.push(filter.principalId);
  }
  if (filter.scopeId !== undefined) {
    where.push(`scope_id = $${i++}`);
    values.push(filter.scopeId);
  }
  if (filter.memoryId !== undefined) {
    where.push(`memory_id = $${i++}`);
    values.push(filter.memoryId);
  }
  if (filter.action !== undefined) {
    where.push(`action = $${i++}`);
    values.push(filter.action);
  }
  if (filter.since !== undefined) {
    where.push(`at >= $${i++}`);
    values.push(filter.since);
  }
  if (filter.until !== undefined) {
    where.push(`at < $${i++}`);
    values.push(filter.until);
  }

  const whereSql = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
  const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const offset = filter.offset ?? 0;

  const sql = `
    SELECT id, at, principal_id, action, memory_id, scope_id, query, metadata
      FROM audit_log
      ${whereSql}
     ORDER BY at DESC, id DESC
     LIMIT $${i++} OFFSET $${i++}
  `;
  values.push(limit, offset);

  const { rows } = await pool.query(sql, values);
  return rows.map(rowToRecord);
}
