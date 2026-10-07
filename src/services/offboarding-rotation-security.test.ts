import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg, { type PoolConfig } from 'pg';
import { addMembership } from '../storage/memberships.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { provisionEntraGroupBinding, revokeEntraGroupBinding } from './membership-sync.js';

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

async function rolePool(pool: pg.Pool, role: string): Promise<pg.Pool> {
  return new pg.Pool({
    ...(pool as unknown as { options: PoolConfig }).options,
    max: 1,
    options: '-c role=' + role,
  });
}

async function grantOwnerRetirementAuthority(pool: pg.Pool, role: string): Promise<void> {
  await pool.query(
    'GRANT ' + quoteRole(role)
    + ' TO CURRENT_USER WITH ADMIN OPTION, SET FALSE, INHERIT FALSE',
  );
}

async function dropRoles(pool: pg.Pool, roles: string[]): Promise<void> {
  for (const role of roles) await pool.query('DROP OWNED BY ' + quoteRole(role));
  for (const role of roles) await pool.query('REVOKE ' + quoteRole(role) + ' FROM CURRENT_USER');
  for (const role of [...roles].reverse()) await pool.query('DROP ROLE ' + quoteRole(role));
}

describe('sync database identity rotation security', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => { await pool?.end(); });

  async function operatorFixture(prefix: string) {
    const admin = await createPrincipal(pool, {
      externalId: prefix + '-admin', kind: 'user', displayName: 'Admin',
    });
    const service = await createPrincipal(pool, {
      externalId: prefix + '-service', kind: 'service', displayName: 'Service',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    const operatorRole = 'continuum_secure_operator_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(operatorRole) + ' NOLOGIN');
    await pool.query('GRANT ' + quoteRole(operatorRole) + ' TO CURRENT_USER');
    await applyGrantScript(pool, 'grant-application-role.sql', { continuum_app_role: operatorRole });
    await applyGrantScript(pool, 'grant-operator-role.sql', {
      continuum_operator_role: operatorRole, continuum_principal_id: admin.id,
    });
    return { admin, service, operatorRole, operator: await rolePool(pool, operatorRole) };
  }

  it('rejects every nonempty NOINHERIT/SET ROLE membership edge around a target', async () => {
    const fixture = await operatorFixture('role-chain');
    const target = 'continuum_chain_target_' + Date.now();
    const bridge = 'continuum_chain_bridge_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(target) + ' NOLOGIN NOINHERIT');
    await pool.query('CREATE ROLE ' + quoteRole(bridge) + ' NOLOGIN NOINHERIT');
    await applyGrantScript(pool, 'grant-application-role.sql', { continuum_app_role: bridge });
    await pool.query('GRANT ' + quoteRole(target) + ' TO ' + quoteRole(bridge));
    try {
      await expect(fixture.operator.query(
        'SELECT continuum_rotate_sync_database_identity($1, $2, $3)',
        [fixture.admin.id, target, fixture.service.id],
      )).rejects.toThrow(/membership|SET ROLE|isolated/i);
      await pool.query('REVOKE ' + quoteRole(target) + ' FROM ' + quoteRole(bridge));
      await pool.query('GRANT ' + quoteRole(bridge) + ' TO ' + quoteRole(target));
      await expect(fixture.operator.query(
        'SELECT continuum_rotate_sync_database_identity($1, $2, $3)',
        [fixture.admin.id, target, fixture.service.id],
      )).rejects.toThrow(/membership|SET ROLE|isolated/i);
    } finally {
      await fixture.operator.end();
      await dropRoles(pool, [target, bridge, fixture.operatorRole]);
    }
  });

  it('rejects CREATEROLE, schema-CREATE, and application-object owner targets', async () => {
    const fixture = await operatorFixture('privileged-target');
    const roles = [
      'continuum_createrole_' + Date.now(),
      'continuum_schema_create_' + Date.now(),
      'continuum_object_owner_' + Date.now(),
    ];
    await pool.query('CREATE ROLE ' + quoteRole(roles[0]) + ' NOLOGIN CREATEROLE');
    await pool.query('CREATE ROLE ' + quoteRole(roles[1]) + ' NOLOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(roles[2]) + ' NOLOGIN');
    await pool.query('GRANT CREATE ON SCHEMA public TO ' + quoteRole(roles[1]));
    await pool.query('CREATE TABLE continuum_rotation_owned_probe (id integer)');
    await pool.query('ALTER TABLE continuum_rotation_owned_probe OWNER TO ' + quoteRole(roles[2]));
    try {
      for (const role of roles) {
        await expect(fixture.operator.query(
          'SELECT continuum_rotate_sync_database_identity($1, $2, $3)',
          [fixture.admin.id, role, fixture.service.id],
        )).rejects.toThrow(/privileged|owner|CREATE|isolated/i);
      }
    } finally {
      await fixture.operator.end();
      await dropRoles(pool, [...roles, fixture.operatorRole]);
    }
  });

  it('does not let sync registration bypass isolation, privilege, ownership, or memory-read checks', async () => {
    const service = await createPrincipal(pool, {
      externalId: 'registration-bypass-service', kind: 'service', displayName: 'Sync',
    });
    const suffix = Date.now();
    const target = 'continuum_registration_target_' + suffix;
    const bridge = 'continuum_registration_bridge_' + Date.now();
    const privileged = 'continuum_registration_privileged_' + suffix;
    const schemaCreate = 'continuum_registration_create_' + suffix;
    const owner = 'continuum_registration_owner_' + suffix;
    const reader = 'continuum_registration_reader_' + suffix;
    await pool.query('CREATE ROLE ' + quoteRole(target) + ' NOLOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(bridge) + ' NOLOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(privileged) + ' NOLOGIN CREATEROLE');
    await pool.query('CREATE ROLE ' + quoteRole(schemaCreate) + ' NOLOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(owner) + ' NOLOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(reader) + ' NOLOGIN');
    await pool.query('GRANT ' + quoteRole(bridge) + ' TO ' + quoteRole(target));
    await pool.query('GRANT CREATE ON SCHEMA public TO ' + quoteRole(schemaCreate));
    await pool.query('CREATE TABLE continuum_registration_owned_probe (id integer)');
    await pool.query('ALTER TABLE continuum_registration_owned_probe OWNER TO ' + quoteRole(owner));
    await pool.query('GRANT SELECT ON TABLE memories TO ' + quoteRole(reader));
    try {
      for (const role of [target, privileged, schemaCreate, owner, reader]) {
        await expect(pool.query(
          'SELECT continuum_register_trusted_database_identity($1, $2, FALSE, TRUE)',
          [role, service.id],
        )).rejects.toThrow(/membership|SET ROLE|isolated|privileged|owner|CREATE|memory/i);
      }
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM continuum_trusted_database_identities
          WHERE database_role = ANY($1::name[])`,
        [[target, privileged, schemaCreate, owner, reader]],
      )).rows[0].count).toBe(0);
    } finally {
      await dropRoles(pool, [target, bridge, privileged, schemaCreate, owner, reader]);
    }
  });

  it('registration safely retires the previous sync identity and enforces one active binding', async () => {
    const fixture = await operatorFixture('registration-verification');
    const first = await createPrincipal(pool, {
      externalId: 'registration-first-service', kind: 'service', displayName: 'First',
    });
    const second = await createPrincipal(pool, {
      externalId: 'registration-second-service', kind: 'service', displayName: 'Second',
    });
    const oldRole = 'continuum_registration_old_' + Date.now();
    const nextRole = 'continuum_registration_next_' + Date.now();
    const applicationRole = 'continuum_registration_app_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(oldRole) + ' LOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(nextRole) + ' LOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(applicationRole) + ' NOLOGIN');
    await applyGrantScript(pool, 'grant-application-role.sql', {
      continuum_app_role: applicationRole,
    });
    try {
      await pool.query(
        'SELECT continuum_register_trusted_database_identity($1, $2, FALSE, TRUE)',
        [oldRole, first.id],
      );
      await pool.query(
        'SELECT continuum_register_trusted_database_identity($1, $2, FALSE, TRUE)',
        [nextRole, second.id],
      );
      expect((await pool.query(
        `SELECT database_role::text, principal_id::text
           FROM continuum_trusted_database_identities WHERE can_sync`,
      )).rows).toEqual([{ database_role: nextRole, principal_id: second.id }]);
      expect((await pool.query(
        'SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [oldRole],
      )).rows[0].rolcanlogin).toBe(false);
      expect((await pool.query(
        `SELECT has_schema_privilege($1, 'public', 'USAGE') AS schema_usage`,
        [oldRole],
      )).rows[0]).toEqual({ schema_usage: false });
      const oldRoleOid = (await pool.query(
        'SELECT oid::text FROM pg_roles WHERE rolname = $1', [oldRole],
      )).rows[0].oid;
      await expect(applyGrantScript(pool, 'retire-sync-role.sql', {
        continuum_schema: 'public', retired_sync_role: oldRole,
        confirm_retired_sync_role_oid: '0',
        confirm_legacy_unrecorded_sync_role: '',
      })).rejects.toThrow(/confirmation|OID/i);
      await expect(applyGrantScript(pool, 'retire-sync-role.sql', {
        continuum_schema: 'public', retired_sync_role: oldRole,
        confirm_retired_sync_role_oid: oldRoleOid,
        confirm_legacy_unrecorded_sync_role: '',
      })).resolves.toBeUndefined();
      await expect(applyGrantScript(pool, 'retire-sync-role.sql', {
        continuum_schema: 'public', retired_sync_role: nextRole,
        confirm_retired_sync_role_oid: (await pool.query(
          'SELECT oid::text FROM pg_roles WHERE rolname = $1', [nextRole],
        )).rows[0].oid,
        confirm_legacy_unrecorded_sync_role: '',
      })).rejects.toThrow(/active trusted database identity/i);
      await pool.query(
        'GRANT ' + quoteRole(oldRole)
        + ' TO CURRENT_USER WITH ADMIN OPTION, SET FALSE, INHERIT FALSE',
      );
      await expect(applyGrantScript(pool, 'verify-database-identities.sql', {
        continuum_schema: 'public',
        continuum_app_role: applicationRole,
        continuum_sync_role: nextRole,
        continuum_operator_role: fixture.operatorRole,
        retired_sync_role: oldRole,
      })).resolves.toBeUndefined();
      await expect(applyGrantScript(pool, 'verify-database-identities.sql', {
        continuum_schema: 'public',
        continuum_app_role: applicationRole,
        continuum_sync_role: nextRole,
        continuum_operator_role: fixture.operatorRole,
        retired_sync_role: oldRole + '_missing',
      })).rejects.toThrow(/retired sync role.*exist|does not resolve|unknown/i);
      await pool.query(
        'GRANT EXECUTE ON FUNCTION continuum_operator_offboard_scope_access(UUID, UUID) TO '
        + quoteRole(applicationRole),
      );
      await expect(applyGrantScript(pool, 'verify-database-identities.sql', {
        continuum_schema: 'public',
        continuum_app_role: applicationRole,
        continuum_sync_role: nextRole,
        continuum_operator_role: fixture.operatorRole,
        retired_sync_role: oldRole,
      })).rejects.toThrow(/application role|function privilege|allow-list|drift/i);
      await pool.query(
        'REVOKE EXECUTE ON FUNCTION continuum_operator_offboard_scope_access(UUID, UUID) FROM '
        + quoteRole(applicationRole),
      );
      await pool.query('ALTER ROLE ' + quoteRole(oldRole) + ' LOGIN');
      await expect(applyGrantScript(pool, 'verify-database-identities.sql', {
        continuum_schema: 'public',
        continuum_app_role: applicationRole,
        continuum_sync_role: nextRole,
        continuum_operator_role: fixture.operatorRole,
        retired_sync_role: '',
      })).rejects.toThrow(/retired sync role.*login|authority/i);
      await pool.query('ALTER ROLE ' + quoteRole(oldRole) + ' NOLOGIN');
      await pool.query('DROP OWNED BY ' + quoteRole(oldRole));
      await pool.query('REVOKE ' + quoteRole(oldRole) + ' FROM CURRENT_USER');
      await pool.query('DROP ROLE ' + quoteRole(oldRole));
      await pool.query('CREATE ROLE ' + quoteRole(oldRole) + ' LOGIN');
      await expect(applyGrantScript(pool, 'verify-database-identities.sql', {
        continuum_schema: 'public', continuum_app_role: applicationRole,
        continuum_sync_role: nextRole, continuum_operator_role: fixture.operatorRole,
        retired_sync_role: '',
      })).rejects.toThrow(/retired sync role name.*reused|different OID/i);
    } finally {
      await pool.query('REVOKE ' + quoteRole(oldRole) + ' FROM CURRENT_USER');
      await fixture.operator.end();
      await dropRoles(pool, [oldRole, nextRole, applicationRole, fixture.operatorRole]);
    }
  });

  it('rejects membership edges and privileged approval registration targets', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'unsafe-approval-admin', kind: 'user', displayName: 'Admin',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    const target = 'continuum_approval_target_' + Date.now();
    const bridge = 'continuum_approval_bridge_' + Date.now();
    const privileged = 'continuum_approval_privileged_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(target) + ' NOLOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(bridge) + ' NOLOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(privileged) + ' NOLOGIN BYPASSRLS');
    await pool.query('GRANT ' + quoteRole(bridge) + ' TO ' + quoteRole(target));
    try {
      for (const role of [target, privileged]) {
        await expect(pool.query(
          'SELECT continuum_register_trusted_database_identity($1, $2, TRUE, FALSE)',
          [role, admin.id],
        )).rejects.toThrow(/membership|SET ROLE|isolated|unsafe|privileged/i);
      }
    } finally { await dropRoles(pool, [target, bridge, privileged]); }
  });

  it('binds authority to role OID so a dropped role name cannot inherit stale sync authority', async () => {
    const service = await createPrincipal(pool, {
      externalId: 'stale-sync-service', kind: 'service', displayName: 'Stale service',
    });
    const role = 'continuum_stale_sync_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(role) + ' LOGIN');
    await grantOwnerRetirementAuthority(pool, role);
    await applyGrantScript(pool, 'grant-sync-role.sql', {
      continuum_sync_role: role, continuum_principal_id: service.id,
    });
    const oldOid = (await pool.query<{ oid: number }>(
      'SELECT oid FROM pg_roles WHERE rolname = $1', [role],
    )).rows[0].oid;
    await pool.query('DROP OWNED BY ' + quoteRole(role));
    await pool.query('REVOKE ' + quoteRole(role) + ' FROM CURRENT_USER');
    await pool.query('DROP ROLE ' + quoteRole(role));
    await pool.query('CREATE ROLE ' + quoteRole(role) + ' LOGIN');
    await grantOwnerRetirementAuthority(pool, role);
    const replacement = await rolePool(pool, role);
    try {
      const binding = (await pool.query(
        'SELECT database_role_oid::oid AS oid FROM continuum_trusted_database_identities WHERE database_role = $1::name',
        [role],
      )).rows[0];
      expect(Number(binding.oid)).toBe(Number(oldOid));
      await expect(replacement.query(
        'SELECT public.continuum_require_sync_session($1)', [service.id],
      ))
        .rejects.toThrow(/permission denied|DB-bound trusted sync identity/i);
    } finally {
      await replacement.end();
      await pool.query('DROP OWNED BY ' + quoteRole(role));
      await pool.query('REVOKE ' + quoteRole(role) + ' FROM CURRENT_USER');
      await pool.query('DROP ROLE ' + quoteRole(role));
      await pool.query('DELETE FROM continuum_trusted_database_identities WHERE database_role = $1::name', [role]);
    }
  });

  it('explicitly rebinds restored database identities to recreated role OIDs', async () => {
    const service = await createPrincipal(pool, {
      externalId: 'logical-restore-service', kind: 'service', displayName: 'Restored',
    });
    const role = 'continuum_restored_sync_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(role) + ' LOGIN');
    await pool.query(
      'SELECT continuum_register_trusted_database_identity($1, $2, FALSE, TRUE)',
      [role, service.id],
    );
    const oldOid = (await pool.query(
      'SELECT oid::text FROM pg_roles WHERE rolname = $1', [role],
    )).rows[0].oid;
    await pool.query('DROP OWNED BY ' + quoteRole(role));
    await pool.query('DROP ROLE ' + quoteRole(role));
    await pool.query('CREATE ROLE ' + quoteRole(role) + ' LOGIN');
    try {
      await expect(pool.query(
        "SELECT continuum_rebind_database_identity_oids('REBIND DATABASE IDENTITIES', 'FOREIGN OID NAMESPACE')",
      )).resolves.toBeDefined();
      const rebound = (await pool.query(
        `SELECT identity.database_role_oid::text AS oid, role.oid::text AS current_oid
           FROM continuum_trusted_database_identities identity
           JOIN pg_roles role ON role.rolname = identity.database_role::text
          WHERE identity.database_role = $1::name`, [role],
      )).rows[0];
      expect(rebound.oid).toBe(rebound.current_oid);
      expect(rebound.oid).not.toBe(oldOid);
    } finally {
      await pool.query(
        'DELETE FROM continuum_trusted_database_identities WHERE database_role = $1::name',
        [role],
      );
      await pool.query('DROP OWNED BY ' + quoteRole(role));
      await pool.query('DROP ROLE ' + quoteRole(role));
    }
  });

  it('rejects rotating back to a terminally retired sync-role OID', async () => {
    const fixture = await operatorFixture('terminal-retirement');
    const nextService = await createPrincipal(pool, {
      externalId: 'terminal-retirement-next', kind: 'service', displayName: 'Next',
    });
    const firstRole = 'continuum_terminal_first_' + Date.now();
    const nextRole = 'continuum_terminal_next_' + Date.now();
    for (const role of [firstRole, nextRole]) {
      await pool.query('CREATE ROLE ' + quoteRole(role) + ' LOGIN');
      await grantOwnerRetirementAuthority(pool, role);
    }
    await pool.query('ALTER ROLE ' + quoteRole(firstRole) + " PASSWORD 'retired-test-secret'");
    try {
      await applyGrantScript(pool, 'grant-sync-role.sql', {
        continuum_sync_role: firstRole, continuum_principal_id: fixture.service.id,
      });
      await fixture.operator.query(
        'SELECT continuum_rotate_sync_database_identity($1, $2, $3)',
        [fixture.admin.id, nextRole, nextService.id],
      );
      expect((await pool.query(
        'SELECT rolpassword IS NULL AS cleared FROM pg_authid WHERE rolname = $1',
        [firstRole],
      )).rows[0].cleared).toBe(true);
      await expect(fixture.operator.query(
        'SELECT continuum_rotate_sync_database_identity($1, $2, $3)',
        [fixture.admin.id, firstRole, fixture.service.id],
      )).rejects.toThrow(/retired.*terminal|previously retired/i);
    } finally {
      await fixture.operator.end();
      await pool.query(
        'DELETE FROM continuum_trusted_database_identities WHERE database_role = ANY($1::name[])',
        [[fixture.operatorRole, firstRole, nextRole]],
      );
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role = ANY($1::name[])',
        [[firstRole, nextRole]],
      );
      await dropRoles(pool, [firstRole, nextRole, fixture.operatorRole]);
    }
  });

  it('does not treat an old-cluster archived OID collision as current retirement', async () => {
    const service = await createPrincipal(pool, {
      externalId: 'archive-oid-collision-service', kind: 'service', displayName: 'Collision',
    });
    const role = 'continuum_archive_collision_' + Date.now();
    const archivedName = 'continuum_old_cluster_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(role) + ' LOGIN');
    await grantOwnerRetirementAuthority(pool, role);
    try {
      const oid = (await pool.query(
        'SELECT oid::text FROM pg_roles WHERE rolname = $1', [role],
      )).rows[0].oid;
      await pool.query(
        `INSERT INTO continuum_unresolved_retired_sync_database_identities
           (database_role, previous_database_role_oid, resolution_kind, cluster_epoch)
         SELECT $1::name, $2::oid, 'superseded', epoch
           FROM continuum_database_identity_epoch WHERE singleton`,
        [archivedName, oid],
      );
      await pool.query("SELECT continuum_rebind_database_identity_oids('REBIND AFTER LOGICAL RESTORE')");
      await expect(applyGrantScript(pool, 'grant-sync-role.sql', {
        continuum_sync_role: role, continuum_principal_id: service.id,
      })).resolves.toBeUndefined();
    } finally {
      await pool.query(
        'DELETE FROM continuum_trusted_database_identities WHERE database_role = $1::name',
        [role],
      );
      await pool.query(
        'DELETE FROM continuum_unresolved_retired_sync_database_identities WHERE database_role = $1::name',
        [archivedName],
      );
      await dropRoles(pool, [role]);
    }
  });

  it('rebinds all active identities atomically when restored role OIDs are reshuffled', async () => {
    const fixture = await operatorFixture('logical-restore-swap');
    const syncRole = 'continuum_restored_swap_sync_' + Date.now();
    const spareRole = 'continuum_restored_swap_spare_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(syncRole) + ' LOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(spareRole) + ' NOLOGIN');
    await grantOwnerRetirementAuthority(pool, syncRole);
    await applyGrantScript(pool, 'grant-sync-role.sql', {
      continuum_sync_role: syncRole, continuum_principal_id: fixture.service.id,
    });
    try {
      const oids = (await pool.query<{ rolname: string; oid: string }>(
        'SELECT rolname, oid::text FROM pg_roles WHERE rolname = ANY($1::name[])',
        [[fixture.operatorRole, syncRole, spareRole]],
      )).rows.reduce<Record<string, string>>((result, row) => {
        result[row.rolname] = row.oid; return result;
      }, {});
      await pool.query(
        'UPDATE continuum_trusted_database_identities SET database_role_oid = $1 WHERE database_role = $2::name',
        [oids[spareRole], fixture.operatorRole],
      );
      await pool.query(
        'UPDATE continuum_trusted_database_identities SET database_role_oid = $1 WHERE database_role = $2::name',
        [oids[fixture.operatorRole], syncRole],
      );
      await pool.query(
        'UPDATE continuum_trusted_database_identities SET database_role_oid = $1 WHERE database_role = $2::name',
        [oids[syncRole], fixture.operatorRole],
      );
      await expect(pool.query(
        "SELECT continuum_rebind_database_identity_oids('REBIND AFTER LOGICAL RESTORE')",
      )).resolves.toBeDefined();
      const rebound = await pool.query(
        `SELECT identity.database_role::text AS role_name,
                identity.database_role_oid::text AS bound_oid, role.oid::text AS current_oid
           FROM continuum_trusted_database_identities identity
           JOIN pg_roles role ON role.rolname = identity.database_role::text
          WHERE identity.database_role = ANY($1::name[])
          ORDER BY identity.database_role`,
        [[fixture.operatorRole, syncRole]],
      );
      expect(rebound.rows).toHaveLength(2);
      expect(rebound.rows.every((row) => row.bound_oid === row.current_oid)).toBe(true);
    } finally {
      await fixture.operator.end();
      await pool.query(
        'DELETE FROM continuum_trusted_database_identities WHERE database_role = ANY($1::name[])',
        [[fixture.operatorRole, syncRole]],
      );
      await dropRoles(pool, [syncRole, spareRole, fixture.operatorRole]);
    }
  });

  it('rejects binding a retired sync-role OID as approval authority', async () => {
    const fixture = await operatorFixture('retired-approval');
    const role = 'continuum_retired_approval_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(role) + ' NOLOGIN');
    await grantOwnerRetirementAuthority(pool, role);
    try {
      const oid = (await pool.query(
        'SELECT oid::text FROM pg_roles WHERE rolname = $1', [role],
      )).rows[0].oid;
      await pool.query(
        `INSERT INTO continuum_retired_sync_database_identities
           (database_role_oid, database_role) VALUES ($1::oid, $2::name)`,
        [oid, role],
      );
      await expect(pool.query(
        'SELECT continuum_register_trusted_database_identity($1, $2, TRUE, FALSE)',
        [role, fixture.admin.id],
      )).rejects.toThrow(/retired.*terminal|previously retired/i);
    } finally {
      await fixture.operator.end();
      await pool.query(
        'DELETE FROM continuum_trusted_database_identities WHERE database_role = ANY($1::name[])',
        [[fixture.operatorRole, role]],
      );
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role = $1::name',
        [role],
      );
      await dropRoles(pool, [role, fixture.operatorRole]);
    }
  });

  it('rebinds reshuffled retired-role history without losing either identity', async () => {
    const first = 'continuum_retired_restore_first_' + Date.now();
    const second = 'continuum_retired_restore_second_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(first) + ' NOLOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(second) + ' NOLOGIN');
    try {
      const oids = (await pool.query<{ rolname: string; oid: string }>(
        'SELECT rolname, oid::text FROM pg_roles WHERE rolname = ANY($1::name[])',
        [[first, second]],
      )).rows.reduce<Record<string, string>>((result, row) => {
        result[row.rolname] = row.oid; return result;
      }, {});
      await pool.query(
        `INSERT INTO continuum_retired_sync_database_identities
           (database_role_oid, database_role) VALUES ($1, $2::name), ($3, $4::name)`,
        [oids[second], first, oids[first], second],
      );
      await expect(pool.query(
        "SELECT continuum_rebind_database_identity_oids('REBIND AFTER LOGICAL RESTORE')",
      )).resolves.toBeDefined();
      const rebound = await pool.query(
        `SELECT history.database_role::text AS role_name,
                history.database_role_oid::text AS bound_oid, role.oid::text AS current_oid
           FROM continuum_retired_sync_database_identities history
           JOIN pg_roles role ON role.rolname = history.database_role::text
          WHERE history.database_role = ANY($1::name[])
          ORDER BY history.database_role`,
        [[first, second]],
      );
      expect(rebound.rows).toHaveLength(2);
      expect(rebound.rows.every((row) => row.bound_oid === row.current_oid)).toBe(true);
    } finally {
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role = ANY($1::name[])',
        [[first, second]],
      );
      await dropRoles(pool, [first, second]);
    }
  });

  it('recovers an unresolved retired identity when its role appears in a later restore stage', async () => {
    const role = 'continuum_staged_restore_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(role) + ' NOLOGIN');
    const oldOid = (await pool.query(
      'SELECT oid::text FROM pg_roles WHERE rolname = $1', [role],
    )).rows[0].oid;
    await pool.query(
      `INSERT INTO continuum_retired_sync_database_identities
         (database_role_oid, database_role) VALUES ($1, $2::name)`,
      [oldOid, role],
    );
    await pool.query('DROP ROLE ' + quoteRole(role));
    try {
      await pool.query("SELECT continuum_rebind_database_identity_oids('REBIND AFTER LOGICAL RESTORE')");
      await pool.query('CREATE ROLE ' + quoteRole(role) + ' NOLOGIN');
      await expect(pool.query(
        "SELECT continuum_rebind_database_identity_oids('REBIND AFTER LOGICAL RESTORE')",
      )).resolves.toBeDefined();
      const state = (await pool.query(
        `SELECT
           (SELECT count(*)::int FROM continuum_retired_sync_database_identities history
             JOIN pg_roles restored_role ON restored_role.oid = history.database_role_oid
              AND restored_role.rolname = history.database_role
            WHERE history.database_role = $1::name) AS resolved,
           (SELECT count(*)::int FROM continuum_unresolved_retired_sync_database_identities
            WHERE database_role = $1::name) AS unresolved`,
        [role],
      )).rows[0];
      expect(state).toEqual({ resolved: 1, unresolved: 0 });
    } finally {
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role = $1::name',
        [role],
      );
      await pool.query(
        'DELETE FROM continuum_unresolved_retired_sync_database_identities WHERE database_role = $1::name',
        [role],
      );
      await pool.query('DROP OWNED BY ' + quoteRole(role));
      await pool.query('DROP ROLE IF EXISTS ' + quoteRole(role));
    }
  });

  it('does not let an operator claim a restore-pending retired role name before rebind', async () => {
    const fixture = await operatorFixture('restore-pending-claim');
    const role = 'continuum_pending_claim_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(role) + ' NOLOGIN');
    const oldOid = (await pool.query(
      'SELECT oid::text FROM pg_roles WHERE rolname = $1', [role],
    )).rows[0].oid;
    await pool.query(
      `INSERT INTO continuum_retired_sync_database_identities
         (database_role_oid, database_role) VALUES ($1, $2::name)`,
      [oldOid, role],
    );
    await pool.query('DROP ROLE ' + quoteRole(role));
    try {
      await pool.query("SELECT continuum_rebind_database_identity_oids('REBIND AFTER LOGICAL RESTORE')");
      await pool.query('CREATE ROLE ' + quoteRole(role) + ' LOGIN');
      await grantOwnerRetirementAuthority(pool, role);
      await expect(fixture.operator.query(
        "SELECT continuum_supersede_restore_pending_sync_identity($1, $2::oid, 'SUPERSEDE RESTORE-PENDING SYNC IDENTITY')",
        [role, oldOid],
      )).rejects.toThrow(/permission denied/i);
      await expect(fixture.operator.query(
        'SELECT continuum_rotate_sync_database_identity($1, $2, $3)',
        [fixture.admin.id, role, fixture.service.id],
      )).rejects.toThrow(/restore.pending|rebind.*first|retired identity/i);
    } finally {
      await fixture.operator.end();
      await pool.query(
        'DELETE FROM continuum_trusted_database_identities WHERE database_role = ANY($1::name[])',
        [[fixture.operatorRole, role]],
      );
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role = $1::name',
        [role],
      );
      await pool.query(
        'DELETE FROM continuum_unresolved_retired_sync_database_identities WHERE database_role = $1::name',
        [role],
      );
      await dropRoles(pool, [role, fixture.operatorRole]);
    }
  });

  it('accepts a changed diagnostic cluster identifier when role OIDs were preserved', async () => {
    const role = 'continuum_upgrade_preserved_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(role) + ' NOLOGIN');
    const oid = (await pool.query(
      'SELECT oid::text FROM pg_roles WHERE rolname = $1', [role],
    )).rows[0].oid;
    const identifier = (await pool.query(
      `SELECT cluster_system_identifier
         FROM continuum_database_identity_epoch WHERE singleton`,
    )).rows[0].cluster_system_identifier;
    await pool.query(
      `INSERT INTO continuum_retired_sync_database_identities
         (database_role_oid, database_role) VALUES ($1, $2::name)`,
      [oid, role],
    );
    try {
      await pool.query(
        `UPDATE continuum_database_identity_epoch
            SET cluster_system_identifier = 'changed-by-major-upgrade' WHERE singleton`,
      );
      await expect(pool.query(
        "SELECT continuum_rebind_database_identity_oids('REBIND DATABASE IDENTITIES', 'PRESERVED OID NAMESPACE')",
      )).resolves.toBeDefined();
      expect((await pool.query(
        `SELECT database_role_oid::text AS oid
           FROM continuum_retired_sync_database_identities
          WHERE database_role = $1::name`, [role],
      )).rows[0].oid).toBe(oid);
    } finally {
      await pool.query(
        'UPDATE continuum_database_identity_epoch SET cluster_system_identifier = $1 WHERE singleton',
        [identifier],
      );
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role = $1::name',
        [role],
      );
      await dropRoles(pool, [role]);
    }
  });

  it('requires the operator to declare an exact role-OID provenance', async () => {
    await expect(pool.query(
      "SELECT continuum_rebind_database_identity_oids('REBIND AFTER LOGICAL RESTORE')",
    )).rejects.toThrow(/OID.*provenance|exact.*confirmation|function.*does not exist/i);
    await expect(pool.query(
      "SELECT continuum_rebind_database_identity_oids('REBIND DATABASE IDENTITIES', 'INFER FROM CLUSTER')",
    )).rejects.toThrow(/OID.*provenance|exact.*confirmation|invalid/i);
  });

  it('epoch-stamps every retired OID written by the runtime retirement path', async () => {
    const fixture = await operatorFixture('retired-epoch-stamp');
    const replacement = await createPrincipal(pool, {
      externalId: 'retired-epoch-stamp-next', kind: 'service', displayName: 'Next',
    });
    const first = 'continuum_epoch_first_' + Date.now();
    const next = 'continuum_epoch_next_' + Date.now();
    for (const role of [first, next]) {
      await pool.query('CREATE ROLE ' + quoteRole(role) + ' LOGIN');
      await grantOwnerRetirementAuthority(pool, role);
    }
    try {
      await applyGrantScript(pool, 'grant-sync-role.sql', {
        continuum_sync_role: first, continuum_principal_id: fixture.service.id,
      });
      await fixture.operator.query(
        'SELECT continuum_rotate_sync_database_identity($1, $2, $3)',
        [fixture.admin.id, next, replacement.id],
      );
      const stamp = (await pool.query(
        `SELECT history.cluster_epoch::text AS history_epoch,
                epoch.epoch::text AS current_epoch
           FROM continuum_retired_sync_database_identities history
           CROSS JOIN continuum_database_identity_epoch epoch
          WHERE epoch.singleton AND history.database_role = $1::name`,
        [first],
      )).rows[0];
      expect(stamp).toBeDefined();
      expect(stamp.history_epoch).toBe(stamp.current_epoch);
    } finally {
      await fixture.operator.end();
      await pool.query(
        'DELETE FROM continuum_trusted_database_identities WHERE database_role = ANY($1::name[])',
        [[fixture.operatorRole, first, next]],
      );
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role = ANY($1::name[])',
        [[first, next]],
      );
      await dropRoles(pool, [first, next, fixture.operatorRole]);
    }
  });

  it('does not require provider control-system functions and documents both provenance modes', async () => {
    const migration = await readFile(
      join(process.cwd(), 'migrations/0052_offboarding_review_repair.sql'), 'utf8',
    );
    const docs = await readFile(join(process.cwd(), 'docs/offboarding.md'), 'utf8');
    const rebindScript = await readFile(
      join(process.cwd(), 'scripts/rebind-database-identities.sql'), 'utf8',
    );
    expect(migration).not.toMatch(/\bpg_control_system\s*\(/i);
    expect(migration).toMatch(/cluster_epoch\s+UUID\s+NOT NULL/i);
    expect(docs).toMatch(/pg_upgrade/i);
    expect(docs).toMatch(/physical fork|PITR|blue.?green/i);
    for (const provenance of ['PRESERVED OID NAMESPACE', 'FOREIGN OID NAMESPACE']) {
      expect(docs).toContain(provenance);
      expect(rebindScript).toContain(provenance);
    }
  });

  it('keeps renamed retired OIDs terminal when preserved provenance is declared', async () => {
    const original = 'continuum_upgrade_retired_' + Date.now();
    const renamed = 'continuum_upgrade_renamed_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(original) + ' NOLOGIN');
    const oid = (await pool.query(
      'SELECT oid::text FROM pg_roles WHERE rolname = $1', [original],
    )).rows[0].oid;
    await pool.query(
      `INSERT INTO continuum_retired_sync_database_identities
         (database_role_oid, database_role) VALUES ($1, $2::name)`,
      [oid, original],
    );
    await pool.query('ALTER ROLE ' + quoteRole(original) + ' RENAME TO ' + quoteRole(renamed));
    try {
      await expect(pool.query(
        "SELECT continuum_rebind_database_identity_oids('REBIND DATABASE IDENTITIES', 'PRESERVED OID NAMESPACE')",
      )).rejects.toThrow(/retired.*OID.*renamed|preserved.*namespace/i);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM continuum_retired_sync_database_identities
          WHERE database_role_oid = $1::oid AND database_role = $2::name`,
        [oid, original],
      )).rows[0].count).toBe(1);
    } finally {
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role_oid = $1::oid',
        [oid],
      );
      await dropRoles(pool, [renamed]);
    }
  });

  it('treats matching cluster diagnostics as foreign when the operator declares foreign OIDs', async () => {
    const retiredName = 'continuum_fork_retired_' + Date.now();
    const overlap = 'continuum_fork_overlap_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(retiredName) + ' NOLOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(overlap) + ' NOLOGIN');
    const overlapOid = (await pool.query(
      'SELECT oid::text FROM pg_roles WHERE rolname = $1', [overlap],
    )).rows[0].oid;
    const restoredOid = (await pool.query(
      'SELECT oid::text FROM pg_roles WHERE rolname = $1', [retiredName],
    )).rows[0].oid;
    await pool.query(
      `INSERT INTO continuum_retired_sync_database_identities
         (database_role_oid, database_role) VALUES ($1, $2::name)`,
      [overlapOid, retiredName],
    );
    try {
      await expect(pool.query(
        "SELECT continuum_rebind_database_identity_oids('REBIND DATABASE IDENTITIES', 'FOREIGN OID NAMESPACE')",
      )).resolves.toBeDefined();
      const state = (await pool.query(
        `SELECT
           (SELECT database_role_oid::text
              FROM continuum_retired_sync_database_identities
             WHERE database_role = $1::name) AS rebound_oid,
           EXISTS (SELECT 1 FROM continuum_retired_sync_database_identities
                    WHERE database_role_oid = $2::oid) AS overlap_retired`,
        [retiredName, overlapOid],
      )).rows[0];
      expect(state).toEqual({ rebound_oid: restoredOid, overlap_retired: false });
    } finally {
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role = $1::name',
        [retiredName],
      );
      await dropRoles(pool, [retiredName, overlap]);
    }
  });

  it('archives foreign same-name history before checking active and retired targets', async () => {
    const fixture = await operatorFixture('foreign-active-history');
    const active = 'continuum_foreign_active_' + Date.now();
    const overlap = 'continuum_foreign_active_overlap_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(active) + ' LOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(overlap) + ' NOLOGIN');
    await grantOwnerRetirementAuthority(pool, active);
    await applyGrantScript(pool, 'grant-sync-role.sql', {
      continuum_sync_role: active, continuum_principal_id: fixture.service.id,
    });
    const activeOid = (await pool.query(
      'SELECT oid::text FROM pg_roles WHERE rolname = $1', [active],
    )).rows[0].oid;
    const overlapOid = (await pool.query(
      'SELECT oid::text FROM pg_roles WHERE rolname = $1', [overlap],
    )).rows[0].oid;
    await pool.query(
      `INSERT INTO continuum_retired_sync_database_identities
         (database_role_oid, database_role) VALUES ($1, $2::name)`,
      [overlapOid, active],
    );
    try {
      await expect(pool.query(
        "SELECT continuum_rebind_database_identity_oids('REBIND DATABASE IDENTITIES', 'FOREIGN OID NAMESPACE')",
      )).resolves.toBeDefined();
      const state = (await pool.query(
        `SELECT
           (SELECT database_role_oid::text FROM continuum_trusted_database_identities
             WHERE database_role = $1::name AND can_sync) AS active_oid,
           (SELECT resolution_kind FROM continuum_unresolved_retired_sync_database_identities
             WHERE database_role = $1::name
               AND previous_database_role_oid = $2::oid) AS archived_kind,
           EXISTS (SELECT 1 FROM continuum_retired_sync_database_identities
                    WHERE database_role_oid = $2::oid) AS overlap_retired`,
        [active, overlapOid],
      )).rows[0];
      expect(state).toEqual({
        active_oid: activeOid, archived_kind: 'superseded', overlap_retired: false,
      });
    } finally {
      await fixture.operator.end();
      await pool.query(
        'DELETE FROM continuum_trusted_database_identities WHERE database_role = ANY($1::name[])',
        [[fixture.operatorRole, active]],
      );
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role = $1::name',
        [active],
      );
      await pool.query(
        'DELETE FROM continuum_unresolved_retired_sync_database_identities WHERE database_role = $1::name',
        [active],
      );
      await dropRoles(pool, [active, overlap, fixture.operatorRole]);
    }
  });

  it('refuses to rebind while a live retired OID has been renamed', async () => {
    const original = 'continuum_retired_before_rename_' + Date.now();
    const renamed = 'continuum_retired_after_rename_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(original) + ' NOLOGIN');
    const oid = (await pool.query(
      'SELECT oid::text FROM pg_roles WHERE rolname = $1', [original],
    )).rows[0].oid;
    await pool.query(
      `INSERT INTO continuum_retired_sync_database_identities
         (database_role_oid, database_role) VALUES ($1, $2::name)`,
      [oid, original],
    );
    await pool.query('ALTER ROLE ' + quoteRole(original) + ' RENAME TO ' + quoteRole(renamed));
    try {
      await expect(pool.query(
        "SELECT continuum_rebind_database_identity_oids('REBIND AFTER LOGICAL RESTORE')",
      )).rejects.toThrow(/retired.*OID.*renamed|renamed.*retired/i);
    } finally {
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role_oid = $1::oid',
        [oid],
      );
      await pool.query(
        'DELETE FROM continuum_unresolved_retired_sync_database_identities WHERE previous_database_role_oid = $1::oid',
        [oid],
      );
      await dropRoles(pool, [renamed]);
    }
  });

  it('does not transfer a renamed retired OID onto an active role using its old name', async () => {
    const fixture = await operatorFixture('retired-active-name-collision');
    const recordedName = 'continuum_retired_collision_' + Date.now();
    const renamedRetired = 'continuum_retired_collision_old_' + Date.now();
    const appRole = 'continuum_retired_collision_app_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(recordedName) + ' NOLOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(appRole) + ' NOLOGIN');
    await grantOwnerRetirementAuthority(pool, recordedName);
    const retiredOid = (await pool.query(
      'SELECT oid::text FROM pg_roles WHERE rolname = $1', [recordedName],
    )).rows[0].oid;
    await pool.query(
      `INSERT INTO continuum_retired_sync_database_identities
         (database_role_oid, database_role) VALUES ($1, $2::name)`,
      [retiredOid, recordedName],
    );
    await pool.query('ALTER ROLE ' + quoteRole(recordedName) + ' RENAME TO ' + quoteRole(renamedRetired));
    await pool.query('CREATE ROLE ' + quoteRole(recordedName) + ' LOGIN');
    await grantOwnerRetirementAuthority(pool, recordedName);
    await applyGrantScript(pool, 'grant-application-role.sql', { continuum_app_role: appRole });
    await applyGrantScript(pool, 'grant-sync-role.sql', {
      continuum_sync_role: recordedName, continuum_principal_id: fixture.service.id,
    });
    const activeOid = (await pool.query(
      'SELECT oid::text FROM pg_roles WHERE rolname = $1', [recordedName],
    )).rows[0].oid;
    try {
      await expect(pool.query(
        "SELECT continuum_rebind_database_identity_oids('REBIND AFTER LOGICAL RESTORE')",
      )).rejects.toThrow(/retired.*OID.*renamed|active.*retired|ambiguous/i);
      const state = (await pool.query(
        `SELECT
           (SELECT database_role_oid::text
              FROM continuum_retired_sync_database_identities
             WHERE database_role_oid = $1::oid) AS retired_oid,
           (SELECT database_role_oid::text
              FROM continuum_trusted_database_identities
             WHERE database_role = $2::name AND can_sync) AS active_oid`,
        [retiredOid, recordedName],
      )).rows[0];
      expect(state).toEqual({ retired_oid: retiredOid, active_oid: activeOid });
      await expect(applyGrantScript(pool, 'verify-database-identities.sql', {
        continuum_schema: 'public', continuum_app_role: appRole,
        continuum_sync_role: recordedName, continuum_operator_role: fixture.operatorRole,
        retired_sync_role: '',
      })).resolves.toBeUndefined();
    } finally {
      await fixture.operator.end();
      await pool.query(
        'DELETE FROM continuum_trusted_database_identities WHERE database_role = ANY($1::name[])',
        [[fixture.operatorRole, recordedName]],
      );
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role_oid = $1::oid',
        [retiredOid],
      );
      await dropRoles(pool, [recordedName, renamedRetired, appRole, fixture.operatorRole]);
    }
  });

  it('rebinds foreign-cluster retired OIDs without touching unrelated colliding roles', async () => {
    const retiredName = 'continuum_foreign_retired_' + Date.now();
    const unrelated = 'continuum_foreign_collision_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(retiredName) + ' NOLOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(unrelated) + ' NOLOGIN');
    const unrelatedOid = (await pool.query(
      'SELECT oid::text FROM pg_roles WHERE rolname = $1', [unrelated],
    )).rows[0].oid;
    const restoredOid = (await pool.query(
      'SELECT oid::text FROM pg_roles WHERE rolname = $1', [retiredName],
    )).rows[0].oid;
    await pool.query(
      `INSERT INTO continuum_retired_sync_database_identities
         (database_role_oid, database_role) VALUES ($1, $2::name)`,
      [unrelatedOid, retiredName],
    );
    try {
      await pool.query(
        `UPDATE continuum_database_identity_epoch
            SET cluster_system_identifier = '-1' WHERE singleton`,
      );
      await expect(pool.query(
        "SELECT continuum_rebind_database_identity_oids('REBIND AFTER LOGICAL RESTORE')",
      )).resolves.toBeDefined();
      const state = (await pool.query(
        `SELECT
           (SELECT database_role_oid::text
              FROM continuum_retired_sync_database_identities
             WHERE database_role = $1::name) AS rebound_oid,
           (SELECT rolcanlogin FROM pg_roles WHERE oid = $2::oid) AS unrelated_login,
           EXISTS (
             SELECT 1 FROM continuum_retired_sync_database_identities
              WHERE database_role_oid = $2::oid) AS unrelated_retired`,
        [retiredName, unrelatedOid],
      )).rows[0];
      expect(state).toEqual({
        rebound_oid: restoredOid, unrelated_login: false, unrelated_retired: false,
      });
    } finally {
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role = $1::name',
        [retiredName],
      );
      await dropRoles(pool, [retiredName, unrelated]);
    }
  });

  it('rejects an incomplete same-cluster retired-role permutation', async () => {
    const first = 'continuum_incomplete_first_' + Date.now();
    const second = 'continuum_incomplete_second_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(first) + ' NOLOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(second) + ' NOLOGIN');
    const firstOid = (await pool.query(
      'SELECT oid::text FROM pg_roles WHERE rolname = $1', [first],
    )).rows[0].oid;
    const secondOid = (await pool.query(
      'SELECT oid::text FROM pg_roles WHERE rolname = $1', [second],
    )).rows[0].oid;
    await pool.query(
      `INSERT INTO continuum_retired_sync_database_identities
         (database_role_oid, database_role) VALUES
         ($1, $2::name), ($3, $4::name)`,
      [firstOid, first, secondOid, second],
    );
    await pool.query('DROP ROLE ' + quoteRole(second));
    await pool.query('ALTER ROLE ' + quoteRole(first) + ' RENAME TO ' + quoteRole(second));
    await pool.query('CREATE ROLE ' + quoteRole(first) + ' NOLOGIN');
    try {
      await expect(pool.query(
        "SELECT continuum_rebind_database_identity_oids('REBIND AFTER LOGICAL RESTORE')",
      )).rejects.toThrow(/complete retired.role restore mapping|ambiguous/i);
    } finally {
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role = ANY($1::name[])',
        [[first, second]],
      );
      await dropRoles(pool, [first, second]);
    }
  });

  it('verifies retired role safety by OID after the role is renamed', async () => {
    const fixture = await operatorFixture('renamed-retired-verification');
    const syncRole = 'continuum_rename_verify_sync_' + Date.now();
    const appRole = 'continuum_rename_verify_app_' + Date.now();
    const retiredRole = 'continuum_rename_verify_retired_' + Date.now();
    const renamedRole = 'continuum_rename_verify_live_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(syncRole) + ' LOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(appRole) + ' NOLOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(retiredRole) + ' NOLOGIN');
    await grantOwnerRetirementAuthority(pool, syncRole);
    await grantOwnerRetirementAuthority(pool, retiredRole);
    await applyGrantScript(pool, 'grant-application-role.sql', { continuum_app_role: appRole });
    await applyGrantScript(pool, 'grant-sync-role.sql', {
      continuum_sync_role: syncRole, continuum_principal_id: fixture.service.id,
    });
    const retiredOid = (await pool.query(
      'SELECT oid::text FROM pg_roles WHERE rolname = $1', [retiredRole],
    )).rows[0].oid;
    await pool.query(
      `INSERT INTO continuum_retired_sync_database_identities
         (database_role_oid, database_role) VALUES ($1, $2::name)`,
      [retiredOid, retiredRole],
    );
    await pool.query('ALTER ROLE ' + quoteRole(retiredRole) + ' RENAME TO ' + quoteRole(renamedRole));
    await pool.query('ALTER ROLE ' + quoteRole(renamedRole) + ' LOGIN');
    try {
      await expect(applyGrantScript(pool, 'verify-database-identities.sql', {
        continuum_schema: 'public', continuum_app_role: appRole,
        continuum_sync_role: syncRole, continuum_operator_role: fixture.operatorRole,
        retired_sync_role: '',
      })).rejects.toThrow(/retired.*login|retired.*authority/i);
    } finally {
      await fixture.operator.end();
      await pool.query(
        'DELETE FROM continuum_trusted_database_identities WHERE database_role = ANY($1::name[])',
        [[fixture.operatorRole, syncRole]],
      );
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role_oid = $1::oid',
        [retiredOid],
      );
      await dropRoles(pool, [syncRole, appRole, renamedRole, fixture.operatorRole]);
    }
  });

  it('archives prior generations when a sync role name is reused and rotated again', async () => {
    const fixture = await operatorFixture('sync-name-reuse');
    const replacement = await createPrincipal(pool, {
      externalId: 'sync-name-reuse-replacement', kind: 'service', displayName: 'Replacement',
    });
    const reusedRole = 'continuum_reused_sync_' + Date.now();
    const bridgeRole = 'continuum_reused_bridge_' + Date.now();
    const finalRole = 'continuum_reused_final_' + Date.now();
    for (const role of [reusedRole, bridgeRole, finalRole]) {
      await pool.query('CREATE ROLE ' + quoteRole(role) + ' LOGIN');
      await grantOwnerRetirementAuthority(pool, role);
    }
    try {
      await applyGrantScript(pool, 'grant-sync-role.sql', {
        continuum_sync_role: reusedRole, continuum_principal_id: fixture.service.id,
      });
      await fixture.operator.query(
        'SELECT continuum_rotate_sync_database_identity($1, $2, $3)',
        [fixture.admin.id, bridgeRole, replacement.id],
      );
      const firstOid = (await pool.query(
        'SELECT oid::text FROM pg_roles WHERE rolname = $1', [reusedRole],
      )).rows[0].oid;
      await pool.query('REVOKE ' + quoteRole(reusedRole) + ' FROM CURRENT_USER');
      await pool.query('DROP ROLE ' + quoteRole(reusedRole));
      await pool.query("SELECT continuum_rebind_database_identity_oids('REBIND AFTER LOGICAL RESTORE')");
      await pool.query('CREATE ROLE ' + quoteRole(reusedRole) + ' LOGIN');
      await grantOwnerRetirementAuthority(pool, reusedRole);
      await pool.query(
        "SELECT continuum_supersede_restore_pending_sync_identity($1, $2::oid, 'SUPERSEDE RESTORE-PENDING SYNC IDENTITY')",
        [reusedRole, firstOid],
      );
      await applyGrantScript(pool, 'grant-sync-role.sql', {
        continuum_sync_role: reusedRole, continuum_principal_id: fixture.service.id,
      });
      await fixture.operator.query(
        'SELECT continuum_rotate_sync_database_identity($1, $2, $3)',
        [fixture.admin.id, finalRole, replacement.id],
      );
      const secondOid = (await pool.query(
        'SELECT oid::text FROM pg_roles WHERE rolname = $1', [reusedRole],
      )).rows[0].oid;
      await pool.query('REVOKE ' + quoteRole(reusedRole) + ' FROM CURRENT_USER');
      await pool.query('DROP ROLE ' + quoteRole(reusedRole));
      await pool.query("SELECT continuum_rebind_database_identity_oids('REBIND AFTER LOGICAL RESTORE')");
      await pool.query('CREATE ROLE ' + quoteRole(reusedRole) + ' LOGIN');
      await grantOwnerRetirementAuthority(pool, reusedRole);
      await pool.query(
        "SELECT continuum_supersede_restore_pending_sync_identity($1, $2::oid, 'SUPERSEDE RESTORE-PENDING SYNC IDENTITY')",
        [reusedRole, secondOid],
      );
      await expect(pool.query(
        "SELECT continuum_rebind_database_identity_oids('REBIND AFTER LOGICAL RESTORE')",
      )).resolves.toBeDefined();
      const generations = (await pool.query(
        `SELECT
           (SELECT count(*)::int FROM continuum_unresolved_retired_sync_database_identities
             WHERE database_role = $1::name
               AND previous_database_role_oid = ANY(ARRAY[$2::oid, $3::oid])
               AND resolution_kind = 'superseded') AS archived,
           (SELECT count(*)::int FROM continuum_retired_sync_database_identities history
             JOIN pg_roles restored ON restored.oid = history.database_role_oid
              AND restored.rolname = history.database_role
            WHERE history.database_role = $1::name
              AND history.database_role_oid <> $3::oid) AS restored`,
        [reusedRole, firstOid, secondOid],
      )).rows[0];
      expect(generations).toEqual({ archived: 2, restored: 0 });
    } finally {
      await fixture.operator.end();
      await pool.query(
        'DELETE FROM continuum_trusted_database_identities WHERE database_role = ANY($1::name[])',
        [[fixture.operatorRole, reusedRole, bridgeRole, finalRole]],
      );
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role = ANY($1::name[])',
        [[reusedRole, bridgeRole, finalRole]],
      );
      await pool.query(
        'DELETE FROM continuum_unresolved_retired_sync_database_identities WHERE database_role = ANY($1::name[])',
        [[reusedRole, bridgeRole, finalRole]],
      );
      await dropRoles(pool, [reusedRole, bridgeRole, finalRole, fixture.operatorRole]);
    }
  });

  it('fails verification when live retired history points at another restored role OID', async () => {
    const fixture = await operatorFixture('logical-restore-stale-history');
    const syncRole = 'continuum_restored_stale_sync_' + Date.now();
    const appRole = 'continuum_restored_stale_app_' + Date.now();
    const missingRetiredRole = 'continuum_restored_missing_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(syncRole) + ' LOGIN');
    await pool.query('CREATE ROLE ' + quoteRole(appRole) + ' NOLOGIN');
    await grantOwnerRetirementAuthority(pool, syncRole);
    await applyGrantScript(pool, 'grant-application-role.sql', { continuum_app_role: appRole });
    await applyGrantScript(pool, 'grant-sync-role.sql', {
      continuum_sync_role: syncRole, continuum_principal_id: fixture.service.id,
    });
    try {
      const appOid = (await pool.query(
        'SELECT oid::text FROM pg_roles WHERE rolname = $1', [appRole],
      )).rows[0].oid;
      await pool.query(
        `INSERT INTO continuum_retired_sync_database_identities
           (database_role_oid, database_role) VALUES ($1, $2::name)`,
        [appOid, missingRetiredRole],
      );
      await expect(applyGrantScript(pool, 'verify-database-identities.sql', {
        continuum_schema: 'public', continuum_app_role: appRole,
        continuum_sync_role: syncRole, continuum_operator_role: fixture.operatorRole,
        retired_sync_role: '',
      })).rejects.toThrow(/retired.*login|retired.*authority/i);
    } finally {
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role = $1::name',
        [missingRetiredRole],
      );
      await fixture.operator.end();
      await pool.query(
        'DELETE FROM continuum_trusted_database_identities WHERE database_role = ANY($1::name[])',
        [[fixture.operatorRole, syncRole]],
      );
      await dropRoles(pool, [syncRole, appRole, fixture.operatorRole]);
    }
  });

  it('refuses to retire an application role that has no recorded sync history', async () => {
    const appRole = 'continuum_never_sync_app_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(appRole) + ' NOLOGIN');
    await applyGrantScript(pool, 'grant-application-role.sql', { continuum_app_role: appRole });
    await pool.query(
      'GRANT ' + quoteRole(appRole)
      + ' TO CURRENT_USER WITH ADMIN OPTION, SET FALSE, INHERIT FALSE',
    );
    try {
      const appOid = (await pool.query(
        'SELECT oid::text FROM pg_roles WHERE rolname = $1', [appRole],
      )).rows[0].oid;
      await expect(applyGrantScript(pool, 'retire-sync-role.sql', {
        continuum_schema: 'public', retired_sync_role: appRole,
        confirm_retired_sync_role_oid: appOid,
        confirm_legacy_unrecorded_sync_role: '',
      })).rejects.toThrow(/recorded sync history|previously bound sync role|legacy.*confirmation/i);
      await expect(applyGrantScript(pool, 'retire-sync-role.sql', {
        continuum_schema: 'public', retired_sync_role: appRole,
        confirm_retired_sync_role_oid: appOid,
        confirm_legacy_unrecorded_sync_role: 'RETIRE UNRECORDED LEGACY SYNC ROLE',
      })).rejects.toThrow(/legacy sync footprint|application role|unsafe privilege/i);
    } finally {
      await pool.query('REVOKE ' + quoteRole(appRole) + ' FROM CURRENT_USER');
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role = $1::name',
        [appRole],
      );
      await dropRoles(pool, [appRole]);
    }
  });

  it('requires a second explicit confirmation to retire an unrecorded legacy sync role', async () => {
    const legacyRole = 'continuum_legacy_unrecorded_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(legacyRole) + ' LOGIN');
    await pool.query(
      'GRANT ' + quoteRole(legacyRole)
      + ' TO CURRENT_USER WITH ADMIN OPTION, SET FALSE, INHERIT FALSE',
    );
    try {
      const legacyOid = (await pool.query(
        'SELECT oid::text FROM pg_roles WHERE rolname = $1', [legacyRole],
      )).rows[0].oid;
      await expect(applyGrantScript(pool, 'retire-sync-role.sql', {
        continuum_schema: 'public', retired_sync_role: legacyRole,
        confirm_retired_sync_role_oid: legacyOid,
        confirm_legacy_unrecorded_sync_role: '',
      })).rejects.toThrow(/legacy.*confirmation|recorded sync history/i);
      await expect(applyGrantScript(pool, 'retire-sync-role.sql', {
        continuum_schema: 'public', retired_sync_role: legacyRole,
        confirm_retired_sync_role_oid: legacyOid,
        confirm_legacy_unrecorded_sync_role: 'RETIRE UNRECORDED LEGACY SYNC ROLE',
      })).resolves.toBeUndefined();
      expect((await pool.query(
        'SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [legacyRole],
      )).rows[0].rolcanlogin).toBe(false);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM continuum_retired_sync_database_identities
          WHERE database_role_oid = $1::oid AND database_role = $2::name`,
        [legacyOid, legacyRole],
      )).rows[0].count).toBe(1);
    } finally {
      await pool.query('REVOKE ' + quoteRole(legacyRole) + ' FROM CURRENT_USER');
      await pool.query(
        'DELETE FROM continuum_retired_sync_database_identities WHERE database_role = $1::name',
        [legacyRole],
      );
      await dropRoles(pool, [legacyRole]);
    }
  });

  it('rejects unsafe owner membership edges and serializes checked retirement with rotation', async () => {
    const legacyRole = 'continuum_legacy_edge_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(legacyRole) + ' LOGIN');
    await pool.query('GRANT ' + quoteRole(legacyRole) + ' TO CURRENT_USER WITH ADMIN OPTION');
    try {
      const legacyOid = (await pool.query(
        'SELECT oid::text FROM pg_roles WHERE rolname = $1', [legacyRole],
      )).rows[0].oid;
      await expect(applyGrantScript(pool, 'retire-sync-role.sql', {
        continuum_schema: 'public', retired_sync_role: legacyRole,
        confirm_retired_sync_role_oid: legacyOid,
        confirm_legacy_unrecorded_sync_role: 'RETIRE UNRECORDED LEGACY SYNC ROLE',
      })).rejects.toThrow(/membership|SET ROLE|INHERIT|exact owner/i);
      const source = await readFile(join(process.cwd(), 'scripts', 'retire-sync-role.sql'), 'utf8');
      expect(source).toContain('pg_advisory_xact_lock(834641726154302119');
      expect(source).toContain('pg_advisory_xact_lock(834641726154302120');
      expect(source).toContain('LOCK TABLE');
      expect(source).toContain('NOT membership.set_option');
      expect(source).toContain('NOT membership.inherit_option');
      expect(source).toContain('PASSWORD NULL');
      const docs = await readFile(join(process.cwd(), 'docs', 'offboarding.md'), 'utf8');
      expect(docs).toContain('pg_terminate_backend');
    } finally {
      await pool.query('REVOKE ' + quoteRole(legacyRole) + ' FROM CURRENT_USER');
      await dropRoles(pool, [legacyRole]);
    }
  });

  it('revokes all old sync reads and does not grant memory content to the replacement', async () => {
    const fixture = await operatorFixture('old-read');
    const oldRole = 'continuum_old_read_' + Date.now();
    const newRole = 'continuum_new_read_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(oldRole) + ' LOGIN');
    await grantOwnerRetirementAuthority(pool, oldRole);
    await applyGrantScript(pool, 'grant-sync-role.sql', {
      continuum_sync_role: oldRole, continuum_principal_id: fixture.service.id,
    });
    const oldConnection = await rolePool(pool, oldRole);
    await pool.query('CREATE ROLE ' + quoteRole(newRole) + ' LOGIN');
    try {
      await expect(oldConnection.query('SELECT body FROM memories LIMIT 1'))
        .rejects.toThrow(/permission denied/i);
      await fixture.operator.query(
        'SELECT continuum_rotate_sync_database_identity($1, $2, $3)',
        [fixture.admin.id, newRole, fixture.service.id],
      );
      await grantOwnerRetirementAuthority(pool, newRole);
      const newConnection = await rolePool(pool, newRole);
      try {
        for (const connection of [oldConnection, newConnection]) {
          await expect(connection.query('SELECT body FROM public.memories LIMIT 1'))
            .rejects.toThrow(/permission denied/i);
        }
        await expect(oldConnection.query('SELECT external_id FROM public.principals LIMIT 1'))
          .rejects.toThrow(/permission denied/i);
        await expect(newConnection.query('SELECT external_id FROM public.entra_groups LIMIT 1'))
          .resolves.toBeDefined();
      } finally { await newConnection.end(); }
    } finally {
      await oldConnection.end();
      await fixture.operator.end();
      await dropRoles(pool, [oldRole, newRole, fixture.operatorRole]);
    }
  });

  it('requires the bound approve identity for guarded revocation and removes raw UPDATE', async () => {
    const fixture = await operatorFixture('guarded-revoke');
    const project = await createScope(pool, { kind: 'project', name: 'guarded-revoke' });
    const groupId = '47000000-0000-4000-8000-000000000001';
    await provisionEntraGroupBinding(fixture.operator, fixture.admin, {
      externalId: groupId, scopeId: project.id, role: 'reader',
    });
    const member = await createPrincipal(pool, {
      externalId: 'guarded-revoke-member', kind: 'user', displayName: 'Member',
    });
    await pool.query(
      "INSERT INTO scope_memberships (principal_id, scope_id, role, source_kind, source_id, active) VALUES ($1, $2, 'reader', 'entra', $3, TRUE)",
      [member.id, project.id, groupId],
    );
    try {
      await expect(fixture.operator.query(
        'UPDATE entra_groups SET active = FALSE, deactivated_at = now(), approval_revoked_by = $2, approval_revoked_at = now() WHERE external_id = $1',
        [groupId, fixture.admin.id],
      )).rejects.toThrow(/permission denied|guarded/i);
      await expect(fixture.operator.query(
        "UPDATE scope_memberships SET active = FALSE, deactivated_at = now() WHERE principal_id = $1 AND source_kind = 'entra' AND source_id = $2",
        [member.id, groupId],
      )).rejects.toThrow(/guarded function/i);
      const org = await getScopeByRef(pool, { kind: 'org', name: '' });
      const remaining = await createPrincipal(pool, {
        externalId: 'guarded-revoke-remaining', kind: 'user', displayName: 'Remaining admin',
      });
      await addMembership(pool, remaining.id, org!.id, 'admin');
      await pool.query(
        "UPDATE scope_memberships SET role = 'writer' WHERE principal_id = $1 AND scope_id = $2 AND source_kind = 'manual'",
        [fixture.admin.id, org!.id],
      );
      await expect(revokeEntraGroupBinding(fixture.operator, fixture.admin, groupId))
        .rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
      expect((await pool.query(
        'SELECT active, approval_revoked_at FROM entra_groups WHERE external_id = $1', [groupId],
      )).rows[0]).toEqual({ active: true, approval_revoked_at: null });
    } finally {
      await fixture.operator.end();
      await dropRoles(pool, [fixture.operatorRole]);
    }
  });
});
