import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';
import {
  mapActorIdentity,
  replaceActorIdentity,
  resolveActorIdentityMapping,
  resolveActorPrincipalId,
  revokeActorIdentity,
} from './actor-identities.js';

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
        mapping_id: expect.any(String), authority: 'github', principal_id: user.id,
      }),
    })]);
    expect(audit.rows[0].metadata).not.toHaveProperty('external_actor_id');
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
    )).rejects.toThrow(/cannot be deleted/);
  });

  it('revokes and replaces mappings with immutable history and explicit audits', async () => {
    const first = await createPrincipal(pool, {
      externalId: 'entra:first-target', kind: 'user', displayName: 'First target',
    });
    const second = await createPrincipal(pool, {
      externalId: 'entra:second-target', kind: 'user', displayName: 'Second target',
    });
    const admin = await createPrincipal(pool, {
      externalId: 'entra:mapping-admin', kind: 'user', displayName: 'Mapping admin',
    });
    const nonAdmin = await createPrincipal(pool, {
      externalId: 'entra:mapping-non-admin', kind: 'user', displayName: 'Non admin',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    await mapActorIdentity(pool, {
      authority: 'github.producer-a', externalActorId: '42', principalId: first.id,
      mappedByPrincipalId: admin.id,
    });

    await expect(pool.query(
      `UPDATE actor_principal_mappings
          SET revoked_by_principal_id = $1
        WHERE authority = 'github.producer-a' AND external_actor_id = '42'
          AND revoked_at IS NULL`,
      [admin.id],
    )).rejects.toThrow(/explicit reason/i);

    await expect(revokeActorIdentity(pool, {
      authority: 'github.producer-a', externalActorId: '42',
      revokedByPrincipalId: nonAdmin.id,
      reason: 'Unauthorized test revocation',
    })).rejects.toThrow(/org admin/);
    expect(await resolveActorPrincipalId(pool, {
      authority: 'github.producer-a', externalId: '42',
    })).toBe(first.id);

    await replaceActorIdentity(pool, {
      authority: 'github.producer-a', externalActorId: '42', principalId: second.id,
      mappedByPrincipalId: admin.id,
      reason: 'Rotate actor ownership',
    });
    expect(await resolveActorPrincipalId(pool, {
      authority: 'github.producer-a', externalId: '42',
    })).toBe(second.id);

    const history = await pool.query(
      `SELECT principal_id, revoked_at IS NOT NULL AS revoked
         FROM actor_principal_mappings
        WHERE authority = 'github.producer-a' AND external_actor_id = '42'
        ORDER BY revoked_at NULLS LAST`,
    );
    expect(history.rows).toEqual([
      { principal_id: first.id, revoked: true },
      { principal_id: second.id, revoked: false },
    ]);
    const audits = await pool.query(
      `SELECT metadata->>'operation' AS operation, metadata
         FROM audit_log
        WHERE metadata->>'authority' = 'github.producer-a'
        ORDER BY id`,
    );
    expect(audits.rows.map((row) => row.operation)).toEqual([
      'set_actor_principal_mapping',
      'revoke_actor_principal_mapping',
      'set_actor_principal_mapping',
    ]);
    expect(audits.rows.every((row) => !Object.hasOwn(row.metadata, 'external_actor_id'))).toBe(true);
    expect(audits.rows.every((row) => typeof row.metadata.mapping_id === 'string')).toBe(true);
  });

  it('serializes revocation behind an in-flight mapped capture lock', async () => {
    const actor = await createPrincipal(pool, {
      externalId: 'entra:serialized-target', kind: 'user', displayName: 'Serialized target',
    });
    const admin = await createPrincipal(pool, {
      externalId: 'entra:serialized-admin', kind: 'user', displayName: 'Serialized admin',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    await mapActorIdentity(pool, {
      authority: 'github.producer-lock', externalActorId: '84', principalId: actor.id,
      mappedByPrincipalId: admin.id,
    });

    const captureClient = await pool.connect();
    const revokeClient = await pool.connect();
    try {
      await captureClient.query('BEGIN');
      const locked = await resolveActorIdentityMapping(captureClient, {
        authority: 'github.producer-lock', externalId: '84',
      }, { lock: true });
      expect(locked?.principalId).toBe(actor.id);

      await revokeClient.query('BEGIN');
      await revokeClient.query("SET LOCAL lock_timeout = '100ms'");
      await expect(revokeActorIdentity(revokeClient, {
        authority: 'github.producer-lock', externalActorId: '84',
        revokedByPrincipalId: admin.id,
        reason: 'Concurrent test revocation',
      })).rejects.toThrow(/lock timeout|canceling statement/i);
      await revokeClient.query('ROLLBACK');
      await captureClient.query('COMMIT');

      expect(await revokeActorIdentity(pool, {
        authority: 'github.producer-lock', externalActorId: '84',
        revokedByPrincipalId: admin.id,
        reason: 'Complete credential rotation',
      })).toBe(true);
    } finally {
      await captureClient.query('ROLLBACK').catch(() => undefined);
      await revokeClient.query('ROLLBACK').catch(() => undefined);
      captureClient.release();
      revokeClient.release();
    }
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
