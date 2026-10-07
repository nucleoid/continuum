import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg, { type PoolConfig } from 'pg';
import { runAuditRetention } from '../maintenance/audit-retention.js';
import { addMembership } from '../storage/memberships.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { provisionEntraGroupBinding, syncEntraMemberships } from './membership-sync.js';
import { mapOwnedUserScope, offboardPrincipal } from './offboarding.js';

async function applyApplicationRoleGrants(pool: pg.Pool, role: string): Promise<void> {
  const source = await readFile(join(process.cwd(), 'scripts/grant-application-role.sql'), 'utf8');
  const sql = source.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n')
    .replaceAll(':"continuum_schema"', '"public"')
    .replaceAll(':"continuum_app_role"', `"${role}"`);
  await pool.query(sql);
}

async function rolePool(pool: pg.Pool, role: string): Promise<pg.Pool> {
  await pool.query(`CREATE ROLE "${role}" NOLOGIN`);
  await pool.query(`GRANT "${role}" TO CURRENT_USER`);
  await applyApplicationRoleGrants(pool, role);
  return new pg.Pool({
    ...(pool as unknown as { options: PoolConfig }).options,
    max: 1,
    options: `-c role=${role}`,
  });
}

async function syncRolePool(
  pool: pg.Pool, role: string, principalId: string,
): Promise<pg.Pool> {
  await pool.query(`CREATE ROLE "${role}" NOLOGIN`);
  await pool.query(`GRANT "${role}" TO CURRENT_USER`);
  const source = await readFile(join(process.cwd(), 'scripts/grant-sync-role.sql'), 'utf8');
  const sql = source.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n')
    .replaceAll(':"continuum_schema"', '"public"')
    .replaceAll(':"continuum_sync_role"', `"${role}"`)
    .replaceAll(":'continuum_principal_id'", `'${principalId}'`)
    .replaceAll(":'continuum_sync_role'", `'${role}'`);
  await pool.query(sql);
  return new pg.Pool({
    ...(pool as unknown as { options: PoolConfig }).options,
    max: 1,
    options: `-c role=${role}`,
  });
}

async function dropRole(pool: pg.Pool, connection: pg.Pool, role: string): Promise<void> {
  await connection.end();
  await pool.query(`DROP OWNED BY "${role}"`);
  await pool.query(`REVOKE "${role}" FROM CURRENT_USER`);
  await pool.query(`DROP ROLE "${role}"`);
}

