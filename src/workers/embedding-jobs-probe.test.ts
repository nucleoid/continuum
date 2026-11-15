import { describe, expect, it, vi } from 'vitest';
import { EmbeddingItemError, EmbeddingProviderError } from '../embeddings/provider.js';
import { probeEmbeddingBatch } from './embedding-jobs-probe.js';

const vector = () => Array(768).fill(1);
describe('bounded embedding poison isolation', () => {
  it('isolates explicit poison only after a successful control', async () => {
    const result = await probeEmbeddingBatch(4, async indexes => {
      if (indexes.includes(2)) throw new EmbeddingItemError('private input');
      return indexes.map(vector);
    });
    expect(result.permanent).toEqual([2]);
    expect(result.ready.map(r => r.index)).toEqual([0, 1, 3]);
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toBe(4);
  });
  it('does not convert an all-failing tree or malformed responses into poison', async () => {
    for (const dispatch of [async () => { throw new EmbeddingItemError('all fail'); }, async () => []]) {
      const result = await probeEmbeddingBatch(32, dispatch);
      expect(result.permanent).toEqual([]); expect(result.ready).toEqual([]);
      expect(result.unresolved).toHaveLength(32); expect(result.outage).toBe(true);
      expect(result.calls).toBeLessThanOrEqual(64);
    }
  });
  it('caps ambiguous diagnostic pressure and retains unresolved items', async () => {
    const dispatch = vi.fn(async () => { throw new EmbeddingProviderError('EMBEDDING_SERVER', 'secret'); });
    const result = await probeEmbeddingBatch(32, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(8); expect(result.permanent).toEqual([]);
    expect(result.unresolved).toHaveLength(32);
  });
  it('stops on auth/rate/network failures and never diagnoses a singleton outage', async () => {
    const dispatch = vi.fn(async () => { throw new EmbeddingProviderError('EMBEDDING_AUTH', 'secret'); });
    expect((await probeEmbeddingBatch(32, dispatch)).calls).toBe(1);
    dispatch.mockClear();
    expect((await probeEmbeddingBatch(1, dispatch)).calls).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('checks cancellation before every additional call', async () => {
    const controller = new AbortController();
    const result = await probeEmbeddingBatch(8, async indexes => {
      controller.abort(); return indexes.map(vector);
    }, controller.signal);
    expect(result.calls).toBe(1); expect(result.unresolved).toHaveLength(8);
    expect(result.cancelled).toBe(true); expect(result.outage).toBe(false);
  });
});
