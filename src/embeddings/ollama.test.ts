import { describe, expect, it, vi } from 'vitest';
import { OllamaEmbeddingProvider } from './ollama.js';

function makeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () =>
    ({
      ok,
      status,
      statusText: ok ? 'OK' : 'ERR',
      json: async () => body,
    }) as unknown as Response,
  );
}

describe('OllamaEmbeddingProvider', () => {
  it('returns vectors of declared dim', async () => {
    const fetchImpl = makeFetch({ embedding: new Array(4).fill(0.1) });
    const p = new OllamaEmbeddingProvider({
      baseUrl: 'http://x',
      model: 'm',
      dim: 4,
      fetchImpl,
    });
    const [v] = await p.embed(['hello']);
    expect(v.length).toBe(4);
  });

  it('accepts the alternate {embeddings: [[...]]} shape', async () => {
    const fetchImpl = makeFetch({ embeddings: [new Array(4).fill(0.2)] });
    const p = new OllamaEmbeddingProvider({
      baseUrl: 'http://x',
      model: 'm',
      dim: 4,
      fetchImpl,
    });
    const [v] = await p.embed(['hello']);
    expect(v[0]).toBeCloseTo(0.2);
  });

  it('throws on dim mismatch', async () => {
    const fetchImpl = makeFetch({ embedding: [0.1, 0.2] });
    const p = new OllamaEmbeddingProvider({
      baseUrl: 'http://x',
      model: 'm',
      dim: 4,
      fetchImpl,
    });
    await expect(p.embed(['hi'])).rejects.toThrow();
  });

  it('throws on non-2xx', async () => {
    const fetchImpl = makeFetch({}, false, 500);
    const p = new OllamaEmbeddingProvider({
      baseUrl: 'http://x',
      model: 'm',
      dim: 4,
      fetchImpl,
    });
    await expect(p.embed(['hi'])).rejects.toThrow();
  });

  it('strips trailing slash from baseUrl', async () => {
    const fetchImpl = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ embedding: new Array(4).fill(0) }),
      }) as unknown as Response,
    );
    const p = new OllamaEmbeddingProvider({
      baseUrl: 'http://x/',
      model: 'm',
      dim: 4,
      fetchImpl,
    });
    await p.embed(['hi']);
    expect(vi.mocked(fetchImpl).mock.calls[0][0]).toBe('http://x/api/embeddings');
  });
});
