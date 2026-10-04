import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Memory, MemoryType } from '../types.js';
import { computeExpiry } from './expiry.js';
import type { ScopeKind } from '../types.js';
import { MEMORY_COLUMNS, rowToMemory } from './memory-row.js';

export interface NewMemory {
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
}

export async function createMemory(
  pool: pg.Pool,
  input: NewMemory,
): Promise<Memory> {
  const id = randomUUID();
  const expiresAt = computeExpiry(input.type, input.scopeKind);
  const { rows } = await pool.query(
    `INSERT INTO memories
       (id, scope_id, type, title, body, metadata, tags, author_id, source, source_ref, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
    ],
  );
  return rowToMemory(rows[0]);
}

export async function getMemory(
  pool: pg.Pool,
  id: string,
): Promise<Memory | null> {
  const { rows } = await pool.query(
    `SELECT ${MEMORY_COLUMNS}
       FROM memories WHERE id = $1`,
    [id],
  );
  return rows[0] ? rowToMemory(rows[0]) : null;
}
