import { describe, expect, it, vi } from 'vitest';
import { OpenAIEmbeddingProvider, VoyageEmbeddingProvider } from './hosted.js';

describe('hosted embedding providers', () => {
  it('batches OpenAI input and restores response index order', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => ({
      ok: true,
      json: async () => ({ data: [
        { index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] },
      ] }),
    }) as Response);
    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'private', model: 'm', dim: 2, fetchImpl,
    });

    await expect(provider.embed(['one', 'two'])).resolves.toEqual([[1, 0], [0, 1]]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer private',
    });
  });

  it('rejects malformed Voyage output and never includes the API key in errors', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, json: async () => ({ data: [{ embedding: [Number.NaN, 0] }] }),
    }) as Response);
    const provider = new VoyageEmbeddingProvider({
      apiKey: 'private-voyage-key', model: 'm', dim: 2, fetchImpl,
    });

    const error = await provider.embed(['one']).catch((cause: unknown) => cause as Error);
    expect(error.message).toMatch(/invalid embedding/i);
    expect(error.message).not.toContain('private-voyage-key');
  });

  it('enforces its deadline even when an injected fetch ignores abort', async () => {
    const fetchImpl = vi.fn(async () => new Promise<Response>(() => undefined));
    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'private', model: 'm', dim: 2, timeoutMs: 5, fetchImpl,
    });

    await expect(provider.embed(['one'])).rejects.toThrow(/timed out/i);
  });

  it('does not start a request when the caller signal is already aborted', async () => {
    const fetchImpl = vi.fn(async () => new Promise<Response>(() => undefined));
    const provider = new OpenAIEmbeddingProvider({
      apiKey: '***', model: 'm', dim: 2, timeoutMs: 5_000, fetchImpl,
    });
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));

    await expect(provider.embed(['one'], { signal: controller.signal }))
      .rejects.toThrow('caller cancelled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects insecure direct hosted endpoints except loopback development endpoints', () => {
    expect(() => new OpenAIEmbeddingProvider({
      apiKey: 'key', model: 'm', dim: 2, endpoint: 'http://remote.example.test/v1',
    })).toThrow(/https/i);
    expect(() => new OpenAIEmbeddingProvider({
      apiKey: 'key', model: 'm', dim: 2, endpoint: 'http://127.0.0.1:8080/v1',
    })).not.toThrow();
  });
});
