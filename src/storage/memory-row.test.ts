import { describe, expect, it } from 'vitest';
import type { Memory } from '../types.js';
import { MEMORY_COLUMNS, rowToMemory, type MemoryRow } from './memory-row.js';

const createdAt = new Date('2026-01-02T03:04:05.000Z');
const updatedAt = new Date('2026-02-03T04:05:06.000Z');
const expiresAt = new Date('2026-03-04T05:06:07.000Z');
const lastVerified = new Date('2026-04-05T06:07:08.000Z');

const completeRow = {
  id: 'memory-id',
  scope_id: 'scope-id',
  type: 'decision',
  title: 'Canonical mapper',
  body: 'Map every persisted memory field once.',
  metadata: { priority: 'high' },
  tags: ['storage', 'mapping'],
  author_id: 'author-id',
  source: 'manual',
  source_ref: 'https://example.test/source',
  state: 'live',
  supersedes_id: 'older-memory-id',
  promoted_to_id: 'promoted-memory-id',
  created_at: createdAt,
  updated_at: updatedAt,
  expires_at: expiresAt,
  last_verified: lastVerified,
} satisfies MemoryRow;

describe('memory row projection and mapping', () => {
  it('defines the canonical unqualified 17-column projection', () => {
    const columns = MEMORY_COLUMNS.split(',').map((column) => column.trim());

    expect(columns).toEqual([
      'id',
      'scope_id',
      'type',
      'title',
      'body',
      'metadata',
      'tags',
      'author_id',
      'source',
      'source_ref',
      'state',
      'supersedes_id',
      'promoted_to_id',
      'created_at',
      'updated_at',
      'expires_at',
      'last_verified',
    ]);
  });

  it('maps all persisted fields and preserves Date object references', () => {
    const memory = rowToMemory(completeRow);
    const expected = {
      id: 'memory-id',
      scopeId: 'scope-id',
      type: 'decision',
      title: 'Canonical mapper',
      body: 'Map every persisted memory field once.',
      metadata: { priority: 'high' },
      tags: ['storage', 'mapping'],
      authorId: 'author-id',
      source: 'manual',
      sourceRef: 'https://example.test/source',
      state: 'live',
      supersedesId: 'older-memory-id',
      promotedToId: 'promoted-memory-id',
      createdAt,
      updatedAt,
      expiresAt,
      lastVerified,
    } satisfies Memory;

    expect(memory).toEqual(expected);
    expect(memory.createdAt).toBe(createdAt);
    expect(memory.updatedAt).toBe(updatedAt);
    expect(memory.expiresAt).toBe(expiresAt);
    expect(memory.lastVerified).toBe(lastVerified);
  });

  it('preserves empty metadata and tags defaults plus nullable fields', () => {
    const memory = rowToMemory({
      ...completeRow,
      metadata: null,
      tags: null,
      source_ref: null,
      supersedes_id: null,
      promoted_to_id: null,
      expires_at: null,
      last_verified: null,
    });

    expect(memory.metadata).toEqual({});
    expect(memory.tags).toEqual([]);
    expect(memory.sourceRef).toBeNull();
    expect(memory.supersedesId).toBeNull();
    expect(memory.promotedToId).toBeNull();
    expect(memory.expiresAt).toBeNull();
    expect(memory.lastVerified).toBeNull();
    expect(memory.createdAt).toBe(createdAt);
    expect(memory.updatedAt).toBe(updatedAt);
  });
});
