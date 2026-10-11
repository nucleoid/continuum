import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { makeTestPool, resetData, promoteWithConfiguredWebhooksForTest } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { createMemory } from './memories.js';
import { claimPromotionDeliveries, completePromotionDelivery } from './promotion-events.js';

type ClaimOutcome = { status: 'fulfilled'; value: unknown }
  | { status: 'rejected'; error: unknown };

it('skips blocked promotion normalization SQL and restores its owned session before reuse', async () => {
  const pool = await makeTestPool();
  const claims = new pg.Pool({
    connectionString: process.env.CONTINUUM_TEST_DATABASE_URL
      ?? 'postgres://continuum:continuum@localhost:5433/continuum',
    max: 1, connectionTimeoutMillis: 1_000,
    options: '-c statement_timeout=9000 -c lock_timeout=0',
  });
  let controller: pg.PoolClient | undefined;
  let claimPid: number | undefined;
  let pending: Promise<ClaimOutcome> | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await resetData(pool);
    const principal = await createPrincipal(pool, {
      externalId: `sql-review-${randomUUID()}`, kind: 'user', displayName: 'SQL Review',
    });
    const sourceScope = await createScope(pool, { kind: 'team', name: 'sql-review-source' });
    const destinationScope = await createScope(pool, { kind: 'project', name: 'sql-review-target' });
    await addMembership(pool, principal.id, sourceScope.id, 'writer');
    await addMembership(pool, principal.id, destinationScope.id, 'writer');
    const source = await createMemory(pool, { scopeId: sourceScope.id, scopeKind: sourceScope.kind,
      authorId: principal.id, type: 'decision', title: 'SQL wait', body: 'Committed event.', source: 'manual' });
    await promoteWithConfiguredWebhooksForTest(pool, principal.id, source.id,
      { kind: destinationScope.kind, name: destinationScope.name }, {}, ['sql-review-hook']);
    const first = await claimPromotionDeliveries(pool, {
      owner: 'previous-owner', webhookIds: ['sql-review-hook'], limit: 1, leaseMs: 60_000, maxAttempts: 1,
    });
    expect(first).toHaveLength(1);
    await pool.query(`UPDATE promotion_event_deliveries
      SET lease_expires_at=clock_timestamp()-interval '1 second'
      WHERE event_id=$1::uuid AND webhook_id=$2::text`, [first[0].event.eventId, first[0].webhookId]);
    const original = (await claims.query<{ pid: number; statement: string; lock: string }>(
      `SELECT pg_catalog.pg_backend_pid() AS pid,
        pg_catalog.current_setting('statement_timeout') AS statement,
        pg_catalog.current_setting('lock_timeout') AS lock`,
    )).rows[0];
    claimPid = original.pid;
    controller = await pool.connect();
    await controller.query('BEGIN');
    const controllerPid = (await controller.query<{ pid: number }>(
      'SELECT pg_catalog.pg_backend_pid() AS pid',
    )).rows[0].pid;
    await controller.query(`SELECT event_id FROM promotion_event_deliveries
      WHERE event_id=$1::uuid AND webhook_id=$2::text FOR UPDATE`, [first[0].event.eventId, first[0].webhookId]);
    const started = Date.now();
    pending = claimPromotionDeliveries(claims, {
      owner: 'blocked-owner', webhookIds: ['sql-review-hook'], limit: 1, leaseMs: 60_000, maxAttempts: 1,
    }).then((value): ClaimOutcome => ({ status: 'fulfilled', value }),
      (error: unknown): ClaimOutcome => ({ status: 'rejected', error }));
    void pending.then(() => { settled = true; });
    const outcome = await Promise.race([pending, new Promise<{ status: 'still-running' }>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'still-running' }), Math.max(1, started + 2_000 - Date.now()));
    })]);
    if (timer) { clearTimeout(timer); timer = undefined; }
    // Exhausted normalization now skips the actually held row. The separate
    // Pool-backed ACK case below retains the real server 55P03 containment proof.
    expect(outcome.status).toBe('fulfilled');
    if (outcome.status !== 'fulfilled') throw new Error('Normalization did not skip its locked row');
    expect(outcome.value).toEqual([]);
    expect((await controller.query(`SELECT state,lease_owner,attempt_count FROM promotion_event_deliveries
      WHERE event_id=$1::uuid AND webhook_id=$2::text`, [first[0].event.eventId, first[0].webhookId])).rows)
      .toEqual([{ state: 'pending', lease_owner: 'previous-owner', attempt_count: 1 }]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await pool.query(`SELECT pid FROM pg_catalog.pg_stat_activity
      WHERE pid=$1::int AND state='active'`, [claimPid])).rows).toEqual([]);

    // With max=1 this query necessarily reuses the safely returned session or
    // establishes a replacement if storage discarded the original connection.
    const restored = (await claims.query<{ pid: number; statement: string; lock: string }>(
      `SELECT pg_catalog.pg_backend_pid() AS pid,
        pg_catalog.current_setting('statement_timeout') AS statement,
        pg_catalog.current_setting('lock_timeout') AS lock`,
    )).rows[0];
    expect(restored.statement).toBe(original.statement);
    expect(restored.lock).toBe(original.lock);
    await controller.query('ROLLBACK');
    controller.release(); controller = undefined;
    // A successful retry also preserves caller limits stricter than the
    // proposed routine defaults. It must not retain temporary storage settings.
    await claims.query("SET statement_timeout='1500ms'; SET lock_timeout='250ms'");
    const recovered = await claimPromotionDeliveries(claims, {
      owner: 'recovered-owner', webhookIds: ['sql-review-hook'], limit: 1, leaseMs: 60_000, maxAttempts: 2,
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0].event.eventId).toBe(first[0].event.eventId);
    expect(recovered[0].attemptCount).toBe(2);
    expect(recovered[0].leaseGeneration).toBe(first[0].leaseGeneration + 1);
    expect((await claims.query(`SELECT pg_catalog.current_setting('statement_timeout') AS statement,
      pg_catalog.current_setting('lock_timeout') AS lock`)).rows)
      .toEqual([{ statement: '1500ms', lock: '250ms' }]);
  } finally {
    if (timer) clearTimeout(timer);
    // Old source is deliberately still blocked when its assertion fails. Cancel
    // that actual backend before unlocking, so cleanup cannot commit its late
    // normalization or leak an active query/unhandled rejection into the suite.
    try {
      if (pending && !settled && claimPid !== undefined) {
        await pool.query('SELECT pg_catalog.pg_cancel_backend($1::int)', [claimPid]);
      }
      if (pending) await pending;
    } finally {
      if (controller) {
        await controller.query('ROLLBACK');
        controller.release();
      }
      if (pending) await pending;
      await claims.end();
      await pool.end();
    }
  }
}, 15_000);

