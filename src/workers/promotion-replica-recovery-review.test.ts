import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPool, resetData, promoteWithConfiguredWebhooksForTest } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { PromotionWebhookRegistry } from '../extensions/promotion.js';
import { PromotionEventWorker, type PromotionWorkerStore } from './promotion-events.js';
import { abandonPromotionDeliveries, claimPromotionDeliveries, completePromotionDelivery,
  failPromotionDelivery, releasePromotionDeliveries, renewPromotionDeliveries, timeoutPromotionDelivery } from '../storage/promotion-events.js';

const actualStore: PromotionWorkerStore = { abandon: abandonPromotionDeliveries, claim: claimPromotionDeliveries,
  complete: completePromotionDelivery, fail: failPromotionDelivery, release: releasePromotionDeliveries,
  renew: renewPromotionDeliveries, timeout: timeoutPromotionDelivery };
const options = (owner: string) => ({ owner, pollMs: 50, claimBatch: 1, leaseMs: 600,
  callbackTimeoutMs: 150, databaseTimeoutMs: 100, shutdownWaitMs: 80,
  maxAttempts: 3, baseBackoffMs: 10, maxBackoffMs: 100, random: () => 0.5,
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined } });
async function beforeWatch<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('replica recovery barrier exceeded its finite watch')), 2_000);
  })]); } finally { if (timer) clearTimeout(timer); }
}
async function afterExpiry(expires: Date): Promise<void> {
  const wait = Math.max(0, expires.getTime() + 100 - Date.now());
  if (wait > 2_000) throw new Error('unexpected lease duration outside the finite replica watch');
  await new Promise((resolve) => setTimeout(resolve, wait));
}

