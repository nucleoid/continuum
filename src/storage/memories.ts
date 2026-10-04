import { randomUUID } from 'node:crypto';
import type { Memory, MemoryType } from '../types.js';
import { computeExpiry } from './expiry.js';
import type { ScopeKind } from '../types.js';
import { MEMORY_COLUMNS, rowToMemory } from './memory-row.js';
import type { Queryable } from './queryable.js';

export interface NewMemory {
  id?: string;
  scopeId: string;
  scopeKind: ScopeKind;
  type: MemoryType;
  title: string;
  body: string;
  authorId: string;
  source: string;
  sourceRef?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  supersedesId?: string | null;
}

export async function createMemory(
  pool: Queryable,
  input: NewMemory,
): Promise<Memory> {
  const id = input.id ?? randomUUID();
  const expiresAt = computeExpiry(input.type, input.scopeKind);
  const { rows } = await pool.query(
    `INSERT INTO memories
       (id, scope_id, type, title, body, metadata, tags, author_id, source, source_ref,
        expires_at, supersedes_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${MEMORY_COLUMNS}`,
    [
      id,
      input.scopeId,
      input.type,
      input.title,
      input.body,
      JSON.stringify(input.metadata ?? {}),
      input.tags ?? [],
      input.authorId,
      input.source,
      input.sourceRef ?? null,
      expiresAt,
      input.supersedesId ?? null,
    ],
  );
  return rowToMemory(rows[0]);
}

export async function updateMemoryMetadata(
  pool: Queryable,
  id: string,
  metadata: Record<string, unknown>,
): Promise<Memory> {
  const { rows } = await pool.query(
    `UPDATE memories
        SET metadata = $2::jsonb,
            updated_at = now()
      WHERE id = $1
      RETURNING ${MEMORY_COLUMNS}`,
    [id, JSON.stringify(metadata)],
  );
  return rowToMemory(rows[0]);
}

export async function getMemory(
  pool: Queryable,
  id: string,
): Promise<Memory | null> {
  const { rows } = await pool.query(
    `SELECT ${MEMORY_COLUMNS}
       FROM memories WHERE id = $1`,
    [id],
  );
  return rows[0] ? rowToMemory(rows[0]) : null;
}