async function seedAcknowledgement(pool: pg.Pool) {
  const principal = await createPrincipal(pool, {
    externalId: `ack-review-${randomUUID()}`, kind: 'user', displayName: 'ACK Review',
  });
  const sourceScope = await createScope(pool, { kind: 'team', name: 'ack-review-source' });
  const destinationScope = await createScope(pool, { kind: 'project', name: 'ack-review-target' });
  await addMembership(pool, principal.id, sourceScope.id, 'writer');
  await addMembership(pool, principal.id, destinationScope.id, 'writer');
  const source = await createMemory(pool, { scopeId: sourceScope.id, scopeKind: sourceScope.kind,
    authorId: principal.id, type: 'decision', title: 'Acknowledgement', body: 'Actual committed event.', source: 'manual' });
  await promoteWithConfiguredWebhooksForTest(pool, principal.id, source.id,
    { kind: destinationScope.kind, name: destinationScope.name }, {}, ['ack-review-hook']);
  const deliveries = await claimPromotionDeliveries(pool, {
    owner: 'ack-owner', webhookIds: ['ack-review-hook'], limit: 1, leaseMs: 60_000,
  });
  expect(deliveries).toHaveLength(1);
  return deliveries[0];
}

it('bounds a Pool-backed acknowledgement while its row is locked and safely restores the owned session', async () => {
  const pool = await makeTestPool();
  const acknowledgements = new pg.Pool({
    connectionString: process.env.CONTINUUM_TEST_DATABASE_URL
      ?? 'postgres://continuum:continuum@localhost:5433/continuum',
    max: 1, connectionTimeoutMillis: 1_000,
    options: '-c statement_timeout=9000 -c lock_timeout=0',
  });
  let controller: pg.PoolClient | undefined;
  let ackPid: number | undefined;
  let pending: Promise<ClaimOutcome> | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await resetData(pool);
    const delivery = await seedAcknowledgement(pool);
    const original = (await acknowledgements.query<{ pid: number; statement: string; lock: string }>(
      `SELECT pg_catalog.pg_backend_pid() AS pid,
        pg_catalog.current_setting('statement_timeout') AS statement,
        pg_catalog.current_setting('lock_timeout') AS lock`,
    )).rows[0];
    ackPid = original.pid;
    controller = await pool.connect();
    await controller.query('BEGIN');
    const controllerPid = (await controller.query<{ pid: number }>(
      'SELECT pg_catalog.pg_backend_pid() AS pid',
    )).rows[0].pid;
    await controller.query(`SELECT event_id FROM promotion_event_deliveries
      WHERE event_id=$1::uuid AND webhook_id=$2::text FOR UPDATE`, [delivery.event.eventId, delivery.webhookId]);
    const started = Date.now();
    pending = completePromotionDelivery(acknowledgements, delivery.event.eventId, delivery.webhookId,
      'ack-owner', delivery.attemptCount, delivery.leaseGeneration)
      .then((value): ClaimOutcome => ({ status: 'fulfilled', value }),
        (error: unknown): ClaimOutcome => ({ status: 'rejected', error }));
    void pending.then(() => { settled = true; });
    let blocked = false;
    while (Date.now() < started + 750) {
      blocked = (await pool.query<{ blocked: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity
          WHERE pid=$1::int AND state='active' AND wait_event_type='Lock'
            AND query LIKE '%UPDATE promotion_event_deliveries%'
            AND $2::int=ANY(pg_catalog.pg_blocking_pids(pid))) AS blocked`,
        [ackPid, controllerPid],
      )).rows[0].blocked;
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(blocked, 'the actual Pool-backed ACK must reach the controller row lock').toBe(true);
    const outcome = await Promise.race([pending, new Promise<{ status: 'still-running' }>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'still-running' }), Math.max(1, started + 2_000 - Date.now()));
    })]);
    if (timer) { clearTimeout(timer); timer = undefined; }
    expect(outcome.status, 'the actual ACK SQL must stop on its server lock bound before the watch expires')
      .toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('Pool-backed ACK outlived its bounded watch');
    expect(outcome.error).toMatchObject({ code: '55P03' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await pool.query(`SELECT pid FROM pg_catalog.pg_stat_activity
      WHERE pid=$1::int AND state='active'`, [ackPid])).rows).toEqual([]);
    const restored = (await acknowledgements.query<{ statement: string; lock: string }>(
      `SELECT pg_catalog.current_setting('statement_timeout') AS statement,
        pg_catalog.current_setting('lock_timeout') AS lock`,
    )).rows[0];
    expect(restored).toEqual({ statement: original.statement, lock: original.lock });
    await controller.query('ROLLBACK');
    controller.release(); controller = undefined;
    await acknowledgements.query("SET statement_timeout='1500ms'; SET lock_timeout='250ms'");
    expect(await completePromotionDelivery(acknowledgements, delivery.event.eventId, delivery.webhookId,
      'ack-owner', delivery.attemptCount, delivery.leaseGeneration)).toBe(true);
    expect((await acknowledgements.query(`SELECT pg_catalog.current_setting('statement_timeout') AS statement,
      pg_catalog.current_setting('lock_timeout') AS lock`)).rows)
      .toEqual([{ statement: '1500ms', lock: '250ms' }]);
    expect((await pool.query('SELECT state FROM promotion_event_deliveries')).rows).toEqual([{ state: 'delivered' }]);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      if (pending && !settled && ackPid !== undefined) {
        await pool.query('SELECT pg_catalog.pg_cancel_backend($1::int)', [ackPid]);
      }
      if (pending) await pending;
    } finally {
      if (controller) { await controller.query('ROLLBACK'); controller.release(); }
      if (pending) await pending;
      await acknowledgements.end();
      await pool.end();
    }
  }
}, 15_000);

it('keeps borrowed acknowledgement transaction settings and independent caller locks intact', async () => {
  const pool = await makeTestPool();
  let caller: pg.PoolClient | undefined;
  try {
    await resetData(pool);
    const delivery = await seedAcknowledgement(pool);
    caller = await pool.connect();
    await caller.query('BEGIN');
    await caller.query("SET LOCAL statement_timeout='1500ms'; SET LOCAL lock_timeout='250ms'");
    const key = BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 14)}`).toString();
    await caller.query('SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)', [key]);
    const transaction = (await caller.query('SELECT pg_catalog.txid_current() AS id')).rows[0].id;
    expect(await completePromotionDelivery(caller, delivery.event.eventId, delivery.webhookId,
      'ack-owner', delivery.attemptCount, delivery.leaseGeneration)).toBe(true);
    expect((await caller.query('SELECT pg_catalog.txid_current() AS id')).rows).toEqual([{ id: transaction }]);
    expect((await caller.query(`SELECT pg_catalog.current_setting('statement_timeout') AS statement,
      pg_catalog.current_setting('lock_timeout') AS lock`)).rows)
      .toEqual([{ statement: '1500ms', lock: '250ms' }]);
    expect((await pool.query('SELECT pg_catalog.pg_try_advisory_xact_lock($1::bigint) AS acquired', [key])).rows)
      .toEqual([{ acquired: false }]);
    // Another session still sees pending: the helper must not commit its
    // caller's transaction merely because its acknowledged UPDATE succeeded.
    expect((await pool.query('SELECT state FROM promotion_event_deliveries')).rows).toEqual([{ state: 'pending' }]);
    expect((await caller.query('SELECT state FROM promotion_event_deliveries')).rows).toEqual([{ state: 'delivered' }]);
    await caller.query('ROLLBACK');
    caller.release(); caller = undefined;
    expect((await pool.query('SELECT state FROM promotion_event_deliveries')).rows).toEqual([{ state: 'pending' }]);
    expect((await pool.query('SELECT pg_catalog.pg_try_advisory_xact_lock($1::bigint) AS acquired', [key])).rows)
      .toEqual([{ acquired: true }]);
  } finally {
    if (caller) { await caller.query('ROLLBACK'); caller.release(); }
    await pool.end();
  }
}, 15_000);
