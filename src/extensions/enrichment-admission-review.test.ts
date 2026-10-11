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
    expect(output === input).toBe(true);
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
  it('skips oversized optional input before cloning while preserving the core result', async () => {
    const registry = new RetrievalEnricherRegistry();
    const enrich = vi.fn(async () => [{ extra: true }]);
    registry.register({ id: 'oversized-input', enrich });
    const input = [result()]; input[0].memory.body = 'x'.repeat(2 * 1024 * 1024);
    const cloning = vi.spyOn(globalThis, 'structuredClone');
    const warn = vi.fn();
    try {
      const output = await applyRetrievalEnrichers(input, input[0].memory.authorId, registry,
        { timeoutMs: 5, maxBytes: 1024, logger: { warn } });
      expect(output === input).toBe(true);
      expect(enrich).not.toHaveBeenCalled();
      expect(cloning.mock.calls.some((args) => args[0] === input)).toBe(false);
      expect(warn).toHaveBeenCalledWith({ event: 'retrieval_enricher_failed', enricherId: 'oversized-input', reason: 'oversized_input' });
    } finally { cloning.mockRestore(); }
  });

  it('bounds retained snapshot body bytes across distinct timed-out calls and releases on settlement', async () => {
    const done = Promise.withResolvers<readonly { extra: boolean }[]>();
    let retainedBodyBytes = 0;
    let peakBodyBytes = 0;
    try {
      for (let id = 0; id < 24; id += 1) {
        const registry = new RetrievalEnricherRegistry();
        registry.register({ id: `byte-budget-${id}`, enrich: async (input) => {
          const bodyBytes = input[0].memory.body.length * 2;
          retainedBodyBytes += bodyBytes; peakBodyBytes = Math.max(peakBodyBytes, retainedBodyBytes);
          try { return await done.promise; } finally { retainedBodyBytes -= bodyBytes; }
        } });
        const input = [result()]; input[0].memory.body = 'x'.repeat(384 * 1024);
        const pending = applyRetrievalEnrichers(input, input[0].memory.authorId, registry,
          { timeoutMs: 5, maxBytes: 1024, logger: { warn: vi.fn() } });
        await vi.advanceTimersByTimeAsync(5); expect(await pending).toBe(input);
      }
      expect(peakBodyBytes).toBeGreaterThan(0);
      expect(peakBodyBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    } finally { done.resolve([{ extra: true }]); await vi.advanceTimersByTimeAsync(0); }
    expect(retainedBodyBytes).toBe(0);
    const registry = new RetrievalEnricherRegistry();
    const enrich = vi.fn(async () => [{ restored: true }]);
    registry.register({ id: 'after-byte-release', enrich });
    const input = [result()]; input[0].memory.body = 'x'.repeat(384 * 1024);
    expect((await applyRetrievalEnrichers(input, input[0].memory.authorId, registry,
      { timeoutMs: 5, maxBytes: 1024, logger: { warn: vi.fn() } }))[0].enrichments?.['after-byte-release']).toEqual({ restored: true });
    expect(enrich).toHaveBeenCalledOnce();
  });

});
