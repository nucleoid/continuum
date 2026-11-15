import { describe, expect, it } from 'vitest';
import { EmbeddingItemError, EmbeddingProviderError, embeddingProviderHttpError } from './provider.js';
import { classifyEmbeddingFailure, embeddingBackoffMs, embeddingCircuitFailure, embeddingRetryAfterMs } from './failure-policy.js';

describe('embedding failure policy', () => {
  it.each([400, 413, 422, 500])('keeps bare HTTP %i provider-wide', async status => {
    const error = await embeddingProviderHttpError(new Response('{}', { status }), 'openai');
    expect(classifyEmbeddingFailure(error).action).toBe('retry');
  });
  it('requires the explicit item type and never retains private messages', () => {
    expect(classifyEmbeddingFailure(new EmbeddingItemError('private input'))).toEqual({ code: 'EMBEDDING_ITEM_FAILED', action: 'isolate_item' });
    expect(classifyEmbeddingFailure({ failureScope: 'item', code: 'EMBEDDING_ITEM_FAILED', message: 'private' }).action).toBe('retry');
    expect(JSON.stringify(classifyEmbeddingFailure(new Error('private provider secret')))).not.toContain('private');
  });
  it('parks auth independently of retryable outages and malformed output', () => {
    expect(classifyEmbeddingFailure(new EmbeddingProviderError('EMBEDDING_AUTH', 'secret')).action).toBe('park_provider');
    expect(classifyEmbeddingFailure(new EmbeddingProviderError('EMBEDDING_INVALID_RESPONSE', 'secret')).action).toBe('retry');
  });
  it('parks explicit configuration failure without retaining response text', async () => {
    const error = await embeddingProviderHttpError(new Response(JSON.stringify({ error: { code:'invalid_model', message:'private model details' } }),
      { status:400, headers:{'retry-after':'2'} }), 'openai');
    expect(classifyEmbeddingFailure(error)).toEqual({ code:'EMBEDDING_FAILED', action:'park_provider', retryAfterMs:2000 });
    expect(JSON.stringify(classifyEmbeddingFailure(error))).not.toContain('private');
  });
  it('parses numeric/date Retry-After and bounds invalid/extreme/past values', () => {
    const now = Date.parse('2026-11-15T00:00:00Z');
    expect(embeddingRetryAfterMs('2', now)).toBe(2000);
    expect(embeddingRetryAfterMs('Sun, 15 Nov 2026 00:00:20 GMT', now)).toBe(20_000);
    expect(embeddingRetryAfterMs('0', now)).toBe(1000);
    expect(embeddingRetryAfterMs('9'.repeat(100), now)).toBe(300_000);
    expect(embeddingRetryAfterMs('Sat, 14 Nov 2026 00:00:00 GMT', now)).toBe(1000);
    for (const value of ['-1', '1.5', '2026-11-15', 'secret', 'Sun, 99 Nov 2026 00:00:00 GMT', '2\nsecret']) {
      expect(embeddingRetryAfterMs(value, now)).toBeUndefined();
    }
  });
  it('keeps retry delay finite without a lifetime outage cutoff or hot loop', () => {
    expect(embeddingBackoffMs(1, 0)).toBe(1000);
    expect(embeddingBackoffMs(5, 0)).toBe(8000);
    expect(embeddingBackoffMs(Number.MAX_SAFE_INTEGER, 0.99)).toBeLessThanOrEqual(300_000);
    expect(embeddingBackoffMs(2, 0, 60_000)).toBe(60_000);
    expect(() => embeddingBackoffMs(0, 0)).toThrow();
    expect(() => embeddingBackoffMs(1, 1)).toThrow();
  });
  it('retains provider parking until an operator/config recovery changes it', () => {
    const prior = { state: 'parked' as const, failures: 2, nextProbeAtMs: 1000 };
    expect(embeddingCircuitFailure(prior, { code: 'EMBEDDING_NETWORK', action: 'retry' }, 2000, 0).state).toBe('parked');
    expect(embeddingCircuitFailure({ ...prior, state: 'half_open' }, { code: 'EMBEDDING_SERVER', action: 'retry' }, 2000, 0))
      .toEqual({ state: 'open', failures: 3, nextProbeAtMs: 4000 });
  });
});
