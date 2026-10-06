import { describe, expect, it, vi } from 'vitest';
import type { RecallResult } from '../types.js';
import {
  RetrievalEnricherRegistry,
  applyRetrievalEnrichers,
  enrichmentConfigFromEnv,
} from './retrieval.js';

function result(title = 'Original'): RecallResult {
  return {
    memory: {
      id: '11111111-1111-4111-8111-111111111111',
      scopeId: '22222222-2222-4222-8222-222222222222',
      type: 'fact', title, body: 'body', metadata: {}, tags: [],
      authorId: '33333333-3333-4333-8333-333333333333', source: 'manual',
      sourceRef: null, state: 'live', supersedesId: null, promotedToId: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'), expiresAt: null,
      lastVerified: null,
    },
    score: 0.75,
    excerpt: 'body',
  };
}

describe('extension registries', () => {
  it('validates unique IDs and returns extensions in deterministic order', () => {
    const registry = new RetrievalEnricherRegistry();
    const zeta = { id: 'zeta', enrich: vi.fn() };
    const alpha = { id: 'alpha.v1', enrich: vi.fn() };
    registry.register(zeta);
    registry.register(alpha);
    expect(registry.ids()).toEqual(['alpha.v1', 'zeta']);
    expect(registry.all()).toEqual([alpha, zeta]);
    expect(() => registry.register({ ...alpha })).toThrow(/duplicate.*alpha\.v1/i);
    expect(() => registry.register({ id: '../bad', enrich: vi.fn() })).toThrow(/invalid extension id/i);
  });
});

