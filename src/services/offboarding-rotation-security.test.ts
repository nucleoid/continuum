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

  it('binds authority to role OID so a dropped role name cannot inherit stale sync authority', async () => {
    const service = await createPrincipal(pool, {
      externalId: 'stale-sync-service', kind: 'service', displayName: 'Stale service',
    });
    const role = 'continuum_stale_sync_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(role) + ' NOLOGIN');
    await pool.query('GRANT ' + quoteRole(role) + ' TO CURRENT_USER');
    await applyGrantScript(pool, 'grant-sync-role.sql', {
      continuum_sync_role: role, continuum_principal_id: service.id,
    });
    const oldOid = (await pool.query<{ oid: number }>(
      'SELECT oid FROM pg_roles WHERE rolname = $1', [role],
    )).rows[0].oid;
    await pool.query('DROP OWNED BY ' + quoteRole(role));
    await pool.query('REVOKE ' + quoteRole(role) + ' FROM CURRENT_USER');
    await pool.query('DROP ROLE ' + quoteRole(role));
    await pool.query('CREATE ROLE ' + quoteRole(role) + ' NOLOGIN');
    await pool.query('GRANT ' + quoteRole(role) + ' TO CURRENT_USER');
    const replacement = await rolePool(pool, role);
    try {
      const binding = (await pool.query(
        'SELECT database_role_oid::oid AS oid FROM continuum_trusted_database_identities WHERE database_role = $1::name',
        [role],
      )).rows[0];
      expect(Number(binding.oid)).toBe(Number(oldOid));
      await expect(replacement.query('SELECT continuum_require_sync_session($1)', [service.id]))
        .rejects.toThrow(/DB-bound trusted sync identity/i);
    } finally {
      await replacement.end();
      await pool.query('DROP OWNED BY ' + quoteRole(role));
      await pool.query('REVOKE ' + quoteRole(role) + ' FROM CURRENT_USER');
      await pool.query('DROP ROLE ' + quoteRole(role));
      await pool.query('DELETE FROM continuum_trusted_database_identities WHERE database_role = $1::name', [role]);
    }
  });

  it('revokes all old sync reads and does not grant memory content to the replacement', async () => {
    const fixture = await operatorFixture('old-read');
    const oldRole = 'continuum_old_read_' + Date.now();
    const newRole = 'continuum_new_read_' + Date.now();
    await pool.query('CREATE ROLE ' + quoteRole(oldRole) + ' NOLOGIN');
    await pool.query('GRANT ' + quoteRole(oldRole) + ' TO CURRENT_USER');
    await applyGrantScript(pool, 'grant-sync-role.sql', {
      continuum_sync_role: oldRole, continuum_principal_id: fixture.service.id,
    });
    const oldConnection = await rolePool(pool, oldRole);
    await pool.query('CREATE ROLE ' + quoteRole(newRole) + ' NOLOGIN');
    await pool.query('GRANT ' + quoteRole(newRole) + ' TO CURRENT_USER');
    try {
      await expect(oldConnection.query('SELECT body FROM memories LIMIT 1')).resolves.toBeDefined();
      await fixture.operator.query(
        'SELECT continuum_rotate_sync_database_identity($1, $2, $3)',
        [fixture.admin.id, newRole, fixture.service.id],
      );
      const newConnection = await rolePool(pool, newRole);
      try {
        for (const connection of [oldConnection, newConnection]) {
          await expect(connection.query('SELECT body FROM memories LIMIT 1'))
            .rejects.toThrow(/permission denied/i);
        }
        await expect(oldConnection.query('SELECT external_id FROM principals LIMIT 1'))
          .rejects.toThrow(/permission denied/i);
        await expect(newConnection.query('SELECT external_id FROM entra_groups LIMIT 1'))
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
    try {
      await expect(fixture.operator.query(
        'UPDATE entra_groups SET active = FALSE, deactivated_at = now(), approval_revoked_by = $2, approval_revoked_at = now() WHERE external_id = $1',
        [groupId, fixture.admin.id],
      )).rejects.toThrow(/permission denied|guarded/i);
      const org = await getScopeByRef(pool, { kind: 'org', name: '' });
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
