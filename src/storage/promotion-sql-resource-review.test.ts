import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { createMemory } from './memories.js';
import { promoteMemoryWithAudit } from './promote.js';
import { claimPromotionDeliveries } from './promotion-events.js';

type ClaimOutcome = { status: 'fulfilled'; value: unknown }
  | { status: 'rejected'; error: unknown };

it('bounds blocked promotion normalization SQL and restores or discards its owned session before reuse', async () => {
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
    await promoteMemoryWithAudit(pool, principal.id, source.id,
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
    const blockingDeadline = started + 750;
    let blocked = false;
    while (Date.now() < blockingDeadline) {
      blocked = (await pool.query<{ blocked: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity
          WHERE pid=$1::int AND state='active' AND wait_event_type='Lock'
            AND query LIKE '%UPDATE promotion_event_deliveries%'
            AND $2::int=ANY(pg_catalog.pg_blocking_pids(pid))) AS blocked`,
        [claimPid, controllerPid],
      )).rows[0].blocked;
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(blocked, 'the real normalization UPDATE must be waiting on the controller row lock').toBe(true);
    const outcome = await Promise.race([pending, new Promise<{ status: 'still-running' }>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'still-running' }), Math.max(1, started + 2_000 - Date.now()));
    })]);
    if (timer) { clearTimeout(timer); timer = undefined; }
    // A worker-side Promise race is insufficient: storage must stop its actual
    // SQL while the controller still owns the row, then release safely.
    expect(outcome.status, 'storage SQL must fail on its server lock bound before the finite watch expires')
      .toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('Storage SQL outlived its bounded watch');
    expect(outcome.error).toMatchObject({ code: '55P03' });
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
