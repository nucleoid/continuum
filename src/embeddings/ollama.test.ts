import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { EmbeddingTimeoutError, OllamaEmbeddingProvider } from './ollama.js';

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok, status, statusText: ok ? 'OK' : 'ERR', json: async () => body,
  } as unknown as Response;
}

describe('OllamaEmbeddingProvider', () => {
  it('returns empty output without an HTTP call', async () => {
    const fetchImpl = vi.fn();
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://x', model: 'm', dim: 4, fetchImpl,
    });

    await expect(provider.embed([])).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('batches requests, preserves order, and uses the /api/embed array contract', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const input = (JSON.parse(String(init?.body)) as { input: string[] }).input;
      return response({ embeddings: input.map((text) => [text.length, 0, 0, 0]) });
    });
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://x/', model: 'm', dim: 4, batchSize: 2, fetchImpl,
    });

    await expect(provider.embed(['a', 'bb', 'ccc'])).resolves.toEqual([
      [1, 0, 0, 0], [2, 0, 0, 0], [3, 0, 0, 0],
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'http://x/api/embed', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ model: 'm', input: ['a', 'bb'] }),
      signal: expect.any(AbortSignal),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'http://x/api/embed', expect.objectContaining({
      body: JSON.stringify({ model: 'm', input: ['ccc'] }),
    }));
  });

  it.each([
    ['cardinality', { embeddings: [[0, 0, 0, 0]] }],
    ['dimension', { embeddings: [[0, 0], [0, 0, 0, 0]] }],
    ['non-finite value', { embeddings: [[0, 0, 0, 0], [0, Number.NaN, 0, 0]] }],
    ['non-numeric value', { embeddings: [[0, 0, 0, 0], [0, 'bad', 0, 0]] }],
    ['legacy response', { embedding: [0, 0, 0, 0] }],
  ])('rejects an invalid %s response for the entire chunk', async (_label, body) => {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://x', model: 'm', dim: 4,
      fetchImpl: vi.fn(async () => response(body)),
    });

    await expect(provider.embed(['one', 'two'])).rejects.toMatchObject({
      code: 'EMBEDDING_INVALID_RESPONSE', failureScope: 'provider',
    });
  });

  it('normalizes its request deadline to a typed timeout error', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://x', model: 'private-model', dim: 4,
      timeoutMs: 5, fetchImpl,
    });

    const error = await provider.embed(['sensitive text']).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbeddingTimeoutError);
    expect(error).toMatchObject({ code: 'EMBEDDING_TIMEOUT', providerId: 'ollama:private-model', timeoutMs: 5 });
    expect(String(error)).not.toContain('sensitive text');
  });

  it('honors a caller abort before making a request', async () => {
    const fetchImpl = vi.fn();
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://x', model: 'm', dim: 4, fetchImpl,
    });
    const controller = new AbortController();
    controller.abort(new Error('deadline'));

    await expect(provider.embed(['one'], { signal: controller.signal })).rejects.toThrow('deadline');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enforces its deadline even when an injected fetch ignores abort', async () => {
    const fetchImpl = vi.fn(async () => new Promise<Response>(() => undefined));
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434', model: 'nomic-embed-text', dim: 768,
      timeoutMs: 5, fetchImpl,
    });

    await expect(provider.embed(['private local text'])).rejects.toThrow(/timed out/i);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a stalled partial response body by its deadline and closes the socket', async () => {
    let requestClosed!: () => void;
    const closed = new Promise<void>((resolve) => { requestClosed = resolve; });
    const server = createServer((request, response) => {
      request.once('close', requestClosed);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"embedding":[0');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const provider = new OllamaEmbeddingProvider({
      baseUrl: `http://127.0.0.1:${port}`, model: 'm', dim: 2, timeoutMs: 30,
    });

    try {
      await expect(provider.embed(['private text'])).rejects.toThrow(/timed out/i);
      await expect(Promise.race([
        closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('socket leaked')), 500)),
      ])).resolves.toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('aborts a stalled response body when the caller cancels and closes the socket', async () => {
    let headersSent!: () => void;
    let requestClosed!: () => void;
    const sent = new Promise<void>((resolve) => { headersSent = resolve; });
    const closed = new Promise<void>((resolve) => { requestClosed = resolve; });
    const server = createServer((request, response) => {
      request.once('close', requestClosed);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"embedding":[0');
      headersSent();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const provider = new OllamaEmbeddingProvider({
      baseUrl: `http://127.0.0.1:${port}`, model: 'm', dim: 2, timeoutMs: 2_000,
    });
    const controller = new AbortController();
    const embedding = provider.embed(['private text'], { signal: controller.signal });

    try {
      await sent;
      controller.abort(new Error('caller cancelled'));
      await expect(embedding).rejects.toThrow('caller cancelled');
      await expect(Promise.race([
        closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('socket leaked')), 500)),
      ])).resolves.toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    [401, 'EMBEDDING_AUTH'],
    [403, 'EMBEDDING_AUTH'],
    [429, 'EMBEDDING_RATE_LIMIT'],
    [503, 'EMBEDDING_SERVER'],
  ])('classifies HTTP %i as provider-wide %s without response bodies', async (status, code) => {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://x', model: 'm', dim: 4,
      fetchImpl: vi.fn(async () => response({ secret: 'do not leak' }, false, status)),
    });
    await expect(provider.embed(['private input'])).rejects.toMatchObject({
      code, failureScope: 'provider',
    });
  });

  it.each([400, 413, 422])(
    'classifies HTTP %i input rejection as an item failure without response bodies',
    async (status) => {
      const provider = new OllamaEmbeddingProvider({
        baseUrl: 'http://x', model: 'm', dim: 4,
        fetchImpl: vi.fn(async () => response({ secret: 'do not leak' }, false, status)),
      });
      await expect(provider.embed(['private oversized input'])).rejects.toMatchObject({
        code: 'EMBEDDING_ITEM_FAILED', failureScope: 'item',
      });
    },
  );

  it('classifies transport failures as provider-wide network errors', async () => {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://x', model: 'm', dim: 4,
      fetchImpl: vi.fn(async () => { throw new TypeError('private socket detail'); }),
    });
    await expect(provider.embed(['private input'])).rejects.toMatchObject({
      code: 'EMBEDDING_NETWORK', failureScope: 'provider',
    });
  });
});
