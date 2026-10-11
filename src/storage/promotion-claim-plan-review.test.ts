import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPool, resetData, promoteWithConfiguredWebhooksForTest } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { createMemory } from './memories.js';
import { claimPromotionDeliveries, failPromotionDelivery, releasePromotionDeliveries } from './promotion-events.js';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

function deliveryWork(plan: PlanNode): number {
  const own = plan['Relation Name'] === 'promotion_event_deliveries' && /Scan$/.test(plan['Node Type'])
    ? ((plan['Actual Rows'] ?? 0) + (plan['Rows Removed by Filter'] ?? 0)
      + (plan['Rows Removed by Index Recheck'] ?? 0)) * (plan['Actual Loops'] ?? 1) : 0;
  return own + (plan.Plans ?? []).reduce((sum, child) => sum + deliveryWork(child), 0);
}

function indexes(plan: PlanNode): string[] {
  return [...(plan['Index Name'] ? [plan['Index Name']] : []), ...(plan.Plans ?? []).flatMap(indexes)];
}

function measuredWrites(pool: pg.Pool) {
  const plans: Array<{ kind: 'claim' | 'normalization' | 'release'; plan: PlanNode }> = [];
  const measured = new Proxy(pool, {
    get(target, property, receiver) {
      if (property !== 'connect') return Reflect.get(target, property, receiver);
      return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(connection, key) {
          if (key === 'query') return async (...args: unknown[]) => {
            const sql = args[0];
            if (typeof sql === 'string' && /UPDATE\s+promotion_event_deliveries/i.test(sql)) {
              await connection.query('SAVEPOINT promotion_tail_plan_probe');
              const result = await Reflect.apply(connection.query, connection,
                [`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, ...args.slice(1)]);
              plans.push({ kind: /JOIN\s+promotion_events/i.test(sql) ? 'claim'
                : /SET\s+lease_owner\s*=\s*NULL/i.test(sql) ? 'release' : 'normalization',
              plan: result.rows[0]['QUERY PLAN'][0].Plan as PlanNode });
              await connection.query('ROLLBACK TO SAVEPOINT promotion_tail_plan_probe');
              await connection.query('RELEASE SAVEPOINT promotion_tail_plan_probe');
            }
            return Reflect.apply(connection.query, connection, args);
          };
          const value = Reflect.get(connection, key);
          return typeof value === 'function' ? value.bind(connection) : value;
        } });
      };
    },
  });
  return { pool: measured, metrics: () => plans.map(({ kind, plan }) => ({ kind,
    examinedDeliveryRows: deliveryWork(plan),
    sharedBuffers: (plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0), indexes: indexes(plan) })) };
}

describe('promotion claim plan review', () => {
  let pool: pg.Pool;
  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });
  afterAll(async () => pool?.end());

  async function producer() {
    const principal = await createPrincipal(pool, {
      externalId: `claim-plan-${randomUUID()}`, kind: 'user', displayName: 'Claim Plan',
    });
    const source = await createScope(pool, { kind: 'team', name: 'claim-plan-source' });
    const destination = await createScope(pool, { kind: 'project', name: 'claim-plan-target' });
    await addMembership(pool, principal.id, source.id, 'writer');
    await addMembership(pool, principal.id, destination.id, 'writer');
    return async (hook: string) => {
      const memory = await createMemory(pool, { scopeId: source.id, scopeKind: source.kind,
        authorId: principal.id, type: 'decision', title: 'Pending promotion', body: 'Small fixture body.', source: 'manual' });
      return promoteWithConfiguredWebhooksForTest(pool, principal.id, memory.id,
        { kind: destination.kind, name: destination.name }, {}, [hook]);
    };
  }

  it('seeks a bounded requested prefix without scanning unrelated IDs or the whole requested backlog', async () => {
    const promote = await producer();
    const requestedBacklog = 512;
    const unrelatedDeliveries = 8192;
    let firstEvent: string | undefined;
    for (let index = 0; index < requestedBacklog; index += 1) {
      const promoted = await promote('plan-requested');
      firstEvent ??= promoted.promotionEvent.eventId;
    }
    // Removed consumers leave valid pending deliveries by contract. A genuine
    // canonical event supplies every FK/provenance check for this bulk fixture;
    // the normal delivery privacy trigger remains enabled for every INSERT.
    await pool.query(`INSERT INTO promotion_event_deliveries(event_id,webhook_id)
      SELECT $1::uuid,'unregistered-'||pg_catalog.lpad(id::text,5,'0')
      FROM pg_catalog.generate_series(1,$2::int) id`, [firstEvent, unrelatedDeliveries]);
    const guards = (await pool.query<{ total: number; disabled: number }>(
      `SELECT count(*)::int AS total,count(*) FILTER(WHERE tgenabled='D')::int AS disabled
        FROM pg_catalog.pg_trigger WHERE NOT tgisinternal AND tgrelid=ANY(ARRAY[
          'memories'::regclass,'promotion_events'::regclass,'promotion_event_deliveries'::regclass])`,
    )).rows[0];
    expect(guards.total).toBeGreaterThan(0);
    expect(guards.disabled).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE webhook_id='plan-requested')::int AS requested
      FROM promotion_event_deliveries WHERE state='pending'`)).rows)
      .toEqual([{ total: requestedBacklog + unrelatedDeliveries, requested: requestedBacklog }]);
    await pool.query('ANALYZE promotion_events; ANALYZE promotion_event_deliveries');
    const plans: Array<{ kind: 'claim' | 'normalization'; plan: PlanNode }> = [];
    const measuredPool = new Proxy(pool, {
      get(target, property, receiver) {
        if (property !== 'connect') return Reflect.get(target, property, receiver);
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, key) {
              if (key === 'query') return async (...args: unknown[]) => {
                const sql = args[0];
                if (typeof sql === 'string' && /UPDATE\s+promotion_event_deliveries/i.test(sql)) {
                  // Execute the actual parameterized production statement and
                  // its actual plan. Roll back only this measurement so the
                  // unchanged statement can still return its normal rows.
                  await connection.query('SAVEPOINT promotion_plan_probe');
                  const result = await Reflect.apply(connection.query, connection,
                    [`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, ...args.slice(1)]);
                  plans.push({ kind: /JOIN\s+promotion_events/i.test(sql) ? 'claim' : 'normalization',
                    plan: result.rows[0]['QUERY PLAN'][0].Plan as PlanNode });
                  await connection.query('ROLLBACK TO SAVEPOINT promotion_plan_probe');
                  await connection.query('RELEASE SAVEPOINT promotion_plan_probe');
                }
                return Reflect.apply(connection.query, connection, args);
              };
              const value = Reflect.get(connection, key);
              return typeof value === 'function' ? value.bind(connection) : value;
            },
          });
        };
      },
    });
    const claimed = await claimPromotionDeliveries(measuredPool, {
      owner: 'plan-owner', webhookIds: ['plan-requested'], limit: 1, perWebhookLimit: 1, leaseMs: 60_000,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].webhookId).toBe('plan-requested');
    const metrics = plans.map(({ kind, plan }) => ({ kind, examinedDeliveryRows: deliveryWork(plan),
      sharedBuffers: (plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0), indexes: indexes(plan) }));
    console.info(JSON.stringify({ event: 'promotion_claim_plan_review', requestedBacklog, unrelatedDeliveries, metrics }));
    const claimMetrics = metrics.filter((metric) => metric.kind === 'claim');
    expect(claimMetrics).toHaveLength(1);
    // One requested row with no locked/ineligible prefix should require a small
    // index-seeking prefix, not either 512 requested rows or 8704 global rows.
    // The allowance includes rechecks/joins without prescribing a plan shape.
    expect(claimMetrics[0].examinedDeliveryRows).toBeLessThanOrEqual(64);
    expect(claimMetrics[0].sharedBuffers).toBeLessThanOrEqual(256);
    expect((await pool.query(`SELECT count(*)::int AS leased FROM promotion_event_deliveries
      WHERE webhook_id<>'plan-requested' AND lease_owner IS NOT NULL`)).rows).toEqual([{ leased: 0 }]);
  }, 120_000);

  it('skips a locked exhausted normalization row and claims healthy work for the same hook', async () => {
    const promote = await producer();
    const exhausted = await promote('same-hook');
    const prior = await claimPromotionDeliveries(pool, {
      owner: 'exhausted-owner', webhookIds: ['same-hook'], limit: 1, leaseMs: 60_000, maxAttempts: 1,
    });
    expect(prior).toHaveLength(1);
    expect(prior[0].event.eventId).toBe(exhausted.promotionEvent.eventId);
    await pool.query(`UPDATE promotion_event_deliveries SET lease_expires_at=pg_catalog.clock_timestamp()-interval '1 second'
      WHERE event_id=$1::uuid AND webhook_id='same-hook'`, [prior[0].event.eventId]);
    const healthy = await promote('same-hook');
    const controller = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await controller.query('BEGIN');
      await controller.query(`SELECT event_id FROM promotion_event_deliveries
        WHERE event_id=$1::uuid AND webhook_id='same-hook' FOR UPDATE`, [prior[0].event.eventId]);
      const started = Date.now();
      pending = claimPromotionDeliveries(pool, {
        owner: 'healthy-owner', webhookIds: ['same-hook'], limit: 1, leaseMs: 60_000, maxAttempts: 1,
      });
      void pending.catch(() => undefined);
      const claimed = await pending;
      expect(claimed).toEqual([expect.objectContaining({ webhookId: 'same-hook',
        event: expect.objectContaining({ eventId: healthy.promotionEvent.eventId }), attemptCount: 1 })]);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect((await controller.query(`SELECT state,lease_owner,attempt_count FROM promotion_event_deliveries
        WHERE event_id=$1::uuid AND webhook_id='same-hook'`, [prior[0].event.eventId])).rows)
        .toEqual([{ state: 'pending', lease_owner: 'exhausted-owner', attempt_count: 1 }]);
    } finally {
      await controller.query('ROLLBACK');
      controller.release();
      if (pending) await pending.catch(() => undefined);
    }
  }, 15_000);

  it('bounds limit-one scans with a registered future backoff tail and live leased front', async () => {
    const promote = await producer();
    const tail = 1024;
    const hook = 'plan-backoff';
    for (let index = 0; index < tail; index += 1) await promote(hook);
    let failed = 0;
    while (failed < tail) {
      const batch = await claimPromotionDeliveries(pool, { owner: 'backoff-owner', webhookIds: [hook],
        limit: 100, perWebhookLimit: 100, leaseMs: 60_000, maxAttempts: 10 });
      expect(batch.length).toBeGreaterThan(0);
      for (const delivery of batch) {
        expect(await failPromotionDelivery(pool, delivery.event.eventId, hook, 'backoff-owner', {
          maxAttempts: 10, retryDelayMs: 300_000, error: new Error('Backoff fixture'),
          attemptCount: delivery.attemptCount, leaseGeneration: delivery.leaseGeneration,
        })).toBe('pending');
        failed += 1;
      }
    }
    // These are actual live claims at the front, not manufactured lease or
    // attempt counters. With no eligible row, limit1 must not scan future time.
    await promote(hook); await promote(hook);
    expect(await claimPromotionDeliveries(pool, { owner: 'leased-front', webhookIds: [hook],
      limit: 2, perWebhookLimit: 2, leaseMs: 60_000, maxAttempts: 10 })).toHaveLength(2);
    expect((await pool.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE available_at>pg_catalog.clock_timestamp())::int AS future,
      count(*) FILTER(WHERE lease_expires_at>pg_catalog.clock_timestamp())::int AS leased
      FROM promotion_event_deliveries WHERE webhook_id=$1::text AND state='pending'`, [hook])).rows)
      .toEqual([{ total: tail + 2, future: tail, leased: 2 }]);
    await pool.query('ANALYZE promotion_events; ANALYZE promotion_event_deliveries');
    const measured = measuredWrites(pool);
    expect(await claimPromotionDeliveries(measured.pool, { owner: 'no-due-work', webhookIds: [hook],
      limit: 1, perWebhookLimit: 1, leaseMs: 60_000, maxAttempts: 10 })).toEqual([]);
    // A valid reduction in retry allowance also makes the normalization lookup
    // consider the same future tail; it must wait for availability without
    // walking every future row or changing any of their durable failures.
    expect(await claimPromotionDeliveries(measured.pool, { owner: 'lowered-attempt-budget', webhookIds: [hook],
      limit: 1, perWebhookLimit: 1, leaseMs: 60_000, maxAttempts: 1 })).toEqual([]);
    const metrics = measured.metrics();
    console.info(JSON.stringify({ event: 'promotion_backoff_tail_plan_review', tail, leasedFront: 2, metrics }));
    expect(metrics.filter((metric) => metric.kind === 'claim')).toHaveLength(2);
    expect(metrics.filter((metric) => metric.kind === 'normalization')).toHaveLength(2);
    for (const metric of metrics) {
      expect(metric.examinedDeliveryRows).toBeLessThanOrEqual(64);
      expect(metric.sharedBuffers).toBeLessThanOrEqual(256);
    }
    expect((await pool.query(`SELECT count(*)::int AS pending FROM promotion_event_deliveries
      WHERE webhook_id=$1::text AND state='pending' AND attempt_count=1`, [hook])).rows)
      .toEqual([{ pending: tail + 2 }]);
  }, 180_000);

  it('bounds actual shutdown release work to its owner instead of unrelated pending IDs', async () => {
    const promote = await producer();
    const event = await promote('release-requested');
    const owned = await claimPromotionDeliveries(pool, { owner: 'release-owner', webhookIds: ['release-requested'],
      limit: 1, leaseMs: 60_000 });
    expect(owned).toHaveLength(1);
    const unrelated = 8192;
    await pool.query(`INSERT INTO promotion_event_deliveries(event_id,webhook_id)
      SELECT $1::uuid,'release-unregistered-'||pg_catalog.lpad(id::text,5,'0')
      FROM pg_catalog.generate_series(1,$2::int) id`, [event.promotionEvent.eventId, unrelated]);
    await pool.query('ANALYZE promotion_events; ANALYZE promotion_event_deliveries');
    const measured = measuredWrites(pool);
    expect(await releasePromotionDeliveries(measured.pool, 'release-owner')).toBe(1);
    const metrics = measured.metrics();
    console.info(JSON.stringify({ event: 'promotion_shutdown_release_plan_review', unrelated, metrics }));
    expect(metrics).toHaveLength(1);
    expect(metrics[0].kind).toBe('release');
    expect(metrics[0].examinedDeliveryRows).toBeLessThanOrEqual(64);
    expect(metrics[0].sharedBuffers).toBeLessThanOrEqual(256);
    expect((await pool.query(`SELECT lease_owner,lease_expires_at,attempt_count,lease_generation
      FROM promotion_event_deliveries WHERE event_id=$1::uuid AND webhook_id='release-requested'`,
    [event.promotionEvent.eventId])).rows).toEqual([{ lease_owner: null, lease_expires_at: null,
      attempt_count: owned[0].attemptCount, lease_generation: String(owned[0].leaseGeneration) }]);
    expect((await pool.query(`SELECT count(*)::int AS untouched FROM promotion_event_deliveries
      WHERE webhook_id<>'release-requested' AND state='pending' AND lease_owner IS NULL AND attempt_count=0`)).rows)
      .toEqual([{ untouched: unrelated }]);
  }, 30_000);
});
