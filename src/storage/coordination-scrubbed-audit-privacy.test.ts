import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { acquireLease, releaseLease } from '../services/coordination.js';
import { mapOwnedUserScope, offboardPrincipal } from '../services/offboarding.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';
import { makeTestPool, resetData } from './test-helpers.js';

let pool: pg.Pool;
beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
afterAll(async () => pool?.end());

it('erases shared audit resource joins while preserving resource fencing history', async () => {
  const operator = await createPrincipal(pool, { externalId: randomUUID(), kind: 'user', displayName: 'Operator' });
  const target = await createPrincipal(pool, { externalId: randomUUID(), kind: 'user', displayName: 'Target' });
  const other = await createPrincipal(pool, { externalId: randomUUID(), kind: 'service', displayName: 'Other holder' });
  const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
  const owned = await createScope(pool, { kind: 'user', name: 'owned-' + randomUUID() });
  const shared = await createScope(pool, { kind: 'project', name: 'shared-' + randomUUID() });
  await addMembership(pool, operator.id, org.id, 'admin');
  await addMembership(pool, target.id, owned.id, 'writer');
  await addMembership(pool, target.id, shared.id, 'writer');
  await addMembership(pool, other.id, shared.id, 'writer');
  await mapOwnedUserScope(pool, operator, target.id, owned.id);
  const keys = ['private:short', 'private:substantially-longer-issue-key'];
  for (const resource of keys) {
    const runId = randomUUID();
    const held = await acquireLease(pool, target, {
      scope: 'project:' + shared.name, resource, runId, requestId: randomUUID(), ttlSeconds: 300,
    });
    expect(held).toMatchObject({ acquired: true, fencingToken: '1' });
    if (!held.acquired) throw new Error('expected shared acquisition');
    await releaseLease(pool, target, { leaseId: held.leaseId, runId, requestId: randomUUID() });
  }
  const auditIds = (await pool.query(`SELECT id FROM audit_log WHERE principal_id=$1
    AND scope_id=$2 AND metadata->>'operation'='lock_acquire' ORDER BY id`, [target.id, shared.id])).rows.map((row) => row.id);
  expect(auditIds).toHaveLength(2);
  const join = `SELECT audit.id,resource.resource FROM audit_log audit JOIN coordination_resources resource
    ON resource.scope_id=audit.scope_id
    AND resource.fencing_token::text=audit.metadata->>'fencing_token'
    AND octet_length(resource.resource)=(audit.metadata->>'resource_bytes')::integer
    WHERE audit.id=ANY($1::bigint[]) ORDER BY resource.resource`;
  expect((await pool.query(`SELECT count(*)::int AS count FROM audit_log audit JOIN coordination_resources resource
    ON resource.scope_id=audit.scope_id AND resource.fencing_token::text=audit.metadata->>'fencing_token'
    WHERE audit.id=ANY($1::bigint[])`, [auditIds])).rows).toEqual([{ count: 4 }]);
  // Byte length disambiguates two keys with the same fencing token.
  expect((await pool.query(join, [auditIds])).rows.map((row) => row.resource)).toEqual([...keys].sort());
  let erased = await offboardPrincipal(pool, operator, target.id, { confirmationScopeId: owned.id, batchSize: 100 });
  for (let attempt=0; attempt<20 && !erased.complete; attempt+=1) {
    erased = await offboardPrincipal(pool, operator, target.id, { confirmationScopeId: owned.id, batchSize: 100 });
  }
  expect(erased.complete).toBe(true);
  expect((await pool.query(`SELECT resource,fencing_token::text AS token FROM coordination_resources
    WHERE scope_id=$1 ORDER BY resource`, [shared.id])).rows)
    .toEqual([...keys].sort().map((resource) => ({ resource, token: '1' })));
  // Check before another acquisition changes the token and could mask this join.
  expect((await pool.query(join, [auditIds])).rows).toEqual([]);
  expect((await pool.query(`SELECT metadata ?| ARRAY['fencing_token','resource_bytes'] AS linkable
    FROM audit_log WHERE id=ANY($1::bigint[]) ORDER BY id`, [auditIds])).rows)
    .toEqual([{ linkable: false }, { linkable: false }]);
  for (const resource of keys) {
    const result = await acquireLease(pool, other, {
      scope: 'project:' + shared.name, resource, runId: randomUUID(), requestId: randomUUID(), ttlSeconds: 300,
    });
    expect(result).toMatchObject({ acquired: true, fencingToken: '2' });
  }
}, 60_000);
