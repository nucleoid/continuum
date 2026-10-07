import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg, { type PoolConfig } from 'pg';
import { runMembershipSync } from '../identity/sync-runner.js';
import { addMembership } from '../storage/memberships.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { provisionEntraGroupBinding } from './membership-sync.js';
import { disablePrincipal } from './principal-admin.js';

const quoteRole = (role: string) => `"${role.replaceAll('"', '""')}"`;

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
  await pool.query('GRANT ' + quoteRole(role) + ' TO CURRENT_USER');
  return new pg.Pool({
    ...(pool as unknown as { options: PoolConfig }).options,
    max: 1,
    options: '-c role=' + role,
  });
}

describe('fresh independent review remediation', () => {
  let pool: pg.Pool;
  const roles: string[] = [];

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  }, 30_000);

  afterAll(async () => {
    for (const role of roles.reverse()) {
      await pool.query('DROP OWNED BY ' + quoteRole(role));
      await pool.query('REVOKE ' + quoteRole(role) + ' FROM CURRENT_USER');
      await pool.query('DROP ROLE ' + quoteRole(role));
    }
    await pool?.end();
  });

  async function createRole(profile: 'application' | 'operator' | 'sync', principalId?: string) {
    const role = `continuum_round4_${profile}_${Date.now()}_${roles.length}`;
    roles.push(role);
    await pool.query(
      'CREATE ROLE ' + quoteRole(role) + (profile === 'sync' ? ' LOGIN' : ' NOLOGIN'),
    );
    if (profile !== 'sync') {
      await applyGrantScript(pool, 'grant-application-role.sql', { continuum_app_role: role });
    }
    if (profile === 'operator') {
      await applyGrantScript(pool, 'grant-operator-role.sql', {
        continuum_operator_role: role, continuum_principal_id: principalId!,
      });
    }
    if (profile === 'sync') {
      await applyGrantScript(pool, 'grant-sync-role.sql', {
        continuum_sync_role: role, continuum_principal_id: principalId!,
      });
      await pool.query(
        'ALTER ROLE ' + quoteRole(role) + " LOGIN PASSWORD 'continuum-test-password'",
      );
      const base = (pool as unknown as { options: PoolConfig }).options;
      const directUrl = new URL(base.connectionString!);
      directUrl.username = role;
      directUrl.password = 'continuum-test-password';
      return {
        role,
        connection: new pg.Pool({ connectionString: directUrl.toString(), max: 1 }),
      };
    }
    return { role, connection: await rolePool(pool, role) };
  }

  it('requires a bound approve session to disable a manual admin or bound operator', async () => {
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const protectedAdmin = await createPrincipal(pool, {
      externalId: 'round4-protected-admin', kind: 'user', displayName: 'Protected',
    });
    const approvingAdmin = await createPrincipal(pool, {
      externalId: 'round4-approving-admin', kind: 'user', displayName: 'Approver',
    });
    const entraAdmin = await createPrincipal(pool, {
      externalId: '44444444-4444-4444-8444-444444444444', kind: 'user', displayName: 'Entra',
    });
    await addMembership(pool, protectedAdmin.id, org.id, 'admin');
    await addMembership(pool, approvingAdmin.id, org.id, 'admin');
    await provisionEntraGroupBinding(pool, approvingAdmin, {
      externalId: '55555555-5555-4555-8555-555555555555',
      scopeId: org.id, role: 'admin',
    });
    await pool.query(
      `INSERT INTO scope_memberships
         (principal_id, scope_id, role, source_kind, source_id, active)
       VALUES ($1, $2, 'admin', 'entra', '55555555-5555-4555-8555-555555555555', TRUE)`,
      [entraAdmin.id, org.id],
    );
    const application = await createRole('application');
    const protectedBinding = await createRole('operator', protectedAdmin.id);
    const approvingBinding = await createRole('operator', approvingAdmin.id);
    try {
      await expect(disablePrincipal(
        application.connection, entraAdmin, protectedAdmin.id,
      )).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(application.connection.query(
        'UPDATE principals SET disabled_at = now() WHERE id = $1', [protectedAdmin.id],
      )).rejects.toThrow(/approve|operator|protected|guarded/i);
      expect((await pool.query(
        'SELECT disabled_at FROM principals WHERE id = $1', [protectedAdmin.id],
      )).rows[0].disabled_at).toBeNull();

      await expect(disablePrincipal(
        approvingBinding.connection, approvingAdmin, protectedAdmin.id,
      )).resolves.toBeUndefined();
    } finally {
      await application.connection.end();
      await protectedBinding.connection.end();
      await approvingBinding.connection.end();
    }
  });

  it('preserves application-role disable for a non-admin with cross-scope Entra access', async () => {
    const actor = await createPrincipal(pool, {
      externalId: 'round4-manual-admin', kind: 'user', displayName: 'Admin',
    });
    const target = await createPrincipal(pool, {
      externalId: 'round4-non-admin', kind: 'user', displayName: 'Target',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const project = await createScope(pool, { kind: 'project', name: 'round4-shared' });
    await addMembership(pool, actor.id, org.id, 'admin');
    await provisionEntraGroupBinding(pool, actor, {
      externalId: '66666666-6666-4666-8666-666666666666',
      scopeId: project.id, role: 'reader',
    });
    await pool.query(
      `INSERT INTO scope_memberships
         (principal_id, scope_id, role, source_kind, source_id, active)
       VALUES ($1, $2, 'reader', 'entra', '66666666-6666-4666-8666-666666666666', TRUE)`,
      [target.id, project.id],
    );
    const application = await createRole('application');
    try {
      await expect(disablePrincipal(application.connection, actor, target.id))
        .resolves.toBeUndefined();
      expect((await pool.query(
        `SELECT p.disabled_at IS NOT NULL AS disabled, m.active
           FROM principals p JOIN scope_memberships m ON m.principal_id = p.id
          WHERE p.id = $1 AND m.scope_id = $2`, [target.id, project.id],
      )).rows[0]).toEqual({ disabled: true, active: false });
    } finally { await application.connection.end(); }
  });

  it('blocks raw Entra membership DELETE and provides an audited operator removal', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'round4-delete-admin', kind: 'user', displayName: 'Admin',
    });
    const member = await createPrincipal(pool, {
      externalId: 'round4-delete-member', kind: 'user', displayName: 'Member',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const project = await createScope(pool, { kind: 'project', name: 'round4-delete' });
    const sourceId = '77777777-7777-4777-8777-777777777777';
    await addMembership(pool, admin.id, org.id, 'admin');
    await provisionEntraGroupBinding(pool, admin, {
      externalId: sourceId, scopeId: project.id, role: 'reader',
    });
    await pool.query(
      `INSERT INTO scope_memberships
         (principal_id, scope_id, role, source_kind, source_id, active)
       VALUES ($1, $2, 'reader', 'entra', $3, TRUE)`, [member.id, project.id, sourceId],
    );
    const application = await createRole('application');
    const operator = await createRole('operator', admin.id);
    try {
      await expect(application.connection.query(
        `DELETE FROM scope_memberships
          WHERE principal_id = $1 AND scope_id = $2 AND source_kind = 'entra'`,
        [member.id, project.id],
      )).rejects.toThrow(/permission denied|guarded|Entra membership/i);
      await expect(operator.connection.query(
        'SELECT continuum_operator_remove_entra_membership($1, $2, $3, $4)',
        [admin.id, member.id, project.id, sourceId],
      )).resolves.toMatchObject({ rows: [{ continuum_operator_remove_entra_membership: true }] });
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM scope_memberships
          WHERE principal_id = $1 AND scope_id = $2 AND source_kind = 'entra'`,
        [member.id, project.id],
      )).rows[0].count).toBe(0);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM audit_log
          WHERE principal_id = $1
            AND metadata->>'operation' = 'entra_membership_removed'
            AND metadata->>'member_principal_id' = $2`, [admin.id, member.id],
      )).rows[0].count).toBe(1);
    } finally {
      await application.connection.end();
      await operator.connection.end();
    }
  });

  it('fails sync startup before Graph access when exact privileges drift', async () => {
    const service = await createPrincipal(pool, {
      externalId: '88888888-8888-4888-8888-888888888888',
      kind: 'service', displayName: 'Sync service',
    });
    const breakGlass = await createPrincipal(pool, {
      externalId: 'round4-sync-break-glass', kind: 'user', displayName: 'Break glass',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, breakGlass.id, org.id, 'admin');
    const sync = await createRole('sync', service.id);
    const fetchSnapshot = vi.fn(async () => []);
    try {
      const driftCases = [
        ['GRANT UPDATE ON TABLE principals TO ', 'REVOKE UPDATE ON TABLE principals FROM '],
        ['GRANT DELETE ON TABLE principals TO ', 'REVOKE DELETE ON TABLE principals FROM '],
        ['GRANT TRIGGER ON TABLE principals TO ', 'REVOKE TRIGGER ON TABLE principals FROM '],
        ['GRANT CREATE ON SCHEMA public TO ', 'REVOKE CREATE ON SCHEMA public FROM '],
        [
          'GRANT EXECUTE ON FUNCTION continuum_disable_principal(uuid,uuid) TO ',
          'REVOKE EXECUTE ON FUNCTION continuum_disable_principal(uuid,uuid) FROM ',
        ],
      ];
      for (const [grant, revoke] of driftCases) {
        await pool.query(grant + quoteRole(sync.role));
        await expect(sync.connection.query(
          'SELECT continuum_verify_sync_database_identity($1)', [service.id],
        )).rejects.toThrow(/identity|privilege|drift|allow-list|isolated/i);
        await pool.query(revoke + quoteRole(sync.role));
      }
      await pool.query('GRANT USAGE ON SCHEMA public TO PUBLIC');
      await expect(sync.connection.query(
        'SELECT continuum_verify_sync_database_identity($1)', [service.id],
      )).rejects.toThrow(/PUBLIC|privilege|drift/i);
      await pool.query('REVOKE USAGE ON SCHEMA public FROM PUBLIC');
      await pool.query('DROP FUNCTION IF EXISTS public.round4_public_drift()');
      await pool.query(`
        CREATE FUNCTION public.round4_public_drift() RETURNS integer
        LANGUAGE sql AS 'SELECT 1'
      `);
      try {
        expect((await pool.query(
          `SELECT has_function_privilege('public',
                    'public.round4_public_drift()', 'EXECUTE') AS allowed`,
        )).rows[0].allowed).toBe(false);
        await pool.query(
          'GRANT EXECUTE ON FUNCTION public.round4_public_drift() TO PUBLIC',
        );
        await expect(sync.connection.query(
          'SELECT continuum_verify_sync_database_identity($1)', [service.id],
        )).rejects.toThrow(/PUBLIC|default|privilege|drift/i);
      } finally {
        await pool.query(
          'REVOKE EXECUTE ON FUNCTION public.round4_public_drift() FROM PUBLIC',
        );
        await pool.query('DROP FUNCTION public.round4_public_drift()');
      }
      await pool.query(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC',
      );
      await expect(sync.connection.query(
        'SELECT continuum_verify_sync_database_identity($1)', [service.id],
      )).rejects.toThrow(/PUBLIC|default|privilege|drift/i);
      await pool.query(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM PUBLIC',
      );

      await pool.query('GRANT UPDATE ON TABLE principals TO ' + quoteRole(sync.role));
      await expect(runMembershipSync(sync.connection, {
        CONTINUUM_ENTRA_MEMBERSHIP_SYNC: 'true',
        CONTINUUM_GRAPH_ACCESS_TOKEN: 'x'.repeat(32),
        CONTINUUM_MEMBERSHIP_SYNC_ACTOR: service.externalId!,
      }, fetchSnapshot)).rejects.toThrow(/identity|privilege|drift|allow-list/i);
      expect(fetchSnapshot).not.toHaveBeenCalled();
    } finally {
      await pool.query('REVOKE USAGE ON SCHEMA public FROM PUBLIC');
      await pool.query(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM PUBLIC',
      );
      await sync.connection.end();
    }
  });

  it('detects PUBLIC schema drift and both directions of Entra source rewriting', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'round4-source-admin', kind: 'user', displayName: 'Admin',
    });
    const member = await createPrincipal(pool, {
      externalId: 'round4-source-member', kind: 'user', displayName: 'Member',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const project = await createScope(pool, { kind: 'project', name: 'round4-source' });
    await addMembership(pool, admin.id, org.id, 'admin');
    await addMembership(pool, member.id, project.id, 'reader');
    await provisionEntraGroupBinding(pool, admin, {
      externalId: '99999999-9999-4999-8999-999999999999',
      scopeId: project.id, role: 'reader',
    });
    const application = await createRole('application');
    try {
      await expect(application.connection.query(
        `UPDATE scope_memberships SET source_kind = 'entra', source_id = $3
          WHERE principal_id = $1 AND scope_id = $2 AND source_kind = 'manual'`,
        [member.id, project.id, '99999999-9999-4999-8999-999999999999'],
      )).rejects.toThrow(/immutable|trusted sync|guarded/i);
      await pool.query(
        `UPDATE scope_memberships SET source_kind = 'entra', source_id = $3
          WHERE principal_id = $1 AND scope_id = $2 AND source_kind = 'manual'`,
        [member.id, project.id, '99999999-9999-4999-8999-999999999999'],
      );
      await expect(application.connection.query(
        `UPDATE scope_memberships SET source_kind = 'manual', source_id = 'manual'
          WHERE principal_id = $1 AND scope_id = $2 AND source_kind = 'entra'`,
        [member.id, project.id],
      )).rejects.toThrow(/immutable|trusted sync|guarded/i);
      await pool.query('GRANT USAGE ON SCHEMA public TO PUBLIC');
      await expect(pool.query('SELECT continuum_verify_database_identity_configuration()'))
        .rejects.toThrow(/PUBLIC.*schema/i);
    } finally {
      await pool.query('REVOKE USAGE ON SCHEMA public FROM PUBLIC');
      await application.connection.end();
    }
  });
});
