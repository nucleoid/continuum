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

  it.each([
    ['OpenAI', OpenAIEmbeddingProvider, 400, { error: { code: 'context_length_exceeded' } }],
    ['OpenAI', OpenAIEmbeddingProvider, 413, { error: { param: 'input' } }],
    ['OpenAI', OpenAIEmbeddingProvider, 422, { error: { code: 'input_too_large' } }],
    ['Voyage', VoyageEmbeddingProvider, 400, { detail: 'input exceeds maximum token limit' }],
    ['Voyage', VoyageEmbeddingProvider, 413, { detail: 'text is too large' }],
    ['Voyage', VoyageEmbeddingProvider, 422, { code: 'text_too_long' }],
  ])('classifies $0 HTTP $2 explicit input rejection as an item failure', async (_name, Provider, status, body) => {
    const provider = new Provider({
      apiKey: 'private-key', model: 'model', dim: 2,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(body), { status })),
    });

    await expect(provider.embed(['private oversized input'])).rejects.toMatchObject({
      code: 'EMBEDDING_ITEM_FAILED', failureScope: 'item',
    });
  });

  it.each([OpenAIEmbeddingProvider, VoyageEmbeddingProvider])(
    'defaults ambiguous HTTP 400 responses from %s to provider-wide',
    async (Provider) => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        error: { code: 'bad_request', message: 'request rejected' },
      }), { status: 400 }));
      const provider = new Provider({
        apiKey: 'test-key', model: 'model', dim: 2, fetchImpl,
      });

      await expect(provider.embed(['one', 'two'])).rejects.toMatchObject({
        code: 'EMBEDDING_FAILED', failureScope: 'provider',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('classifies the realistic OpenAI null-code maximum-context envelope as item-scoped', async () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: '***', model: 'model', dim: 2,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        error: {
          message: "This model's maximum context length is 8192 tokens, however you requested 9001 tokens (9001 in your prompt; 0 for the completion). Please reduce your prompt; or completion length.",
          type: 'invalid_request_error',
          param: null,
          code: null,
        },
      }), { status: 400 })),
    });

    await expect(provider.embed(['private oversized input'])).rejects.toMatchObject({
      code: 'EMBEDDING_ITEM_FAILED', failureScope: 'item',
    });
  });

  it('classifies the realistic Voyage per-request token-limit envelope as item-scoped', async () => {
    const provider = new VoyageEmbeddingProvider({
      apiKey: '***', model: 'model', dim: 2,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        detail: 'The total number of tokens in the batch (130001) exceeds the max allowed tokens per request (120000).',
      }), { status: 400 })),
    });

    await expect(provider.embed(['one', 'two'])).rejects.toMatchObject({
      code: 'EMBEDDING_ITEM_FAILED', failureScope: 'item',
    });
  });

  it.each([
    ['Voyage indexed example token limit', VoyageEmbeddingProvider, {
      detail: 'The example at index 1 has too many tokens for the model context window.',
    }],
    ['Voyage submitted-batch token limit', VoyageEmbeddingProvider, {
      detail: 'The max allowed tokens per submitted batch is 120000. Your batch has 130001 tokens.',
    }],
    ['OpenAI per-request token limit', OpenAIEmbeddingProvider, {
      error: {
        message: 'Requested 300001 tokens, max 300000 tokens per request',
        type: 'invalid_request_error', param: null, code: null,
      },
    }],
  ])('classifies the realistic %s payload as item-scoped', async (_name, Provider, body) => {
    const provider = new Provider({
      apiKey: '***', model: 'model', dim: 2,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(body), { status: 400 })),
    });

    await expect(provider.embed(['one', 'two'])).rejects.toMatchObject({
      code: 'EMBEDDING_ITEM_FAILED', failureScope: 'item',
    });
  });

  it.each([
    ['authentication', 401, {
      error: { message: 'Requested 300001 tokens, max 300000 tokens per request' },
    }, 'EMBEDDING_AUTH'],
    ['format', 400, {
      error: { code: 'invalid_request_format', message: 'Requested 300001 tokens, max 300000 tokens per request' },
    }, 'EMBEDDING_FAILED'],
    ['provider configuration', 400, {
      error: { code: 'invalid_model_configuration', message: 'Requested 300001 tokens, max 300000 tokens per request' },
    }, 'EMBEDDING_FAILED'],
  ])('does not misclassify an OpenAI %s failure', async (_name, status, body, code) => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: '***', model: 'model', dim: 2,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(body), { status })),
    });

    await expect(provider.embed(['one', 'two'])).rejects.toMatchObject({
      code, failureScope: 'provider',
    });
  });

  it.each([
    ['Voyage format failure', VoyageEmbeddingProvider, {
      detail: 'Invalid input format: text exceeds maximum field width.',
    }],
    ['Voyage provider failure', VoyageEmbeddingProvider, {
      code: 'invalid_model_configuration',
      detail: 'The max allowed tokens per submitted batch is unavailable for this model.',
    }],
    ['OpenAI malformed request', OpenAIEmbeddingProvider, {
      error: {
        message: 'Malformed request: Requested 300001 tokens, max 300000 tokens per request',
        type: 'invalid_request_error', param: null, code: null,
      },
    }],
  ])('keeps the %s provider-wide', async (_name, Provider, body) => {
    const provider = new Provider({
      apiKey: '***', model: 'model', dim: 2,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(body), { status: 400 })),
    });

    await expect(provider.embed(['one', 'two'])).rejects.toMatchObject({
      code: 'EMBEDDING_FAILED', failureScope: 'provider',
    });
  });

  it('honors hosted per-request batch size while preserving result order', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({
        data: payload.input.map((text, index) => ({ index, embedding: [text.length, 0] })),
      }));
    });
    const provider = new OpenAIEmbeddingProvider({
      apiKey: '***', model: 'model', dim: 2, batchSize: 2, fetchImpl,
    });

    await expect(provider.embed(['a', 'bb', 'ccc'])).resolves.toEqual([
      [1, 0], [2, 0], [3, 0],
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not inspect an oversized error body for item attribution', async () => {
    const body = JSON.stringify({
      error: { code: 'context_length_exceeded', padding: 'x'.repeat(9_000) },
    });
    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'test-key', model: 'model', dim: 2,
      fetchImpl: vi.fn(async () => new Response(body, {
        status: 400,
        headers: { 'content-length': String(body.length) },
      })),
    });

    await expect(provider.embed(['one', 'two'])).rejects.toMatchObject({
      code: 'EMBEDDING_FAILED', failureScope: 'provider',
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