describe('promotion replica recovery review', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => { await pool?.end(); });
  async function seed(hooks: string[]) {
    const principal = await createPrincipal(pool, { externalId: 'replica-review', kind: 'user', displayName: 'Replica review' });
    const sourceScope = await createScope(pool, { kind: 'team', name: 'replica-source' });
    const destination = await createScope(pool, { kind: 'project', name: 'replica-target' });
    await addMembership(pool, principal.id, sourceScope.id, 'writer');
    await addMembership(pool, principal.id, destination.id, 'writer');
    const events = new Map<string, string>();
    for (const hook of hooks) {
      const source = await createMemory(pool, { scopeId: sourceScope.id, scopeKind: 'team', type: 'fact',
        title: hook, body: 'Normal promotion.', authorId: principal.id, source: 'manual' });
      const promoted = await promoteWithConfiguredWebhooksForTest(pool, principal.id, source.id,
        { kind: 'project', name: destination.name }, {}, [hook]);
      events.set(hook, promoted.promotionEvent.eventId);
    }
    return events;
  }

  it('keeps an unsettled consumer fenced across replicas after one recoverable renewal failure', async () => {
    const events = await seed(['uncertain-hook']);
    const entered = Promise.withResolvers<void>();
    const callbackDone = Promise.withResolvers<void>();
    const renewalFailed = Promise.withResolvers<void>();
    let unsettled = false;
    let renewals = 0;
    const registry = new PromotionWebhookRegistry();
    registry.register({ id: 'uncertain-hook', onPromoted: async () => {
      unsettled = true; entered.resolve(); await callbackDone.promise; unsettled = false;
    } });
    const store: PromotionWorkerStore = { ...actualStore, renew: async (...args) => {
      if (++renewals === 1) { renewalFailed.resolve(); throw new Error('injected recoverable renewal failure'); }
      return renewPromotionDeliveries(...args);
    } };
    const worker = new PromotionEventWorker(pool, registry, options('primary-renewal'), store);
    const draining = worker.drainOnce().then(() => undefined, (error: unknown) => error);
    try {
      await beforeWatch(entered.promise);
      const original = (await pool.query('SELECT lease_expires_at FROM promotion_event_deliveries WHERE event_id=$1::uuid',
        [events.get('uncertain-hook')])).rows[0].lease_expires_at as Date;
      await beforeWatch(renewalFailed.promise);
      await afterExpiry(original);
      expect(unsettled).toBe(true);
      // An independent replica has no access to this process's in-flight map.
      // Its real SQL admission must still refuse the actively renewed fence.
      const peer = await claimPromotionDeliveries(pool, { owner: 'independent-replica',
        webhookIds: ['uncertain-hook'], limit: 1, leaseMs: 600, maxAttempts: 3 });
      expect(peer).toEqual([]);
      expect(renewals).toBeGreaterThan(1);
    } finally {
      callbackDone.resolve(); await draining; await worker.stop('test-finished');
    }
  });

  it('renews a running consumer while multiple paid callbacks have stalled ACK reconciliation', async () => {
    const paidHooks = ['ack-a', 'ack-b', 'ack-c', 'ack-d', 'ack-e', 'ack-f'];
    const events = await seed([...paidHooks, 'running-hook']);
    const entered = Promise.withResolvers<void>();
    const callbackDone = Promise.withResolvers<void>();
    const ackGate = Promise.withResolvers<void>();
    const firstRenewed = Promise.withResolvers<void>();
    const attempts = new Map<string, number>();
    const pendingWrites = new Set<Promise<boolean>>();
    let unsettled = false;
    let paidCalls = 0;
    const registry = new PromotionWebhookRegistry();
    for (const hook of paidHooks) registry.register({ id: hook, onPromoted: async () => { paidCalls += 1; } });
    registry.register({ id: 'running-hook', onPromoted: async () => {
      unsettled = true; entered.resolve(); await callbackDone.promise; unsettled = false;
    } });
    const store: PromotionWorkerStore = { ...actualStore,
      complete: (...args) => {
        const eventId = args[1];
        if (eventId === events.get('running-hook')) return completePromotionDelivery(...args);
        const count = (attempts.get(eventId) ?? 0) + 1; attempts.set(eventId, count);
        if (count === 1) return Promise.reject(new Error('injected initial ACK transport failure'));
        // Fault injection parks ACK responses, not lease SQL. The lease owner,
        // generation, expiry and competing admission below are actual PG state.
        const writing = ackGate.promise.then(() => completePromotionDelivery(...args));
        pendingWrites.add(writing); void writing.then(() => pendingWrites.delete(writing), () => pendingWrites.delete(writing));
        return writing;
      },
      renew: async (...args) => { const result = await renewPromotionDeliveries(...args); firstRenewed.resolve(); return result; },
    };
    const worker = new PromotionEventWorker(pool, registry, options('primary-ack'), store);
    const draining = worker.drainOnce().then(() => undefined, (error: unknown) => error);
    try {
      await beforeWatch(entered.promise);
      await beforeWatch(firstRenewed.promise);
      expect(paidCalls).toBe(paidHooks.length);
      const renewed = (await pool.query('SELECT lease_expires_at FROM promotion_event_deliveries WHERE event_id=$1::uuid',
        [events.get('running-hook')])).rows[0].lease_expires_at as Date;
      await afterExpiry(renewed);
      expect(unsettled).toBe(true);
      const peer = await claimPromotionDeliveries(pool, { owner: 'independent-ack-replica',
        webhookIds: ['running-hook'], limit: 1, leaseMs: 600, maxAttempts: 3 });
      expect(peer).toEqual([]);
    } finally {
      ackGate.resolve(); callbackDone.resolve();
      await draining; await worker.stop('test-finished'); await Promise.allSettled([...pendingWrites]);
    }
  });
  it('charges a started consumer rejection after renewal uncertainty and preserves its backoff', async () => {
    const events = await seed(['started-failure']);
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const persisted = Promise.withResolvers<void>();
    let calls = 0;
    let renewals = 0;
    const registry = new PromotionWebhookRegistry();
    registry.register({ id: 'started-failure', onPromoted: async (_event, context) => {
      calls += 1; entered.resolve();
      context.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      await aborted.promise;
      throw new Error('started consumer rejected after ownership uncertainty');
    } });
    const store: PromotionWorkerStore = { ...actualStore,
      renew: async (...args) => {
        if (++renewals === 1) throw new Error('injected recoverable ownership uncertainty');
        return renewPromotionDeliveries(...args);
      },
      abandon: async (...args) => { const result = await abandonPromotionDeliveries(...args); persisted.resolve(); return result; },
      fail: async (...args) => { const result = await failPromotionDelivery(...args); persisted.resolve(); return result; },
    };
    const worker = new PromotionEventWorker(pool, registry, { ...options('started-primary'),
      callbackTimeoutMs: 450, baseBackoffMs: 200, maxBackoffMs: 400 }, store);
    const draining = worker.drainOnce().then(() => undefined, (error: unknown) => error);
    try {
      await beforeWatch(entered.promise);
      await beforeWatch(persisted.promise);
      expect(calls).toBe(1);
      const state = (await pool.query(`SELECT attempt_count,state,last_error,lease_owner,
        available_at>pg_catalog.clock_timestamp() AS backoff_remains FROM promotion_event_deliveries WHERE event_id=$1::uuid`,
        [events.get('started-failure')])).rows[0];
      expect(state).toMatchObject({ attempt_count: 1, state: 'pending', last_error: 'callback failed',
        lease_owner: null, backoff_remains: true });
    } finally { aborted.resolve(); await draining; await worker.stop('test-finished'); }
  });

  it('reconciles a rejected failure write after recovery without replay or losing the charged backoff', async () => {
    const events = await seed(['negative-write']);
    const recorded = Promise.withResolvers<void>();
    let writes = 0; let calls = 0;
    const exactWrites: { attemptCount: number; leaseGeneration: number; retryDelayMs: number }[] = [];
    const registry = new PromotionWebhookRegistry();
    registry.register({ id: 'negative-write', onPromoted: async () => { calls += 1; throw new Error('actual consumer failure'); } });
    const store: PromotionWorkerStore = { ...actualStore,
      fail: async (...args) => {
        writes += 1; exactWrites.push({ attemptCount: args[4].attemptCount,
          leaseGeneration: args[4].leaseGeneration, retryDelayMs: args[4].retryDelayMs });
        if (writes === 1) throw new Error('injected one failure-write outage');
        const result = await failPromotionDelivery(...args); recorded.resolve(); return result;
      },
    };
    const worker = new PromotionEventWorker(pool, registry, { ...options('negative-primary'),
      baseBackoffMs: 1000, maxBackoffMs: 1000 }, store);
    try {
      await worker.drainOnce().then(() => undefined, () => undefined);
      expect(writes).toBe(1); expect(calls).toBe(1);
      const before = (await pool.query('SELECT pg_catalog.clock_timestamp() AS observed')).rows[0].observed as Date;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([recorded.promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1500); })]);
      } finally { if (timer) clearTimeout(timer); }
      const state = (await pool.query(`SELECT attempt_count,state,last_error,lease_owner,available_at
        FROM promotion_event_deliveries WHERE event_id=$1::uuid`, [events.get('negative-write')])).rows[0];
      expect(state).toMatchObject({ attempt_count: 1, state: 'pending', last_error: 'callback failed', lease_owner: null });
      expect((state.available_at as Date).getTime()).toBeGreaterThanOrEqual(before.getTime() + 1000);
      expect(writes).toBeGreaterThan(1);
      expect(exactWrites.every((write) => write.attemptCount === 1 && write.leaseGeneration === 1 && write.retryDelayMs === 1000)).toBe(true);
      expect(calls).toBe(1);
    } finally { await worker.stop('test-finished'); }
  });

});
