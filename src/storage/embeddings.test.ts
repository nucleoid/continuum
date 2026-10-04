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

describe('vector search filters', () => {
  const vector = Array(768).fill(0) as number[];
  const scopeIds = ['00000000-0000-0000-0000-000000000001'];
  const provider = { id: 'hosted:model', dim: 768 };

  it.each([
    ['undefined', undefined],
    ['empty', []],
  ])('leaves search unfiltered for %s types', async (_label, types) => {
    const db = queryable();
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);

    await vectorSearchMemoryIds(db, vector, scopeIds, provider, 10, types);

    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('m.type = ANY');
    expect(params).toEqual([
      expect.any(String),
      scopeIds,
      provider.id,
      provider.dim,
      10,
    ]);
  });

  it('combines multiple requested types with provider and dimension filters', async () => {
    const db = queryable();
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);

    await vectorSearchMemoryIds(
      db,
      vector,
      scopeIds,
      provider,
      7,
      ['decision', 'playbook'],
    );

    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('m.type = ANY($5::text[])');
    expect(sql).toContain('e.provider = $3');
    expect(sql).toContain('e.dim = $4');
    expect(sql).toContain('LIMIT $6');
    expect(params).toEqual([
      expect.any(String),
      scopeIds,
      provider.id,
      provider.dim,
      ['decision', 'playbook'],
      7,
    ]);
  });

  it('applies similarity threshold and self exclusion before a bounded stable order', async () => {
    const db = queryable();
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);

    await vectorSearchMemoryIds(
      db,
      vector,
      scopeIds,
      provider,
      5,
      undefined,
      { threshold: 0.92, excludeMemoryId: '00000000-0000-0000-0000-000000000099' },
    );

    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('m.id <> $5::uuid');
    expect(sql).toContain('1 - (e.embedding <=> $1::vector) >= $6');
    expect(sql).toContain('ORDER BY distance ASC, m.id ASC');
    expect(sql).toContain('LIMIT $7');
    expect(params).toEqual([
      expect.any(String), scopeIds, provider.id, provider.dim,
      '00000000-0000-0000-0000-000000000099', 0.92, 5,
    ]);
  });
});
