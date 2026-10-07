import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg, { type PoolConfig } from 'pg';
import { addMembership } from '../storage/memberships.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { provisionEntraGroupBinding } from './membership-sync.js';
import { mapOwnedUserScope, offboardPrincipal } from './offboarding.js';
import { disablePrincipal } from './principal-admin.js';

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
  pool: pg.Pool, role: string, profile: 'application' | 'operator', principalId?: string,
): Promise<pg.Pool> {
  await pool.query('CREATE ROLE ' + quoteRole(role) + ' NOLOGIN');
  await applyGrantScript(pool, 'grant-application-role.sql', { continuum_app_role: role });
  if (profile === 'operator') {
    await applyGrantScript(pool, 'grant-operator-role.sql', {
      continuum_operator_role: role, continuum_principal_id: principalId!,
    });
  }
  await pool.query('GRANT ' + quoteRole(role) + ' TO CURRENT_USER');
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

describe('post-independent-review offboarding remediation', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => { await pool?.end(); });

  async function fixture(prefix: string) {
    const admin = await createPrincipal(pool, {
      externalId: prefix + '-admin', kind: 'user', displayName: 'Admin',
    });
    const target = await createPrincipal(pool, {
      externalId: prefix + '-target', kind: 'user', displayName: 'Target',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const owned = await createScope(pool, { kind: 'user', name: prefix + '-owned' });
    const shared = await createScope(pool, { kind: 'project', name: prefix + '-shared' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    await addMembership(pool, target.id, owned.id, 'writer');
    await mapOwnedUserScope(pool, admin, target.id, owned.id);
    const groupId = prefix.padEnd(8, '0').slice(0, 8) + '-0000-4000-8000-000000000001';
    await provisionEntraGroupBinding(pool, admin, {
      externalId: groupId, scopeId: shared.id, role: 'reader',
    });
    await pool.query(
      `INSERT INTO scope_memberships
         (principal_id, scope_id, role, source_kind, source_id, active)
       VALUES ($1, $2, 'reader', 'entra', $3, TRUE)`,
      [target.id, shared.id, groupId],
    );
    return { admin, target, owned, shared, groupId };
  }

  it('lets the shared application role disable a principal with cross-scope Entra access', async () => {
    const value = await fixture('a1000000');
    const role = 'continuum_disable_cross_scope_' + Date.now();
    const connection = await createRolePool(pool, role, 'application');
    try {
      await expect(disablePrincipal(connection, value.admin, value.target.id)).resolves.toBeUndefined();
      expect((await pool.query(
        `SELECT p.disabled_at IS NOT NULL AS disabled, m.active
           FROM principals p JOIN scope_memberships m ON m.principal_id = p.id
          WHERE p.id = $1 AND m.scope_id = $2 AND m.source_kind = 'entra'`,
        [value.target.id, value.shared.id],
      )).rows[0]).toEqual({ disabled: true, active: false });
    } finally { await dropRole(pool, connection, role); }
  });

  it('lets an operator offboard while deactivating cross-scope Entra access and auditing cleanup', async () => {
    const value = await fixture('b2000000');
    const role = 'continuum_offboard_cross_scope_' + Date.now();
    const connection = await createRolePool(pool, role, 'operator', value.admin.id);
    try {
      await expect(offboardPrincipal(connection, value.admin, value.target.id, {
        confirmationScopeId: value.owned.id,
      })).resolves.toMatchObject({ complete: true });
      expect((await pool.query(
        `SELECT active FROM scope_memberships
          WHERE principal_id = $1 AND scope_id = $2 AND source_kind = 'entra'`,
        [value.target.id, value.shared.id],
      )).rows[0].active).toBe(false);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM audit_log
          WHERE principal_id = $1
            AND metadata->>'operation' = 'offboarding_scope_access_closed'
            AND metadata->>'scope_id' = $2`,
        [value.admin.id, value.owned.id],
      )).rows[0].count).toBe(1);
    } finally { await dropRole(pool, connection, role); }
  });

  it('rejects scope cleanup without a started incomplete run bound to the owned user scope', async () => {
    const value = await fixture('c3000000');
    const role = 'continuum_unbound_cleanup_' + Date.now();
    const connection = await createRolePool(pool, role, 'operator', value.admin.id);
    try {
      await expect(connection.query(
        'SELECT * FROM continuum_operator_offboard_scope_access($1, $2)',
        [value.admin.id, value.shared.id],
      )).rejects.toThrow(/incomplete offboarding run|owned user scope|started/i);
      expect((await pool.query(
        `SELECT active FROM scope_memberships
          WHERE principal_id = $1 AND scope_id = $2 AND source_kind = 'entra'`,
        [value.target.id, value.shared.id],
      )).rows[0].active).toBe(true);
    } finally { await dropRole(pool, connection, role); }
  });
});
