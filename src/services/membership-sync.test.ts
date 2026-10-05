import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership, hasRole, removeMembership } from '../storage/memberships.js';
import { provisionEntraGroupBinding, syncEntraMemberships } from './membership-sync.js';

describe('Entra membership sync', () => {
  let pool: pg.Pool;
  let admin: Awaited<ReturnType<typeof createPrincipal>>;
  beforeEach(async () => {
    pool ??= await makeTestPool(); await resetData(pool);
    admin = await createPrincipal(pool, { externalId: 'admin', kind: 'user', displayName: 'Admin' });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, admin.id, org!.id, 'admin');
  });
  afterAll(async () => { await pool?.end(); });

  it('never binds by name and skips arbitrary tenant groups with an audit summary', async () => {
    const alpha = await createScope(pool, { kind: 'team', name: 'alpha' });
    const user = await createPrincipal(pool, {
      externalId: '11111111-1111-4111-8111-111111111111', kind: 'user', displayName: 'User',
    });
    const result = await syncEntraMemberships(pool, admin, [{
      id: '22222222-2222-4222-8222-222222222222', status: 'present',
      displayName: 'continuum-team-alpha-admin', memberObjectIds: [user.externalId],
    }]);
    expect(await hasRole(pool, user.id, alpha.id, 'reader')).toBe(false);
    expect((await pool.query('SELECT count(*)::int AS count FROM entra_groups')).rows[0].count).toBe(0);
    expect(result).toMatchObject({ groupsSeen: 0, groupsSkipped: 1, skipCodes: { UNBOUND_GROUP: 1 } });
  });

  it('database-enforces approval against a pre-remediation name-based writer', async () => {
    const alpha = await createScope(pool, { kind: 'team', name: 'alpha' });
    const user = await createPrincipal(pool, {
      externalId: '11111111-1111-4111-8111-111111111111', kind: 'user', displayName: 'User',
    });
    const groupId = '22222222-2222-4222-8222-222222222222';
    await pool.query(
      `INSERT INTO entra_groups (external_id, display_name, scope_id, role, active)
       VALUES ($1, 'continuum-team-alpha-admin', $2, 'admin', FALSE)`,
      [groupId, alpha.id],
    );
    await expect(pool.query(
      `INSERT INTO scope_memberships
         (principal_id, scope_id, role, source_kind, source_id, active)
       VALUES ($1, $2, 'admin', 'entra', $3, TRUE)`,
      [user.id, alpha.id, groupId],
    )).rejects.toThrow(/approved immutable group binding/);
  });

  it('uses an audited explicit binding, treats rename as metadata, and safely reactivates', async () => {
    const alpha = await createScope(pool, { kind: 'team', name: 'alpha' });
    const beta = await createScope(pool, { kind: 'team', name: 'beta' });
    const user = await createPrincipal(pool, {
      externalId: '11111111-1111-4111-8111-111111111111', kind: 'user', displayName: 'User',
    });
    const groupId = '22222222-2222-4222-8222-222222222222';
    await provisionEntraGroupBinding(pool, admin, { externalId: groupId, scopeId: alpha.id, role: 'writer' });
    await syncEntraMemberships(pool, admin, [{
      id: groupId, status: 'present', displayName: 'anything-at-all', memberObjectIds: [user.externalId],
    }]);
    expect(await hasRole(pool, user.id, alpha.id, 'writer')).toBe(true);
    expect(await hasRole(pool, user.id, beta.id, 'reader')).toBe(false);

    await syncEntraMemberships(pool, admin, [{ id: groupId, status: 'missing' }], {
      allowMassDeactivation: true,
    });
    expect(await hasRole(pool, user.id, alpha.id, 'reader')).toBe(false);
    const autoReactivated = await syncEntraMemberships(pool, admin, [{
      id: groupId, status: 'present', displayName: 'returned-renamed', memberObjectIds: [user.externalId],
    }]);
    expect(autoReactivated.groupsReactivated).toBe(1);
    expect(await hasRole(pool, user.id, alpha.id, 'writer')).toBe(true);

    await syncEntraMemberships(pool, admin, [{ id: groupId, status: 'missing' }], {
      allowMassDeactivation: true,
    });
    await provisionEntraGroupBinding(pool, admin, {
      externalId: groupId, scopeId: alpha.id, role: 'writer', displayName: 'approved-return',
    });
    await syncEntraMemberships(pool, admin, [{
      id: groupId, status: 'present', displayName: 'returned-renamed', memberObjectIds: [user.externalId],
    }]);
    expect(await hasRole(pool, user.id, alpha.id, 'writer')).toBe(true);
    await provisionEntraGroupBinding(pool, admin, {
      externalId: groupId, scopeId: beta.id, role: 'admin', displayName: 'approved-move',
    });
    expect(await hasRole(pool, user.id, alpha.id, 'reader')).toBe(false);
    const ops = (await pool.query(
      "SELECT metadata->>'operation' AS operation FROM audit_log WHERE metadata->>'operation' LIKE 'entra_group_binding_%' ORDER BY id",
    )).rows.map((row) => row.operation);
    expect(ops).toEqual([
      'entra_group_binding_provisioned', 'entra_group_binding_reactivated',
      'entra_group_binding_updated',
    ]);
  });

  it('skips malformed and failed bound groups without preserving removed access in valid groups', async () => {
    const alpha = await createScope(pool, { kind: 'team', name: 'alpha' });
    const beta = await createScope(pool, { kind: 'team', name: 'beta' });
    const user = await createPrincipal(pool, {
      externalId: '11111111-1111-4111-8111-111111111111', kind: 'user', displayName: 'User',
    });
    const good = '22222222-2222-4222-8222-222222222222';
    const failed = '33333333-3333-4333-8333-333333333333';
    await provisionEntraGroupBinding(pool, admin, { externalId: good, scopeId: alpha.id, role: 'reader' });
    await provisionEntraGroupBinding(pool, admin, { externalId: failed, scopeId: beta.id, role: 'reader' });
    await syncEntraMemberships(pool, admin, [
      { id: good, status: 'present', displayName: 'good', memberObjectIds: [user.externalId] },
      { id: failed, status: 'present', displayName: 'failed', memberObjectIds: [user.externalId] },
    ]);
    const result = await syncEntraMemberships(pool, admin, [
      { id: good, status: 'present', displayName: 'good-renamed', memberObjectIds: [] },
      { id: failed, status: 'invalid', errorCode: 'GRAPH_FAILURE' },
      { id: 'not-a-uuid', status: 'present', displayName: 'bad', memberObjectIds: [] },
    ]);
    expect(await hasRole(pool, user.id, alpha.id, 'reader')).toBe(false);
    expect(await hasRole(pool, user.id, beta.id, 'reader')).toBe(true);
    expect(result).toMatchObject({ membershipsDeactivated: 1, groupsSkipped: 2 });
  });

  it('fails closed on empty and mass-deactivation snapshots and preserves syncing authority', async () => {
    const alpha = await createScope(pool, { kind: 'team', name: 'alpha' });
    const ids = [
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    for (const id of ids) {
      await provisionEntraGroupBinding(pool, admin, { externalId: id, scopeId: alpha.id, role: 'reader' });
    }
    await expect(syncEntraMemberships(pool, admin, [])).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(syncEntraMemberships(pool, admin, ids.map((id) => ({ id, status: 'missing' })))).rejects
      .toMatchObject({ code: 'CONFLICT' });
    expect((await pool.query('SELECT count(*)::int AS count FROM entra_groups WHERE active')).rows[0].count).toBe(2);
  });

  it('rolls back suspicious mass membership removal from an otherwise present group', async () => {
    const alpha = await createScope(pool, { kind: 'team', name: 'alpha' });
    const groupId = '22222222-2222-4222-8222-222222222222';
    await provisionEntraGroupBinding(pool, admin, { externalId: groupId, scopeId: alpha.id, role: 'reader' });
    const inserted = await pool.query(
      `INSERT INTO principals (id, external_id, kind, display_name)
       SELECT gen_random_uuid(), gen_random_uuid()::text, 'user', 'Bulk user'
         FROM generate_series(1, 100)
       RETURNING external_id`,
    );
    const memberObjectIds = inserted.rows.map((row) => row.external_id as string);
    await syncEntraMemberships(pool, admin, [{
      id: groupId, status: 'present', displayName: 'bulk', memberObjectIds,
    }]);
    await expect(syncEntraMemberships(pool, admin, [{
      id: groupId, status: 'present', displayName: 'bulk', memberObjectIds: [],
    }])).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM scope_memberships WHERE source_kind = 'entra' AND active",
    )).rows[0].count).toBe(100);
  });

  it('cannot remove the synchronizing principal when it is the last org admin', async () => {
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const groupId = '22222222-2222-4222-8222-222222222222';
    await provisionEntraGroupBinding(pool, admin, { externalId: groupId, scopeId: org!.id, role: 'admin' });
    await pool.query('UPDATE principals SET external_id = $2 WHERE id = $1', [
      admin.id, '11111111-1111-4111-8111-111111111111',
    ]);
    admin.externalId = '11111111-1111-4111-8111-111111111111';
    await syncEntraMemberships(pool, admin, [{
      id: groupId, status: 'present', displayName: 'org-admin', memberObjectIds: [admin.externalId],
    }]);
    await removeMembership(pool, admin.id, org!.id);
    await expect(syncEntraMemberships(pool, admin, [{
      id: groupId, status: 'present', displayName: 'org-admin', memberObjectIds: [],
    }])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await hasRole(pool, admin.id, org!.id, 'admin')).toBe(true);
  });

  it('rejects unauthorized binding and sync atomically', async () => {
    const actor = await createPrincipal(pool, { externalId: 'reader', kind: 'user', displayName: 'Reader' });
    const alpha = await createScope(pool, { kind: 'team', name: 'alpha' });
    await expect(provisionEntraGroupBinding(pool, actor, {
      externalId: '22222222-2222-4222-8222-222222222222', scopeId: alpha.id, role: 'admin',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(syncEntraMemberships(pool, actor, [])).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
