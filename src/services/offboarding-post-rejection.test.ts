import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg, { type PoolConfig } from 'pg';
import { addMembership } from '../storage/memberships.js';
import { createPrincipal } from '../storage/principals.js';
import { getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';

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

describe('post-rejection database authority remediation', () => {
  let pool: pg.Pool;
  const roles: string[] = [];
  const rolePools: pg.Pool[] = [];

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  }, 30_000);

  afterAll(async () => {
    await Promise.all(rolePools.splice(0).map((connection) => connection.end()));
    for (const role of roles.reverse()) {
      await pool.query('DROP OWNED BY ' + quoteRole(role));
      await pool.query('REVOKE ' + quoteRole(role) + ' FROM CURRENT_USER');
      await pool.query('DROP ROLE ' + quoteRole(role));
    }
    await pool?.end();
  });

  async function createRole(profile: 'application' | 'operator' | 'sync', principalId?: string) {
    const role = `continuum_post_rejection_${profile}_${Date.now()}_${roles.length}`;
    roles.push(role);
    await pool.query('CREATE ROLE ' + quoteRole(role) + ' NOLOGIN');
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
    }
    const connection = await rolePool(pool, role);
    rolePools.push(connection);
    return { role, connection };
  }

  it('binds the canonical org identity and excludes kind/name from application updates', async () => {
    const application = await createRole('application');
    await application.connection.query('BEGIN');
    try {
      await expect(application.connection.query(
        "UPDATE scopes SET name = 'renamed' WHERE kind = 'org' AND name = ''",
      )).rejects.toThrow(/canonical org|immutable|permission denied/i);
      await expect(application.connection.query(
        "INSERT INTO scopes (id, kind, name) VALUES (gen_random_uuid(), 'org', 'forged')",
      )).rejects.toThrow(/canonical org|singleton|permission denied/i);
    } finally {
      await application.connection.query('ROLLBACK');
    }
    const grants = await readFile(join(process.cwd(), 'scripts/grant-application-role.sql'), 'utf8');
    expect(grants).toMatch(/UPDATE\s*\([^)]*created_at|UPDATE\s*\([^)]*\)\s*ON TABLE[\s\S]*scopes/i);
    expect(grants).not.toMatch(/SELECT, INSERT, UPDATE ON TABLE[\s\S]{0,120}scopes/i);
  });

  it('rejects owner sync verification and direct or PUBLIC column read drift', async () => {
    const service = await createPrincipal(pool, {
      externalId: 'post-rejection-sync-service', kind: 'service', displayName: 'Sync',
    });
    await expect(pool.query(
      'SELECT continuum_verify_sync_database_identity($1)', [service.id],
    )).rejects.toThrow(/owner|superuser|sync database identity/i);

    const sync = await createRole('sync', service.id);
    await pool.query('GRANT SELECT (body) ON memories TO ' + quoteRole(sync.role));
    await expect(sync.connection.query(
      'SELECT continuum_verify_sync_database_identity($1)', [service.id],
    )).rejects.toThrow(/column|privilege|drift|allow-list/i);
    await pool.query('REVOKE SELECT (body) ON memories FROM ' + quoteRole(sync.role));
    await pool.query('GRANT SELECT (body) ON memories TO PUBLIC');
    try {
      await expect(sync.connection.query(
        'SELECT continuum_verify_sync_database_identity($1)', [service.id],
      )).rejects.toThrow(/PUBLIC|column|privilege|drift/i);
    } finally {
      await pool.query('REVOKE SELECT (body) ON memories FROM PUBLIC');
    }
  });

  it('rejects operator membership edges at the privileged runtime boundary', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'post-rejection-operator', kind: 'user', displayName: 'Operator',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, admin.id, org.id, 'admin');
    const application = await createRole('application');
    const operator = await createRole('operator', admin.id);
    await pool.query('GRANT ' + quoteRole(operator.role) + ' TO ' + quoteRole(application.role));
    await application.connection.query('SET ROLE ' + quoteRole(operator.role));
    await expect(application.connection.query(
      'SELECT continuum_operator_authorize_audit_retention($1)', [admin.id],
    )).rejects.toThrow(/membership|role edge|isolated|configuration drift/i);
  });

  it('revokes marker tables and rejects forged marker authority', async () => {
    const application = await createRole('application');
    for (const table of [
      'continuum_entra_guarded_mutations', 'continuum_principal_disable_requests',
    ]) {
      expect((await pool.query(
        `SELECT has_table_privilege($1, $2, 'INSERT') AS allowed`,
        [application.role, table],
      )).rows[0].allowed).toBe(false);
    }
    const migration = await readFile(
      join(process.cwd(), 'migrations/0052_offboarding_review_repair.sql'), 'utf8',
    );
    expect(migration).toMatch(/authorization_principal_id[\s\S]*continuum_require_trusted_database_identity/i);
    expect(migration).toMatch(/continuum_assert_application_role_allowlist/i);
  });

  it('proves retirement authority before installing a sync identity', async () => {
    const migration = await readFile(
      join(process.cwd(), 'migrations/0052_offboarding_review_repair.sql'), 'utf8',
    );
    expect(migration).toMatch(/continuum_require_sync_retirement_authority/i);
    expect(migration).toMatch(/admin_option[\s\S]*target_database_role|target_database_role[\s\S]*admin_option/i);
    expect(migration).toMatch(/continuum_install_sync_database_identity[\s\S]*continuum_require_sync_retirement_authority/i);
  });

  it('handles extension-owned pgvector routines without weakening application routines', async () => {
    const migration51 = await readFile(
      join(process.cwd(), 'migrations/0051_offboarding_security_contract.sql'), 'utf8',
    );
    const migration52 = await readFile(
      join(process.cwd(), 'migrations/0052_offboarding_review_repair.sql'), 'utf8',
    );
    expect(migration51).toMatch(/pg_extension[\s\S]*extension-owned|extension-owned[\s\S]*pg_extension/i);
    expect(migration52).toMatch(/extension updates?[\s\S]*continuum_grant_application_vector_functions/i);
    expect(migration52).toMatch(/pg_depend[\s\S]*deptype\s*=\s*'e'/i);
  });

  it('forward-repairs edited migration shapes and documents migration 0052', async () => {
    const migration = await readFile(
      join(process.cwd(), 'migrations/0052_offboarding_review_repair.sql'), 'utf8',
    );
    expect(migration).toMatch(/ALTER TABLE continuum_principal_disable_requests/i);
    expect(migration).toMatch(/ALTER TABLE continuum_entra_guarded_mutations/i);
    expect(migration).toMatch(/DROP TRIGGER IF EXISTS[\s\S]*ON principals/i);
    expect(migration).toMatch(/DROP TRIGGER IF EXISTS[\s\S]*ON entra_groups/i);
    expect(migration).toMatch(/VALIDATE CONSTRAINT/i);
    const docs = await readFile(join(process.cwd(), 'docs/offboarding.md'), 'utf8');
    expect(docs).toMatch(/0052_offboarding_review_repair\.sql/);
    expect(docs).toMatch(/52 migrations|migration count[^\n]*52/i);
  });
});
