import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromotionWebhookRegistry } from '../extensions/promotion.js';
import type { ClaimedPromotionDelivery } from '../storage/promotion-events.js';
import type { PromotionWorkerOptions, PromotionWorkerStore } from './promotion-events.js';

let Worker: typeof import('./promotion-events.js').PromotionEventWorker;
const pool = new pg.Pool({ max: 1 });
const delivery = (hook: string): ClaimedPromotionDelivery => ({
  event: { eventId: '00000000-0000-4000-8000-000000000001',
    sourceId: '00000000-0000-4000-8000-000000000002',
    destinationId: '00000000-0000-4000-8000-000000000003',
    destinationScopeId: '00000000-0000-4000-8000-000000000004',
    destinationScope: { kind: 'project', name: 'reference' },
    principalId: '00000000-0000-4000-8000-000000000005', occurredAt: new Date() },
  webhookId: hook, attemptCount: 1, leaseGeneration: 1, leaseRecovered: false,
});
const options = (extra: Partial<PromotionWorkerOptions> = {}): PromotionWorkerOptions => ({
  owner: 'admission-review', pollMs: 100, claimBatch: 1, leaseMs: 300,
  callbackTimeoutMs: 100, databaseTimeoutMs: 30, shutdownWaitMs: 50,
  maxAttempts: 1, baseBackoffMs: 10, maxBackoffMs: 100, random: () => 0.5,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, ...extra,
});
const store = (extra: Partial<PromotionWorkerStore> = {}): PromotionWorkerStore => ({
  claim: vi.fn().mockResolvedValue([]), complete: vi.fn().mockResolvedValue(true),
  abandon: vi.fn().mockResolvedValue(0), fail: vi.fn().mockResolvedValue('pending'),
  timeout: vi.fn().mockResolvedValue('pending'), renew: vi.fn().mockResolvedValue(0),
  release: vi.fn().mockResolvedValue(0), ...extra,
});

beforeEach(async () => {
  vi.resetModules();
  ({ PromotionEventWorker: Worker } = await import('./promotion-events.js'));
});
afterEach(() => { vi.useRealTimers(); });

