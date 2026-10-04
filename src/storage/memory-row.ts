import type { Memory, MemoryState, MemoryType } from '../types.js';

export const MEMORY_COLUMNS = `id, scope_id, type, title, body, metadata, tags,
  author_id, source, source_ref, state, supersedes_id, promoted_to_id,
  created_at, updated_at, expires_at, last_verified`;

export interface MemoryRow {
  id: string;
  scope_id: string;
  type: MemoryType;
  title: string;
  body: string;
  metadata: Record<string, unknown> | null;
  tags: string[] | null;
  author_id: string;
  source: string;
  source_ref: string | null;
  state: MemoryState;
  supersedes_id: string | null;
  promoted_to_id: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
  last_verified: Date | null;
}

export function rowToMemory(row: MemoryRow | Record<string, unknown>): Memory {
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
