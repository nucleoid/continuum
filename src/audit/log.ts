import type pg from 'pg';
import type { AuditAction } from '../types.js';
import type { Queryable } from '../storage/queryable.js';

export interface AuditEntry {
  principalId: string;
  action: AuditAction;
  memoryId?: string | null;
  scopeId?: string | null;
  query?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function record(
  pool: Queryable,
  entry: AuditEntry,
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (principal_id, action, memory_id, scope_id, query, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.principalId,
      entry.action,
      entry.memoryId ?? null,
      entry.scopeId ?? null,
      entry.query ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    ],
  );
}
