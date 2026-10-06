import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { provisionEntraGroupBinding, syncEntraMemberships } from '../services/membership-sync.js';
import { MembershipSnapshotTooLargeError } from './graph-membership.js';
import { runMembershipSync } from './sync-runner.js';

describe('membership sync CLI runner', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => { await pool?.end(); });

  it('audits a production Graph overflow and fail-closes stale access before surfacing its code', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'sync-admin', kind: 'user', displayName: 'Sync admin',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, admin.id, org.id, 'admin');
    const user = await createPrincipal(pool, {
      externalId: '11111111-1111-4111-8111-111111111111', kind: 'user', displayName: 'User',
    });
    const scope = await createScope(pool, { kind: 'team', name: 'overflow' });
    const groupId = '22222222-2222-4222-8222-222222222222';
    await provisionEntraGroupBinding(pool, admin, {
      externalId: groupId, scopeId: scope.id, role: 'reader',
    });
    await syncEntraMemberships(pool, admin, [{
      id: groupId, status: 'present', displayName: 'Overflow group',
      memberObjectIds: [user.externalId],
    }]);
    await pool.query(
      `UPDATE entra_sync_state SET last_success_at = now() - interval '25 hours'`,
    );

    await expect(runMembershipSync(pool, {
      CONTINUUM_ENTRA_MEMBERSHIP_SYNC: 'true',
      CONTINUUM_GRAPH_ACCESS_TOKEN: 'x'.repeat(32),
      CONTINUUM_MEMBERSHIP_SYNC_ACTOR: admin.externalId,
      CONTINUUM_ENTRA_MAX_STALENESS_HOURS: '24',
    }, async () => { throw new MembershipSnapshotTooLargeError(); }))
      .rejects.toMatchObject({
        code: 'PAYLOAD_TOO_LARGE', publicMessage: 'Entra snapshot exceeds the whole-run limit',
      });

    expect((await pool.query(
      `SELECT active FROM scope_memberships
        WHERE principal_id = $1 AND scope_id = $2 AND source_kind = 'entra'`,
      [user.id, scope.id],
    )).rows).toEqual([{ active: false }]);
    expect((await pool.query(
      `SELECT metadata->>'reason' AS reason
         FROM audit_log WHERE metadata->>'operation' = 'entra_membership_sync_rejected'`,
    )).rows).toEqual([{ reason: 'SNAPSHOT_TOO_LARGE' }]);
  });

  it('rejects a non-manual sync actor before making a Graph request', async () => {
    const breakGlass = await createPrincipal(pool, {
      externalId: 'break-glass', kind: 'user', displayName: 'Break glass',
    });
    const actor = await createPrincipal(pool, {
      externalId: '11111111-1111-4111-8111-111111111111', kind: 'user', displayName: 'Entra admin',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, breakGlass.id, org.id, 'admin');
    const groupId = '22222222-2222-4222-8222-222222222222';
    await provisionEntraGroupBinding(pool, breakGlass, {
      externalId: groupId, scopeId: org.id, role: 'admin',
    });
    await syncEntraMemberships(pool, breakGlass, [{
      id: groupId, status: 'present', displayName: 'Entra admins',
      memberObjectIds: [actor.externalId],
    }]);
    const fetchSnapshot = vi.fn(async () => []);

    await expect(runMembershipSync(pool, {
      CONTINUUM_ENTRA_MEMBERSHIP_SYNC: 'true',
      CONTINUUM_GRAPH_ACCESS_TOKEN: 'x'.repeat(32),
      CONTINUUM_MEMBERSHIP_SYNC_ACTOR: actor.externalId,
    }, fetchSnapshot)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      publicMessage: 'membership sync actor must be an active manually managed org administrator',
    });
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });
});
