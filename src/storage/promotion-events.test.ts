import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { createMemory, getMemory } from './memories.js';
import { promoteMemoryWithAudit } from './promote.js';
import {
  claimPromotionDeliveries,
  completePromotionDelivery,
  failPromotionDelivery,
  manualRetryPromotionDelivery,
  releasePromotionDeliveries,
  renewPromotionDeliveries,
} from './promotion-events.js';

describe('promotion outbox', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => pool?.end());

  async function seed() {
    const principal = await createPrincipal(pool, {
      externalId: 'outbox-user', kind: 'user', displayName: 'Outbox User',
    });
    const sourceScope = await createScope(pool, { kind: 'team', name: 'source' });
    const destinationScope = await createScope(pool, { kind: 'project', name: 'destination' });
    await addMembership(pool, principal.id, sourceScope.id, 'writer');
    await addMembership(pool, principal.id, destinationScope.id, 'writer');
    const source = await createMemory(pool, {
      scopeId: sourceScope.id, scopeKind: sourceScope.kind, type: 'decision',
      title: 'Promote', body: 'Transactional.', authorId: principal.id, source: 'manual',
    });
    return { principal, source, destinationScope };
  }

  it('atomically creates one stable event and one delivery per sorted webhook', async () => {
    const { principal, source, destinationScope } = await seed();
    const promoted = await promoteMemoryWithAudit(
      pool, principal.id, source.id, { kind: 'project', name: 'destination' }, {},
      ['zeta', 'alpha'],
    );
    const { rows: events } = await pool.query('SELECT * FROM promotion_events');
    const { rows: deliveries } = await pool.query(
      'SELECT event_id, webhook_id, state, attempt_count FROM promotion_event_deliveries ORDER BY webhook_id',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: promoted.promotionEvent.eventId,
      source_memory_id: source.id,
      destination_memory_id: promoted.destination.id,
      destination_scope_id: destinationScope.id,
      destination_scope_kind: 'project',
      destination_scope_name: 'destination',
      principal_id: principal.id,
    });
    expect(deliveries).toEqual([
      { event_id: events[0].id, webhook_id: 'alpha', state: 'pending', attempt_count: 0 },
      { event_id: events[0].id, webhook_id: 'zeta', state: 'pending', attempt_count: 0 },
    ]);
  });

  it('rolls back source, destination, audit, event, and deliveries if outbox insertion fails', async () => {
    const { principal, source } = await seed();
    await pool.query(`
      CREATE FUNCTION reject_issue26_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'expected delivery failure'; END $$;
      CREATE TRIGGER reject_issue26_delivery BEFORE INSERT ON promotion_event_deliveries
      FOR EACH ROW EXECUTE FUNCTION reject_issue26_delivery();
    `);
    try {
      await expect(promoteMemoryWithAudit(
        pool, principal.id, source.id, { kind: 'project', name: 'destination' }, {}, ['hook'],
      )).rejects.toThrow('expected delivery failure');
    } finally {
      await pool.query('DROP TRIGGER reject_issue26_delivery ON promotion_event_deliveries');
      await pool.query('DROP FUNCTION reject_issue26_delivery()');
    }
    expect(await getMemory(pool, source.id)).toMatchObject({ state: 'live', promotedToId: null });
    for (const table of ['audit_log', 'promotion_events', 'promotion_event_deliveries']) {
      const { rows } = await pool.query(`SELECT count(*)::int AS count FROM ${table}`);
      expect(rows[0].count).toBe(0);
    }
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM memories');
    expect(rows[0].count).toBe(1);
  });

  it('claims each delivery once across workers and reclaims expired leases with the same event ID', async () => {
    const { principal, source } = await seed();
    await promoteMemoryWithAudit(
      pool, principal.id, source.id, { kind: 'project', name: 'destination' }, {}, ['hook'],
    );
    const [first, second] = await Promise.all([
      claimPromotionDeliveries(pool, { owner: 'one', webhookIds: ['hook'], limit: 1, leaseMs: 1000 }),
      claimPromotionDeliveries(pool, { owner: 'two', webhookIds: ['hook'], limit: 1, leaseMs: 1000 }),
    ]);
    expect([...first, ...second]).toHaveLength(1);
    const claimed = [...first, ...second][0];
    const consumerSeen = new Set([claimed.event.eventId]);
    expect(claimed.attemptCount).toBe(1);
    expect(await claimPromotionDeliveries(pool, {
      owner: 'three', webhookIds: ['hook'], limit: 1, leaseMs: 1000,
    })).toEqual([]);

    await pool.query(
      `UPDATE promotion_event_deliveries SET lease_expires_at = now() - interval '1 second'`,
    );
    const reclaimed = await claimPromotionDeliveries(pool, {
      owner: 'three', webhookIds: ['hook'], limit: 1, leaseMs: 1000,
    });
    expect(reclaimed[0].event.eventId).toBe(claimed.event.eventId);
    expect(reclaimed[0].attemptCount).toBe(2);
    expect(reclaimed[0].leaseRecovered).toBe(true);
    expect(consumerSeen.has(reclaimed[0].event.eventId)).toBe(true);
  });

  it('completes independently, dead-letters safely, and supports explicit manual retry', async () => {
    const { principal, source } = await seed();
    await promoteMemoryWithAudit(
      pool, principal.id, source.id, { kind: 'project', name: 'destination' }, {},
      ['good', 'bad'],
    );
    const claimed = await claimPromotionDeliveries(pool, {
      owner: 'worker', webhookIds: ['good', 'bad'], limit: 2, leaseMs: 1000,
    });
    const good = claimed.find((item) => item.webhookId === 'good')!;
    const bad = claimed.find((item) => item.webhookId === 'bad')!;
    expect(await completePromotionDelivery(pool, good.event.eventId, 'good', 'worker')).toBe(true);
    expect(await failPromotionDelivery(pool, bad.event.eventId, 'bad', 'worker', {
      maxAttempts: 1, retryDelayMs: 25, error: new Error('token=secret-value'),
    })).toBe('dead_letter');
    const { rows } = await pool.query(
      `SELECT webhook_id, state, last_error FROM promotion_event_deliveries ORDER BY webhook_id`,
    );
    expect(rows).toEqual([
      { webhook_id: 'bad', state: 'dead_letter', last_error: 'callback failed' },
      { webhook_id: 'good', state: 'delivered', last_error: null },
    ]);
    expect(await manualRetryPromotionDelivery(pool, bad.event.eventId, 'bad')).toBe(true);
    const retried = await claimPromotionDeliveries(pool, {
      owner: 'retry', webhookIds: ['bad'], limit: 1, leaseMs: 1000,
    });
    expect(retried[0].event.eventId).toBe(bad.event.eventId);
    expect(retried[0].attemptCount).toBe(1);
    expect(await releasePromotionDeliveries(pool, 'retry')).toBe(1);
  });

  it('renews only leases owned by the stopping worker', async () => {
    const { principal, source } = await seed();
    await promoteMemoryWithAudit(
      pool, principal.id, source.id, { kind: 'project', name: 'destination' }, {}, ['hook'],
    );
    await claimPromotionDeliveries(pool, {
      owner: 'worker', webhookIds: ['hook'], limit: 1, leaseMs: 1000,
    });
    await pool.query(
      `UPDATE promotion_event_deliveries SET lease_expires_at = now() - interval '1 second'`,
    );

    expect(await renewPromotionDeliveries(pool, 'other-worker', 1000)).toBe(0);
    expect(await renewPromotionDeliveries(pool, 'worker', 1000)).toBe(1);
    expect(await claimPromotionDeliveries(pool, {
      owner: 'contender', webhookIds: ['hook'], limit: 1, leaseMs: 1000,
    })).toEqual([]);
  });

  it('leaves deliveries for unregistered webhook IDs pending and observable', async () => {
    const { principal, source } = await seed();
    await promoteMemoryWithAudit(
      pool, principal.id, source.id, { kind: 'project', name: 'destination' }, {}, ['missing'],
    );
    expect(await claimPromotionDeliveries(pool, {
      owner: 'worker', webhookIds: [], limit: 10, leaseMs: 1000,
    })).toEqual([]);
    const { rows } = await pool.query('SELECT state, attempt_count FROM promotion_event_deliveries');
    expect(rows).toEqual([{ state: 'pending', attempt_count: 0 }]);
  });
});
