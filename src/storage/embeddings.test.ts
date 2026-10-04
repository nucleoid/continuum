import { describe, expect, it, vi } from 'vitest';
import {
  storeMemoryEmbeddingVector,
  vectorSearchMemoryIds,
} from './embeddings.js';
import type { Queryable } from './queryable.js';

function queryable() {
  return { query: vi.fn() } as unknown as Queryable;
}

describe('embedding dimension compatibility', () => {
  it('rejects a provider dimension that cannot fit the database schema before writing', async () => {
    const db = queryable();

    await expect(storeMemoryEmbeddingVector(
      db,
      'memory-id',
      Array(384).fill(0),
      { id: 'hosted:model', dim: 384 },
    )).rejects.toThrow(/provider dimension.*768.*database vector\(768\)/i);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rejects a returned vector that does not match the configured provider before writing', async () => {
    const db = queryable();

    await expect(storeMemoryEmbeddingVector(
      db,
      'memory-id',
      Array(384).fill(0),
      { id: 'hosted:model', dim: 768 },
    )).rejects.toThrow(/embedding vector dimension 384.*provider dimension 768/i);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rejects a query vector that does not match the configured provider before searching', async () => {
    const db = queryable();

    await expect(vectorSearchMemoryIds(
      db,
      Array(384).fill(0),
      ['00000000-0000-0000-0000-000000000001'],
      { id: 'hosted:model', dim: 768 },
      10,
    )).rejects.toThrow(/embedding vector dimension 384.*provider dimension 768/i);
    expect(db.query).not.toHaveBeenCalled();
  });
});
