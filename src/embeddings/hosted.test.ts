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
    expect(error).toMatchObject({
      code: 'EMBEDDING_INVALID_RESPONSE', failureScope: 'provider',
    });
  });

  it.each([
    [401, 'EMBEDDING_AUTH'],
    [429, 'EMBEDDING_RATE_LIMIT'],
    [500, 'EMBEDDING_SERVER'],
  ])('classifies HTTP %i as provider-wide %s', async (status, code) => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'secret', model: 'model', dim: 2,
      fetchImpl: vi.fn(async () => ({ ok: false, status }) as Response),
    });
    await expect(provider.embed(['one'])).rejects.toMatchObject({
      code, failureScope: 'provider',
    });
  });

  it('enforces its deadline even when an injected fetch ignores abort', async () => {
    const fetchImpl = vi.fn(async () => new Promise<Response>(() => undefined));
    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'private', model: 'm', dim: 2, timeoutMs: 5, fetchImpl,
    });

    await expect(provider.embed(['one'])).rejects.toMatchObject({
      code: 'EMBEDDING_TIMEOUT', failureScope: 'provider',
    });
  });

  it('classifies transport failures as provider-wide network errors', async () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: '***', model: 'm', dim: 2,
      fetchImpl: vi.fn(async () => { throw new TypeError('private socket detail'); }),
    });

    await expect(provider.embed(['one'])).rejects.toMatchObject({
      code: 'EMBEDDING_NETWORK', failureScope: 'provider',
    });
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
