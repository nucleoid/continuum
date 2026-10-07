import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg, { type PoolConfig } from 'pg';
import request from 'supertest';
import { createApp } from '../api/server.js';
import { addMembership } from '../storage/memberships.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { provisionEntraGroupBinding } from './membership-sync.js';

const quoteRole = (role: string) => '"' + role.replaceAll('"', '""') + '"';

async function applyGrantScript(
  pool: pg.Pool, filename: string, variables: Record<string, string>,
): Promise<void> {
  const source = await readFile(join(process.cwd(), 'scripts', filename), 'utf8');
  let sql = source.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\')).join('\n')
    .replaceAll(':"continuum_schema"', '"public"');
  for (const [name, value] of Object.entries(variables)) {
    sql = sql.replaceAll(':"' + name + '"', quoteRole(value));
    sql = sql.replaceAll(":'" + name + "'", "'" + value.replaceAll("'", "''") + "'");
  }
  await pool.query(sql);
}

async function createRolePool(
  pool: pg.Pool, role: string, profile: 'application' | 'operator' | 'sync', principalId?: string,
): Promise<pg.Pool> {
  await pool.query('CREATE ROLE ' + quoteRole(role) + (profile === 'sync' ? ' LOGIN' : ' NOLOGIN'));
  await pool.query(
    'GRANT ' + quoteRole(role) + ' TO CURRENT_USER'
    + (profile === 'sync' ? ' WITH ADMIN OPTION, SET FALSE, INHERIT FALSE' : ''),
  );
  if (profile !== 'sync') {
    await applyGrantScript(pool, 'grant-application-role.sql', { continuum_app_role: role });
  }
  if (profile === 'operator') {
    await applyGrantScript(pool, 'grant-operator-role.sql', {
      continuum_operator_role: role, continuum_principal_id: principalId!,
    });
  } else if (profile === 'sync') {
    await applyGrantScript(pool, 'grant-sync-role.sql', {
      continuum_sync_role: role, continuum_principal_id: principalId!,
    });
  }
  return new pg.Pool({
    ...(pool as unknown as { options: PoolConfig }).options, max: 1, options: '-c role=' + role,
  });
}

async function dropRole(pool: pg.Pool, connection: pg.Pool, role: string): Promise<void> {
  await connection.end();
  await pool.query('DROP OWNED BY ' + quoteRole(role));
  await pool.query('REVOKE ' + quoteRole(role) + ' FROM CURRENT_USER');
  await pool.query('DROP ROLE ' + quoteRole(role));
}

