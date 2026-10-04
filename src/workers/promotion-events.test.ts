import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { promoteMemoryWithAudit } from '../storage/promote.js';
import { PromotionWebhookRegistry } from '../extensions/promotion.js';
import { PromotionEventWorker } from './promotion-events.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
    return new PromotionEventWorker(pool, registry, {
      owner: 'worker-test', pollMs: 1000, claimBatch: 10, leaseMs: 1000,
      callbackTimeoutMs: 100, shutdownWaitMs: 100,
      maxAttempts: 3, baseBackoffMs: 10, maxBackoffMs: 100,
      random: () => 0.5,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ...overrides,
    });
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
});
