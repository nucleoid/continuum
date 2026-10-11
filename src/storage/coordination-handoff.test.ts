import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';
import { makeTestPool, resetData } from './test-helpers.js';
import { acquireLease, inspectLease, releaseLease, renewLease } from '../services/coordination.js';
import { preparePrincipalReceipts } from './coordination.js';

describe('coordination public handoff contract', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => pool?.end());


  it('resets detached history to the disabled production principal and hard quota', async () => {
    expect((await pool.query(
      `SELECT principal.disabled_at IS NOT NULL AS disabled,
              usage.acquire_receipt_limit, usage.contended_receipt_limit,
              usage.acquire_receipt_count + usage.contended_receipt_count + usage.mutation_receipt_count AS total
         FROM principals principal LEFT JOIN coordination_principal_usage usage ON usage.principal_id=principal.id
        WHERE principal.id='00000000-0000-4000-8000-000000000012'`,
    )).rows).toEqual([{ disabled: true, acquire_receipt_limit: 10000,
      contended_receipt_limit: 10000, total: 0 }]);
  });

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
  }, 120_000);

  async function eraseWithHeldHighResource() {
    const operator = await createPrincipal(pool, {
      externalId: `erase:${randomUUID()}`, kind: 'user', displayName: 'Operator',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, operator.id, org.id, 'admin');
    const scope = await createScope(pool, { kind: 'user', name: `erase-${randomUUID()}` });
    await pool.query(`INSERT INTO coordination_resources(scope_id, resource, fencing_token)
      VALUES ($1, 'a-low', 1), ($1, 'z-high', 900)`, [scope.id]);
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(`SELECT 1 FROM coordination_resources
      WHERE scope_id = $1 AND resource = 'z-high' FOR UPDATE`, [scope.id]);
    try {
      await pool.query('SELECT continuum_operator_pseudonymize_scope_v2($1, $2, $3)',
        [operator.id, scope.id, `erased-${scope.id}`]);
      return { operator, scope };
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  }

  it('does not complete scope erasure after skipping a held resource', async () => {
    const { scope } = await eraseWithHeldHighResource();
    expect((await pool.query(`SELECT phase, completed_at FROM coordination_scope_privacy_progress
      WHERE scope_id = $1`, [scope.id])).rows).toEqual([{ phase: 'resources', completed_at: null }]);
  });

  it('preserves the high fencing floor when scope erasure resumes after a held resource', async () => {
    const { operator, scope } = await eraseWithHeldHighResource();
    await pool.query('SELECT continuum_operator_pseudonymize_scope_v2($1, $2, $3)',
      [operator.id, scope.id, `erased-${scope.id}`]);
    expect((await pool.query('SELECT fencing_floor::text AS floor FROM coordination_scope_fencing_floors WHERE scope_id = $1', [scope.id])).rows)
      .toEqual([{ floor: '900' }]);
    expect((await pool.query('SELECT count(*)::int AS count FROM coordination_resources WHERE scope_id = $1', [scope.id])).rows)
      .toEqual([{ count: 0 }]);
  });

  it('resumes bounded counter repair, preserves over-budget evidence, and gates only fresh mutations', async () => {
    const { principal, scope, input } = await fixture();
    const acquired = await acquireLease(pool, principal, input);
    if (!acquired.acquired) throw new Error('expected acquisition');
    for (let count = 0; count < 2; count += 1) await acquireLease(pool, principal, { ...input, requestId: randomUUID() });
    for (let count = 0; count < 3; count += 1) await renewLease(pool, principal, {
      leaseId: acquired.leaseId, runId: input.runId, requestId: randomUUID(),
    });
    const release = { leaseId: acquired.leaseId, runId: input.runId, requestId: randomUUID() };
    await releaseLease(pool, principal, release);
    const before = (await pool.query(`SELECT operation,request_id,payload_hash FROM coordination_operation_receipts
      WHERE principal_id=$1 ORDER BY operation,request_id`, [principal.id])).rows;
    // Reproduce an older installation's short windows and uncounted mutations.
    await pool.query('ALTER TABLE coordination_operation_receipts DROP CONSTRAINT coordination_receipt_minimum_retention');
    await pool.query('ALTER TABLE coordination_operation_receipts DISABLE TRIGGER coordination_receipt_compatibility_guard');
    try {
      await pool.query(`UPDATE coordination_operation_receipts SET retain_until=server_time+interval '90 seconds'
        WHERE principal_id=$1 AND (operation='renew' OR outcome='contended')`, [principal.id]);
    } finally {
      await pool.query('ALTER TABLE coordination_operation_receipts ENABLE TRIGGER coordination_receipt_compatibility_guard');
      await pool.query(`ALTER TABLE coordination_operation_receipts ADD CONSTRAINT coordination_receipt_minimum_retention
        CHECK(retain_until>=server_time+interval '24 hours') NOT VALID`);
    }
    await pool.query(`UPDATE coordination_principal_usage SET mutation_receipt_count=0,acquire_receipt_limit=3 WHERE principal_id=$1`, [principal.id]);
    await pool.query('UPDATE coordination_scope_usage SET resource_limit=20000 WHERE scope_id=$1', [scope.id]);
    await pool.query(`UPDATE coordination_contract_backfill_state SET phase='usage',principal_cursor=NULL,scope_cursor=NULL,
      receipt_principal_cursor=NULL,receipt_operation_cursor=NULL,receipt_request_cursor=NULL WHERE singleton`);
    try {
      await expect(acquireLease(pool, principal, { ...input, resource: 'pending-repair', requestId: randomUUID() }))
        .rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
      await expect(releaseLease(pool, principal, release)).resolves.toEqual({ released: true, alreadyReleased: true });
      let complete = false;
      for (let batch = 0; batch < 20 && !complete; batch += 1) {
        complete = (await pool.query('SELECT continuum_backfill_coordination_contract(2) AS complete')).rows[0].complete;
        if (batch === 0) expect(complete).toBe(false);
      }
      expect(complete).toBe(true);
      expect((await pool.query(`SELECT acquire_receipt_count,contended_receipt_count,mutation_receipt_count,acquire_receipt_limit
        FROM coordination_principal_usage WHERE principal_id=$1`, [principal.id])).rows)
        .toEqual([{ acquire_receipt_count: 1, contended_receipt_count: 2, mutation_receipt_count: 4, acquire_receipt_limit: 3 }]);
      expect((await pool.query(`SELECT operation,request_id,payload_hash FROM coordination_operation_receipts
        WHERE principal_id=$1 ORDER BY operation,request_id`, [principal.id])).rows).toEqual(before);
      expect((await pool.query(`SELECT bool_and(retain_until>=server_time+interval '24 hours') AS retained
        FROM coordination_operation_receipts WHERE principal_id=$1`, [principal.id])).rows).toEqual([{ retained: true }]);
      expect((await pool.query('SELECT resource_limit FROM coordination_scope_usage WHERE scope_id=$1', [scope.id])).rows)
        .toEqual([{ resource_limit: 10000 }]);
      await expect(acquireLease(pool, principal, { ...input, requestId: randomUUID() }))
        .rejects.toMatchObject({ code: 'COORDINATION_QUOTA_EXCEEDED' });
      await expect(releaseLease(pool, principal, release)).resolves.toEqual({ released: true, alreadyReleased: true });
    } finally {
      await pool.query("UPDATE coordination_contract_backfill_state SET phase='complete' WHERE singleton");
    }
  }, 30_000);
});
