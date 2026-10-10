import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { makeTestPool, resetData } from './test-helpers.js';
import { acquireLease, inspectLease, releaseLease, renewLease } from '../services/coordination.js';
import { preparePrincipalReceipts } from './coordination.js';

describe('coordination public handoff contract', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => pool?.end());

  async function fixture() {
    const principal = await createPrincipal(pool, {
      externalId: `handoff:${randomUUID()}`, kind: 'service', displayName: 'Handoff',
    });
    const scope = await createScope(pool, { kind: 'project', name: `handoff-${randomUUID()}` });
    await addMembership(pool, principal.id, scope.id, 'writer');
    const input = { scope: `project:${scope.name}`, resource: 'github:private/repo:issue:7', runId: randomUUID(), requestId: randomUUID() };
    return { principal, scope, input };
  }

  it('writes useful bounded audit metadata without an enumerable resource digest', async () => {
    const { principal, input } = await fixture();
    const acquired = await acquireLease(pool, principal, input);
    if (!acquired.acquired) throw new Error('expected acquisition');
    await acquireLease(pool, principal, { ...input, requestId: randomUUID() });
    await inspectLease(pool, principal, { scope: input.scope, resource: input.resource });
    await renewLease(pool, principal, { leaseId: acquired.leaseId, runId: input.runId, requestId: randomUUID() });
    await releaseLease(pool, principal, { leaseId: acquired.leaseId, runId: input.runId, requestId: randomUUID() });
    const { rows } = await pool.query('SELECT metadata FROM audit_log WHERE principal_id = $1', [principal.id]);
    expect(rows).toHaveLength(5);
    for (const { metadata } of rows) {
      expect(metadata).toMatchObject({ resource_bytes: Buffer.byteLength(input.resource) });
      expect(metadata).not.toHaveProperty('resource_sha256');
      expect(metadata).not.toHaveProperty('resource');
    }
  });

  it('skips an expired receipt held by a peer cleanup transaction', async () => {
    const { principal, input } = await fixture();
    await acquireLease(pool, principal, input);
    await pool.query(`UPDATE coordination_operation_receipts SET
      server_time = clock_timestamp() - interval '25 hours',
      retain_until = clock_timestamp() - interval '1 hour'
      WHERE principal_id = $1`, [principal.id]);
    const blocker = await pool.connect();
    const cleaner = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM coordination_operation_receipts WHERE principal_id = $1 FOR UPDATE', [principal.id]);
      await cleaner.query('BEGIN');
      await cleaner.query("SET LOCAL statement_timeout = '500ms'");
      await expect(preparePrincipalReceipts(cleaner, principal.id)).resolves.toBe(1);
      expect((await cleaner.query('SELECT count(*)::int AS count FROM coordination_operation_receipts WHERE principal_id = $1', [principal.id])).rows)
        .toEqual([{ count: 1 }]);
    } finally {
      await cleaner.query('ROLLBACK');
      await blocker.query('ROLLBACK');
      cleaner.release();
      blocker.release();
    }
  });

  it('retains every operation and contention receipt for at least 24 hours', async () => {
    const { principal, input } = await fixture();
    const acquired = await acquireLease(pool, principal, input);
    if (!acquired.acquired) throw new Error('expected acquisition');
    await acquireLease(pool, principal, { ...input, requestId: randomUUID() });
    await renewLease(pool, principal, { leaseId: acquired.leaseId, runId: input.runId, requestId: randomUUID(), ttlSeconds: 30 });
    await releaseLease(pool, principal, { leaseId: acquired.leaseId, runId: input.runId, requestId: randomUUID() });
    const { rows } = await pool.query(`SELECT operation, outcome, retain_until >= server_time + interval '24 hours' AS retained
      FROM coordination_operation_receipts WHERE principal_id = $1`, [principal.id]);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.retained)).toBe(true);
  });

  it('never evicts a retained renewal when a lease records more than 100 renewals', async () => {
    const { principal, input } = await fixture();
    const acquired = await acquireLease(pool, principal, input);
    if (!acquired.acquired) throw new Error('expected acquisition');
    const requestId = randomUUID();
    const renewed = await renewLease(pool, principal, { leaseId: acquired.leaseId, runId: input.runId, requestId });
    await pool.query(`INSERT INTO coordination_operation_receipts
      (principal_id, operation, request_id, payload_hash, outcome, scope_id, resource,
       lease_id, run_id, fencing_token, expires_at, server_time, retain_until)
      SELECT principal_id, operation, gen_random_uuid(), payload_hash, outcome, scope_id, resource,
        lease_id, run_id, fencing_token, expires_at, server_time, retain_until
      FROM coordination_operation_receipts, generate_series(1, 100)
      WHERE principal_id = $1 AND operation = 'renew' AND request_id = $2`, [principal.id, requestId]);
    expect((await pool.query(`SELECT count(*)::int AS count FROM coordination_operation_receipts
      WHERE principal_id = $1 AND operation = 'renew'`, [principal.id])).rows).toEqual([{ count: 101 }]);
    await expect(renewLease(pool, principal, { leaseId: acquired.leaseId, runId: input.runId, requestId }))
      .resolves.toEqual(renewed);
  });

  it('rejects a renewal at the combined 10000 retained receipt limit without changing the lease', async () => {
    const { principal, input } = await fixture();
    const acquired = await acquireLease(pool, principal, input);
    if (!acquired.acquired) throw new Error('expected acquisition');
    await pool.query(`INSERT INTO coordination_operation_receipts
      (principal_id, operation, request_id, payload_hash, outcome, scope_id, resource,
       lease_id, run_id, fencing_token, expires_at, server_time, retain_until)
      SELECT principal_id, operation, gen_random_uuid(), payload_hash, outcome, scope_id, resource,
        lease_id, run_id, fencing_token, expires_at, server_time, retain_until
      FROM coordination_operation_receipts, generate_series(1, 9999)
      WHERE principal_id = $1 AND operation = 'acquire' AND request_id = $2`, [principal.id, input.requestId]);
    const before = (await pool.query('SELECT * FROM coordination_leases WHERE lease_id = $1', [acquired.leaseId])).rows;
    await expect(renewLease(pool, principal, { leaseId: acquired.leaseId, runId: input.runId, requestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'COORDINATION_QUOTA_EXCEEDED' });
    expect((await pool.query('SELECT * FROM coordination_leases WHERE lease_id = $1', [acquired.leaseId])).rows).toEqual(before);
  }, 30_000);
});
