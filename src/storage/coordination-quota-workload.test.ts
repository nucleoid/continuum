import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { acquireLease, releaseLease, renewLease } from '../services/coordination.js';

describe('public combined receipt quota workload', () => {
  let pool: pg.Pool;
  beforeAll(async () => { pool = await makeTestPool(); await resetData(pool); }, 60_000);
  afterAll(async () => pool?.end());

  it('fills the actual combined cap with contention and atomically blocks held renewal and release', async () => {
    const actor = await createPrincipal(pool, {
      externalId: `quota-workload:${randomUUID()}`, kind: 'service', displayName: 'Quota workload',
    });
    const scope = await createScope(pool, { kind: 'project', name: `quota-workload-${randomUUID()}` });
    await addMembership(pool, actor.id, scope.id, 'writer');
    const runId = randomUUID();
    const held = await acquireLease(pool, actor, {
      scope: `project:${scope.name}`, resource: 'held', runId, requestId: randomUUID(), ttlSeconds: 900,
    });
    expect(held.acquired).toBe(true);
    if (!held.acquired) throw new Error('fixture did not acquire the held generation');
    const started = performance.now();
    // Real API operations, including their production authorization, counter,
    // transaction and receipt paths. No manufactured quota counters or rows.
    for (let attempt = 1; attempt < 10_000; attempt += 1) {
      if (performance.now() - started > 180_000) throw new Error('bounded quota workload fixture deadline exceeded');
      const contended = await acquireLease(pool, actor, {
        scope: `project:${scope.name}`, resource: 'held', runId: randomUUID(),
        requestId: randomUUID(), ttlSeconds: 900,
      });
      expect(contended.acquired).toBe(false);
    }
    expect((await pool.query(
      `SELECT count(*)::int AS total, count(*) FILTER(WHERE outcome='contended')::int AS contended
         FROM coordination_operation_receipts WHERE principal_id = $1`, [actor.id],
    )).rows[0]).toEqual({ total: 10_000, contended: 9_999 });
    const before = (await pool.query(
      'SELECT expires_at, released_at FROM coordination_leases WHERE lease_id = $1', [held.leaseId],
    )).rows[0];
    await expect(renewLease(pool, actor, { leaseId: held.leaseId, runId, requestId: randomUUID(), ttlSeconds: 900 }))
      .rejects.toMatchObject({ code: 'COORDINATION_QUOTA_EXCEEDED' });
    await expect(releaseLease(pool, actor, { leaseId: held.leaseId, runId, requestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'COORDINATION_QUOTA_EXCEEDED' });
    expect((await pool.query(
      'SELECT expires_at, released_at FROM coordination_leases WHERE lease_id = $1', [held.leaseId],
    )).rows[0]).toEqual(before);
    expect((await pool.query(
      'SELECT current_lease_id FROM coordination_resources WHERE scope_id = $1 AND resource = $2', [scope.id, 'held'],
    )).rows[0].current_lease_id).toBe(held.leaseId);
    console.info('combined-receipt-quota-workload', JSON.stringify({ total: 10_000,
      contended: 9_999, elapsedMs: Math.round(performance.now() - started) }));
  }, 240_000);
});