describe('applyRetrievalEnrichers', () => {
  it('runs concurrently, attaches output by sorted namespace, and cannot mutate core results', async () => {
    const registry = new RetrievalEnricherRegistry();
    registry.register({
      id: 'zeta',
      async enrich(results) {
        expect(Object.isFrozen(results)).toBe(true);
        expect(Object.isFrozen(results[0].memory)).toBe(true);
        expect(() => {
          (results[0].memory as { title: string }).title = 'corrupt';
        }).toThrow();
        return [{ linked: 2 }];
      },
    });
    registry.register({ id: 'alpha', enrich: async () => [{ linked: 1 }] });
    const original = result();

    const enriched = await applyRetrievalEnrichers([original], 'principal', registry, {
      timeoutMs: 100, maxBytes: 1024,
    });

    expect(original.memory.title).toBe('Original');
    expect(enriched[0].memory.title).toBe('Original');
    expect(enriched[0].enrichments).toEqual({ alpha: { linked: 1 }, zeta: { linked: 2 } });
    expect(Object.keys(enriched[0].enrichments!)).toEqual(['alpha', 'zeta']);
  });

  it('uses one strict global deadline, signals abort, fails open, and sanitizes logs', async () => {
    vi.useFakeTimers();
    try {
      const registry = new RetrievalEnricherRegistry();
      const aborted: string[] = [];
      for (const id of ['first', 'second']) {
        registry.register({
          id,
          enrich: (_results, { signal }) => new Promise((resolve) => {
            signal.addEventListener('abort', () => { aborted.push(id); resolve([{ late: true }]); });
          }),
        });
      }
      registry.register({
        id: 'throws',
        enrich: async () => { throw new Error('token=super-secret https://user:pass@example.test/path'); },
      });
      const logger = { warn: vi.fn() };
      const pending = applyRetrievalEnrichers([result()], 'principal', registry, {
        timeoutMs: 25, maxBytes: 1024, logger,
      });
      await vi.advanceTimersByTimeAsync(25);

      await expect(pending).resolves.toEqual([result()]);
      expect(aborted.sort()).toEqual(['first', 'second']);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
        event: 'retrieval_enricher_failed', enricherId: 'throws', reason: 'error',
      }));
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('super-secret');
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('user:pass');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['oversized', () => [{ text: 'x'.repeat(200) }]],
    ['circular', () => { const value: any = {}; value.self = value; return [value]; }],
    ['function', () => [{ bad: () => undefined }]],
    ['prototype', () => [new (class Output { value = 1; })()]],
    ['non-finite', () => [{ value: Number.POSITIVE_INFINITY }]],
  ])('rejects %s output and preserves the base response', async (_name, makeOutput) => {
    const registry = new RetrievalEnricherRegistry();
    registry.register({ id: 'unsafe', enrich: async () => makeOutput() });
    const logger = { warn: vi.fn() };
    const base = result();
    await expect(applyRetrievalEnrichers([base], 'principal', registry, {
      timeoutMs: 100, maxBytes: 64, logger,
    })).resolves.toEqual([base]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'retrieval_enricher_failed', enricherId: 'unsafe', reason: 'invalid_output',
    }));
  });

  it('is byte-shape compatible when the registry is empty', async () => {
    const base = [result()];
    const output = await applyRetrievalEnrichers(
      base, 'principal', new RetrievalEnricherRegistry(), { timeoutMs: 100, maxBytes: 1024 },
    );
    expect(output).toBe(base);
    expect(JSON.stringify(output)).toBe(JSON.stringify(base));
  });

  it('enforces one combined serialized output budget in deterministic ID order', async () => {
    const registry = new RetrievalEnricherRegistry();
    registry.register({ id: 'zeta', enrich: async () => [{ value: 'z'.repeat(30) }] });
    registry.register({ id: 'alpha', enrich: async () => [{ value: 'a'.repeat(30) }] });
    const logger = { warn: vi.fn() };
    const output = await applyRetrievalEnrichers([result()], 'principal', registry, {
      timeoutMs: 100, maxBytes: 70, logger,
    });
    expect(output[0].enrichments).toEqual({ alpha: { value: 'a'.repeat(30) } });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      enricherId: 'zeta', reason: 'invalid_output',
    }));
  });

  it('remains fail open if the operational logger itself throws', async () => {
    const registry = new RetrievalEnricherRegistry();
    registry.register({ id: 'bad', enrich: async () => { throw new Error('private'); } });
    const base = [result()];
    await expect(applyRetrievalEnrichers(base, 'principal', registry, {
      timeoutMs: 100,
      maxBytes: 1024,
      logger: { warn: () => { throw new Error('logger unavailable'); } },
    })).resolves.toBe(base);
  });

  it('signals active enrichers and fails open during runtime shutdown', async () => {
    const shutdown = new AbortController();
    const registry = new RetrievalEnricherRegistry();
    const entered = Promise.withResolvers<void>();
    registry.register({
      id: 'active',
      enrich: (_results, { signal }) => new Promise((resolve) => {
        entered.resolve();
        signal.addEventListener('abort', () => resolve([{ tooLate: true }]));
      }),
    });
    const logger = { warn: vi.fn() };
    const base = [result()];
    const pending = applyRetrievalEnrichers(base, 'principal', registry, {
      timeoutMs: 1000, maxBytes: 1024, logger, signal: shutdown.signal,
    });
    await entered.promise;
    shutdown.abort();

    await expect(pending).resolves.toBe(base);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'retrieval_enricher_failed', enricherId: 'active', reason: 'aborted',
    }));
  });

  it('loads a bounded timeout from the environment', () => {
    expect(enrichmentConfigFromEnv({})).toMatchObject({ timeoutMs: 250 });
    expect(enrichmentConfigFromEnv({ CONTINUUM_ENRICHER_TIMEOUT_MS: '50' }).timeoutMs).toBe(50);
    expect(() => enrichmentConfigFromEnv({ CONTINUUM_ENRICHER_TIMEOUT_MS: '0' })).toThrow(/between/);
    expect(() => enrichmentConfigFromEnv({ CONTINUUM_ENRICHER_TIMEOUT_MS: '5001' })).toThrow(/between/);
  });
});
