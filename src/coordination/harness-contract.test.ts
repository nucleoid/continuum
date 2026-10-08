import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import {
  acquireLease,
  releaseLease,
  renewLease,
} from '../services/coordination.js';

describe('test-only coordination harness contract', () => {
  let pool: pg.Pool;
  let principal: Awaited<ReturnType<typeof createPrincipal>>;
  let scopeId: string;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
    principal = await createPrincipal(pool, {
      externalId: 'service:test-harness',
      kind: 'service',
      displayName: 'Test harness',
    });
    const scope = await createScope(pool, { kind: 'project', name: 'harness' });
    scopeId = scope.id;
    await addMembership(pool, principal.id, scope.id, 'writer');
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function dispatch(resource: string, runId: string): Promise<boolean> {
    const lease = await acquireLease(pool, principal, {
      scope: 'project:harness',
      resource,
      runId,
      requestId: randomUUID(),
      ttlSeconds: 300,
    });
    return lease.acquired;
  }

  it('acquires before dispatch and contention prevents duplicate work', async () => {
    const resource = 'github:nucleoid/continuum:issue:7';
    const dispatched = await Promise.all([
      dispatch(resource, randomUUID()),
      dispatch(resource, randomUUID()),
    ]);
    expect(dispatched.filter(Boolean)).toHaveLength(1);
  });

  it('pauses publication after renewal loss', async () => {
    const runId = randomUUID();
    const acquired = await acquireLease(pool, principal, {
      scope: 'project:harness',
      resource: 'publication',
      runId,
      requestId: randomUUID(),
    });
    expect(acquired.acquired).toBe(true);
    await pool.query(
      `UPDATE scope_memberships SET active = FALSE, deactivated_at = clock_timestamp()
        WHERE principal_id = $1 AND scope_id = $2`,
      [principal.id, scopeId],
    );
    let publicationAllowed = true;
    try {
      await renewLease(pool, principal, {
        leaseId: acquired.acquired ? acquired.leaseId : '',
        runId,
        requestId: randomUUID(),
      });
    } catch {
      publicationAllowed = false;
    }
    expect(publicationAllowed).toBe(false);
  });

  it('takes over after a crash expiry and stale release cannot clear the successor', async () => {
    const crashedRun = randomUUID();
    const crashed = await acquireLease(pool, principal, {
      scope: 'project:harness',
      resource: 'crash',
      runId: crashedRun,
      requestId: randomUUID(),
    });
    expect(crashed.acquired).toBe(true);
    await pool.query(
      `UPDATE coordination_leases
          SET acquired_at = clock_timestamp() - interval '2 seconds',
              expires_at = clock_timestamp() - interval '1 second'
        WHERE lease_id = $1`,
      [crashed.acquired ? crashed.leaseId : null],
    );
    const successor = await acquireLease(pool, principal, {
      scope: 'project:harness',
      resource: 'crash',
      runId: randomUUID(),
      requestId: randomUUID(),
    });
    expect(successor).toMatchObject({ acquired: true, fencingToken: '2' });
    await expect(releaseLease(pool, principal, {
      leaseId: crashed.acquired ? crashed.leaseId : '',
      runId: crashedRun,
      requestId: randomUUID(),
    })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    const current = await pool.query(
      `SELECT current_lease_id FROM coordination_resources
        WHERE scope_id = $1 AND resource = 'crash'`,
      [scopeId],
    );
    expect(current.rows[0].current_lease_id)
      .toBe(successor.acquired ? successor.leaseId : undefined);
  });

  it('uses deterministic exact-key ordering for multi-resource callers', () => {
    const keys = [
      ['project:harness', 'z'],
      ['project:harness', 'A'],
      ['project:another', 'schema-migrations'],
    ] as Array<[string, string]>;
    expect(keys.sort(([as, ar], [bs, br]) =>
      as.localeCompare(bs) || ar.localeCompare(br))).toEqual([
      ['project:another', 'schema-migrations'],
      ['project:harness', 'A'],
      ['project:harness', 'z'],
    ]);
  });
});
