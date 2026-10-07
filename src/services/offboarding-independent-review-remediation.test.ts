import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg, { type PoolConfig } from 'pg';
import { runAuditRetention } from '../maintenance/audit-retention.js';
import { addMembership } from '../storage/memberships.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { reactivatePrincipal } from './principal-admin.js';

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
    ...(pool as unknown as { options: PoolConfig }).options,
    max: 1,
    options: '-c role=' + role,
  });
}

async function dropRole(pool: pg.Pool, connection: pg.Pool, role: string): Promise<void> {
  await connection.end();
  await pool.query('DROP OWNED BY ' + quoteRole(role));
  await pool.query('REVOKE ' + quoteRole(role) + ' FROM CURRENT_USER');
  await pool.query('DROP ROLE ' + quoteRole(role));
}

describe('independent exact-head review remediation', () => {
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

  it('denies real sync-role attacks against manual org, project, and user memberships', async () => {
    const { org } = await adminFixture('manual-attack-admin');
    const service = await createPrincipal(pool, {
      externalId: 'manual-attack-sync', kind: 'service', displayName: 'Sync',
    });
    const victim = await createPrincipal(pool, {
      externalId: 'manual-attack-victim', kind: 'user', displayName: 'Victim',
    });
    const replacement = await createPrincipal(pool, {
      externalId: 'manual-attack-replacement', kind: 'user', displayName: 'Replacement',
    });
    const project = await createScope(pool, { kind: 'project', name: 'manual-attack-project' });
    const user = await createScope(pool, { kind: 'user', name: 'manual-attack-user' });
    await addMembership(pool, victim.id, org.id, 'reader');
    await addMembership(pool, victim.id, project.id, 'reader');
    await addMembership(pool, victim.id, user.id, 'writer');
    const role = 'continuum_sync_manual_attack_' + Date.now();
    const connection = await createRolePool(pool, role, 'sync', service.id);
    try {
      for (const scopeId of [org.id, project.id, user.id]) {
        await expect(connection.query(
          `UPDATE scope_memberships SET role = 'admin', active = FALSE,
                    deactivated_at = now(), principal_id = $1
            WHERE principal_id = $2 AND scope_id = $3 AND source_kind = 'manual'`,
          [replacement.id, victim.id, scopeId],
        )).rejects.toThrow(/permission denied|manual membership/i);
      }
      expect((await pool.query(
        `SELECT scope_id::text, principal_id::text, role, active
           FROM scope_memberships WHERE principal_id = $1 AND source_kind = 'manual'
           ORDER BY scope_id`, [victim.id],
      )).rows).toEqual(expect.arrayContaining([
        { scope_id: org.id, principal_id: victim.id, role: 'reader', active: true },
        { scope_id: project.id, principal_id: victim.id, role: 'reader', active: true },
        { scope_id: user.id, principal_id: victim.id, role: 'writer', active: true },
      ]));
      expect((await connection.query(
        `SELECT has_table_privilege(current_user, 'scope_memberships', 'UPDATE') AS allowed`,
      )).rows[0].allowed).toBe(false);
    } finally { await dropRole(pool, connection, role); }
  });

  it('rotates to a fresh least-privilege sync role and atomically disables the old binding', async () => {
    const { admin } = await adminFixture('role-rotation');
    const oldService = await createPrincipal(pool, {
      externalId: 'role-rotation-old', kind: 'service', displayName: 'Old sync',
    });
    const newService = await createPrincipal(pool, {
      externalId: 'role-rotation-new', kind: 'service', displayName: 'New sync',
    });
    const oldRole = 'continuum_sync_old_' + Date.now();
    const oldConnection = await createRolePool(pool, oldRole, 'sync', oldService.id);
    const newRole = 'continuum_sync_new_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(newRole) + ' LOGIN');
    await pool.query(
      'GRANT ' + quoteRole(newRole)
      + ' TO CURRENT_USER WITH ADMIN OPTION, SET FALSE, INHERIT FALSE',
    );
    const operatorRole = 'continuum_rotation_operator_' + Date.now();
    const operator = await createRolePool(pool, operatorRole, 'operator', admin.id);
    let newConnection: pg.Pool | undefined;
    try {
      await operator.query(
        'SELECT continuum_rotate_sync_database_identity($1, $2, $3)',
        [admin.id, newRole, newService.id],
      );
      newConnection = new pg.Pool({
        ...(pool as unknown as { options: PoolConfig }).options,
        max: 1, options: '-c role=' + newRole,
      });
      await expect(newConnection.query(
        'SELECT continuum_require_sync_session($1)', [newService.id],
      )).resolves.toBeDefined();
      await expect(oldConnection.query(
        'SELECT public.continuum_require_sync_session($1)', [oldService.id],
      )).rejects.toThrow(/permission denied|trusted sync/i);
      expect((await pool.query(
        `SELECT database_role::text, principal_id::text FROM continuum_trusted_database_identities
          WHERE can_sync ORDER BY database_role`,
      )).rows).toEqual([{ database_role: newRole, principal_id: newService.id }]);
    } finally {
      await newConnection?.end();
      await dropRole(pool, operator, operatorRole);
      await dropRole(pool, oldConnection, oldRole);
      await pool.query('DROP OWNED BY ' + quoteRole(newRole));
      await pool.query('REVOKE ' + quoteRole(newRole) + ' FROM CURRENT_USER');
      await pool.query('DROP ROLE ' + quoteRole(newRole));
    }
  });

  it('rejects owner, shared-app, and approve-related rotation targets without losing operators', async () => {
    const { admin } = await adminFixture('unsafe-rotation');
    const service = await createPrincipal(pool, {
      externalId: 'unsafe-rotation-service', kind: 'service', displayName: 'Sync',
    });
    const operatorRole = 'continuum_unsafe_operator_' + Date.now();
    const operator = await createRolePool(pool, operatorRole, 'operator', admin.id);
    const appRole = 'continuum_unsafe_app_' + Date.now();
    const app = await createRolePool(pool, appRole, 'application');
    try {
      const owner = (await pool.query(
        `SELECT pg_get_userbyid(relowner)::text AS role FROM pg_class WHERE oid = 'principals'::regclass`,
      )).rows[0].role as string;
      for (const target of [owner, appRole, operatorRole]) {
        await expect(operator.query(
          'SELECT continuum_rotate_sync_database_identity($1, $2, $3)',
          [admin.id, target, service.id],
        )).rejects.toThrow(/owner|application|operator|approve|approval|least-privilege|membership|SET ROLE|isolated/i);
      }
      await expect(operator.query(
        'SELECT continuum_operator_authorize_audit_retention($1)', [admin.id],
      )).resolves.toBeDefined();
      expect((await pool.query(
        `SELECT can_approve, can_sync FROM continuum_trusted_database_identities
          WHERE database_role = $1::name`, [operatorRole],
      )).rows[0]).toEqual({ can_approve: true, can_sync: false });
    } finally {
      await dropRole(pool, app, appRole);
      await dropRole(pool, operator, operatorRole);
    }
  });

  it('removes raw Entra UPDATE so an operator cannot rewrite an external ID', async () => {
    const { admin } = await adminFixture('immutable-group');
    const project = await createScope(pool, { kind: 'project', name: 'immutable-group-project' });
    const role = 'continuum_immutable_operator_' + Date.now();
    const operator = await createRolePool(pool, role, 'operator', admin.id);
    const externalId = '35000000-0000-4000-8000-000000000001';
    try {
      await operator.query(
        `SELECT continuum_upsert_entra_group_binding($1, $2, 'immutable', $3, 'reader')`,
        [admin.id, externalId, project.id],
      );
      expect((await operator.query(
        `SELECT has_table_privilege(current_user, 'entra_groups', 'UPDATE') AS allowed`,
      )).rows[0].allowed).toBe(false);
      await expect(operator.query(
        `UPDATE entra_groups SET external_id = $2 WHERE external_id = $1`,
        [externalId, '35000000-0000-4000-8000-000000000002'],
      )).rejects.toThrow(/permission denied/i);
      expect((await pool.query(
        'SELECT external_id FROM entra_groups WHERE external_id = $1', [externalId],
      )).rows).toEqual([{ external_id: externalId }]);
    } finally { await dropRole(pool, operator, role); }
  });

  it('maps shared-app reactivation and retention authorization failures to FORBIDDEN', async () => {
    const { admin } = await adminFixture('forbidden-map');
    const target = await createPrincipal(pool, {
      externalId: 'forbidden-map-target', kind: 'user', displayName: 'Target',
    });
    await pool.query('UPDATE principals SET disabled_at = now() WHERE id = $1', [target.id]);
    const role = 'continuum_forbidden_app_' + Date.now();
    const connection = await createRolePool(pool, role, 'application');
    try {
      await expect(connection.query(
        'SELECT * FROM continuum_get_offboarding_run($1, $2)', [target.id, admin.id],
      )).rejects.toThrow(/permission denied/i);
      await expect(connection.query(
        'SELECT * FROM continuum_operator_get_offboarding_run($1, $2)', [target.id, admin.id],
      )).rejects.toThrow(/permission denied/i);
      await expect(reactivatePrincipal(connection, admin, target.id))
        .rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
      await expect(runAuditRetention(connection, {
        retentionDays: 30, principalExternalId: admin.externalId, dryRun: false,
      })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    } finally { await dropRole(pool, connection, role); }
  });

  it('ships a forward-only migration and quoted-schema-safe least-privilege grants', async () => {
    const migration = await readFile(
      join(process.cwd(), 'migrations/0048_offboarding_independent_review.sql'), 'utf8',
    );
    const syncGrants = await readFile(join(process.cwd(), 'scripts/grant-sync-role.sql'), 'utf8');
    const operatorGrants = await readFile(join(process.cwd(), 'scripts/grant-operator-role.sql'), 'utf8');
    const docs = await readFile(join(process.cwd(), 'docs/offboarding.md'), 'utf8');
    expect(migration).toMatch(/continuum_sync_deactivate_entra_memberships/i);
    expect(migration).toMatch(/external_id[\s\S]*immutable/i);
    expect(migration).toMatch(/database_role_oid/i);
    expect(migration).toMatch(/separate_capabilities/i);
    expect(migration).toMatch(/format\([^)]*%I/i);
    expect(syncGrants).not.toMatch(/GRANT UPDATE ON TABLE[\s\S]*scope_memberships/i);
    expect(syncGrants).not.toMatch(/GRANT UPDATE ON TABLE[\s\S]*entra_groups/i);
    expect(syncGrants).not.toMatch(/GRANT SELECT ON TABLE[\s\S]*memories/i);
    expect(operatorGrants).not.toMatch(/GRANT UPDATE ON TABLE[\s\S]*entra_groups/i);
    expect(docs).toMatch(/PostgreSQL 16[\s\S]*post-migration grants/i);
    expect(docs).toMatch(/rollback[\s\S]*pre-migration backup/i);
  });
});
