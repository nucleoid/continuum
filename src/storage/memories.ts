import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Memory, MemoryState, MemoryType } from '../types.js';
import { computeExpiry } from './expiry.js';
import type { ScopeKind } from '../types.js';

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

function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    id: row.id as string,
    scopeId: row.scope_id as string,
    type: row.type as MemoryType,
    title: row.title as string,
    body: row.body as string,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    tags: (row.tags as string[]) ?? [],
    authorId: row.author_id as string,
    source: row.source as string,
    sourceRef: (row.source_ref as string | null) ?? null,
    state: row.state as MemoryState,
    supersedesId: (row.supersedes_id as string | null) ?? null,
    promotedToId: (row.promoted_to_id as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    expiresAt: (row.expires_at as Date | null) ?? null,
    lastVerified: (row.last_verified as Date | null) ?? null,
  };
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
     RETURNING id, scope_id, type, title, body, metadata, tags, author_id,
               source, source_ref, state, supersedes_id, promoted_to_id,
               created_at, updated_at, expires_at, last_verified`,
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
    `SELECT id, scope_id, type, title, body, metadata, tags, author_id,
            source, source_ref, state, supersedes_id, promoted_to_id,
            created_at, updated_at, expires_at, last_verified
       FROM memories WHERE id = $1`,
    [id],
  );
  return rows[0] ? rowToMemory(rows[0]) : null;
}
