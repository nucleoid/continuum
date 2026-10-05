import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

  it('passes a report abort signal to each serial request and stops after abort', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ embedding: new Array(4).fill(0) }),
      } as unknown as Response;
    });
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://x', model: 'm', dim: 4, fetchImpl,
    });
    const controller = new AbortController();
    controller.abort(new Error('deadline'));
    await expect(provider.embed(['one', 'two'], { signal: controller.signal }))
      .rejects.toThrow('deadline');
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
});
