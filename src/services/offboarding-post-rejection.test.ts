import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
  const assertion = sql.lastIndexOf('\nSELECT "public".continuum_assert_application_role_allowlist');
  if (assertion < 0 || /^\s*BEGIN;/im.test(sql)) {
    await pool.query(sql);
    return;
  }
  try {
    await pool.query(sql.slice(0, assertion));
  } catch (error) {
    throw new Error('application profile grants failed', { cause: error });
  }
  try {
    await pool.query(sql.slice(assertion));
  } catch (error) {
    throw new Error('application profile allow-list assertion failed', { cause: error });
  }
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
    const role = profile === 'sync'
      ? `Continuum-Sync-${Date.now()}-${roles.length}`
      : `continuum_post_rejection_${profile}_${Date.now()}_${roles.length}`;
    roles.push(role);
    await pool.query(
      'CREATE ROLE ' + quoteRole(role)
      + (profile === 'sync' ? " LOGIN PASSWORD 'continuum-test-password'" : ' NOLOGIN'),
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
    }
    const base = (pool as unknown as { options: PoolConfig }).options;
    const directUrl = new URL(base.connectionString!);
    directUrl.username = role;
    directUrl.password = 'continuum-test-password';
    const connection = profile === 'sync' ? new pg.Pool({
      connectionString: directUrl.toString(),
      ssl: base.ssl,
      max: 1,
    }) : await rolePool(pool, role);
    rolePools.push(connection);
    return { role, connection };
  }

  it('binds the canonical org identity and excludes kind/name from application updates', async () => {
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM continuum_canonical_org_scope WHERE singleton',
    )).rows[0].count).toBe(1);
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
    expect(grants).toMatch(
      /GRANT SELECT, INSERT ON TABLE\s+:"continuum_schema"\.scopes/i,
    );
    expect(grants).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON TABLE[\s\S]*scopes/i);

    await pool.query('BEGIN');
    try {
      const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
      await expect(pool.query(
        "UPDATE scopes SET name = 'owner-renamed' WHERE id = $1", [org.id],
      )).rejects.toThrow(/canonical org|immutable/i);
    } finally {
      await pool.query('ROLLBACK');
    }

    await pool.query('BEGIN');
    try {
      await pool.query('TRUNCATE continuum_canonical_org_scope');
      await expect(pool.query('SELECT continuum_org_scope_id()'))
        .rejects.toThrow(/canonical|organization|marker|identity/i);
    } finally {
      await pool.query('ROLLBACK');
    }
  });

  it('rejects schema and PUBLIC privilege drift in the exact application profile', async () => {
    const application = await createRole('application');
    await pool.query('GRANT CREATE ON SCHEMA public TO ' + quoteRole(application.role));
    await expect(pool.query(
      'SELECT continuum_assert_application_role_allowlist($1)', [application.role],
    )).rejects.toThrow(/schema|privilege|drift|allow-list/i);
    await pool.query('REVOKE CREATE ON SCHEMA public FROM ' + quoteRole(application.role));

    await pool.query(
      'GRANT EXECUTE ON FUNCTION continuum_operator_authorize_audit_retention(UUID) TO PUBLIC',
    );
    try {
      await expect(pool.query(
        'SELECT continuum_assert_application_role_allowlist($1)', [application.role],
      )).rejects.toThrow(/PUBLIC|function|privilege|drift|allow-list/i);
    } finally {
      await pool.query(
        'REVOKE EXECUTE ON FUNCTION continuum_operator_authorize_audit_retention(UUID) FROM PUBLIC',
      );
    }
  });

  it('returns a failing psql exit code when a grant script is missing variables', () => {
    const databaseUrl = (pool as unknown as { options: PoolConfig }).options.connectionString!;
    const result = spawnSync('psql', [
      databaseUrl,
      '--file=' + join(process.cwd(), 'scripts/grant-application-role.sql'),
    ], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    const retireResult = spawnSync('psql', [
      databaseUrl,
      '--file=' + join(process.cwd(), 'scripts/retire-sync-role.sql'),
    ], { encoding: 'utf8' });
    expect(retireResult.status).not.toBe(0);
  });

  it('does not exempt non-vector extension functions from PUBLIC drift checks', async () => {
    const application = await createRole('application');
    await pool.query('BEGIN');
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS hstore WITH SCHEMA public');
      await pool.query(`DO $grant_public_extension_function$
        DECLARE function_signature TEXT;
        BEGIN
          SELECT format('%I.%I(%s)', namespace.nspname, function.proname,
                        pg_get_function_identity_arguments(function.oid))
            INTO function_signature
            FROM pg_proc function
            JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
            JOIN pg_depend dependency
              ON dependency.classid = 'pg_proc'::regclass
             AND dependency.objid = function.oid
             AND dependency.refclassid = 'pg_extension'::regclass
             AND dependency.deptype = 'e'
            JOIN pg_extension extension ON extension.oid = dependency.refobjid
           WHERE extension.extname = 'hstore'
             AND function.pronamespace = quote_ident(current_schema())::regnamespace
           ORDER BY function.oid LIMIT 1;
          IF function_signature IS NULL THEN
            RAISE EXCEPTION 'hstore test function not found in application schema';
          END IF;
          EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', function_signature);
        END;
      $grant_public_extension_function$`);
      await expect(pool.query(
        'SELECT continuum_assert_application_role_allowlist($1)', [application.role],
      )).rejects.toThrow(/PUBLIC|extension|function|privilege|drift/i);
    } finally {
      await pool.query('ROLLBACK');
    }
  });

  it('rejects owner sync verification and direct or PUBLIC column read drift', async () => {
    const service = await createPrincipal(pool, {
      externalId: 'post-rejection-sync-service', kind: 'service', displayName: 'Sync',
    });
    await expect(pool.query(
      'SELECT continuum_verify_sync_database_identity($1)', [service.id],
    )).rejects.toThrow(/owner|superuser|sync database identity/i);

    const sync = await createRole('sync', service.id);
    const ownerSetRole = await rolePool(pool, sync.role);
    await expect(ownerSetRole.query(
      'SELECT continuum_verify_sync_database_identity($1)', [service.id],
    )).rejects.toThrow(/owner|superuser|session|sync database identity/i);
    await ownerSetRole.end();
    await pool.query('REVOKE ' + quoteRole(sync.role) + ' FROM CURRENT_USER');
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
    await expect(operator.connection.query('SELECT id FROM scopes LIMIT 1'))
      .resolves.toBeDefined();
    await pool.query('GRANT ' + quoteRole(operator.role) + ' TO ' + quoteRole(application.role));
    await application.connection.query('SET ROLE ' + quoteRole(operator.role));
    await expect(application.connection.query(
      'SELECT continuum_operator_authorize_audit_retention($1)', [admin.id],
    )).rejects.toThrow(/membership|role edge|isolated|configuration drift/i);
  });

  it('atomically reapplies application then operator grants to an existing operator', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'post-rejection-regrant-operator', kind: 'user', displayName: 'Operator',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, admin.id, org.id, 'admin');
    const operator = await createRole('operator', admin.id);
    await expect(applyGrantScript(pool, 'grant-application-role.sql', {
      continuum_app_role: operator.role,
    })).resolves.toBeUndefined();
    await expect(applyGrantScript(pool, 'grant-operator-role.sql', {
      continuum_operator_role: operator.role,
      continuum_principal_id: admin.id,
    })).resolves.toBeUndefined();
    expect((await pool.query(
      `SELECT has_function_privilege($1,
                'continuum_operator_offboard_scope_access(uuid,uuid)', 'EXECUTE') AS allowed`,
      [operator.role],
    )).rows[0].allowed).toBe(true);
  });

  it('rejects trigger-bypass parameter grants and per-role settings', async () => {
    const application = await createRole('application');
    await pool.query(
      'GRANT SET ON PARAMETER session_replication_role TO ' + quoteRole(application.role),
    );
    await expect(pool.query(
      'SELECT continuum_assert_application_role_allowlist($1)', [application.role],
    )).rejects.toThrow(/parameter|setting|replication|privilege|drift/i);
    await pool.query(
      'REVOKE SET ON PARAMETER session_replication_role FROM ' + quoteRole(application.role),
    );
    await pool.query(
      'ALTER ROLE ' + quoteRole(application.role) + " SET statement_timeout = '30s'",
    );
    await expect(pool.query(
      'SELECT continuum_assert_application_role_allowlist($1)', [application.role],
    )).rejects.toThrow(/parameter|setting|role|drift/i);
    await pool.query('ALTER ROLE ' + quoteRole(application.role) + ' RESET ALL');
  });

  it('revokes marker tables and rejects forged marker authority', async () => {
    const application = await createRole('application');
    for (const table of [
      'continuum_entra_guarded_mutations', 'continuum_principal_disable_requests',
      'continuum_entra_reapproval_requests',
    ]) {
      expect((await pool.query(
        `SELECT has_table_privilege($1, $2, 'INSERT') AS allowed`,
        [application.role, table],
      )).rows[0].allowed).toBe(false);
    }
    await expect(application.connection.query(`
      INSERT INTO continuum_entra_guarded_mutations
        (external_id, mutation_kind, backend_pid, transaction_id,
         authorization_principal_id)
      VALUES ('forged', 'delete', pg_backend_pid(), txid_current(),
              gen_random_uuid())
    `)).rejects.toThrow(/permission denied/i);
    const migration = await readFile(
      join(process.cwd(), 'migrations/0052_offboarding_review_repair.sql'), 'utf8',
    );
    expect(migration).toMatch(/authorization_principal_id[\s\S]*continuum_require_trusted_database_identity/i);
    expect(migration).toMatch(/continuum_assert_application_role_allowlist/i);
    expect(migration).toMatch(/continuum_entra_reapproval_requests[\s\S]*authorization_principal_id/i);
    expect(migration).toMatch(/continuum_protect_capability_marker_write/i);
  });

  it('rejects operator column, trigger, and extra-function drift exactly', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'post-rejection-exact-operator', kind: 'user', displayName: 'Operator',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, admin.id, org.id, 'admin');
    const operator = await createRole('operator', admin.id);
    await expect(pool.query(
      'SELECT continuum_assert_operator_role_allowlist($1)', [operator.role],
    )).resolves.toBeDefined();
    await pool.query('GRANT UPDATE (display_name) ON principals TO ' + quoteRole(operator.role));
    await expect(pool.query(
      'SELECT continuum_assert_operator_role_allowlist($1)', [operator.role],
    )).rejects.toThrow(/operator|column|privilege|drift|allow-list/i);
  });

  it('proves retirement authority before installing a sync identity', async () => {
    const migration = await readFile(
      join(process.cwd(), 'migrations/0052_offboarding_review_repair.sql'), 'utf8',
    );
    expect(migration).toMatch(/continuum_require_sync_retirement_authority/i);
    expect(migration).toMatch(/admin_option[\s\S]*target_database_role|target_database_role[\s\S]*admin_option/i);
    expect(migration).toMatch(/continuum_install_sync_database_identity[\s\S]*continuum_require_sync_retirement_authority/i);
  });

  it('discovers and refreshes pgvector grants after function hardening', async () => {
    const application = await createRole('application');
    const vectorFunction = (await pool.query<{ signature: string }>(`
      SELECT function.oid::regprocedure::text AS signature
        FROM pg_proc function
        JOIN pg_depend dependency ON dependency.classid = 'pg_proc'::regclass
         AND dependency.objid = function.oid
         AND dependency.refclassid = 'pg_extension'::regclass
         AND dependency.deptype = 'e'
        JOIN pg_extension extension ON extension.oid = dependency.refobjid
       WHERE extension.extname = 'vector' AND function.pronamespace = 'public'::regnamespace
       ORDER BY function.oid LIMIT 1
    `)).rows[0];
    expect(vectorFunction).toBeDefined();
    await pool.query('BEGIN');
    try {
      await pool.query(
        `REVOKE EXECUTE ON FUNCTION ${vectorFunction.signature} FROM PUBLIC, ${quoteRole(application.role)}`,
      );
      await pool.query('SELECT continuum_grant_application_vector_functions()');
      expect((await pool.query(
        'SELECT has_function_privilege($1, $2, $3) AS allowed',
        [application.role, vectorFunction.signature, 'EXECUTE'],
      )).rows[0].allowed).toBe(true);
    } finally {
      await pool.query('ROLLBACK');
    }

    const managedOwner = `continuum_vector_provider_${Date.now()}`;
    await pool.query('BEGIN');
    try {
      await pool.query('CREATE ROLE ' + quoteRole(managedOwner) + ' NOLOGIN');
      await pool.query(`
        CREATE FUNCTION continuum_managed_vector_probe(integer)
        RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT $1'
      `);
      await pool.query(
        'ALTER FUNCTION continuum_managed_vector_probe(integer) OWNER TO '
        + quoteRole(managedOwner),
      );
      await pool.query(
        'ALTER EXTENSION vector ADD FUNCTION continuum_managed_vector_probe(integer)',
      );
      await pool.query(
        'REVOKE EXECUTE ON FUNCTION continuum_managed_vector_probe(integer) FROM PUBLIC, '
        + quoteRole(application.role),
      );
      await expect(pool.query('SELECT continuum_grant_application_vector_functions()'))
        .rejects.toThrow(/extension owner must grant EXECUTE/i);
    } finally {
      await pool.query('ROLLBACK');
    }

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
