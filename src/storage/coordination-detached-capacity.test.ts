import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';
import { acquireLease, renewLease, releaseLease } from '../services/coordination.js';
import { mapOwnedUserScope } from '../services/offboarding.js';

const detached = '00000000-0000-4000-8000-000000000012';

describe('coordination detached total receipt capacity', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => pool?.end());

  async function fixture(budget: number) {
    const operator = await createPrincipal(pool, { externalId: `operator:${randomUUID()}`, kind: 'user', displayName: 'Operator' });
    const target = await createPrincipal(pool, { externalId: `target:${randomUUID()}`, kind: 'user', displayName: 'Target' });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const owned = await createScope(pool, { kind: 'user', name: `owned-${randomUUID()}` });
    const shared = await createScope(pool, { kind: 'project', name: `shared-${randomUUID()}` });
    await addMembership(pool, operator.id, org.id, 'admin');
    await addMembership(pool, target.id, owned.id, 'writer');
    await addMembership(pool, target.id, shared.id, 'writer');
    await mapOwnedUserScope(pool, operator, target.id, owned.id);
    const runId = randomUUID();
    const input = { scope: `project:${shared.name}`, resource: 'mixed-receipts', runId, requestId: randomUUID() };
    const held = await acquireLease(pool, target, input);
    if (!held.acquired) throw new Error('expected fixture acquisition');
    await acquireLease(pool, target, { ...input, requestId: randomUUID() });
    await renewLease(pool, target, { leaseId: held.leaseId, runId, requestId: randomUUID() });
    await releaseLease(pool, target, { leaseId: held.leaseId, runId, requestId: randomUUID() });
    const preservedRequest = randomUUID();
    await pool.query(`INSERT INTO coordination_operation_receipts
      (principal_id,operation,request_id,payload_hash,outcome,scope_id,resource,expires_at,server_time,retry_after_seconds,retain_until)
      VALUES($1,'acquire',$2,sha256(convert_to('preserved-anonymous','UTF8')),'contended',$3,'mixed-receipts',
        clock_timestamp()+interval '1 minute',clock_timestamp(),1,clock_timestamp()+interval '24 hours')`,
    [detached, preservedRequest, shared.id]);
    await pool.query('SELECT continuum_operator_set_coordination_principal_quota($1::uuid,$2::uuid,$3::integer,$3::integer)', [operator.id, detached, budget]);
    await pool.query('UPDATE principals SET disabled_at=clock_timestamp() WHERE id=$1', [target.id]);
    const fences = (await pool.query('SELECT resource,fencing_token::text FROM coordination_resources WHERE scope_id=$1', [shared.id])).rows;
    return { operator, target, owned, shared, preservedRequest, fences };
  }

  async function scrub(value: Awaited<ReturnType<typeof fixture>>) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL continuum.client_coordination_privacy_version='4'");
      const { rows } = await client.query('SELECT continuum_operator_scrub_coordination_principal($1,$2,$3,10) AS result',
        [value.operator.id, value.target.id, value.owned.id]);
      await client.query('COMMIT');
      return rows[0].result as { complete: boolean; progressed: boolean; receipts_scrubbed: number; reason: string | null };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function verifyCountsAndEvidence(value: Awaited<ReturnType<typeof fixture>>) {
    expect((await pool.query(`SELECT acquire_receipt_count+contended_receipt_count+mutation_receipt_count AS counted,
      (SELECT count(*)::int FROM coordination_operation_receipts WHERE principal_id=$1) AS actual
      FROM coordination_principal_usage WHERE principal_id=$1`, [detached])).rows).toEqual([{ counted: 1, actual: 1 }]);
    expect((await pool.query('SELECT 1 FROM coordination_operation_receipts WHERE principal_id=$1 AND request_id=$2',
      [detached, value.preservedRequest])).rowCount).toBe(1);
    expect((await pool.query('SELECT resource,fencing_token::text FROM coordination_resources WHERE scope_id=$1', [value.shared.id])).rows)
      .toEqual(value.fences);
  }

  it.each([2, 3])('uses one combined available budget of %i across acquire, contention, renewal, and release', async (budget) => {
    const value = await fixture(budget);
    expect((await scrub(value)).progressed).toBe(true); // Bounded audit phase.
    const receiptBatch = await scrub(value);
    expect(receiptBatch).toMatchObject({ complete: false, progressed: true, receipts_scrubbed: budget - 1 });
    await verifyCountsAndEvidence(value);
    let complete = receiptBatch.complete;
    for (let attempt = 0; attempt < 20 && !complete; attempt += 1) complete = (await scrub(value)).complete;
    expect(complete).toBe(true);
    await verifyCountsAndEvidence(value);
    expect((await pool.query('SELECT acquire_receipt_count,contended_receipt_count,mutation_receipt_count FROM coordination_principal_usage WHERE principal_id=$1',
      [value.target.id])).rows).toEqual([{ acquire_receipt_count: 0, contended_receipt_count: 0, mutation_receipt_count: 0 }]);
  }, 30_000);

  it('returns a bounded quota block without evicting retained anonymous evidence, then resumes after expiry', async () => {
    const value = await fixture(1);
    await scrub(value); // Audit phase.
    await scrub(value); // Eligible lease can detach independently.
    expect(await scrub(value)).toMatchObject({ complete: false, progressed: false, receipts_scrubbed: 0, reason: 'detached_quota' });
    await verifyCountsAndEvidence(value);
    expect((await pool.query('SELECT count(*)::int AS count FROM coordination_operation_receipts WHERE principal_id=$1', [value.target.id])).rows)
      .toEqual([{ count: 4 }]);
    await pool.query(`UPDATE coordination_operation_receipts SET server_time=clock_timestamp()-interval '25 hours',
      retain_until=clock_timestamp()-interval '1 hour' WHERE principal_id=$1 AND request_id=$2`, [detached, value.preservedRequest]);
    let complete = false;
    for (let attempt = 0; attempt < 20 && !complete; attempt += 1) complete = (await scrub(value)).complete;
    expect(complete).toBe(true);
    expect((await pool.query('SELECT resource,fencing_token::text FROM coordination_resources WHERE scope_id=$1', [value.shared.id])).rows)
      .toEqual(value.fences);
    expect((await pool.query('SELECT count(*)::int AS count FROM coordination_operation_receipts WHERE principal_id=$1', [value.target.id])).rows)
      .toEqual([{ count: 0 }]);
  }, 30_000);
});
