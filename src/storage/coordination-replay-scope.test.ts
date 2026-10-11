import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { acquireLease, releaseLease, renewLease } from '../services/coordination.js';

describe('coordination receipt scope authorization', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 60_000);
  afterAll(async () => pool?.end());

  it.each(['renew', 'release'] as const)('returns LEASE_LOST before checking a %s receipt from a different revoked scope', async (operation) => {
    const actor = await createPrincipal(pool, {
      externalId: `scope-replay:${randomUUID()}`, kind: 'service', displayName: 'Scope replay actor',
    });
    const first = await createScope(pool, { kind: 'project', name: `receipt-first-${randomUUID()}` });
    const second = await createScope(pool, { kind: 'project', name: `receipt-second-${randomUUID()}` });
    await addMembership(pool, actor.id, first.id, 'writer');
    await addMembership(pool, actor.id, second.id, 'writer');
    const runA = randomUUID();
    const runB = randomUUID();
    const leaseA = await acquireLease(pool, actor, {
      scope: `project:${first.name}`, resource: 'first', runId: runA, requestId: randomUUID(), ttlSeconds: 300,
    });
    const leaseB = await acquireLease(pool, actor, {
      scope: `project:${second.name}`, resource: 'second', runId: runB, requestId: randomUUID(), ttlSeconds: 300,
    });
    expect(leaseA.acquired && leaseB.acquired).toBe(true);
    if (!leaseA.acquired || !leaseB.acquired) throw new Error('fixture failed to acquire both leases');
    const requestId = randomUUID();
    const mutate = (leaseId: string, runId: string, ttlSeconds = 300) => operation === 'renew'
      ? renewLease(pool, actor, { leaseId, runId, requestId, ttlSeconds })
      : releaseLease(pool, actor, { leaseId, runId, requestId });
    await mutate(leaseA.leaseId, runA);
    await pool.query('DELETE FROM scope_memberships WHERE principal_id = $1 AND scope_id = $2', [actor.id, first.id]);
    const before = (await pool.query(
      'SELECT expires_at, released_at FROM coordination_leases WHERE lease_id = $1', [leaseB.leaseId],
    )).rows[0];
    await expect(mutate(leaseB.leaseId, runB)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect((await pool.query(
      'SELECT expires_at, released_at FROM coordination_leases WHERE lease_id = $1', [leaseB.leaseId],
    )).rows[0]).toEqual(before);
    expect((await pool.query(
      'SELECT scope_id FROM coordination_operation_receipts WHERE principal_id = $1 AND operation = $2 AND request_id = $3',
      [actor.id, operation, requestId],
    )).rows).toEqual([{ scope_id: first.id }]);
    // A genuinely authorized same-scope changed payload retains CONFLICT.
    await addMembership(pool, actor.id, first.id, 'writer');
    await expect(mutate(leaseA.leaseId, randomUUID(), 301)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