describe('rejected-head offboarding remediation', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => { await pool?.end(); });

  async function adminFixture(prefix: string) {
    const admin = await createPrincipal(pool, {
      externalId: `${prefix}-admin`, kind: 'user', displayName: 'Admin',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    return { admin, org: org! };
  }

  it('reactivates a missing then returning binding through the documented non-owner sync role', async () => {
    const { admin } = await adminFixture('returning');
    const syncService = await createPrincipal(pool, {
      externalId: 'returning-sync-service', kind: 'service', displayName: 'Sync service',
    });
    const project = await createScope(pool, { kind: 'project', name: 'returning-project' });
    const groupId = '10000000-0000-4000-8000-000000000001';
    const memberId = '10000000-0000-4000-8000-000000000002';
    await provisionEntraGroupBinding(pool, admin, {
      externalId: groupId, scopeId: project.id, role: 'reader',
    });
    await syncEntraMemberships(pool, admin, [{
      id: groupId, status: 'present', displayName: 'Returning', memberObjectIds: [memberId],
    }], { allowMassDeactivation: true });

    const role = `continuum_sync_return_${Date.now()}`;
    const connection = await syncRolePool(pool, role, syncService.id);
    try {
      await syncEntraMemberships(connection, syncService, [{ id: groupId, status: 'missing' }], {
        allowMassDeactivation: true,
      });
      await expect(syncEntraMemberships(connection, syncService, [{
        id: groupId, status: 'present', displayName: 'Returning again', memberObjectIds: [memberId],
      }], { allowMassDeactivation: true })).resolves.toMatchObject({ groupsReactivated: 1 });
      expect((await pool.query(
        'SELECT active, approval_revoked_at, quarantined_at FROM entra_groups WHERE external_id = $1',
        [groupId],
      )).rows[0]).toEqual({ active: true, approval_revoked_at: null, quarantined_at: null });
    } finally {
      await dropRole(pool, connection, role);
    }
  });

  it('does not let the shared app role borrow an admin UUID to mint bindings, members, or approvals', async () => {
    const { admin, org } = await adminFixture('forgery');
    const arbitrary = await createPrincipal(pool, {
      externalId: 'forgery-arbitrary', kind: 'user', displayName: 'Arbitrary',
    });
    const scope = await createScope(pool, { kind: 'user', name: 'forgery-owned' });
    await pool.query(
      `INSERT INTO principal_user_scopes
         (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
          acknowledged_evidence_hash)
       VALUES ($1, $2, $3, '{}'::uuid[], repeat('a', 64))`,
      [arbitrary.id, scope.id, admin.id],
    );
    const role = `continuum_forgery_${Date.now()}`;
    const connection = await rolePool(pool, role);
    try {
      await expect(connection.query(
        `SELECT continuum_upsert_entra_group_binding(
           $1, '20000000-0000-4000-8000-000000000001', 'forged', $2, 'admin')`,
        [admin.id, org.id],
      )).rejects.toThrow(/trusted|permission denied|database identity/i);
      await expect(connection.query(
        `SELECT continuum_activate_entra_memberships(
           $1, '20000000-0000-4000-8000-000000000001', $2::uuid[])`,
        [admin.id, [arbitrary.id]],
      )).rejects.toThrow(/trusted|permission denied|database identity/i);
      await expect(connection.query(
        `SELECT continuum_create_user_scope_approval(
           $1, $2, $3, '{}'::uuid[], repeat('a', 64))`,
        [admin.id, arbitrary.id, scope.id],
      )).rejects.toThrow(/trusted|permission denied|database identity/i);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM scope_memberships
          WHERE principal_id = $1 AND scope_id = $2 AND role = 'admin' AND active`,
        [arbitrary.id, org.id],
      )).rows[0].count).toBe(0);
    } finally {
      await dropRole(pool, connection, role);
    }
  });

  it('blocks direct non-owner update and delete of every manual org administrator', async () => {
    const first = await adminFixture('manual-first');
    const second = await createPrincipal(pool, {
      externalId: 'manual-second', kind: 'user', displayName: 'Second',
    });
    await addMembership(pool, second.id, first.org.id, 'admin');
    const role = `continuum_manual_guard_${Date.now()}`;
    const connection = await rolePool(pool, role);
    try {
      await expect(connection.query(
        `UPDATE scope_memberships SET role = 'writer'
          WHERE principal_id = $1 AND scope_id = $2 AND source_kind = 'manual'`,
        [first.admin.id, first.org.id],
      )).rejects.toThrow(/guarded operator path/i);
      await expect(connection.query(
        `DELETE FROM scope_memberships
          WHERE principal_id = $1 AND scope_id = $2 AND source_kind = 'manual'`,
        [second.id, first.org.id],
      )).rejects.toThrow(/guarded operator path/i);
    } finally {
      await dropRole(pool, connection, role);
    }
  });

  it('supports guarded audited manual-admin demotion and takeover for a DB-bound operator', async () => {
    const first = await adminFixture('operator-first');
    const replacement = await createPrincipal(pool, {
      externalId: 'operator-replacement', kind: 'user', displayName: 'Replacement',
    });
    const role = `continuum_operator_${Date.now()}`;
    await pool.query(`CREATE ROLE "${role}" NOLOGIN`);
    await pool.query(`GRANT "${role}" TO CURRENT_USER`);
    await pool.query(
      `SELECT continuum_register_trusted_database_identity($1, $2, TRUE, FALSE)`,
      [role, first.admin.id],
    );
    await pool.query(
      `GRANT USAGE ON SCHEMA public TO "${role}";
       GRANT EXECUTE ON FUNCTION continuum_takeover_manual_org_admin(UUID, UUID, UUID)
         TO "${role}";
       GRANT SELECT ON TABLE audit_log, scope_memberships, scopes, principals TO "${role}"`,
    );
    const connection = new pg.Pool({
      ...(pool as unknown as { options: PoolConfig }).options,
      max: 1,
      options: `-c role=${role}`,
    });
    try {
      await expect(connection.query(
        'SELECT continuum_takeover_manual_org_admin($1, $2, $3)',
        [first.admin.id, first.admin.id, replacement.id],
      )).resolves.toBeDefined();
      expect((await pool.query(
        `SELECT principal_id::text, role, active FROM scope_memberships
          WHERE scope_id = $1 AND source_kind = 'manual' ORDER BY principal_id`,
        [first.org.id],
      )).rows).toEqual(expect.arrayContaining([
        { principal_id: first.admin.id, role: 'writer', active: true },
        { principal_id: replacement.id, role: 'admin', active: true },
      ]));
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM audit_log
          WHERE metadata->>'operation' = 'manual_org_admin_takeover'
            AND metadata->>'from_principal_id' = $1
            AND metadata->>'to_principal_id' = $2`,
        [first.admin.id, replacement.id],
      )).rows[0].count).toBe(1);
    } finally {
      await dropRole(pool, connection, role);
    }
  });

  it('does not widen redaction through a legacy request-id mapping', async () => {
    const { admin } = await adminFixture('redaction');
    const target = await createPrincipal(pool, {
      externalId: 'redaction-target', kind: 'user', displayName: 'Target',
    });
    const other = await createPrincipal(pool, {
      externalId: 'redaction-other', kind: 'user', displayName: 'Other',
    });
    const scope = await createScope(pool, { kind: 'user', name: 'redaction-owned' });
    await addMembership(pool, target.id, scope.id, 'writer');
    await mapOwnedUserScope(pool, admin, target.id, scope.id);
    await pool.query(
      `INSERT INTO memories (id, scope_id, type, title, body, author_id, source)
       SELECT gen_random_uuid(), $1, 'context', 'private', 'private', $2, 'manual'
         FROM generate_series(1, 3)`, [scope.id, target.id],
    );
    const unrelated = (await pool.query<{ id: string }>(
      `INSERT INTO audit_log (principal_id, action, query, metadata)
       VALUES ($1, 'read', 'other secret', '{"request_id":"legacy-shared"}')
       RETURNING id::text`, [other.id],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO principal_offboarding_audit_requests (principal_id, request_id)
       VALUES ($1, 'legacy-shared')`, [target.id],
    );
    const started = await offboardPrincipal(pool, admin, target.id, {
      confirmationScopeId: scope.id, batchSize: 1,
    });
    expect(started.complete).toBe(false);
    await expect(pool.query(
      'SELECT * FROM continuum_redact_offboarding_audit($1, $2, $3::bigint[])',
      [target.id, admin.id, [unrelated]],
    )).rejects.toThrow(/outside the active offboarding run/i);
    expect((await pool.query('SELECT query FROM audit_log WHERE id = $1', [unrelated])).rows[0].query)
      .toBe('other secret');
  });

  it('rejects below-policy retention before dry-run and records the selected applied cutoff', async () => {
    const { admin } = await adminFixture('retention');
    await pool.query(
      `INSERT INTO audit_log (at, principal_id, action, query, metadata)
       VALUES ('2025-01-01T00:00:00Z', $1, 'read', 'old', '{}')`, [admin.id],
    );
    await expect(runAuditRetention(pool, {
      retentionDays: 29, principalExternalId: 'retention-admin', dryRun: true,
    })).rejects.toThrow(/minimum|30/i);
    const result = await runAuditRetention(pool, {
      retentionDays: 30, principalExternalId: 'retention-admin',
    });
    const summary = (await pool.query(
      `SELECT metadata FROM audit_log
        WHERE metadata->>'source' = 'audit-retention' ORDER BY id DESC LIMIT 1`,
    )).rows[0].metadata as { cutoff: string };
    expect(summary.cutoff).toBe(result.cutoff);
  });

  it('refuses resume immediately when immutable started evidence is missing', async () => {
    const { admin } = await adminFixture('missing-start');
    const target = await createPrincipal(pool, {
      externalId: 'missing-start-target', kind: 'user', displayName: 'Target',
    });
    const scope = await createScope(pool, { kind: 'user', name: 'missing-start-owned' });
    await addMembership(pool, target.id, scope.id, 'writer');
    await mapOwnedUserScope(pool, admin, target.id, scope.id);
    await pool.query(
      `INSERT INTO memories (id, scope_id, type, title, body, author_id, source)
       SELECT gen_random_uuid(), $1, 'context', 'private', 'private', $2, 'manual'
         FROM generate_series(1, 3)`, [scope.id, target.id],
    );
    const first = await offboardPrincipal(pool, admin, target.id, {
      confirmationScopeId: scope.id, batchSize: 1,
    });
    expect(first.complete).toBe(false);
    const runId = (await pool.query(
      'SELECT run_id::text FROM principal_offboarding_runs WHERE principal_id = $1', [target.id],
    )).rows[0].run_id as string;
    await pool.query('ALTER TABLE principal_offboarding_run_events DISABLE TRIGGER preserve_offboarding_run_event');
    try {
      await pool.query(
        `DELETE FROM principal_offboarding_run_events WHERE run_id = $1 AND phase = 'started'`, [runId],
      );
    } finally {
      await pool.query('ALTER TABLE principal_offboarding_run_events ENABLE TRIGGER preserve_offboarding_run_event');
    }
    await expect(pool.query(
      'SELECT continuum_resume_offboarding_run($1, $2)', [runId, admin.id],
    )).rejects.toThrow(/immutable start evidence/i);
  });

  it('documents the bounded rollout and rollback contract without old-binary compatibility claims', async () => {
    const docs = await readFile(join(process.cwd(), 'docs/offboarding.md'), 'utf8');
    expect(docs).toMatch(/stop[\s\S]*migrate[\s\S]*regrant[\s\S]*start/i);
    expect(docs).toMatch(/rollback[\s\S]*0047-aware/i);
    expect(docs).not.toMatch(/old application tolerates/i);
    expect(docs).toMatch(/takeover[\s\S]*current effective org administrator/i);
  });
});
