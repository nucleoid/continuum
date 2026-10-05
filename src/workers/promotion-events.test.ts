import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { promoteMemoryWithAudit } from '../storage/promote.js';
import { PromotionWebhookRegistry } from '../extensions/promotion.js';
import type {
  ClaimedPromotionDelivery,
  PromotionLeaseRenewalResult,
} from '../storage/promotion-events.js';
import {
  PromotionEventWorker,
  type PromotionWorkerOptions,
  type PromotionWorkerStore,
} from './promotion-events.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const claimedDelivery: ClaimedPromotionDelivery = {
  event: {
    eventId: 'event-1',
    sourceId: 'source-1',
    destinationId: 'destination-1',
    destinationScopeId: 'scope-1',
    destinationScope: { kind: 'project', name: 'test' },
    principalId: 'principal-1',
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
  },
  webhookId: 'hook',
  attemptCount: 1,
  leaseRecovered: false,
};

function mockStore(
  overrides: Partial<PromotionWorkerStore> = {},
): PromotionWorkerStore {
  return {
    abandon: vi.fn().mockResolvedValue(0),
    claim: vi.fn().mockResolvedValue([]),
    complete: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue('pending'),
    timeout: vi.fn().mockResolvedValue('pending'),
    release: vi.fn().mockResolvedValue(0),
    renew: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function workerOptions(overrides: Partial<PromotionWorkerOptions> = {}): PromotionWorkerOptions {
  return {
    owner: 'worker-test', pollMs: 1000, claimBatch: 10, leaseMs: 1000,
    callbackTimeoutMs: 100, shutdownWaitMs: 50,
    maxAttempts: 3, baseBackoffMs: 10, maxBackoffMs: 100,
    random: () => 0.5,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe('PromotionEventWorker', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });
  afterAll(async () => pool?.end());

  async function seed(webhookIds: string[]) {
    const principal = await createPrincipal(pool, {
      externalId: `worker-${Math.random()}`, kind: 'service', displayName: 'Worker Test',
    });
    const sourceScope = await createScope(pool, { kind: 'team', name: `source-${Math.random()}` });
    const destinationScope = await createScope(pool, {
      kind: 'project', name: `destination-${Math.random()}`,
    });
    await addMembership(pool, principal.id, sourceScope.id, 'writer');
    await addMembership(pool, principal.id, destinationScope.id, 'writer');
    const source = await createMemory(pool, {
      scopeId: sourceScope.id, scopeKind: sourceScope.kind, type: 'fact',
      title: 'Worker event', body: 'Deliver me.', authorId: principal.id, source: 'manual',
    });
    return promoteMemoryWithAudit(
      pool, principal.id, source.id,
      { kind: destinationScope.kind, name: destinationScope.name }, {}, webhookIds,
    );
  }

  function worker(registry: PromotionWebhookRegistry, overrides = {}) {
    return new PromotionEventWorker(pool, registry, workerOptions(overrides));
  }

  it('delivers callbacks outside the claim transaction and isolates webhook failures', async () => {
    const promoted = await seed(['bad', 'good']);
    const registry = new PromotionWebhookRegistry();
    registry.register({
      id: 'bad',
      onPromoted: async () => { throw new Error('token=do-not-log'); },
    });
    const good = vi.fn(async (event) => {
      const query = await pool.query('SELECT state FROM memories WHERE id = $1', [event.destinationId]);
      expect(query.rows[0].state).toBe('live');
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.destinationScope)).toBe(true);
      expect(() => { (event as { eventId: string }).eventId = 'changed'; }).toThrow();
    });
    registry.register({ id: 'good', onPromoted: good });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const instance = worker(registry, { maxAttempts: 1, logger });

    await expect(instance.drainOnce()).resolves.toBe(2);

    expect(good).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: promoted.promotionEvent.eventId }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const { rows } = await pool.query(
      'SELECT webhook_id, state FROM promotion_event_deliveries ORDER BY webhook_id',
    );
    expect(rows).toEqual([
      { webhook_id: 'bad', state: 'dead_letter' },
      { webhook_id: 'good', state: 'delivered' },
    ]);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('do-not-log');
  });

  it('retains a timed-out callback lease until its late success is acknowledged', async () => {
    const promoted = await seed(['slow']);
    const registry = new PromotionWebhookRegistry();
    const aborted = deferred();
    const releaseCallback = deferred();
    registry.register({
      id: 'slow', onPromoted: async (_event, { signal }) => {
        signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        await releaseCallback.promise;
      },
    });
    const instance = worker(registry, { callbackTimeoutMs: 25 });
    const draining = instance.drainOnce();
    await aborted.promise;
    await expect(draining).resolves.toBe(1);
    const { rows } = await pool.query(
      `SELECT event_id, state, attempt_count, lease_owner,
              lease_expires_at IS NOT NULL AS lease_retained
         FROM promotion_event_deliveries`,
    );
    expect(rows).toEqual([{
      event_id: promoted.promotionEvent.eventId,
      state: 'pending', attempt_count: 1, lease_owner: 'worker-test', lease_retained: true,
    }]);
    releaseCallback.resolve();
    await vi.waitFor(async () => {
      const result = await pool.query('SELECT state FROM promotion_event_deliveries');
      expect(result.rows).toEqual([{ state: 'delivered' }]);
    });
  });

  it('stops claiming and retains a deadline-abandoned callback lease', async () => {
    vi.useFakeTimers();
    const releaseCallback = deferred();
    try {
      await seed(['stuck']);
      const entered = deferred();
      const registry = new PromotionWebhookRegistry();
      registry.register({
        id: 'stuck',
        onPromoted: async (_event, { signal }) => {
          entered.resolve();
          signal.addEventListener('abort', () => undefined, { once: true });
          await releaseCallback.promise;
        },
      });
      const instance = worker(registry, {
        leaseMs: 20_000, callbackTimeoutMs: 10_000, shutdownWaitMs: 20,
      });
      const draining = instance.drainOnce();
      await entered.promise;
      const stopping = instance.stop('SIGTERM');
      await vi.advanceTimersByTimeAsync(20);
      await expect(stopping).resolves.toBeUndefined();
      await expect(draining).resolves.toBe(1);
      await expect(instance.drainOnce()).resolves.toBe(0);
      const { rows } = await pool.query(
        `SELECT state, lease_owner, lease_expires_at IS NOT NULL AS lease_retained
           FROM promotion_event_deliveries`,
      );
      expect(rows).toEqual([{
        state: 'pending', lease_owner: 'worker-test', lease_retained: true,
      }]);
    } finally {
      releaseCallback.resolve();
      await vi.runAllTicks();
      vi.useRealTimers();
    }
  });

  it('waits for an in-flight claim, launches no callback, and stops idempotently', async () => {
    const claimEntered = deferred();
    const claimResult = deferred<ClaimedPromotionDelivery[]>();
    const store = mockStore({
      claim: vi.fn(async () => {
        claimEntered.resolve();
        return claimResult.promise;
      }),
    });
    const callback = vi.fn();
    const registry = new PromotionWebhookRegistry();
    registry.register({ id: 'hook', onPromoted: callback });
    const instance = new PromotionEventWorker(pool, registry, workerOptions(), store);

    const draining = instance.drainOnce();
    await claimEntered.promise;
    const firstStop = instance.stop('SIGTERM');
    const secondStop = instance.stop('again');
    expect(secondStop).toBe(firstStop);
    claimResult.resolve([claimedDelivery]);

    await expect(draining).resolves.toBe(1);
    await expect(firstStop).resolves.toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
    expect(store.abandon).toHaveBeenCalledWith(pool, 'worker-test', [claimedDelivery]);
    expect(store.release).toHaveBeenCalledOnce();
    expect(store.release).toHaveBeenCalledWith(pool, 'worker-test', []);
    await expect(instance.drainOnce()).resolves.toBe(0);
  });

  it('releases a claim that finishes after the bounded shutdown deadline', async () => {
    vi.useFakeTimers();
    try {
      const claimEntered = deferred();
      const claimResult = deferred<ClaimedPromotionDelivery[]>();
      const store = mockStore({
        claim: vi.fn(async () => {
          claimEntered.resolve();
          return claimResult.promise;
        }),
      });
      const registry = new PromotionWebhookRegistry();
      const callback = vi.fn();
      registry.register({ id: 'hook', onPromoted: callback });
      const instance = new PromotionEventWorker(pool, registry, workerOptions(), store);

      const draining = instance.drainOnce();
      await claimEntered.promise;
      const stopping = instance.stop('SIGTERM');
      await vi.advanceTimersByTimeAsync(100);
      await expect(stopping).resolves.toBeUndefined();
      expect(store.release).toHaveBeenCalledOnce();

      claimResult.resolve([claimedDelivery]);
      await expect(draining).resolves.toBe(1);
      expect(callback).not.toHaveBeenCalled();
      expect(store.abandon).toHaveBeenCalledWith(pool, 'worker-test', [claimedDelivery]);
      expect(store.release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resolve stop until an already-started callback has settled', async () => {
    const entered = deferred();
    const release = deferred();
    const registry = new PromotionWebhookRegistry();
    const callback = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    registry.register({ id: 'hook', onPromoted: callback });
    const store = mockStore({ claim: vi.fn().mockResolvedValue([claimedDelivery]) });
    const instance = new PromotionEventWorker(pool, registry, workerOptions(), store);

    const draining = instance.drainOnce();
    await entered.promise;
    let stopped = false;
    const stopping = instance.stop('SIGTERM').then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve();

    await draining;
    await stopping;
    expect(callback).toHaveBeenCalledOnce();
    expect(store.release).toHaveBeenCalledOnce();
  });

  it('tracks every sibling callback when one delivery persistence rejects', async () => {
    const siblingEntered = deferred();
    const releaseSibling = deferred();
    const firstPersistenceFailed = deferred();
    const secondDelivery: ClaimedPromotionDelivery = {
      ...claimedDelivery,
      event: { ...claimedDelivery.event, eventId: 'event-2' },
    };
    const registry = new PromotionWebhookRegistry();
    registry.register({
      id: 'hook',
      onPromoted: async (event) => {
        if (event.eventId === 'event-2') {
          siblingEntered.resolve();
          await releaseSibling.promise;
        }
      },
    });
    const store = mockStore({
      claim: vi.fn().mockResolvedValue([claimedDelivery, secondDelivery]),
      complete: vi.fn(async (_pool, eventId) => {
        if (eventId === 'event-1') {
          firstPersistenceFailed.resolve();
          throw new Error('complete write failed');
        }
        return true;
      }),
    });
    const instance = new PromotionEventWorker(
      pool,
      registry,
      workerOptions({ leaseMs: 20_000, callbackTimeoutMs: 10_000, shutdownWaitMs: 5_000 }),
      store,
    );

    const draining = instance.drainOnce();
    let drainSettled = false;
    void draining.finally(() => { drainSettled = true; }).catch(() => undefined);
    await siblingEntered.promise;
    await firstPersistenceFailed.promise;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(drainSettled).toBe(false);
    const stopping = instance.stop('SIGTERM');
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    expect(store.release).not.toHaveBeenCalled();
    releaseSibling.resolve();
    await expect(draining).rejects.toThrow('complete write failed');
    await expect(stopping).resolves.toBeUndefined();
    expect(store.complete).toHaveBeenCalledWith(pool, 'event-2', 'hook', 'worker-test');
    expect(store.complete).toHaveBeenCalledBefore(store.release as ReturnType<typeof vi.fn>);
  });

  it('abandons a claimed delivery when its webhook is unavailable', async () => {
    const missing = { ...claimedDelivery, webhookId: 'missing' };
    const store = mockStore({ claim: vi.fn().mockResolvedValue([missing]) });
    const instance = new PromotionEventWorker(
      pool,
      new PromotionWebhookRegistry(),
      workerOptions(),
      store,
    );

    await expect(instance.drainOnce()).resolves.toBe(1);
    expect(store.abandon).toHaveBeenCalledWith(pool, 'worker-test', [missing]);
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.fail).not.toHaveBeenCalled();
    await instance.stop('test_complete');
  });

  it('abandons a failure caused by its own shutdown abort', async () => {
    vi.useFakeTimers();
    try {
      const entered = deferred();
      const registry = new PromotionWebhookRegistry();
      registry.register({
        id: 'hook',
        onPromoted: async (_event, { signal }) => {
          entered.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
      });
      const store = mockStore({ claim: vi.fn().mockResolvedValue([claimedDelivery]) });
      const instance = new PromotionEventWorker(
        pool,
        registry,
        workerOptions({ leaseMs: 100, callbackTimeoutMs: 80, shutdownWaitMs: 40 }),
        store,
      );

      const draining = instance.drainOnce();
      await entered.promise;
      const stopping = instance.stop('SIGTERM');
      await vi.advanceTimersByTimeAsync(40);
      await stopping;
      await draining;
      await vi.runAllTicks();

      expect(store.abandon).toHaveBeenCalledWith(pool, 'worker-test', [claimedDelivery]);
      expect(store.fail).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires shutdown grace to be shorter than the delivery lease', () => {
    expect(() => new PromotionEventWorker(
      pool,
      new PromotionWebhookRegistry(),
      workerOptions({ leaseMs: 100, callbackTimeoutMs: 50, shutdownWaitMs: 100 }),
    )).toThrow('shutdownWaitMs must be less than leaseMs');
  });

  it('durably acknowledges a successful callback that settles during shutdown', async () => {
    const entered = deferred();
    const releaseCallback = deferred();
    const registry = new PromotionWebhookRegistry();
    registry.register({
      id: 'hook',
      onPromoted: async () => {
        entered.resolve();
        await releaseCallback.promise;
      },
    });
    const store = mockStore({ claim: vi.fn().mockResolvedValue([claimedDelivery]) });
    const instance = new PromotionEventWorker(pool, registry, workerOptions(), store);

    const draining = instance.drainOnce();
    await entered.promise;
    const stopping = instance.stop('SIGTERM');
    releaseCallback.resolve();

    await expect(draining).resolves.toBe(1);
    await expect(stopping).resolves.toBeUndefined();
    expect(store.complete).toHaveBeenCalledOnce();
    expect(store.complete).toHaveBeenCalledWith(pool, 'event-1', 'hook', 'worker-test');
    expect(store.complete).toHaveResolvedWith(true);
    expect(store.complete).toHaveBeenCalledBefore(store.release as ReturnType<typeof vi.fn>);
  });

  it.each([
    { outcome: 'complete', callback: async () => undefined },
    { outcome: 'fail', callback: async () => { throw new Error('expected'); } },
  ])('removes the callback fence while $outcome persistence is in flight', async ({
    outcome, callback,
  }) => {
    const persistenceEntered = deferred();
    const persistenceResult = deferred<boolean | 'pending'>();
    const store = mockStore({
      claim: vi.fn().mockResolvedValue([claimedDelivery]),
      complete: vi.fn(async () => {
        persistenceEntered.resolve();
        return persistenceResult.promise as Promise<boolean>;
      }),
      fail: vi.fn(async () => {
        persistenceEntered.resolve();
        return persistenceResult.promise as Promise<'pending'>;
      }),
    });
    const registry = new PromotionWebhookRegistry();
    registry.register({ id: 'hook', onPromoted: callback });
    const instance = new PromotionEventWorker(pool, registry, workerOptions(), store);

    const draining = instance.drainOnce();
    await persistenceEntered.promise;

    const contenderStore = mockStore();
    const contender = new PromotionEventWorker(
      pool,
      registry,
      workerOptions({ owner: 'contender' }),
      contenderStore,
    );
    await expect(contender.drainOnce()).resolves.toBe(0);
    expect((contenderStore.claim as ReturnType<typeof vi.fn>).mock.calls[0]?.[1].excluded)
      .toEqual([]);

    persistenceResult.resolve(outcome === 'complete' ? true : 'pending');
    await expect(draining).resolves.toBe(1);
    await instance.stop('test_complete');
    await contender.stop('test_complete');
  });

  it('keeps a real late follower fenced when timeout persistence rejects, then cleans it', async () => {
    vi.useFakeTimers();
    const releaseCallback = deferred();
    try {
      const entered = deferred();
      const registry = new PromotionWebhookRegistry();
      registry.register({
        id: 'hook',
        onPromoted: async () => {
          entered.resolve();
          await releaseCallback.promise;
        },
      });
      const store = mockStore({
        claim: vi.fn().mockResolvedValueOnce([claimedDelivery]).mockResolvedValue([]),
        timeout: vi.fn().mockRejectedValue(new Error('timeout write failed')),
      });
      const instance = new PromotionEventWorker(
        pool,
        registry,
        workerOptions({ leaseMs: 90, callbackTimeoutMs: 20 }),
        store,
      );
      const draining = instance.drainOnce();
      await entered.promise;
      await vi.advanceTimersByTimeAsync(20);
      await expect(draining).rejects.toThrow('timeout write failed');
      await vi.advanceTimersByTimeAsync(100);
      expect(store.renew).not.toHaveBeenCalled();

      const contenderStore = mockStore();
      const contender = new PromotionEventWorker(
        pool,
        registry,
        workerOptions({ owner: 'contender' }),
        contenderStore,
      );
      await contender.drainOnce();
      expect((contenderStore.claim as ReturnType<typeof vi.fn>).mock.calls[0]?.[1].excluded)
        .toEqual([claimedDelivery]);

      releaseCallback.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(store.complete).toHaveBeenCalledOnce();
      await contender.drainOnce();
      expect((contenderStore.claim as ReturnType<typeof vi.fn>).mock.calls[1]?.[1].excluded)
        .toEqual([]);
      await instance.stop('test_complete');
      await contender.stop('test_complete');
    } finally {
      releaseCallback.resolve();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('continues claiming after a final-attempt timeout while its callback remains hung', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
    const releaseCallback = deferred();
    try {
      const entered = deferred();
      const registry = new PromotionWebhookRegistry();
      registry.register({
        id: 'hook',
        onPromoted: async () => {
          entered.resolve();
          await releaseCallback.promise;
        },
      });
      const store = mockStore({
        claim: vi.fn()
          .mockResolvedValueOnce([{ ...claimedDelivery, attemptCount: 3 }])
          .mockResolvedValue([]),
        timeout: vi.fn().mockResolvedValue('dead_letter'),
        renew: vi.fn().mockResolvedValue(0),
      });
      const instance = new PromotionEventWorker(
        pool,
        registry,
        workerOptions({ leaseMs: 90, callbackTimeoutMs: 20, maxAttempts: 3 }),
        store,
      );

      const draining = instance.drainOnce();
      await entered.promise;
      await vi.advanceTimersByTimeAsync(20);
      await expect(draining).resolves.toBe(1);
      await vi.advanceTimersByTimeAsync(40);
      expect(store.renew).not.toHaveBeenCalled();

      await expect(instance.drainOnce()).resolves.toBe(0);
      expect(store.claim).toHaveBeenCalledTimes(2);
    } finally {
      releaseCallback.resolve();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('does not abort a healthy callback when another delivery completes during renewal', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
    const finishFirst = deferred();
    const finishSecond = deferred();
    try {
      const secondDelivery: ClaimedPromotionDelivery = {
        ...claimedDelivery,
        event: { ...claimedDelivery.event, eventId: 'event-2' },
      };
      const renewalEntered = deferred();
      const releaseRenewal = deferred<PromotionLeaseRenewalResult>();
      const firstCompleted = deferred();
      const secondAborted = vi.fn();
      const registry = new PromotionWebhookRegistry();
      registry.register({
        id: 'hook',
        onPromoted: async (event, { signal }) => {
          if (event.eventId === 'event-1') await finishFirst.promise;
          else {
            signal.addEventListener('abort', secondAborted, { once: true });
            await finishSecond.promise;
          }
        },
      });
      const store = mockStore({
        claim: vi.fn().mockResolvedValue([claimedDelivery, secondDelivery]),
        complete: vi.fn(async (_pool, eventId) => {
          if (eventId === 'event-1') firstCompleted.resolve();
          return true;
        }),
        renew: vi.fn(async () => {
          renewalEntered.resolve();
          return releaseRenewal.promise;
        }),
      });
      const instance = new PromotionEventWorker(
        pool,
        registry,
        workerOptions({ leaseMs: 90, callbackTimeoutMs: 80 }),
        store,
      );

      const draining = instance.drainOnce();
      await vi.advanceTimersByTimeAsync(30);
      await renewalEntered.promise;
      finishFirst.resolve();
      await firstCompleted.promise;
      releaseRenewal.resolve({
        renewed: [secondDelivery], terminalOwned: [], lost: [claimedDelivery],
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(secondAborted).not.toHaveBeenCalled();
      finishSecond.resolve();
      await expect(draining).resolves.toBe(2);
      expect(store.complete).toHaveBeenCalledWith(pool, 'event-2', 'hook', 'worker-test');
    } finally {
      finishFirst.resolve();
      finishSecond.resolve();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('bounds a hung renewal and aborts callbacks fail-closed without rearming', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
    const releaseCallback = deferred();
    try {
      const entered = deferred();
      const aborted = deferred();
      const registry = new PromotionWebhookRegistry();
      registry.register({
        id: 'hook',
        onPromoted: async (_event, { signal }) => {
          entered.resolve();
          signal.addEventListener('abort', () => aborted.resolve(), { once: true });
          await releaseCallback.promise;
        },
      });
      const never = new Promise<number>(() => undefined);
      const store = mockStore({
        claim: vi.fn().mockResolvedValue([claimedDelivery]),
        renew: vi.fn(() => never),
      });
      const instance = new PromotionEventWorker(
        pool,
        registry,
        workerOptions({ leaseMs: 90, callbackTimeoutMs: 80 }),
        store,
      );

      const draining = instance.drainOnce();
      await entered.promise;
      await vi.advanceTimersByTimeAsync(59);
      expect(store.renew).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await aborted.promise;
      await expect(draining).resolves.toBe(1);

      await vi.advanceTimersByTimeAsync(300);
      expect(store.renew).toHaveBeenCalledOnce();
      await expect(instance.drainOnce()).resolves.toBe(1);
      expect(store.claim).toHaveBeenCalledTimes(2);
    } finally {
      releaseCallback.resolve();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('keeps stop wall-clock bounded when renewal and release never settle', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
    const releaseCallback = deferred();
    try {
      const entered = deferred();
      const never = new Promise<number>(() => undefined);
      const registry = new PromotionWebhookRegistry();
      registry.register({
        id: 'hook',
        onPromoted: async () => {
          entered.resolve();
          await releaseCallback.promise;
        },
      });
      const store = mockStore({
        claim: vi.fn().mockResolvedValue([claimedDelivery]),
        renew: vi.fn(() => never),
        release: vi.fn(() => never),
      });
      const instance = new PromotionEventWorker(
        pool,
        registry,
        workerOptions({ leaseMs: 90, callbackTimeoutMs: 80, shutdownWaitMs: 40 }),
        store,
      );

      void instance.drainOnce();
      await entered.promise;
      await vi.advanceTimersByTimeAsync(30);
      expect(store.renew).toHaveBeenCalledOnce();
      const stopping = instance.stop('SIGTERM');
      let stopped = false;
      void stopping.then(() => { stopped = true; });

      await vi.advanceTimersByTimeAsync(39);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(stopping).resolves.toBeUndefined();
      expect(store.release).toHaveBeenCalledOnce();
    } finally {
      releaseCallback.resolve();
      await vi.runAllTicks();
      vi.useRealTimers();
    }
  });

  it('does not rearm renewal after stop and prunes a late successful callback fence', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
    const releaseCallback = deferred();
    try {
      const entered = deferred();
      const renewal = deferred<number>();
      const registry = new PromotionWebhookRegistry();
      registry.register({
        id: 'hook',
        onPromoted: async () => {
          entered.resolve();
          await releaseCallback.promise;
        },
      });
      const store = mockStore({
        claim: vi.fn().mockResolvedValue([claimedDelivery]),
        renew: vi.fn(() => renewal.promise),
      });
      const instance = new PromotionEventWorker(
        pool,
        registry,
        workerOptions({ leaseMs: 90, callbackTimeoutMs: 80, shutdownWaitMs: 40 }),
        store,
      );

      void instance.drainOnce();
      await entered.promise;
      await vi.advanceTimersByTimeAsync(30);
      const stopping = instance.stop('SIGTERM');
      await vi.advanceTimersByTimeAsync(40);
      await stopping;

      renewal.resolve(1);
      releaseCallback.resolve();
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(1);
      expect(store.complete).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(100);
      expect(store.renew).toHaveBeenCalledOnce();

      await instance.stop('again');
      expect(store.release).toHaveBeenCalledWith(pool, 'worker-test', [claimedDelivery]);
    } finally {
      releaseCallback.resolve();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('bounds lease renewal and shutdown when a callback ignores abort', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
    const releaseCallback = deferred();
    try {
      let owner: string | undefined;
      let leaseExpiresAt = 0;
      let delivered = false;
      const store = mockStore({
        claim: vi.fn(async (_pool, input) => {
          if (delivered || (owner && leaseExpiresAt > Date.now())) return [];
          if (input.excluded.some((delivery) =>
            delivery.event.eventId === claimedDelivery.event.eventId
            && delivery.webhookId === claimedDelivery.webhookId)) return [];
          owner = input.owner;
          leaseExpiresAt = Date.now() + input.leaseMs;
          return [claimedDelivery];
        }),
        complete: vi.fn(async (_pool, _eventId, _webhookId, claimant) => {
          if (owner !== claimant) return false;
          delivered = true;
          owner = undefined;
          return true;
        }),
        release: vi.fn(async (_pool, claimant, retained = []) => {
          if (owner !== claimant) return 0;
          if (retained.some((delivery) => delivery.event.eventId === claimedDelivery.event.eventId
            && delivery.webhookId === claimedDelivery.webhookId)) return 0;
          owner = undefined;
          leaseExpiresAt = 0;
          return 1;
        }),
        renew: vi.fn(async (_pool, claimant, deliveries, leaseMs) => {
          if (owner !== claimant || deliveries.length === 0) return 0;
          leaseExpiresAt = Date.now() + leaseMs;
          return 1;
        }),
      });
      const entered = deferred();
      const aborted = deferred();
      const registry = new PromotionWebhookRegistry();
      registry.register({
        id: 'hook',
        onPromoted: async (_event, { signal }) => {
          entered.resolve();
          signal.addEventListener('abort', () => aborted.resolve(), { once: true });
          await releaseCallback.promise;
        },
      });
      const instance = new PromotionEventWorker(
        pool,
        registry,
        workerOptions({ leaseMs: 90, callbackTimeoutMs: 60, shutdownWaitMs: 40 }),
        store,
      );

      const draining = instance.drainOnce();
      await entered.promise;
      const stopping = instance.stop('SIGTERM');
      await vi.advanceTimersByTimeAsync(40);
      await aborted.promise;

      await expect(stopping).resolves.toBeUndefined();
      await expect(draining).resolves.toBe(1);
      expect(store.renew).toHaveBeenCalledOnce();
      expect(store.release).toHaveBeenCalledOnce();
      expect(store.release).toHaveBeenCalledWith(pool, 'worker-test', [claimedDelivery]);

      const contenderCallback = vi.fn();
      const contenderRegistry = new PromotionWebhookRegistry();
      contenderRegistry.register({ id: 'hook', onPromoted: contenderCallback });
      const contender = new PromotionEventWorker(
        pool,
        contenderRegistry,
        workerOptions({ owner: 'contender', leaseMs: 90, callbackTimeoutMs: 60 }),
        store,
      );
      await expect(contender.drainOnce()).resolves.toBe(0);
      expect(contenderCallback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(81);
      await expect(contender.drainOnce()).resolves.toBe(0);
      expect(contenderCallback).not.toHaveBeenCalled();
      expect((store.claim as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1].excluded)
        .toEqual([claimedDelivery]);

      releaseCallback.resolve();
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(1);
      expect(store.complete).toHaveBeenCalledOnce();
      await expect(contender.drainOnce()).resolves.toBe(0);
      expect(contenderCallback).not.toHaveBeenCalled();
      expect((store.claim as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1].excluded)
        .toEqual([]);
      await contender.stop('test_complete');

      expect(store.renew).toHaveBeenCalledOnce();
    } finally {
      releaseCallback.resolve();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('renews during shutdown grace and prevents redelivery after acknowledgement', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
    try {
      let owner: string | undefined;
      let leaseExpiresAt = 0;
      let delivered = false;
      const store = mockStore({
        claim: vi.fn(async (_pool, input) => {
          if (delivered || (owner && leaseExpiresAt > Date.now())) return [];
          if (input.excluded.some((delivery) =>
            delivery.event.eventId === claimedDelivery.event.eventId
            && delivery.webhookId === claimedDelivery.webhookId)) return [];
          owner = input.owner;
          leaseExpiresAt = Date.now() + input.leaseMs;
          return [claimedDelivery];
        }),
        complete: vi.fn(async (_pool, _eventId, _webhookId, claimant) => {
          if (owner !== claimant) return false;
          delivered = true;
          owner = undefined;
          return true;
        }),
        release: vi.fn(async (_pool, claimant, retained = []) => {
          if (owner !== claimant) return 0;
          if (retained.some((delivery) => delivery.event.eventId === claimedDelivery.event.eventId
            && delivery.webhookId === claimedDelivery.webhookId)) return 0;
          owner = undefined;
          leaseExpiresAt = 0;
          return 1;
        }),
        renew: vi.fn(async (_pool, claimant, deliveries, leaseMs) => {
          if (owner !== claimant) return 0;
          if (deliveries.length === 0) return 0;
          leaseExpiresAt = Date.now() + leaseMs;
          return 1;
        }),
      });
      const firstEntered = deferred();
      const firstRelease = deferred();
      const firstRegistry = new PromotionWebhookRegistry();
      const firstCallback = vi.fn(async () => {
        firstEntered.resolve();
        await firstRelease.promise;
      });
      firstRegistry.register({ id: 'hook', onPromoted: firstCallback });
      const first = new PromotionEventWorker(
        pool,
        firstRegistry,
        workerOptions({
          owner: 'first', leaseMs: 90, callbackTimeoutMs: 60, shutdownWaitMs: 70,
        }),
        store,
      );
      const firstDrain = first.drainOnce();
      await firstEntered.promise;
      const stopping = first.stop('SIGTERM');

      await vi.advanceTimersByTimeAsync(40);
      expect(store.renew).toHaveBeenCalled();
      const secondRegistry = new PromotionWebhookRegistry();
      const secondCallback = vi.fn();
      secondRegistry.register({ id: 'hook', onPromoted: secondCallback });
      const second = new PromotionEventWorker(
        pool,
        secondRegistry,
        workerOptions({ owner: 'second', leaseMs: 90, callbackTimeoutMs: 60 }),
        store,
      );
      await expect(second.drainOnce()).resolves.toBe(0);
      expect(secondCallback).not.toHaveBeenCalled();

      firstRelease.resolve();
      await firstDrain;
      await stopping;
      await expect(second.drainOnce()).resolves.toBe(0);
      expect(secondCallback).not.toHaveBeenCalled();
      await second.stop('test_complete');
    } finally {
      vi.useRealTimers();
    }
  });
});
