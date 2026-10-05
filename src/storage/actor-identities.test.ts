import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';
import { mapActorIdentity, resolveActorPrincipalId } from './actor-identities.js';

describe('actor identity mappings', () => {
  let pool: pg.Pool;
  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });
  afterAll(async () => pool?.end());

  it('requires org-admin authority and a user target', async () => {
    const user = await createPrincipal(pool, {
      externalId: 'entra:user-target', kind: 'user', displayName: 'Shared Display',
    });
    const service = await createPrincipal(pool, {
      externalId: 'svc:target', kind: 'service', displayName: 'Shared Display',
    });
    const nonAdmin = await createPrincipal(pool, {
      externalId: 'entra:non-admin', kind: 'user', displayName: 'Non Admin',
    });
    const admin = await createPrincipal(pool, {
      externalId: 'entra:admin', kind: 'user', displayName: 'Admin',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, admin.id, org!.id, 'admin');

    await expect(mapActorIdentity(pool, {
      authority: 'github', externalActorId: 'opaque-1', principalId: user.id,
      mappedByPrincipalId: nonAdmin.id,
    })).rejects.toThrow(/org admin/);
    await expect(mapActorIdentity(pool, {
      authority: 'github', externalActorId: 'opaque-1', principalId: service.id,
      mappedByPrincipalId: admin.id,
    })).rejects.toThrow(/user principal/);

    await mapActorIdentity(pool, {
      authority: 'github', externalActorId: 'opaque-1', principalId: user.id,
      mappedByPrincipalId: admin.id,
    });
    const audit = await pool.query(
      "SELECT principal_id, action, metadata FROM audit_log WHERE metadata->>'operation' = 'set_actor_principal_mapping'",
    );
    expect(audit.rows).toEqual([expect.objectContaining({
      principal_id: admin.id,
      action: 'write',
      metadata: expect.objectContaining({
        authority: 'github', external_actor_id: 'opaque-1', principal_id: user.id,
      }),
    })]);
    expect(await resolveActorPrincipalId(pool, {
      authority: 'github', externalId: 'opaque-1',
    })).toBe(user.id);
    expect(await resolveActorPrincipalId(pool, {
      authority: 'github', externalId: 'Shared Display',
    })).toBeNull();
    await expect(pool.query(
      "UPDATE principals SET kind = 'service' WHERE id = $1", [user.id],
    )).rejects.toThrow(/must remain a user/);
    await expect(pool.query(
      "UPDATE actor_principal_mappings SET principal_id = $1 WHERE authority = 'github' AND external_actor_id = 'opaque-1'",
      [admin.id],
    )).rejects.toThrow(/immutable/);
    await expect(pool.query(
      "DELETE FROM actor_principal_mappings WHERE authority = 'github' AND external_actor_id = 'opaque-1'",
    )).rejects.toThrow(/immutable/);
  });

  it('does not infer a mapping from scope ownership or display names', async () => {
    const user = await createPrincipal(pool, {
      externalId: 'entra:owner', kind: 'user', displayName: 'octocat',
    });
    await createScope(pool, { kind: 'user', name: 'octocat' }, user.id);
    expect(await resolveActorPrincipalId(pool, {
      authority: 'github', externalId: 'octocat',
    })).toBeNull();
  });
});
