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

describe('promotion recovery review', () => {
  for (const ack of ['failure', 'late-commit'] as const) {
    it(`reconciles a successful callback after ACK ${ack}, renewal failure and database recovery without replay`, async () => {
      let recovered = false;
      let delivered = false;
      let claimedFirst = false;
      let claimedSecond = false;
      const lateAck = Promise.withResolvers<boolean>();
      const callback = vi.fn(async () => undefined);
      const registry = new PromotionWebhookRegistry();
      registry.register({ id: 'alpha', onPromoted: callback });
      const store = persistence({
        claim: vi.fn(async () => {
          if (!claimedFirst) { claimedFirst = true; return [first]; }
          if (recovered && !claimedSecond) { claimedSecond = true; return [second]; }
          return [];
        }),
        complete: vi.fn(async (_pool, eventId) => {
          if (eventId === first.event.eventId && !recovered) {
            if (ack === 'failure') throw new Error('expected ACK failure');
            const committed = await lateAck.promise; delivered = committed; return committed;
          }
          if (eventId === first.event.eventId) delivered = true;
          return true;
        }),
        renew: vi.fn(async (_pool, _owner, claims) => {
          if (!recovered) throw new Error('expected renewal failure');
          return delivered ? { renewed: [], terminalOwned: [], lost: claims }
            : { renewed: claims, terminalOwned: [], lost: [] };
        }),
      });
      const worker = new Worker(pool, registry, settings(), store);
      try {
        const draining = worker.drainOnce();
        await vi.advanceTimersByTimeAsync(15);
        await draining;
        expect(callback).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(15);
        expect(store.renew).toHaveBeenCalledOnce();
        recovered = true;
        if (ack === 'late-commit') lateAck.resolve(true);
        await vi.advanceTimersByTimeAsync(120);
        await worker.drainOnce();
        expect(callback.mock.calls.filter(([event]) => event.eventId === first.event.eventId)).toHaveLength(1);
        expect(delivered).toBe(true);
        expect(claimedSecond).toBe(true);
        expect(callback.mock.calls.filter(([event]) => event.eventId === second.event.eventId)).toHaveLength(1);
      } finally {
        lateAck.resolve(true);
        const stopping = worker.stop('test-finished');
        await vi.advanceTimersByTimeAsync(20); await stopping;
      }
    });
  }

  it('never starts an earlier callback on a fence reclaimed while a later serial claim is delayed', async () => {
    const start = Date.now();
    let owner = 'recovery-review';
    let generation = 1;
    let expires = start + 90;
    let delivered = false;
    const later = Promise.withResolvers<ClaimedPromotionDelivery[]>();
    const staleStarts: string[] = [];
    const registry = new PromotionWebhookRegistry();
    registry.register({ id: 'alpha', onPromoted: async (event) => {
      if (owner !== 'recovery-review' || generation !== 1 || expires <= Date.now()) staleStarts.push(event.eventId);
    } });
    registry.register({ id: 'zeta', onPromoted: async () => undefined });
    const store = persistence({
      claim: vi.fn(async (_pool, input) => {
        if (input.webhookIds.includes('alpha')) {
          await new Promise((resolve) => setTimeout(resolve, 50)); return [first];
        }
        return later.promise;
      }),
      complete: vi.fn(async () => {
        if (owner !== 'recovery-review' || generation !== 1) return false;
        delivered = true; return true;
      }),
      renew: vi.fn(async (_pool, claimant, claims, leaseMs) => {
        if (claimant !== owner || generation !== 1 || delivered) return { renewed: [], terminalOwned: [], lost: claims };
        expires = Date.now() + leaseMs; return { renewed: claims, terminalOwned: [], lost: [] };
      }),
    });
    const worker = new Worker(pool, registry, settings({ databaseTimeoutMs: 60 }), store);
    try {
      const draining = worker.drainOnce();
      await vi.advanceTimersByTimeAsync(95);
      expect(store.claim).toHaveBeenCalledTimes(2);
      // A different process can reclaim an expired, incomplete durable lease.
      if (!delivered && expires <= Date.now()) { owner = 'replica'; generation = 2; }
      later.resolve([]);
      await draining;
      expect(staleStarts).toEqual([]);
    } finally {
      later.resolve([]); const stopping = worker.stop('test-finished');
      await vi.advanceTimersByTimeAsync(20); await stopping;
    }
  });
});
