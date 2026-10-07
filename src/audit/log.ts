import { randomUUID } from 'node:crypto';
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

export interface ReadAuditMemory {
  memoryId: string;
  scopeId: string;
  metadata?: {
    rank: number;
    score?: number;
    delivery?: 'agents-md';
  };
}

export interface ReadAuditEntry {
  principalId: string;
  /** Producer-owned policy label. Never source this value from request metadata. */
  operation?: 'get_memory' | 'list_memories';
  query?: string | null;
  metadata?: Record<string, unknown>;
  memories: ReadAuditMemory[];
}

/**
 * Records a read request summary and every distinct returned memory in one
 * statement. The summary retains request-level context; identity rows carry
 * only bounded delivery metadata so query or memory text is not duplicated.
 */
export async function recordRead(
  pool: Queryable,
  entry: ReadAuditEntry,
): Promise<void> {
  const requestId = randomUUID();
  const transport = entry.metadata?.transport;
  // These keys select retention/redaction policy and are owned by audit
  // producers. Read callers may supply request context, never a policy label.
  const {
    operation: _operation,
    source: _source,
    request_id: _requestId,
    record_kind: _recordKind,
    ...requestMetadata
  } = entry.metadata ?? {};
  const seen = new Set<string>();
  const memories = entry.memories.filter((memory) => {
    if (seen.has(memory.memoryId)) return false;
    seen.add(memory.memoryId);
    return true;
  });
  const rows = [
    {
      memory_id: null,
      scope_id: null,
      query: entry.query ?? null,
      metadata: {
        ...requestMetadata,
        ...(entry.operation === undefined ? {} : { operation: entry.operation }),
        request_id: requestId,
        record_kind: 'summary',
      },
    },
    ...memories.map((memory) => ({
      memory_id: memory.memoryId,
      scope_id: memory.scopeId,
      query: null,
      metadata: {
        ...memory.metadata,
        ...(transport === undefined ? {} : { transport }),
        request_id: requestId,
        record_kind: 'result',
      },
    })),
  ];

  await pool.query(
    `INSERT INTO audit_log
       (principal_id, action, memory_id, scope_id, query, metadata)
     SELECT $1::uuid, 'read', (returned.item->>'memory_id')::uuid,
            (returned.item->>'scope_id')::uuid,
            returned.item->>'query', returned.item->'metadata'
       FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY
         AS returned(item, ordinal)
      ORDER BY returned.ordinal`,
    [entry.principalId, JSON.stringify(rows)],
  );
}
