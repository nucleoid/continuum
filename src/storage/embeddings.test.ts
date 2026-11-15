import { describe, expect, it, vi } from 'vitest';
import {
  storeMemoryEmbeddingVector,
  vectorSearchMemoryIds,
  vectorSearchRelatedMemories,
  type MemoryEmbeddingAdmission,
  admitMemoryEmbedding,
  embeddingTargetIsCurrent,
} from './embeddings.js';
import type { Queryable } from './queryable.js';
import { embeddingTarget } from '../embeddings/target.js';

const target = embeddingTarget({ space: { provider: 'ollama:model-b', model: 'model-b',
  profile: 'synthetic-test-v1', dim: 768, inputTransform: 'memory-title-body-v1' },
  endpoint: 'http://localhost:11434', local: true });
const admission: MemoryEmbeddingAdmission = { memoryId: 'memory-id', generation: '1', inputHash: 'a'.repeat(64),
  target, policyGeneration: '1', policyDigest: 'b'.repeat(64) };

describe('actual embedding provider locality', () => {
  it('does not admit a local target for an explicitly remote provider before any SQL or provider I/O', async () => {
    const db = queryable();
    vi.mocked(db.query).mockResolvedValue({ rows: [{ current: true, admission }] } as never);
    const provider = { id: target.space.provider, dim: 768, local: false, target };
    expect(await embeddingTargetIsCurrent(db, provider, ['scope-id'])).toBe(false);
    await expect(admitMemoryEmbedding(db, 'memory-id', provider)).rejects.toThrow(/descriptor/i);
    expect(db.query).not.toHaveBeenCalled();
  });
});

function queryable() {
  return { query: vi.fn() } as unknown as Queryable;
}

function vectorQueryable() {
  const db = queryable();
  vi.mocked(db.query)
    .mockResolvedValueOnce({ rows: [{ current: true }] } as never)
    .mockResolvedValueOnce({ rows: [{ schema: 'provider extensions' }] } as never)
    .mockResolvedValueOnce({ rows: [] } as never);
  return db;
}

describe('embedding dimension compatibility', () => {
  it('rejects a provider dimension that cannot fit the database schema before writing', async () => {
    const db = queryable();

    await expect(storeMemoryEmbeddingVector(
      db,
      'memory-id',
      Array(384).fill(0),
      { id: 'hosted:model', dim: 384 },
      admission,
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
      admission,
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

describe('provider-qualified storage', () => {
  it('applies only the matching provider identity using its original source admission', async () => {
    const db = queryable();
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ stored: true }] } as never);
    await storeMemoryEmbeddingVector(db, 'memory-id', Array(768).fill(0), {
      id: 'ollama:model-b', dim: 768,
    }, admission);
    expect(db.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT continuum_embedding_apply_vector($1,$2,$3) AS stored',
      ['memory-id', expect.any(String), admission],
    );
  });

  it('propagates a rejected current lifecycle or expiry gate without replacing the admission', async () => {
    const db = queryable();
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ stored: false }] } as never);

    await expect(storeMemoryEmbeddingVector(db, 'memory-id', Array(768).fill(0), {
      id: 'ollama:model-b', dim: 768,
    }, admission)).resolves.toBe(false);
    expect(db.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT continuum_embedding_apply_vector($1,$2,$3) AS stored',
      ['memory-id', expect.any(String), admission],
    );
  });

  it('rejects a different source or vector space before any storage call', async () => {
    const db = queryable();
    await expect(storeMemoryEmbeddingVector(db, 'other-memory', Array(768).fill(0),
      { id: 'ollama:model-b', dim: 768 }, admission)).rejects.toThrow('Original embedding source admission is required');
    await expect(storeMemoryEmbeddingVector(db, 'memory-id', Array(768).fill(0),
      { id: 'ollama:model-c', dim: 768 }, admission)).rejects.toThrow('Original embedding source admission is required');
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('vector search filters', () => {
  const vector = Array(768).fill(0) as number[];
  const scopeIds = ['00000000-0000-0000-0000-000000000001'];
  const provider = { id: target.space.provider, dim: 768, local: true, target };

  it('does not inspect vector storage when the approved target is no longer current', async () => {
    const db = queryable();
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ current: false }] } as never);
    await expect(vectorSearchMemoryIds(db, vector, scopeIds, provider, 10)).resolves.toEqual([]);
    expect(db.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT continuum_embedding_target_is_current($1,$2) AS current', [target, scopeIds]);
  });

  it.each([
    ['undefined', undefined],
    ['empty', []],
  ])('leaves search unfiltered for %s types', async (_label, types) => {
    const db = vectorQueryable();

    await vectorSearchMemoryIds(db, vector, scopeIds, provider, 10, types);

    const [sql, params] = vi.mocked(db.query).mock.calls[2] as [string, unknown[]];
    expect(sql).not.toContain('m.type = ANY');
    expect(sql).toContain('OPERATOR("provider extensions".<=>)');
    expect(params).toEqual([
      expect.any(String),
      scopeIds,
      provider.id,
      provider.dim,
      10,
    ]);
  });

  it('materializes the provider-qualified candidate set before vector ordering', async () => {
    const db = vectorQueryable();

    await vectorSearchMemoryIds(db, vector, scopeIds, provider, 10);

    const [sql] = vi.mocked(db.query).mock.calls[2] as [string, unknown[]];
    expect(sql).toMatch(/WITH provider_embeddings AS MATERIALIZED/i);
    expect(sql.indexOf('e.provider = $3')).toBeLessThan(sql.indexOf('ORDER BY'));
    const materializedEnd = sql.indexOf('\n     )');
    expect(sql.indexOf('JOIN memories m')).toBeLessThan(materializedEnd);
    expect(sql.indexOf('m.scope_id = ANY')).toBeLessThan(materializedEnd);
    expect(sql.indexOf("m.state = 'live'")).toBeLessThan(materializedEnd);
    expect(sql.indexOf('m.expires_at IS NULL')).toBeLessThan(materializedEnd);
    expect(sql.indexOf('continuum_embedding_vector_is_current')).toBeLessThan(materializedEnd);
  });

  it('scope-filters related-memory candidates inside the materialized exact scan', async () => {
    const db = vectorQueryable();

    await vectorSearchRelatedMemories(db, vector, scopeIds, provider, {
      threshold: 0.75,
      excludeMemoryId: '00000000-0000-0000-0000-000000000002',
      limit: 5,
    });

    const [sql] = vi.mocked(db.query).mock.calls[2] as [string, unknown[]];
    const materializedEnd = sql.indexOf('\n     )');
    expect(sql).toMatch(/WITH provider_embeddings AS MATERIALIZED/i);
    expect(sql.indexOf('JOIN memories m')).toBeLessThan(materializedEnd);
    expect(sql.indexOf('m.scope_id = ANY')).toBeLessThan(materializedEnd);
    expect(sql.indexOf("m.state = 'live'")).toBeLessThan(materializedEnd);
    expect(sql.indexOf('m.expires_at IS NULL')).toBeLessThan(materializedEnd);
    expect(sql.indexOf('continuum_embedding_vector_is_current')).toBeLessThan(materializedEnd);
  });

  it('combines multiple requested types with provider and dimension filters', async () => {
    const db = vectorQueryable();

    await vectorSearchMemoryIds(
      db,
      vector,
      scopeIds,
      provider,
      7,
      ['decision', 'playbook'],
    );

    const [sql, params] = vi.mocked(db.query).mock.calls[2] as [string, unknown[]];
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

});
