import { describe, expect, it, vi } from 'vitest';
import { GeminiEmbeddingProvider } from './gemini.js';
import { makeEmbeddingRouterFromEnv } from './factory.js';

const vector = (value = 1) => Array(768).fill(value);
const response = (values: unknown[]) => new Response(JSON.stringify({ embeddings: values.map(values => ({ values })) }));
const provider = (fetchImpl: typeof fetch, extra = {}) => new GeminiEmbeddingProvider({
  apiKey: 'private-key', model: 'gemini-embedding-2-preview', dim: 768, fetchImpl, ...extra,
});

describe('Gemini embeddings', () => {
  it('chunks ordered text with explicit dimensions and header auth without task prompts', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return response(body.requests.map((request: { content: { parts: { text: string }[] } }) => vector(Number(request.content.parts[0].text))));
    });
    const p = provider(fetchImpl, { batchSize: 2 });
    expect(p.id).toBe('gemini:gemini-embedding-2-preview');
    expect(p.local).toBe(false);
    await expect(p.embed(['1', '2', '3'])).resolves.toEqual([vector(1), vector(2), vector(3)]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:batchEmbedContents');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ headers: { 'x-goog-api-key': 'private-key' }, redirect: 'error' });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ requests: ['1', '2'].map(text => ({ model: 'models/gemini-embedding-2-preview', content: { parts: [{ text }] }, outputDimensionality: 768 })) });
    await expect(p.embed([])).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { embeddings: [] }, { embeddings: [null] }, { embeddings: [{ values: [1] }] }, { embeddings: [{ values: vector('bad' as unknown as number) }] }])('rejects malformed output as provider-wide', async body => {
    const p = provider(vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(p.embed(['private input'])).rejects.toMatchObject({ code: 'EMBEDDING_INVALID_RESPONSE', failureScope: 'provider' });
  });

  it('rejects nonfinite vectors from a response object', async () => {
    const p = provider(vi.fn(async () => ({ ok: true, json: async () => ({ embeddings: [{ values: vector(Infinity) }] }) }) as Response));
    await expect(p.embed(['one'])).rejects.toMatchObject({ code: 'EMBEDDING_INVALID_RESPONSE' });
  });

  it('bounds streamed response bytes and cancels oversized output', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } });
    await expect(provider(vi.fn(async () => new Response(stream))).embed(['one'])).rejects.toMatchObject({ code: 'EMBEDDING_INVALID_RESPONSE' });
    expect(cancelled).toBe(true);
  });

  it.each([[400, 'EMBEDDING_FAILED'], [404, 'EMBEDDING_FAILED'], [401, 'EMBEDDING_AUTH'], [403, 'EMBEDDING_AUTH'], [429, 'EMBEDDING_RATE_LIMIT'], [503, 'EMBEDDING_SERVER']])('keeps HTTP %i provider-wide and sanitized', async (status, code) => {
    const p = provider(vi.fn(async () => new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', code: 'input_too_large', message: 'private-key private input invalid model' } }), { status: Number(status) })));
    const error = await p.embed(['private input']).catch(error => error);
    expect(error).toMatchObject({ code, failureScope: 'provider' });
    expect(error.message).not.toMatch(/private-key|private input|invalid model/);
  });

  it('bounds abort-ignoring fetch and propagates caller cancellation before the next chunk', async () => {
    const hung = provider(vi.fn(() => new Promise<Response>(() => {})), { timeoutMs: 5 });
    await expect(hung.embed(['one'])).rejects.toMatchObject({ code: 'EMBEDDING_TIMEOUT' });
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => { controller.abort(new Error('caller cancelled')); return response([vector()]); });
    await expect(provider(fetchImpl, { batchSize: 1 }).embed(['one', 'two'], { signal: controller.signal })).rejects.toThrow('caller cancelled');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('classifies network failure and rejects unsafe model, dimensions, endpoint and batches', async () => {
    await expect(provider(vi.fn(async () => { throw new Error('private network detail'); })).embed(['one'])).rejects.toMatchObject({ code: 'EMBEDDING_NETWORK' });
    for (const extra of [{ model: '../secret' }, { dim: 1024 }, { batchSize: 101 }, { endpoint: 'https://example.test/?key=secret' }, { endpoint: 'http://remote.test/' }]) {
      expect(() => provider(vi.fn(), extra)).toThrow();
    }
  });

  it('dispatches Gemini using only its key and leaves local-only scopes unavailable', () => {
    const config = (local = false) => JSON.stringify({ providers: [{ alias: 'uat', kind: 'gemini', model: 'gemini-embedding-2-preview', dim: 768, local, batch_size: 2 }], routing: { default: 'none', rules: [{ match: { kind: 'project', name: 'synthetic-uat' }, provider: 'uat' }, { match: { kind: 'user' }, provider: 'local-only' }] } });
    expect(() => makeEmbeddingRouterFromEnv({ CONTINUUM_EMBEDDING_CONFIG: config(), VOYAGE_API_KEY: 'wrong' })).toThrow('GEMINI_API_KEY');
    expect(() => makeEmbeddingRouterFromEnv({ CONTINUUM_EMBEDDING_CONFIG: config(true), GEMINI_API_KEY: 'private' })).toThrow(/cannot be marked local/);
    const router = makeEmbeddingRouterFromEnv({ CONTINUUM_EMBEDDING_CONFIG: config(), GEMINI_API_KEY: 'private' });
    expect(router.resolve({ kind: 'project', name: 'synthetic-uat' }).provider).toMatchObject({ id: 'gemini:gemini-embedding-2-preview', dim: 768, batchSize: 2, local: false });
    expect(router.resolve({ kind: 'user', name: 'sensitive' })).toMatchObject({ provider: null, policy: 'local-only-unavailable' });
    expect(router.resolve({ kind: 'org', name: '' })).toMatchObject({ provider: null, policy: 'disabled' });
  });
});
