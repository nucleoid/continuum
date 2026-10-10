import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { makeTestPool, resetData } from './test-helpers.js';
import { acquireLease, inspectLease, releaseLease, renewLease } from '../services/coordination.js';

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
});
