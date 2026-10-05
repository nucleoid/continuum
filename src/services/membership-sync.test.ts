import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership, hasRole } from '../storage/memberships.js';
import { syncEntraMemberships } from './membership-sync.js';

describe('Entra membership sync', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); });
  afterAll(async () => { await pool?.end(); });

  it('binds immutable group IDs, treats rename as metadata, and soft-deactivates only sourced rows', async () => {
    const admin = await createPrincipal(pool, { externalId: 'admin', kind: 'user', displayName: 'Admin' });
    const user = await createPrincipal(pool, {
      externalId: '11111111-1111-4111-8111-111111111111', kind: 'user', displayName: 'User',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    const alpha = await createScope(pool, { kind: 'team', name: 'alpha' });
    const beta = await createScope(pool, { kind: 'team', name: 'beta' });
    await addMembership(pool, user.id, alpha.id, 'reader');
    const groupId = '22222222-2222-4222-8222-222222222222';
    const memberId = '11111111-1111-4111-8111-111111111111';
    await syncEntraMemberships(pool, admin, [{
      id: groupId, displayName: 'continuum-team-alpha-writer', memberObjectIds: [memberId],
    }]);
    expect(await hasRole(pool, user.id, alpha.id, 'writer')).toBe(true);

    await syncEntraMemberships(pool, admin, [{
      id: groupId, displayName: 'continuum-team-beta-admin', memberObjectIds: [memberId],
    }]);
    expect(await hasRole(pool, user.id, alpha.id, 'writer')).toBe(true);
    expect(await hasRole(pool, user.id, beta.id, 'reader')).toBe(false);

    await syncEntraMemberships(pool, admin, []);
    expect(await hasRole(pool, user.id, alpha.id, 'reader')).toBe(true);
    expect(await hasRole(pool, user.id, alpha.id, 'writer')).toBe(false);
    const sourced = await pool.query(
      "SELECT active, deactivated_at FROM scope_memberships WHERE source_kind = 'entra' AND source_id = $1",
      [groupId],
    );
    expect(sourced.rows[0]).toMatchObject({ active: false });
    expect(sourced.rows[0].deactivated_at).toBeInstanceOf(Date);
    const audits = await pool.query("SELECT metadata FROM audit_log WHERE metadata->>'operation' = 'entra_membership_sync'");
    expect(audits.rowCount).toBe(3);
  });

  it('rejects an unauthorized sync atomically', async () => {
    const actor = await createPrincipal(pool, { externalId: 'reader', kind: 'user', displayName: 'Reader' });
    await expect(syncEntraMemberships(pool, actor, [])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await pool.query('SELECT count(*)::int AS count FROM audit_log')).rows[0].count).toBe(0);
  });
});