describe('promotion admission review', () => {
  it('reaches a backlogged final ID among 101 permitted registry IDs across bounded drains', async () => {
    const registry = new PromotionWebhookRegistry();
    const callback = vi.fn(async () => undefined);
    for (let i = 0; i < 101; i += 1) registry.register({ id: `hook${String(i).padStart(3, '0')}`, onPromoted: callback });
    let claimed = false;
    const persistence = store({ claim: vi.fn(async (_pool, input) => {
      if (!claimed && input.webhookIds.includes('hook100')) { claimed = true; return [delivery('hook100')]; }
      return [];
    }) });
    const worker = new Worker(pool, registry, options(), persistence);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) await worker.drainOnce();
      expect(callback).toHaveBeenCalledOnce();
      expect(persistence.complete).toHaveBeenCalledOnce();
    } finally { await worker.stop('test-finished'); }
  });

  for (const failure of ['error', 'timeout'] as const) {
    it(`preserves unstarted first-hook attempts when a later claim ends in ${failure}`, async () => {
      vi.useFakeTimers();
      let charged = 0;
      let started = false;
      const laterClaim = Promise.withResolvers<ClaimedPromotionDelivery[]>();
      const registry = new PromotionWebhookRegistry();
      registry.register({ id: 'alpha', onPromoted: async () => { started = true; } });
      registry.register({ id: 'zeta', onPromoted: async () => undefined });
      const persistence = store({
        claim: vi.fn(async (_pool, input) => {
          if (input.webhookIds.includes('alpha')) { charged += 1; return [delivery('alpha')]; }
          if (failure === 'error') throw new Error('expected later claim failure');
          return laterClaim.promise;
        }),
        abandon: vi.fn(async (_pool, owner, claims) => {
          for (const claim of claims) if (owner === 'admission-review' && claim.webhookId === 'alpha'
            && claim.attemptCount === 1 && claim.leaseGeneration === 1) charged -= 1;
          return claims.length;
        }),
      });
      const worker = new Worker(pool, registry, options(), persistence);
      try {
        const outcome = worker.drainOnce().then(() => undefined, (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(30);
        expect(await outcome).toBeInstanceOf(Error);
        // Processing a valid sibling or refunding an unstarted exact claim are
        // both safe; charging an invocation that never happened is not.
        expect(started ? 0 : charged).toBe(0);
      } finally {
        laterClaim.resolve([]);
        const stopping = worker.stop('test-finished');
        await vi.advanceTimersByTimeAsync(50);
        await stopping;
      }
    });
  }

  it('refunds a not-started sibling when an earlier synchronous callback initiates stop', async () => {
    const attempts = new Map([['alpha', 0], ['zeta', 0]]);
    const registry = new PromotionWebhookRegistry();
    let worker: InstanceType<typeof Worker>;
    let stopping: Promise<void> | undefined;
    registry.register({ id: 'alpha', onPromoted: () => { stopping = worker.stop('callback-stop'); return Promise.resolve(); } });
    const sibling = vi.fn(async () => undefined);
    registry.register({ id: 'zeta', onPromoted: sibling });
    const persistence = store({
      claim: vi.fn(async (_pool, input) => {
        const hook = input.webhookIds[0]; attempts.set(hook, 1); return [delivery(hook)];
      }),
      abandon: vi.fn(async (_pool, owner, claims) => {
        for (const claim of claims) if (owner === 'admission-review' && claim.attemptCount === 1 && claim.leaseGeneration === 1)
          attempts.set(claim.webhookId, 0);
        return claims.length;
      }),
    });
    worker = new Worker(pool, registry, options(), persistence);
    try {
      await worker.drainOnce();
      await stopping;
      expect(sibling).not.toHaveBeenCalled();
      expect(attempts.get('zeta')).toBe(0);
    } finally { await worker.stop('test-finished'); }
  });
  it('preserves admission for a known initially empty healthy ID across two same-registry workers and ten hung IDs', async () => {
    vi.useFakeTimers();
    const hungDone = Promise.withResolvers<void>();
    const registry = new PromotionWebhookRegistry();
    let hungStarted = 0;
    let healthyBacklog = false;
    let healthyClaimed = false;
    let healthyCalls = 0;
    let sequence = 10;
    for (let i = 0; i < 10; i += 1) registry.register({ id: `hang${String(i).padStart(2, '0')}`,
      onPromoted: async () => { hungStarted += 1; await hungDone.promise; } });
    registry.register({ id: 'healthy', onPromoted: async () => { healthyCalls += 1; } });
    const persistence = store({ claim: vi.fn(async (_pool, input) => {
      const hook = input.webhookIds[0];
      if (hook === 'healthy') {
        if (!healthyBacklog || healthyClaimed) return [];
        healthyClaimed = true; return [delivery(hook)];
      }
      return Array.from({ length: input.limit }, () => ({ ...delivery(hook),
        event: { ...delivery(hook).event, eventId: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` } }));
    }), renew: vi.fn(async (_pool, _owner, claims) => ({ renewed: claims, terminalOwned: [], lost: [] })) });
    const workers = ['same-set-one', 'same-set-two'].map((owner) => new Worker(pool, registry,
      options({ owner, claimBatch: 10, callbackTimeoutMs: 5, maxAttempts: 3 }), persistence));
    const drain = async (worker: InstanceType<typeof Worker>) => {
      const running = worker.drainOnce(); await vi.advanceTimersByTimeAsync(5); await running;
    };
    try {
      await drain(workers[0]);
      for (let attempt = 0; attempt < 3; attempt += 1) await drain(workers[attempt % 2]);
      expect(hungStarted).toBeGreaterThan(0);
      expect(hungStarted).toBeLessThan(100);
      expect(healthyCalls).toBe(0);
      healthyBacklog = true;
      await drain(workers[1]);
      expect(healthyCalls).toBe(1);
      expect(hungStarted + healthyCalls).toBeLessThanOrEqual(100);
    } finally {
      hungDone.resolve(); await vi.advanceTimersByTimeAsync(0);
      const stopping = Promise.all(workers.map((worker) => worker.stop('test-finished')));
      await vi.advanceTimersByTimeAsync(50); await stopping;
    }
  });

});
