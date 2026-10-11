import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecallResult } from '../types.js';
import { applyRetrievalEnrichers, RetrievalEnricherRegistry } from './retrieval.js';
const result = (): RecallResult => ({ memory: {
  id: '11111111-1111-4111-8111-111111111111', scopeId: '22222222-2222-4222-8222-222222222222',
  authorId: '33333333-3333-4333-8333-333333333333', type: 'fact', title: 'Resource review', body: 'Authorized body',
  metadata: {}, tags: [], source: 'manual', sourceRef: null, state: 'live', supersedesId: null, promotedToId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), expiresAt: null, lastVerified: null },
  score: 0.5, excerpt: 'Authorized body', bodyTruncated: false });
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('enrichment admission review', () => {
  it('does not invoke an already aborted optional enricher', async () => {
    const registry = new RetrievalEnricherRegistry();
    const enrich = vi.fn(async () => [{ extra: true }]);
    registry.register({ id: 'pre-aborted', enrich });
    const controller = new AbortController(); controller.abort();
    const input = [result()];
    const output = await applyRetrievalEnrichers(input, input[0].memory.authorId, registry,
      { timeoutMs: 5, maxBytes: 1024, signal: controller.signal, logger: { warn: vi.fn() } });
    expect(output).toBe(input);
    expect(enrich).not.toHaveBeenCalled();
  });

  it('retains one hung enricher fence across bounded requests while another ID remains healthy', async () => {
    const done = Promise.withResolvers<readonly { extra: boolean }[]>();
    const registry = new RetrievalEnricherRegistry();
    const hung = vi.fn(() => done.promise);
    const healthy = vi.fn(async () => [{ extra: true }]);
    const warn = vi.fn();
    registry.register({ id: 'hung-resource', enrich: hung });
    registry.register({ id: 'healthy-resource', enrich: healthy });
    try {
      for (let request = 0; request < 20; request += 1) {
        const input = [result()];
        const pending = applyRetrievalEnrichers(input, input[0].memory.authorId, registry,
          { timeoutMs: 5, maxBytes: 1024, logger: { warn } });
        await vi.advanceTimersByTimeAsync(5);
        const output = await pending;
        expect(output[0].enrichments?.['healthy-resource']).toEqual({ extra: true });
        expect(output[0].enrichments?.['hung-resource']).toBeUndefined();
      }
      expect(hung).toHaveBeenCalledOnce();
      expect(healthy).toHaveBeenCalledTimes(20);
      expect(warn).toHaveBeenCalledWith({ event: 'retrieval_enricher_failed', enricherId: 'hung-resource', reason: 'saturated' });
    } finally { done.resolve([{ extra: true }]); await vi.advanceTimersByTimeAsync(0); }
    const input = [result()];
    const output = await applyRetrievalEnrichers(input, input[0].memory.authorId, registry,
      { timeoutMs: 5, maxBytes: 1024, logger: { warn } });
    expect(hung).toHaveBeenCalledTimes(2);
    expect(output[0].enrichments?.['hung-resource']).toEqual({ extra: true });
  });

  it('bounds detached optional calls across distinct registry IDs until their actual settlement', async () => {
    const done = Promise.withResolvers<readonly { extra: boolean }[]>();
    let outstanding = 0;
    let peak = 0;
    try {
      for (let id = 0; id < 48; id += 1) {
        const registry = new RetrievalEnricherRegistry();
        registry.register({ id: `distinct-${id}`, enrich: async () => {
          outstanding += 1; peak = Math.max(peak, outstanding);
          try { return await done.promise; } finally { outstanding -= 1; }
        } });
        const input = [result()];
        const pending = applyRetrievalEnrichers(input, input[0].memory.authorId, registry,
          { timeoutMs: 5, maxBytes: 1024, logger: { warn: vi.fn() } });
        await vi.advanceTimersByTimeAsync(5); expect(await pending).toBe(input);
      }
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(16);
    } finally { done.resolve([{ extra: true }]); await vi.advanceTimersByTimeAsync(0); }
    expect(outstanding).toBe(0);
  });
});
