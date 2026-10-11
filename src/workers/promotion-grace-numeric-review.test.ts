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

describe('promotion grace and numeric recovery review', () => {
  it('retries uncertain renewal throughout finite shutdown grace without new callbacks or timers afterward', async () => {
    const start = Date.now();
    const callbackDone = Promise.withResolvers<void>();
    const slowClaim = Promise.withResolvers<ClaimedPromotionDelivery[]>();
    const registry = new PromotionWebhookRegistry();
    const callback = vi.fn(() => callbackDone.promise);
    registry.register({ id: 'alpha', onPromoted: callback });
    registry.register({ id: 'zeta', onPromoted: vi.fn(async () => undefined) });
    let phase = 'initial'; let claimed = false; let expires = start + 90;
    const store = persistence({
      claim: vi.fn(async (_pool, input) => {
        if (phase === 'later' && input.webhookIds.includes('zeta')) return slowClaim.promise;
        if (!claimed && input.webhookIds.includes('alpha')) { claimed = true; return [first]; }
        return [];
      }),
      renew: vi.fn(async (_pool, _owner, deliveries, leaseMs) => {
        if (vi.mocked(store.renew).mock.calls.length === 1) throw new Error('expected one grace renewal failure');
        expires = Date.now() + leaseMs; return { renewed: deliveries, terminalOwned: [], lost: [] };
      }),
    });
    const worker = new Worker(pool, registry, settings({ leaseMs: 90, callbackTimeoutMs: 80,
      databaseTimeoutMs: 89, shutdownWaitMs: 89 }), store);
    let initial: Promise<number> | undefined; let later: Promise<number> | undefined;
    let stopping: Promise<void> | undefined; let stopSettled = false;
    try {
      initial = worker.drainOnce(); await vi.advanceTimersByTimeAsync(25);
      expect(callback).toHaveBeenCalledOnce();
      phase = 'later'; later = worker.drainOnce(); await vi.advanceTimersByTimeAsync(4);
      stopping = worker.stop('grace-test').then(() => { stopSettled = true; });
      await vi.advanceTimersByTimeAsync(66);
      expect(stopSettled).toBe(false);
      expect(vi.mocked(store.renew).mock.calls.length).toBeGreaterThan(1);
      expect(expires).toBeGreaterThan(Date.now());
      slowClaim.resolve([]); await vi.advanceTimersByTimeAsync(1);
      await stopping;
      const renewals = vi.mocked(store.renew).mock.calls.length;
      await vi.advanceTimersByTimeAsync(120);
      expect(store.renew).toHaveBeenCalledTimes(renewals);
      expect(callback).toHaveBeenCalledOnce();
    } finally {
      slowClaim.resolve([]); callbackDone.resolve(); await vi.advanceTimersByTimeAsync(1);
      if (initial) await initial; if (later) await later;
      stopping ??= worker.stop('test-finished'); await vi.advanceTimersByTimeAsync(100); await stopping;
    }
  });

  it('reconciles a paid pending ACK after a short legacy numeric renewal count without replay or a stranded fence', async () => {
    let claimed = false; let recovered = false; let delivered = false;
    const registry = new PromotionWebhookRegistry(); const callback = vi.fn(async () => undefined);
    registry.register({ id: 'alpha', onPromoted: callback });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const store = persistence({
      claim: vi.fn(async () => { if (claimed) return []; claimed = true; return [first]; }),
      complete: vi.fn(async () => { if (!recovered) throw new Error('expected ACK response failure'); delivered = true; return true; }),
      renew: vi.fn().mockResolvedValue(0),
    });
    const worker = new Worker(pool, registry, settings({ logger }), store);
    try {
      await worker.drainOnce(); expect(callback).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(31); expect(store.renew).toHaveBeenCalledOnce();
      recovered = true; await vi.advanceTimersByTimeAsync(60);
      expect(delivered).toBe(true);
      await worker.drainOnce();
      expect(callback).toHaveBeenCalledOnce();
      expect(store.abandon).not.toHaveBeenCalled();
      // No pending-ACK fence remains in the process-wide occupied slot signal.
      expect(logger.info.mock.calls.some(([event]) => event.event === 'promotion_worker_capacity'
        && event.processInFlight === 0 && event.retainedFences === 0)).toBe(true);
    } finally {
      recovered = true; const stopping = worker.stop('test-finished');
      await vi.advanceTimersByTimeAsync(20); await stopping;
    }
  });
});