describe('offboarding database-role remediation', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => { await pool?.end(); });

  async function adminFixture(prefix: string) {
    const admin = await createPrincipal(pool, {
      externalId: prefix + '-admin', kind: 'user', displayName: 'Admin',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    return { admin, org: org! };
  }

  it('rejects app-role caller UUID forgery for reactivation and retention', async () => {
    const { admin } = await adminFixture('forged-authority');
    const target = await createPrincipal(pool, {
      externalId: 'forged-authority-target', kind: 'user', displayName: 'Target',
    });
    await pool.query('UPDATE principals SET disabled_at = now() WHERE id = $1', [target.id]);
    const role = 'continuum_app_forgery_' + Date.now();
    const connection = await createRolePool(pool, role, 'application');
    try {
      await expect(connection.query(
        'SELECT continuum_reactivate_principal($1, $2)', [target.id, admin.id],
      )).rejects.toThrow(/permission denied|trusted|operator/i);
      await expect(connection.query(
        "SELECT continuum_apply_audit_retention($1, now() - interval '31 days', 30, gen_random_uuid(), 1, '{}'::jsonb, 'none', NULL)", [admin.id],
      )).rejects.toThrow(/permission denied|trusted|operator/i);
    } finally { await dropRole(pool, connection, role); }
  });

  it('removes every irreversible offboarding and takeover capability from the app role', async () => {
    const role = 'continuum_app_capabilities_' + Date.now();
    const connection = await createRolePool(pool, role, 'application');
    try {
      const signatures = [
        'continuum_complete_offboarding_run(uuid,uuid,jsonb)',
        'continuum_resume_offboarding_run(uuid,uuid)',
        'continuum_restart_offboarding_run(uuid,uuid,jsonb)',
        'continuum_write_offboarding_run(uuid,uuid,text,jsonb)',
        'continuum_start_offboarding_run(uuid,uuid,jsonb)',
        'continuum_redact_offboarding_audit(uuid,uuid,bigint[])',
        'continuum_record_offboarding_event(uuid)',
        'continuum_apply_audit_retention(uuid,timestamptz,integer,uuid,integer,jsonb,text,text)',
        'continuum_reactivate_principal(uuid,uuid)',
        'continuum_change_manual_org_admin(uuid,uuid,text,boolean)',
        'continuum_takeover_manual_org_admin(uuid,uuid,uuid)',
      ];
      const privileges = await connection.query<{ allowed: boolean }>(
        `SELECT has_function_privilege(current_user, signature, 'EXECUTE') AS allowed
           FROM unnest($1::text[]) signature`, [signatures],
      );
      expect(privileges.rows).toHaveLength(signatures.length);
      expect(privileges.rows.every((row) => !row.allowed)).toBe(true);
      await expect(connection.query(
        'SELECT continuum_takeover_manual_org_admin(gen_random_uuid(), gen_random_uuid(), gen_random_uuid())',
      )).rejects.toThrow(/permission denied/i);
      await expect(connection.query(
        'SELECT continuum_redact_offboarding_audit(gen_random_uuid(), gen_random_uuid(), ARRAY[]::bigint[])',
      )).rejects.toThrow(/permission denied/i);
      await expect(connection.query(
        "SELECT continuum_restart_offboarding_run(gen_random_uuid(), gen_random_uuid(), '{}'::jsonb)",
      )).rejects.toThrow(/permission denied/i);
    } finally { await dropRole(pool, connection, role); }
  });

  it('rejects caller UUID forgery through every DB-bound operator wrapper', async () => {
    const { admin, org } = await adminFixture('operator-claim');
    const other = await createPrincipal(pool, {
      externalId: 'operator-claim-other', kind: 'user', displayName: 'Other admin',
    });
    await addMembership(pool, other.id, org.id, 'admin');
    const role = 'continuum_operator_claim_' + Date.now();
    const connection = await createRolePool(pool, role, 'operator', admin.id);
    const random = '34000000-0000-4000-8000-000000000001';
    const attacks: Array<[string, unknown[]]> = [
      ["SELECT * FROM continuum_operator_write_offboarding_run($1, $2, 'create', '{}'::jsonb)", [random, other.id]],
      ["SELECT continuum_operator_start_offboarding_run($1, $2, '{}'::jsonb)", [random, other.id]],
      ["SELECT continuum_operator_complete_offboarding_run($1, $2, '{}'::jsonb)", [random, other.id]],
      ['SELECT continuum_operator_resume_offboarding_run($1, $2)', [random, other.id]],
      ["SELECT * FROM continuum_operator_restart_offboarding_run($1, $2, '{}'::jsonb)", [random, other.id]],
      ['SELECT * FROM continuum_operator_redact_offboarding_audit($1, $2, ARRAY[]::bigint[])', [random, other.id]],
      ["SELECT continuum_operator_apply_audit_retention($1, now() - interval '31 days', 30, gen_random_uuid(), 1, '[]'::jsonb, 'none', NULL)", [other.id]],
      ['SELECT continuum_operator_reactivate_principal($1, $2)', [random, other.id]],
    ];
    try {
      expect((await connection.query(
        `SELECT has_function_privilege(current_user,
                  'continuum_write_offboarding_run(uuid,uuid,text,jsonb)', 'EXECUTE') AS raw,
                has_function_privilege(current_user,
                  'continuum_operator_write_offboarding_run(uuid,uuid,text,jsonb)', 'EXECUTE') AS guarded`,
      )).rows[0]).toEqual({ raw: false, guarded: true });
      for (const [sql, parameters] of attacks) {
        await expect(connection.query(sql, parameters)).rejects.toThrow(/DB-bound trusted approve identity/i);
      }
    } finally { await dropRole(pool, connection, role); }
  });

  it('blocks app and sync roles from reassigning an Entra membership principal', async () => {
    const { admin } = await adminFixture('membership-move');
    const first = await createPrincipal(pool, { externalId: 'membership-first', kind: 'user', displayName: 'First' });
    const second = await createPrincipal(pool, { externalId: 'membership-second', kind: 'user', displayName: 'Second' });
    const project = await createScope(pool, { kind: 'project', name: 'membership-move' });
    const groupId = '31000000-0000-4000-8000-000000000001';
    await provisionEntraGroupBinding(pool, admin, { externalId: groupId, scopeId: project.id, role: 'admin' });
    await pool.query(
      "INSERT INTO scope_memberships (principal_id, scope_id, role, source_kind, source_id, active) VALUES ($1, $2, 'admin', 'entra', $3, TRUE)",
      [first.id, project.id, groupId],
    );
    const service = await createPrincipal(pool, { externalId: 'membership-sync-service', kind: 'service', displayName: 'Sync service' });
    for (const [profile, principal] of [['application', undefined], ['sync', service.id]] as const) {
      const role = 'continuum_move_' + profile + '_' + Date.now();
      const connection = await createRolePool(pool, role, profile, principal);
      try {
        await expect(connection.query(
          "UPDATE scope_memberships SET principal_id = $1 WHERE principal_id = $2 AND scope_id = $3 AND source_kind = 'entra'",
          [second.id, first.id, project.id],
        )).rejects.toThrow(/permission denied|immutable|trusted sync/i);
      } finally { await dropRole(pool, connection, role); }
    }
  });

  it('blocks app and sync direct SQL from clearing revocation, quarantine, or freshness', async () => {
    const { admin } = await adminFixture('binding-clear');
    const project = await createScope(pool, { kind: 'project', name: 'binding-clear' });
    const groupId = '32000000-0000-4000-8000-000000000001';
    await provisionEntraGroupBinding(pool, admin, { externalId: groupId, scopeId: project.id, role: 'reader' });
    await pool.query(
      "UPDATE entra_groups SET active = FALSE, deactivated_at = now(), approval_revoked_by = $2, approval_revoked_at = now(), quarantined_at = now(), quarantine_reason = 'TEST' WHERE external_id = $1",
      [groupId, admin.id],
    );
    const service = await createPrincipal(pool, { externalId: 'binding-sync-service', kind: 'service', displayName: 'Sync service' });
    for (const [profile, principal] of [['application', undefined], ['sync', service.id]] as const) {
      const role = 'continuum_clear_' + profile + '_' + Date.now();
      const connection = await createRolePool(pool, role, profile, principal);
      try {
        await expect(connection.query(
          'UPDATE entra_groups SET approval_revoked_by = NULL, approval_revoked_at = NULL, quarantined_at = NULL, quarantine_reason = NULL WHERE external_id = $1', [groupId],
        )).rejects.toThrow(/permission denied|reapproval|guarded/i);
        await expect(connection.query('UPDATE entra_sync_state SET last_success_at = now() WHERE singleton'))
          .rejects.toThrow(/permission denied/i);
        if (profile === 'sync') {
          await expect(connection.query('SELECT continuum_record_entra_sync_success($1, 48)', [service.id]))
            .resolves.toBeDefined();
        }
      } finally { await dropRole(pool, connection, role); }
    }
  });

  it('provisions and reapproves bindings through the real operator grants', async () => {
    const { admin } = await adminFixture('operator-binding');
    const project = await createScope(pool, { kind: 'project', name: 'operator-binding' });
    const role = 'continuum_operator_binding_' + Date.now();
    const connection = await createRolePool(pool, role, 'operator', admin.id);
    const groupId = '33000000-0000-4000-8000-000000000001';
    try {
      expect((await pool.query(
        "SELECT has_table_privilege($1, 'scopes', 'SELECT') AS allowed", [role],
      )).rows[0].allowed).toBe(true);
      await expect(connection.query('SELECT id FROM scopes WHERE id = $1', [project.id]))
        .resolves.toBeDefined();
      await expect(provisionEntraGroupBinding(connection, admin, { externalId: groupId, scopeId: project.id, role: 'reader' }))
        .resolves.toMatchObject({ created: true });
      await pool.query(
        "UPDATE entra_groups SET active = FALSE, deactivated_at = now(), approval_revoked_by = $2, approval_revoked_at = now(), quarantined_at = now(), quarantine_reason = 'TEST' WHERE external_id = $1",
        [groupId, admin.id],
      );
      await expect(provisionEntraGroupBinding(connection, admin, { externalId: groupId, scopeId: project.id, role: 'reader' }))
        .resolves.toMatchObject({ created: false });
      expect((await pool.query(
        'SELECT active, approval_revoked_at, quarantined_at FROM entra_groups WHERE external_id = $1', [groupId],
      )).rows[0]).toEqual({ active: true, approval_revoked_at: null, quarantined_at: null });
    } finally { await dropRole(pool, connection, role); }
  });

  it('rejects a DB-bound operator after its principal is deauthorized', async () => {
    const { admin, org } = await adminFixture('deauthorized');
    const remaining = await createPrincipal(pool, { externalId: 'remaining-admin', kind: 'user', displayName: 'Remaining' });
    const target = await createPrincipal(pool, { externalId: 'deauthorized-target', kind: 'user', displayName: 'Target' });
    await addMembership(pool, remaining.id, org.id, 'admin');
    await addMembership(pool, target.id, org.id, 'admin');
    const role = 'continuum_deauthorized_' + Date.now();
    const connection = await createRolePool(pool, role, 'operator', admin.id);
    try {
      await pool.query("UPDATE scope_memberships SET role = 'writer' WHERE principal_id = $1 AND scope_id = $2 AND source_kind = 'manual'", [admin.id, org.id]);
      await expect(connection.query("SELECT continuum_change_manual_org_admin($1, $2, 'writer', TRUE)", [admin.id, target.id]))
        .rejects.toThrow(/effective manual org administrator|trusted/i);
      await expect(connection.query(
        'SELECT continuum_takeover_manual_org_admin($1, $2, $3)',
        [admin.id, target.id, remaining.id],
      )).rejects.toThrow(/effective manual org administrator|trusted/i);
    } finally { await dropRole(pool, connection, role); }
  });

  it('rotates sync authority to an enabled service principal through an operator', async () => {
    const { admin } = await adminFixture('sync-rotation');
    const service = await createPrincipal(pool, { externalId: 'rotated-sync-service', kind: 'service', displayName: 'Rotated sync' });
    const syncRole = 'continuum_rotated_sync_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(syncRole) + ' LOGIN');
    await pool.query(
      'GRANT ' + quoteRole(syncRole)
      + ' TO CURRENT_USER WITH ADMIN OPTION, SET FALSE, INHERIT FALSE',
    );
    const operatorRole = 'continuum_rotation_operator_' + Date.now();
    const operator = await createRolePool(pool, operatorRole, 'operator', admin.id);
    try {
      await expect(operator.query('SELECT continuum_rotate_sync_database_identity($1, $2, $3)', [admin.id, syncRole, service.id]))
        .resolves.toBeDefined();
      expect((await pool.query(
        'SELECT principal_id::text, can_sync FROM continuum_trusted_database_identities WHERE database_role = $1::name', [syncRole],
      )).rows[0]).toEqual({ principal_id: service.id, can_sync: true });
    } finally {
      await dropRole(pool, operator, operatorRole);
      await pool.query('DROP OWNED BY ' + quoteRole(syncRole));
      await pool.query('DROP ROLE ' + quoteRole(syncRole));
    }
  });

  it('makes REST owned-scope mapping explicitly operator-only under shipped grants', async () => {
    const { admin } = await adminFixture('rest-role');
    const target = await createPrincipal(pool, { externalId: 'rest-role-target', kind: 'user', displayName: 'Target' });
    const personal = await createScope(pool, { kind: 'user', name: 'rest-role-owned' });
    await addMembership(pool, target.id, personal.id, 'writer');
    const appRole = 'continuum_rest_app_' + Date.now();
    const appPool = await createRolePool(pool, appRole, 'application');
    const operatorRole = 'continuum_rest_operator_' + Date.now();
    const operatorPool = await createRolePool(pool, operatorRole, 'operator', admin.id);
    try {
      const path = '/api/v0/admin/principals/' + target.id + '/owned-user-scope';
      const denied = await request(createApp(appPool, { logger: { info() {}, error() {} } }))
        .put(path).set('Authorization', 'Bearer rest-role-admin').send({ scopeId: personal.id });
      expect(denied.status).toBe(403);
      const allowed = await request(createApp(operatorPool, { logger: { info() {}, error() {} } }))
        .put(path).set('Authorization', 'Bearer rest-role-admin').send({ scopeId: personal.id });
      expect(allowed.status).toBe(201);
      expect(allowed.body).toMatchObject({ principalId: target.id, scopeId: personal.id });
    } finally {
      await dropRole(pool, appPool, appRole);
      await dropRole(pool, operatorPool, operatorRole);
    }
  });

  it('documents bounded rollout, forward rollback, cleanup, and sync rotation', async () => {
    const docs = await readFile(join(process.cwd(), 'docs/offboarding.md'), 'utf8');
    expect(docs).toMatch(/operator-only[\s\S]*owned-user-scope/i);
    expect(docs).toMatch(/dedicated[\s\S]*service principal[\s\S]*rotate/i);
    expect(docs).toMatch(/stop[\s\S]*migrate[\s\S]*grant[\s\S]*start/i);
    expect(docs).toMatch(/backup[\s\S]*forward-only/i);
    expect(docs).toMatch(/bounded[\s\S]*principal_offboarding_audit_requests/i);
    const appGrants = await readFile(join(process.cwd(), 'scripts/grant-application-role.sql'), 'utf8');
    expect(appGrants).not.toMatch(/GRANT SELECT[^;]*principal_offboarding_audit_requests/is);
  });
});
