import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { promoteMemoryWithAudit } from '../storage/promote.js';
import { PromotionWebhookRegistry } from '../extensions/promotion.js';
import type { ClaimedPromotionDelivery } from '../storage/promotion-events.js';
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
    claim: vi.fn().mockResolvedValue([]),
    complete: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue('pending'),
    release: vi.fn().mockResolvedValue(0),
    renew: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function workerOptions(overrides: Partial<PromotionWorkerOptions> = {}): PromotionWorkerOptions {
  return {
    owner: 'worker-test', pollMs: 1000, claimBatch: 10, leaseMs: 1000,
    callbackTimeoutMs: 100, shutdownWaitMs: 100,
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

  it('aborts a timed-out callback, schedules bounded retry, and retains the event ID', async () => {
    const promoted = await seed(['slow']);
    const registry = new PromotionWebhookRegistry();
    const aborted = deferred();
    registry.register({
      id: 'slow',
      onPromoted: (_event, { signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { aborted.resolve(); resolve(); });
      }),
    });
    const instance = worker(registry, { callbackTimeoutMs: 25 });
    const draining = instance.drainOnce();
    await aborted.promise;
    await expect(draining).resolves.toBe(1);
    const { rows } = await pool.query(
      'SELECT event_id, state, attempt_count, lease_owner FROM promotion_event_deliveries',
    );
    expect(rows).toEqual([{
      event_id: promoted.promotionEvent.eventId,
      state: 'pending', attempt_count: 1, lease_owner: null,
    }]);
  });

  it('stops claiming, drains cooperative callbacks, and releases abandoned leases', async () => {
    vi.useFakeTimers();
    try {
      await seed(['stuck']);
      const entered = deferred();
      const registry = new PromotionWebhookRegistry();
      registry.register({
        id: 'stuck',
        onPromoted: async (_event, { signal }) => {
          entered.resolve();
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
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
        'SELECT state, lease_owner, lease_expires_at FROM promotion_event_deliveries',
      );
      expect(rows).toEqual([{ state: 'pending', lease_owner: null, lease_expires_at: null }]);
    } finally {
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
    expect(store.release).toHaveBeenCalledOnce();
    await expect(instance.drainOnce()).resolves.toBe(0);
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

  it('renews a shutdown lease so another worker cannot duplicate an active callback', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
    try {
      let owner: string | undefined;
      let leaseExpiresAt = 0;
      let delivered = false;
      const store = mockStore({
        claim: vi.fn(async (_pool, input) => {
          if (delivered || (owner && leaseExpiresAt > Date.now())) return [];
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
        release: vi.fn(async (_pool, claimant) => {
          if (owner !== claimant) return 0;
          owner = undefined;
          leaseExpiresAt = 0;
          return 1;
        }),
        renew: vi.fn(async (_pool, claimant, leaseMs) => {
          if (owner !== claimant) return 0;
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
          owner: 'first', leaseMs: 90, callbackTimeoutMs: 60, shutdownWaitMs: 10,
        }),
        store,
      );
      const firstDrain = first.drainOnce();
      await firstEntered.promise;
      const stopping = first.stop('SIGTERM');

      await vi.advanceTimersByTimeAsync(100);
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
      await expect(second.drainOnce()).resolves.toBe(1);
      expect(secondCallback).toHaveBeenCalledOnce();
      await second.stop('test_complete');
    } finally {
      vi.useRealTimers();
    }
  });
});
