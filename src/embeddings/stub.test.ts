import { describe, expect, it } from 'vitest';
import { StubEmbeddingProvider } from './stub.js';

describe('StubEmbeddingProvider', () => {
  it('produces a vector of the requested dim', async () => {
    const p = new StubEmbeddingProvider(768);
    const [v] = await p.embed(['hello']);
    expect(v.length).toBe(768);
  });

  it('is deterministic for the same input', async () => {
    const p = new StubEmbeddingProvider();
    const [a] = await p.embed(['same text']);
    const [b] = await p.embed(['same text']);
    expect(a).toEqual(b);
  });

  it('differs across inputs', async () => {
    const p = new StubEmbeddingProvider();
    const [a] = await p.embed(['one']);
    const [b] = await p.embed(['two']);
    expect(a).not.toEqual(b);
  });

  it('produces unit-length vectors', async () => {
    const p = new StubEmbeddingProvider(64);
    const [v] = await p.embed(['unit test']);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-9);
  });
});
