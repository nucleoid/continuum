import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromotionWebhookRegistry } from '../extensions/promotion.js';
import type { ClaimedPromotionDelivery } from '../storage/promotion-events.js';
import type { PromotionWorkerOptions, PromotionWorkerStore } from './promotion-events.js';

let Worker: typeof import('./promotion-events.js').PromotionEventWorker;
const pool = new pg.Pool({ max: 1 });
const first: ClaimedPromotionDelivery = { event: {
  eventId: '00000000-0000-4000-8000-000000000001', sourceId: '00000000-0000-4000-8000-000000000002',
  destinationId: '00000000-0000-4000-8000-000000000003', destinationScopeId: '00000000-0000-4000-8000-000000000004',
  destinationScope: { kind: 'project', name: 'reference' }, principalId: '00000000-0000-4000-8000-000000000005',
  occurredAt: new Date('2026-01-01T00:00:00Z') }, webhookId: 'alpha', attemptCount: 1, leaseGeneration: 1, leaseRecovered: false };
const second = { ...first, event: { ...first.event, eventId: '00000000-0000-4000-8000-000000000006' } };
const settings = (extra: Partial<PromotionWorkerOptions> = {}): PromotionWorkerOptions => ({
  owner: 'recovery-review', pollMs: 100, claimBatch: 1, leaseMs: 90, callbackTimeoutMs: 50,
  databaseTimeoutMs: 15, shutdownWaitMs: 10, maxAttempts: 3, baseBackoffMs: 5, maxBackoffMs: 100,
  random: () => 0.5, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, ...extra,
});
const persistence = (extra: Partial<PromotionWorkerStore>): PromotionWorkerStore => ({
  claim: vi.fn().mockResolvedValue([]), complete: vi.fn().mockResolvedValue(true),
  abandon: vi.fn().mockResolvedValue(0), fail: vi.fn().mockResolvedValue('pending'), timeout: vi.fn().mockResolvedValue('pending'),
  renew: vi.fn().mockResolvedValue(0), release: vi.fn().mockResolvedValue(0), ...extra,
});
beforeEach(async () => {
  vi.resetModules(); ({ PromotionEventWorker: Worker } = await import('./promotion-events.js'));
  vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
});
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => { await pool.end(); });

