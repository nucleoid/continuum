import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership, hasRole, removeMembership } from '../storage/memberships.js';
import {
  listBoundEntraGroupIds, MAX_SYNC_GROUPS, provisionEntraGroupBinding,
  revokeEntraGroupBinding, syncEntraMemberships,
} from './membership-sync.js';

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
      `INSERT INTO entra_groups
         (external_id, display_name, scope_id, role, active, deactivated_at)
       VALUES ($1, 'continuum-team-alpha-admin', $2, 'admin', FALSE, now())`,
      [groupId, alpha.id],
    );
    await expect(pool.query(
      `INSERT INTO scope_memberships
         (principal_id, scope_id, role, source_kind, source_id, active)
       VALUES ($1, $2, 'admin', 'entra', $3, TRUE)`,
      [user.id, alpha.id, groupId],
    )).rejects.toThrow(/approved immutable group binding/);
  });

  it('database-enforces the approved source, scope, and role on inserts and updates', async () => {
    const alpha = await createScope(pool, { kind: 'team', name: 'alpha' });
    const beta = await createScope(pool, { kind: 'team', name: 'beta' });
    const user = await createPrincipal(pool, {
      externalId: '11111111-1111-4111-8111-111111111111', kind: 'user', displayName: 'User',
    });
    const groupId = '22222222-2222-4222-8222-222222222222';
    await provisionEntraGroupBinding(pool, admin, {
      externalId: groupId, scopeId: alpha.id, role: 'writer',
    });

    await expect(pool.query(
      `INSERT INTO scope_memberships
         (principal_id, scope_id, role, source_kind, source_id, active)
       VALUES ($1, $2, 'admin', 'entra', $3, TRUE)`,
      [user.id, alpha.id, groupId],
    )).rejects.toThrow(/approved immutable group binding/);

    await pool.query(
      `INSERT INTO scope_memberships
         (principal_id, scope_id, role, source_kind, source_id, active)
       VALUES ($1, $2, 'writer', 'entra', $3, TRUE)`,
      [user.id, alpha.id, groupId],
    );
    for (const [column, value] of [
      ['role', 'admin'], ['scope_id', beta.id],
      ['source_id', '33333333-3333-4333-8333-333333333333'],
    ] as const) {
      await expect(pool.query(
        `UPDATE scope_memberships SET ${column} = $1
          WHERE principal_id = $2 AND source_kind = 'entra' AND source_id = $3`,
        [value, user.id, groupId],
      )).rejects.toThrow(/approved immutable group binding/);
    }
  });

  it('locks the approved binding while an active Entra membership is written', async () => {
    const alpha = await createScope(pool, { kind: 'team', name: 'locking' });
    const user = await createPrincipal(pool, {
      externalId: '11111111-1111-4111-8111-111111111111', kind: 'user', displayName: 'User',
    });
    const groupId = '22222222-2222-4222-8222-222222222222';
    await provisionEntraGroupBinding(pool, admin, {
      externalId: groupId, scopeId: alpha.id, role: 'reader',
    });
    const membershipClient = await pool.connect();
    const bindingClient = await pool.connect();
    try {
      await membershipClient.query('BEGIN');
      await membershipClient.query(
        `INSERT INTO scope_memberships
           (principal_id, scope_id, role, source_kind, source_id, active)
         VALUES ($1, $2, 'reader', 'entra', $3, TRUE)`,
        [user.id, alpha.id, groupId],
      );
      await bindingClient.query('BEGIN');
      await bindingClient.query("SET LOCAL lock_timeout = '100ms'");
      await expect(bindingClient.query(
        'UPDATE entra_groups SET active = FALSE WHERE external_id = $1', [groupId],
      )).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await Promise.allSettled([
        membershipClient.query('ROLLBACK'), bindingClient.query('ROLLBACK'),
      ]);
      membershipClient.release();
      bindingClient.release();
    }
  });

  it('database-blocks binding invalidation until sourced access is deactivated', async () => {
    const alpha = await createScope(pool, { kind: 'team', name: 'binding-guard' });
    const user = await createPrincipal(pool, {
      externalId: '11111111-1111-4111-8111-111111111111', kind: 'user', displayName: 'User',
    });
    const groupId = '22222222-2222-4222-8222-222222222222';
    await provisionEntraGroupBinding(pool, admin, {
      externalId: groupId, scopeId: alpha.id, role: 'reader',
    });
    await syncEntraMemberships(pool, admin, [{
      id: groupId, status: 'present', displayName: 'binding-guard',
      memberObjectIds: [user.externalId],
    }]);

    const mutations = [
      ['UPDATE entra_groups SET active = FALSE, deactivated_at = now() WHERE external_id = $1'],
      ["UPDATE entra_groups SET role = 'writer' WHERE external_id = $1"],
      ['DELETE FROM entra_groups WHERE external_id = $1'],
    ];
    for (const [sql] of mutations) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await expect(client.query(sql, [groupId]))
          .rejects.toThrow(/active Entra memberships must match an approved binding/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }

    expect(await revokeEntraGroupBinding(pool, admin, groupId)).toBe(true);
    expect(await hasRole(pool, user.id, alpha.id, 'reader')).toBe(false);
    await provisionEntraGroupBinding(pool, admin, {
      externalId: groupId, scopeId: alpha.id, role: 'writer',
    });
    await syncEntraMemberships(pool, admin, [{
      id: groupId, status: 'present', displayName: 'binding-guard-renamed',
      memberObjectIds: [user.externalId],
    }]);
    expect(await hasRole(pool, user.id, alpha.id, 'writer')).toBe(true);
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

  it('rolls back a rebind that removes the actor or the last active org administrator', async () => {
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const team = await createScope(pool, { kind: 'team', name: 'rebind-target' });
    const groupId = '22222222-2222-4222-8222-222222222222';
    await pool.query('UPDATE principals SET external_id = $2 WHERE id = $1', [
      admin.id, '11111111-1111-4111-8111-111111111111',
    ]);
    admin.externalId = '11111111-1111-4111-8111-111111111111';
    await provisionEntraGroupBinding(pool, admin, {
      externalId: groupId, scopeId: org!.id, role: 'admin',
    });
    await syncEntraMemberships(pool, admin, [{
      id: groupId, status: 'present', displayName: 'admins', memberObjectIds: [admin.externalId],
    }]);
    await removeMembership(pool, admin.id, org!.id);

    await expect(provisionEntraGroupBinding(pool, admin, {
      externalId: groupId, scopeId: team.id, role: 'reader',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await hasRole(pool, admin.id, org!.id, 'admin')).toBe(true);
    expect((await pool.query(
      'SELECT scope_id, role FROM entra_groups WHERE external_id = $1', [groupId],
    )).rows[0]).toEqual({ scope_id: org!.id, role: 'admin' });
  });

  it('canonicalizes group and scope UUIDs and treats mixed-case snapshots as one binding', async () => {
    const alpha = await createScope(pool, { kind: 'team', name: 'canonical' });
    const user = await createPrincipal(pool, {
      externalId: '11111111-1111-4111-8111-111111111111', kind: 'user', displayName: 'User',
    });
    const lower = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await provisionEntraGroupBinding(pool, admin, {
      externalId: lower.toUpperCase(), scopeId: alpha.id.toUpperCase(), role: 'reader',
    });
    expect(await listBoundEntraGroupIds(pool)).toEqual([lower]);
    await syncEntraMemberships(pool, admin, [{
      id: lower.toUpperCase(), status: 'present', displayName: 'canonical',
      memberObjectIds: [user.externalId.toUpperCase()],
    }]);
    expect(await hasRole(pool, user.id, alpha.id, 'reader')).toBe(true);

    const duplicate = await syncEntraMemberships(pool, admin, [
      { id: lower, status: 'present', displayName: 'canonical', memberObjectIds: [user.externalId] },
      { id: lower.toUpperCase(), status: 'present', displayName: 'canonical', memberObjectIds: [user.externalId] },
    ]);
    expect(duplicate).toMatchObject({ groupsSeen: 0, skipCodes: { DUPLICATE_GROUP_ID: 1 } });
    expect(await hasRole(pool, user.id, alpha.id, 'reader')).toBe(false);
  });

  it('rejects a 501st approved and unrevoked binding', async () => {
    const alpha = await createScope(pool, { kind: 'team', name: 'cardinality' });
    await pool.query(
      `INSERT INTO entra_groups
         (external_id, display_name, scope_id, role, active, approved_by, approved_at)
       SELECT lpad(n::text, 8, '0') || '-0000-4000-8000-' || lpad(n::text, 12, '0'),
              'approved-' || n, $1, 'reader', TRUE, $2, now()
         FROM generate_series(1, $3) n`,
      [alpha.id, admin.id, MAX_SYNC_GROUPS],
    );

    await expect(provisionEntraGroupBinding(pool, admin, {
      externalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      scopeId: alpha.id,
      role: 'reader',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM entra_groups
        WHERE approved_by IS NOT NULL AND approval_revoked_at IS NULL`,
    )).rows[0].count).toBe(MAX_SYNC_GROUPS);
  });

  it('database-enforces immutable group IDs and approved binding cardinality', async () => {
    const alpha = await createScope(pool, { kind: 'team', name: 'database-cardinality' });
    await expect(pool.query(
      `INSERT INTO entra_groups
         (external_id, display_name, scope_id, role, active, approved_by, approved_at)
       VALUES ('not-a-graph-id', 'invalid', $1, 'reader', TRUE, $2, now())`,
      [alpha.id, admin.id],
    )).rejects.toThrow();
    await pool.query(
      `INSERT INTO entra_groups
         (external_id, display_name, scope_id, role, active, approved_by, approved_at)
       SELECT lpad(n::text, 8, '0') || '-0000-4000-8000-' || lpad(n::text, 12, '0'),
              'approved-' || n, $1, 'reader', TRUE, $2, now()
         FROM generate_series(1, $3) n`,
      [alpha.id, admin.id, MAX_SYNC_GROUPS],
    );
    await expect(pool.query(
      `INSERT INTO entra_groups
         (external_id, display_name, scope_id, role, active, approved_by, approved_at)
       VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'extra', $1, 'reader', TRUE, $2, now())`,
      [alpha.id, admin.id],
    )).rejects.toThrow(/cannot approve more than 500 Entra group bindings/);
  });

  it('fails closed for malformed and failed bound groups while valid groups remain authoritative', async () => {
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
    expect(await hasRole(pool, user.id, beta.id, 'reader')).toBe(false);
    expect(result).toMatchObject({ membershipsDeactivated: 2, groupsSkipped: 2,
      skipCodes: { GRAPH_FAILURE: 1, INVALID_GROUP_ID: 1 } });
    expect((await pool.query(
      'SELECT active FROM entra_groups WHERE external_id = $1', [failed],
    )).rows[0].active).toBe(false);
  });

  it('audits revocation, deactivates sourced access, and never silently reprovisions it', async () => {
    const alpha = await createScope(pool, { kind: 'team', name: 'alpha' });
    const user = await createPrincipal(pool, {
      externalId: '11111111-1111-4111-8111-111111111111', kind: 'user', displayName: 'User',
    });
    const groupId = '22222222-2222-4222-8222-222222222222';
    await provisionEntraGroupBinding(pool, admin, { externalId: groupId, scopeId: alpha.id, role: 'writer' });
    const snapshot = [{
      id: groupId, status: 'present' as const, displayName: 'alpha', memberObjectIds: [user.externalId],
    }];
    await syncEntraMemberships(pool, admin, snapshot);

    expect(await revokeEntraGroupBinding(pool, admin, groupId)).toBe(true);
    expect(await hasRole(pool, user.id, alpha.id, 'reader')).toBe(false);
    expect(await syncEntraMemberships(pool, admin, snapshot)).toMatchObject({
      groupsSeen: 0, groupsSkipped: 1, skipCodes: { REVOKED_GROUP: 1 },
    });
    expect(await hasRole(pool, user.id, alpha.id, 'reader')).toBe(false);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM audit_log WHERE metadata->>'operation' = 'entra_group_binding_revoked'",
    )).rows[0].count).toBe(1);
  });

  it('rolls back revocation that would remove the actor or last org administrator', async () => {
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const groupId = '22222222-2222-4222-8222-222222222222';
    await pool.query('UPDATE principals SET external_id = $2 WHERE id = $1', [
      admin.id, '11111111-1111-4111-8111-111111111111',
    ]);
    admin.externalId = '11111111-1111-4111-8111-111111111111';
    await provisionEntraGroupBinding(pool, admin, { externalId: groupId, scopeId: org!.id, role: 'admin' });
    await syncEntraMemberships(pool, admin, [{
      id: groupId, status: 'present', displayName: 'admins', memberObjectIds: [admin.externalId],
    }]);
    await removeMembership(pool, admin.id, org!.id);

    await expect(revokeEntraGroupBinding(pool, admin, groupId)).rejects
      .toMatchObject({ code: 'FORBIDDEN' });
    expect(await hasRole(pool, admin.id, org!.id, 'admin')).toBe(true);
    expect((await pool.query(
      'SELECT approval_revoked_at FROM entra_groups WHERE external_id = $1', [groupId],
    )).rows[0].approval_revoked_at).toBeNull();
  });

  it('rejects an oversized snapshot without quarantining valid tenant access', async () => {
    const alpha = await createScope(pool, { kind: 'team', name: 'alpha' });
    const user = await createPrincipal(pool, {
      externalId: '11111111-1111-4111-8111-111111111111', kind: 'user', displayName: 'User',
    });
    const groupId = '22222222-2222-4222-8222-222222222222';
    await provisionEntraGroupBinding(pool, admin, { externalId: groupId, scopeId: alpha.id, role: 'reader' });
    await syncEntraMemberships(pool, admin, [{
      id: groupId, status: 'present', displayName: 'alpha', memberObjectIds: [user.externalId],
    }]);
    const oversized = Array.from({ length: MAX_SYNC_GROUPS + 1 }, (_, index) => ({
      id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
      status: 'invalid' as const, errorCode: 'GRAPH_FAILURE',
    }));

    await expect(syncEntraMemberships(pool, admin, oversized)).rejects
      .toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(await hasRole(pool, user.id, alpha.id, 'reader')).toBe(true);
    expect((await pool.query(
      `SELECT metadata FROM audit_log
        WHERE metadata->>'operation' = 'entra_membership_sync_rejected'
        ORDER BY id DESC LIMIT 1`,
    )).rows[0].metadata).toMatchObject({
      reason: 'SNAPSHOT_TOO_LARGE', groups_deactivated: 0, memberships_deactivated: 0,
    });
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

  it('keeps quarantine and rejection audits when a later global guard rolls back valid removals', async () => {
    const alpha = await createScope(pool, { kind: 'team', name: 'alpha' });
    const beta = await createScope(pool, { kind: 'team', name: 'beta' });
    const good = '22222222-2222-4222-8222-222222222222';
    const failed = '33333333-3333-4333-8333-333333333333';
    await provisionEntraGroupBinding(pool, admin, { externalId: good, scopeId: alpha.id, role: 'reader' });
    await provisionEntraGroupBinding(pool, admin, { externalId: failed, scopeId: beta.id, role: 'reader' });
    const inserted = await pool.query(
      `INSERT INTO principals (id, external_id, kind, display_name)
       SELECT gen_random_uuid(), gen_random_uuid()::text, 'user', 'Bulk user'
         FROM generate_series(1, 101)
       RETURNING id, external_id`,
    );
    const goodIds = inserted.rows.slice(0, 100).map((row) => row.external_id as string);
    const failedId = inserted.rows[100].external_id as string;
    await syncEntraMemberships(pool, admin, [
      { id: good, status: 'present', displayName: 'good', memberObjectIds: goodIds },
      { id: failed, status: 'present', displayName: 'failed', memberObjectIds: [failedId] },
    ]);

    await expect(syncEntraMemberships(pool, admin, [
      { id: good, status: 'present', displayName: 'good', memberObjectIds: [] },
      { id: failed, status: 'invalid', errorCode: 'GRAPH_FAILURE' },
    ])).rejects.toMatchObject({ code: 'CONFLICT' });

    expect((await pool.query(
      `SELECT count(*)::int AS count FROM scope_memberships
        WHERE source_kind = 'entra' AND source_id = $1 AND active`, [good],
    )).rows[0].count).toBe(100);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM scope_memberships
        WHERE source_kind = 'entra' AND source_id = $1 AND active`, [failed],
    )).rows[0].count).toBe(0);
    expect((await pool.query(
      `SELECT metadata FROM audit_log
        WHERE metadata->>'operation' = 'entra_membership_sync_rejected'
        ORDER BY id DESC LIMIT 1`,
    )).rows[0].metadata).toMatchObject({
      reason: 'MEMBERSHIP_DEACTIVATION_THRESHOLD',
      quarantine: { memberships_deactivated: 1, skip_codes: { GRAPH_FAILURE: 1 } },
    });
  });

  it('quarantines a duplicated binding without reapplying its first result', async () => {
    const alpha = await createScope(pool, { kind: 'team', name: 'alpha' });
    const user = await createPrincipal(pool, {
      externalId: '11111111-1111-4111-8111-111111111111', kind: 'user', displayName: 'User',
    });
    const groupId = '22222222-2222-4222-8222-222222222222';
    await provisionEntraGroupBinding(pool, admin, { externalId: groupId, scopeId: alpha.id, role: 'reader' });
    const snapshot = {
      id: groupId, status: 'present' as const, displayName: 'alpha', memberObjectIds: [user.externalId],
    };
    await syncEntraMemberships(pool, admin, [snapshot]);

    const result = await syncEntraMemberships(pool, admin, [snapshot, snapshot]);
    expect(result).toMatchObject({
      groupsSeen: 0, groupsSkipped: 1, membershipsDeactivated: 1,
      skipCodes: { DUPLICATE_GROUP_ID: 1 },
    });
    expect(await hasRole(pool, user.id, alpha.id, 'reader')).toBe(false);
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