describe('promotion renewal timing review', () => {
  it('retries a hung renewal before the last committed lease expires', async () => {
    const start = Date.now();
    const hung = Promise.withResolvers<number>();
    const callbackDone = Promise.withResolvers<void>();
    const registry = new PromotionWebhookRegistry();
    registry.register({ id: 'alpha', onPromoted: () => callbackDone.promise });
    let claimed = false;
    let expires = start + 120;
    const issued: number[] = [];
    const store = persistence({
      claim: vi.fn(async () => { if (claimed) return []; claimed = true; return [first]; }),
      renew: vi.fn(async (_pool, _owner, claims, leaseMs) => {
        issued.push(Date.now());
        if (issued.length === 1) return hung.promise;
        if (Date.now() >= expires) return { renewed: [], terminalOwned: [], lost: claims };
        expires = Date.now() + leaseMs;
        return { renewed: claims, terminalOwned: [], lost: [] };
      }),
    });
    const worker = new Worker(pool, registry, settings({ leaseMs: 120, callbackTimeoutMs: 100 }), store);
    let draining: Promise<number> | undefined;
    try {
      draining = worker.drainOnce();
      await vi.advanceTimersByTimeAsync(119);
      expect(issued[0]).toBe(start + 40);
      expect(issued.filter((time) => time < start + 120).length).toBeGreaterThan(1);
      expect(expires).toBeGreaterThan(start + 120);
    } finally {
      hung.resolve(0); callbackDone.resolve();
      await vi.advanceTimersByTimeAsync(1); if (draining) await draining;
      const stopping = worker.stop('test-finished'); await vi.advanceTimersByTimeAsync(20); await stopping;
    }
  });

  for (const stale of ['lost', 'terminalOwned', 'renewed'] as const) {
    it(`ignores old ${stale} renewal results after the same key starts a newer exact fence`, async () => {
      const oldResult = Promise.withResolvers<{ renewed: ClaimedPromotionDelivery[];
        terminalOwned: ClaimedPromotionDelivery[]; lost: ClaimedPromotionDelivery[] }>();
      const oldCallback = Promise.withResolvers<void>();
      const newCallback = Promise.withResolvers<void>();
      const newer = { ...first, attemptCount: 2, leaseGeneration: 2 };
      const signals: AbortSignal[] = [];
      const registry = new PromotionWebhookRegistry();
      registry.register({ id: 'alpha', onPromoted: (_event, context) => {
        signals.push(context.signal); return signals.length === 1 ? oldCallback.promise : newCallback.promise;
      } });
      let claims = 0;
      let renewals = 0;
      let acknowledgements = 0;
      let delivered = false;
      const store = persistence({
        claim: vi.fn(async () => { claims += 1; return claims === 1 ? [first] : claims === 2 ? [newer] : []; }),
        renew: vi.fn(async (_pool, _owner, deliveries) => {
          renewals += 1; if (renewals === 1) return oldResult.promise;
          return { renewed: deliveries, terminalOwned: [], lost: [] };
        }),
        complete: vi.fn(async (_pool, _eventId, _hookId, _owner, attempt, generation) => {
          if (stale === 'renewed') {
            if (attempt !== 2 || generation !== 2) return false;
            acknowledgements += 1;
            if (acknowledgements === 1) throw new Error('expected newer ACK uncertainty');
            delivered = true;
          }
          return true;
        }),
      });
      const worker = new Worker(pool, registry, settings({ leaseMs: 300, callbackTimeoutMs: 200,
        databaseTimeoutMs: 90 }), store);
      let firstDrain: Promise<number> | undefined;
      let secondDrain: Promise<number> | undefined;
      try {
        firstDrain = worker.drainOnce();
        await vi.advanceTimersByTimeAsync(110);
        expect(store.renew).toHaveBeenCalledOnce();
        oldCallback.reject(new Error('actual first callback failure'));
        await vi.advanceTimersByTimeAsync(1); await firstDrain;
        expect(store.fail).toHaveBeenCalledOnce();
        secondDrain = worker.drainOnce(); await vi.advanceTimersByTimeAsync(1);
        expect(signals).toHaveLength(2);
        if (stale === 'renewed') {
          newCallback.resolve(); await vi.advanceTimersByTimeAsync(1);
          expect(store.complete).toHaveBeenCalledOnce();
        }
        oldResult.resolve({ renewed: stale === 'renewed' ? [first] : [], terminalOwned: stale === 'terminalOwned' ? [first] : [],
          lost: stale === 'lost' ? [first] : [] });
        await vi.advanceTimersByTimeAsync(1);
        expect(signals[1].aborted).toBe(false);
        if (stale === 'renewed') expect(vi.mocked(store.complete).mock.calls.every((call) =>
          call[4] === 2 && call[5] === 2)).toBe(true);
        await vi.advanceTimersByTimeAsync(110);
        expect(vi.mocked(store.renew).mock.calls.some((call) => call[2].some((delivery) =>
          delivery.attemptCount === 2 && delivery.leaseGeneration === 2))).toBe(true);
        expect(store.fail).toHaveBeenCalledOnce();
        if (stale === 'renewed') expect(delivered).toBe(true);
      } finally {
        oldResult.resolve({ renewed: [], terminalOwned: [], lost: [] });
        oldCallback.resolve(); newCallback.resolve();
        await vi.advanceTimersByTimeAsync(1);
        if (firstDrain) await firstDrain; if (secondDrain) await secondDrain;
        const stopping = worker.stop('test-finished'); await vi.advanceTimersByTimeAsync(20); await stopping;
      }
    });
  }

  it('persists charged failure and backoff when a callback rejects after its timeout write failed', async () => {
    const callbackDone = Promise.withResolvers<void>();
    const registry = new PromotionWebhookRegistry();
    registry.register({ id: 'alpha', onPromoted: () => callbackDone.promise });
    let claimed = false;
    const store = persistence({
      claim: vi.fn(async () => { if (claimed) return []; claimed = true; return [first]; }),
      timeout: vi.fn().mockRejectedValue(new Error('expected timeout write failure')),
      renew: vi.fn(async (_pool, _owner, claims) => ({ renewed: claims, terminalOwned: [], lost: [] })),
    });
    const worker = new Worker(pool, registry, settings({ callbackTimeoutMs: 20 }), store);
    try {
      const result = worker.drainOnce().then(() => undefined, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(21);
      expect(await result).toBeInstanceOf(Error);
      expect(store.timeout).toHaveBeenCalledOnce();
      callbackDone.reject(new Error('actual late callback failure'));
      await vi.advanceTimersByTimeAsync(1);
      expect(store.fail).toHaveBeenCalledOnce();
      expect(store.fail).toHaveBeenCalledWith(pool, first.event.eventId, 'alpha', 'recovery-review',
        expect.objectContaining({ attemptCount: 1, leaseGeneration: 1, retryDelayMs: 5 }));
      expect(store.abandon).not.toHaveBeenCalled();
    } finally {
      callbackDone.resolve(); await vi.advanceTimersByTimeAsync(1);
      const stopping = worker.stop('test-finished'); await vi.advanceTimersByTimeAsync(20); await stopping;
    }
  });
});
