import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg, { type PoolConfig } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addMembership } from './memberships.js';
import { runMigrations } from './migrator.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { makeTestPool, resetData } from './test-helpers.js';
import { mapOwnedUserScope } from '../services/offboarding.js';

const detachedPrincipalId = '00000000-0000-4000-8000-000000000012';
const quoteRole = (role: string) => `"${role.replaceAll('"', '""')}"`;

async function applyGrantScript(
  database: pg.Pool, filename: string, variables: Record<string, string>,
): Promise<void> {
  const source = await readFile(join(process.cwd(), 'scripts', filename), 'utf8');
  const schema = String((await database.query('SELECT current_schema() AS schema')).rows[0].schema);
  let sql = source.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n').replaceAll(':"continuum_schema"', quoteRole(schema));
  for (const [name, value] of Object.entries(variables)) {
    sql = sql.replaceAll(':"' + name + '"', quoteRole(value));
    sql = sql.replaceAll(":'" + name + "'", "'" + value.replaceAll("'", "''") + "'");
  }
  await database.query(sql);
}

describe('issue 7 final remediation review 2 PostgreSQL proofs', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    if (!pool) {
      pool = await makeTestPool();
      await pool.query(await readFile(
        join(process.cwd(), 'migrations/0076_coordination_review_2_remediation.sql'), 'utf8',
      ));
    }
    await resetData(pool);
  }, 30_000);
  afterAll(async () => pool?.end());

  async function fixture(label: string) {
    const operator = await createPrincipal(pool, {
      externalId: `operator:${label}:${randomUUID()}`, kind: 'user', displayName: 'Operator',
    });
    const target = await createPrincipal(pool, {
      externalId: `target:${label}:${randomUUID()}`, kind: 'user', displayName: 'Target',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const owned = await createScope(pool, { kind: 'user', name: `${label}-owned-${randomUUID()}` });
    const shared = await createScope(pool, {
      kind: 'project', name: `${label}-shared-${randomUUID()}`,
    });
    await addMembership(pool, operator.id, org.id, 'admin');
    await addMembership(pool, target.id, owned.id, 'writer');
    await addMembership(pool, target.id, shared.id, 'writer');
    await mapOwnedUserScope(pool, operator, target.id, owned.id);
    return { operator, target, owned, shared };
  }

  async function makeIncomplete(value: Awaited<ReturnType<typeof fixture>>) {
    await pool.query('UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1', [
      value.target.id,
    ]);
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, completed_at)
       VALUES ($1, $2, 2, NULL)`, [value.target.id, detachedPrincipalId],
    );
    return String((await pool.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
       VALUES ($1, 'write', $2, jsonb_build_object(
         'operation', 'lock_inspect', 'request_id', gen_random_uuid())) RETURNING id`,
      [value.target.id, value.shared.id],
    )).rows[0].id);
  }

  it('keeps one principal scrub committed while another session holds detached usage', async () => {
    const first = await fixture('detached-first');
    const second = await fixture('detached-second');
    await makeIncomplete(first);
    const secondAuditId = await makeIncomplete(second);
    await pool.query(
      `INSERT INTO coordination_principal_usage (principal_id)
       VALUES ($1) ON CONFLICT (principal_id) DO NOTHING`, [detachedPrincipalId],
    );

    const firstSession = await pool.connect();
    const secondSession = await pool.connect();
    try {
      await firstSession.query('BEGIN');
      await firstSession.query("SET LOCAL continuum.client_coordination_privacy_version = '4'");
      const firstResult = await firstSession.query(
        `SELECT continuum_operator_scrub_coordination_principal($1, $2, $3, 10) AS result`,
        [first.operator.id, first.target.id, first.owned.id],
      );
      expect(firstResult.rows[0].result.progressed).toBe(true);

      await secondSession.query('BEGIN');
      await secondSession.query("SET LOCAL continuum.client_coordination_privacy_version = '4'");
      const secondResult = await secondSession.query(
        `SELECT continuum_operator_scrub_coordination_principal($1, $2, $3, 10) AS result`,
        [second.operator.id, second.target.id, second.owned.id],
      );
      expect(secondResult.rows[0].result).toMatchObject({ progressed: true, reason: null });
      await secondSession.query('COMMIT');

      expect((await pool.query(
        'SELECT metadata FROM audit_log WHERE id = $1', [secondAuditId],
      )).rows).toEqual([{ metadata: { operation: 'lock_inspect' } }]);
    } finally {
      await secondSession.query('ROLLBACK').catch(() => undefined);
      await firstSession.query('ROLLBACK').catch(() => undefined);
      secondSession.release();
      firstSession.release();
    }
  }, 30_000);

  it('refuses an unversioned runtime role before mutation with deterministic SQLSTATE', async () => {
    const value = await fixture('mixed-version');
    const auditId = await makeIncomplete(value);
    const role = `review_2_old_client_${Date.now()}`;
    await pool.query(`CREATE ROLE ${quoteRole(role)} NOLOGIN`);
    let runtime: pg.Pool | undefined;
    try {
      await applyGrantScript(pool, 'grant-application-role.sql', { continuum_app_role: role });
      await applyGrantScript(pool, 'grant-operator-role.sql', {
        continuum_operator_role: role, continuum_principal_id: value.operator.id,
      });
      await pool.query(
        `GRANT ${quoteRole(role)} TO CURRENT_USER
         WITH ADMIN OPTION, SET FALSE, INHERIT FALSE`,
      );
      const connectionString = (pool as unknown as { options: PoolConfig }).options.connectionString!;
      runtime = new pg.Pool({ connectionString, max: 1, options: `-c role=${role}` });
      await expect(runtime.query(
        `SELECT continuum_operator_scrub_coordination_principal($1, $2, $3, 10)`,
        [value.operator.id, value.target.id, value.owned.id],
      )).rejects.toMatchObject({ code: '0A000' });
      expect((await pool.query(
        `SELECT metadata ? 'request_id' AS raw_request,
                metadata->>'operation' AS operation
           FROM audit_log WHERE id = $1`, [auditId],
      )).rows).toEqual([{ raw_request: true, operation: 'lock_inspect' }]);

      await runtime.query('BEGIN');
      await runtime.query("SET LOCAL continuum.client_coordination_privacy_version = '4'");
      const accepted = await runtime.query(
        `SELECT continuum_operator_scrub_coordination_principal($1, $2, $3, 10) AS result`,
        [value.operator.id, value.target.id, value.owned.id],
      );
      await runtime.query('COMMIT');
      expect(accepted.rows[0].result.progressed).toBe(true);
      expect((await pool.query(
        `SELECT metadata ? 'request_id' AS raw_request FROM audit_log WHERE id = $1`,
        [auditId],
      )).rows).toEqual([{ raw_request: false }]);
    } finally {
      await runtime?.end();
      await pool.query(`DROP OWNED BY ${quoteRole(role)}`).catch(() => undefined);
      await pool.query(`REVOKE ${quoteRole(role)} FROM CURRENT_USER CASCADE`).catch(() => undefined);
      await pool.query(`DROP ROLE IF EXISTS ${quoteRole(role)}`).catch(() => undefined);
    }
  }, 30_000);

  it('uses the four-argument production function and repair index at a 50000-row deep cursor', async () => {
    const operator = await createPrincipal(pool, {
      externalId: `operator:deep:${randomUUID()}`, kind: 'user', displayName: 'Operator',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, operator.id, org.id, 'admin');
    const label = randomUUID();
    await pool.query(
      `INSERT INTO principals (id, external_id, kind, display_name, disabled_at)
       SELECT ('61000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $1 || ':' || n, 'user', 'Deep eligible', clock_timestamp()
         FROM generate_series(1, 50000) n`, [`deep:${label}`],
    );
    await pool.query(
      `INSERT INTO scopes (id, kind, name)
       SELECT ('62000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              'user', $1 || ':' || n FROM generate_series(1, 50000) n`, [`scope:${label}`],
    );
    await pool.query(
      `INSERT INTO principal_user_scopes
         (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
          acknowledged_evidence_hash)
       SELECT ('61000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              ('62000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $1, ARRAY[('61000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid],
              repeat('a', 64) FROM generate_series(1, 50000) n`, [operator.id],
    );
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, completed_at)
       SELECT ('61000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $1, 2, NULL FROM generate_series(1, 50000) n`, [detachedPrincipalId],
    );
    for (const table of [
      'principals', 'principal_user_scopes', 'coordination_principal_privacy_progress',
    ]) await pool.query(`ANALYZE ${table}`);

    await pool.query('SELECT pg_stat_force_next_flush()');
    const scansBefore = BigInt((await pool.query(
      `SELECT COALESCE(idx_scan, 0)::text AS scans FROM pg_stat_user_indexes
        WHERE schemaname = current_schema()
          AND indexrelname = 'coordination_privacy_repair_eligible_idx'`,
    )).rows[0]?.scans ?? '0');
    await pool.query('SET plan_cache_mode = force_generic_plan');
    await pool.query(
      `PREPARE review_2_deep(uuid, uuid, uuid, integer) AS
       SELECT * FROM continuum_operator_list_coordination_privacy_repairs($1, $2, $3, $4)`,
    );
    const cursor = '61000000-0000-4000-8000-00000000bf68';
    const explained = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       EXECUTE review_2_deep('${operator.id}'::uuid, '${cursor}'::uuid, NULL::uuid, 100)`,
    );
    const root = explained.rows[0]['QUERY PLAN'][0].Plan as Record<string, unknown>;
    const buffers = Number(root['Shared Hit Blocks'] ?? 0)
      + Number(root['Shared Read Blocks'] ?? 0);
    expect(root['Actual Rows']).toBe(100);
    expect(buffers).toBeLessThan(5_000);
    await pool.query('SELECT pg_stat_force_next_flush()');
    const scansAfter = BigInt((await pool.query(
      `SELECT COALESCE(idx_scan, 0)::text AS scans FROM pg_stat_user_indexes
        WHERE schemaname = current_schema()
          AND indexrelname = 'coordination_privacy_repair_eligible_idx'`,
    )).rows[0]?.scans ?? '0');
    expect(scansAfter).toBeGreaterThan(scansBefore);
    const page = await pool.query(
      `SELECT principal_id::text FROM continuum_operator_list_coordination_privacy_repairs(
         $1, $2, NULL, 100)`, [operator.id, cursor],
    );
    expect(page.rows[0].principal_id).toBe('61000000-0000-4000-8000-00000000bf69');
    expect(page.rows.at(-1).principal_id).toBe('61000000-0000-4000-8000-00000000bfcc');
  }, 120_000);

  it('keeps partial-0074 discovery available across a timed-out 0075 retry in a custom schema', async () => {
    const schema = `review_2_partial_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const connectionString = (pool as unknown as { options: PoolConfig }).options.connectionString!;
    const admin = new pg.Pool({ connectionString, max: 3 });
    const partialDirectory = await mkdtemp(join(tmpdir(), 'continuum-review-2-through-0074-'));
    const schemaPool = new pg.Pool({
      connectionString, max: 2, options: `-c search_path=${schema},public`,
    });
    const oldBatch = process.env.CONTINUUM_COORDINATION_V4_BACKFILL_BATCH_SIZE;
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const migrations = join(process.cwd(), 'migrations');
      for (const name of (await readdir(migrations)).filter(
        (name) => name.endsWith('.sql')
          && name <= '0074_coordination_compatibility_and_upgrade_repair.sql',
      )) await copyFile(join(migrations, name), join(partialDirectory, name));
      await runMigrations(schemaPool, partialDirectory);
      const operatorId = randomUUID();
      const targetId = randomUUID();
      const ownedId = randomUUID();
      await schemaPool.query(
        `INSERT INTO principals (id, external_id, kind, display_name, disabled_at) VALUES
         ($1, $2, 'user', 'Operator', NULL),
         ($3, $4, 'user', 'Target', clock_timestamp())`,
        [operatorId, `partial-operator:${operatorId}`, targetId, `partial-target:${targetId}`],
      );
      await schemaPool.query(
        `INSERT INTO scopes (id, kind, name) VALUES ($1, 'user', $2)`,
        [ownedId, `partial-owned:${ownedId}`],
      );
      await schemaPool.query(
        `INSERT INTO principal_user_scopes
           (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
            acknowledged_evidence_hash)
         VALUES ($1, $2, $3, ARRAY[$1::uuid], repeat('a', 64))`,
        [targetId, ownedId, operatorId],
      );
      await schemaPool.query(
        `INSERT INTO coordination_principal_privacy_progress
           (principal_id, detached_principal_id, privacy_version, completed_at)
         VALUES ($1, $2, 2, NULL)`, [targetId, detachedPrincipalId],
      );
      await schemaPool.query(
        `UPDATE coordination_principal_privacy_progress
            SET repair_eligible = NULL WHERE principal_id = $1`, [targetId],
      );
      expect((await schemaPool.query(
        `SELECT principal_id::text FROM continuum_coordination_privacy_repair_candidates(
           NULL, $1, 1)`, [targetId],
      )).rows).toEqual([{ principal_id: targetId }]);

      // Finish the concurrent index once without a blocker. Then replay the
      // unapplied backfill directive against the already-valid index so the
      // lock test measures the bounded backfill rather than CREATE INDEX's
      // old-snapshot wait.
      await copyFile(
        join(migrations, '0075_coordination_online_repair_finish.sql'),
        join(partialDirectory, '0075_coordination_online_repair_finish.sql'),
      );
      await runMigrations(schemaPool, partialDirectory);
      await schemaPool.query(
        `UPDATE coordination_principal_privacy_progress
            SET repair_eligible = NULL WHERE principal_id = $1`, [targetId],
      );
      await schemaPool.query(
        `UPDATE coordination_v4_backfill_state
            SET last_principal_id = NULL, completed = FALSE`,
      );
      await schemaPool.query(
        `DELETE FROM _continuum_migrations
          WHERE name = '0075_coordination_online_repair_finish.sql'`,
      );

      const blocker = await schemaPool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          `SELECT 1 FROM coordination_principal_privacy_progress
            WHERE principal_id = $1 FOR UPDATE`, [targetId],
        );
        process.env.CONTINUUM_COORDINATION_V4_BACKFILL_BATCH_SIZE = '8';
        await expect(runMigrations(schemaPool, join(process.cwd(), 'migrations')))
          .rejects.toThrow(/0075|lock|timeout/i);
        expect((await schemaPool.query(
          `SELECT principal_id::text FROM continuum_coordination_privacy_repair_candidates(
             NULL, $1, 1)`, [targetId],
        )).rows).toEqual([{ principal_id: targetId }]);
        expect((await schemaPool.query(
          `SELECT count(*)::int AS count FROM _continuum_migrations
            WHERE name = '0075_coordination_online_repair_finish.sql'`,
        )).rows).toEqual([{ count: 0 }]);
        await blocker.query('ROLLBACK');
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
      }
      await runMigrations(schemaPool, join(process.cwd(), 'migrations'));
      expect((await schemaPool.query(
        `SELECT repair_eligible FROM coordination_principal_privacy_progress
          WHERE principal_id = $1`, [targetId],
      )).rows).toEqual([{ repair_eligible: true }]);
      expect((await schemaPool.query(
        `SELECT name FROM _continuum_migrations
          WHERE name IN ('0075_coordination_online_repair_finish.sql',
                         '0076_coordination_review_2_remediation.sql',
                         '0077_coordination_review_2_online_finish.sql') ORDER BY name`,
      )).rows).toEqual([
        { name: '0075_coordination_online_repair_finish.sql' },
        { name: '0076_coordination_review_2_remediation.sql' },
        { name: '0077_coordination_review_2_online_finish.sql' },
      ]);
    } finally {
      if (oldBatch === undefined) delete process.env.CONTINUUM_COORDINATION_V4_BACKFILL_BATCH_SIZE;
      else process.env.CONTINUUM_COORDINATION_V4_BACKFILL_BATCH_SIZE = oldBatch;
      await schemaPool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await admin.end();
      await rm(partialDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it('repairs only owned non-extension Continuum CRLF functions in a shared schema', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const schema = `review_2_crlf_${suffix}`;
    const foreignRole = `review_2_crlf_owner_${suffix}`;
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const connectionString = (pool as unknown as { options: PoolConfig }).options.connectionString!;
    const admin = new pg.Pool({ connectionString, max: 2 });
    const schemaPool = new pg.Pool({
      connectionString, max: 1, options: `-c search_path=${schema},public`,
    });
    const through0064 = await mkdtemp(join(tmpdir(), 'continuum-review-2-crlf-'));
    let extensionMember = false;
    let extensionCreated = false;
    try {
      await admin.query(`CREATE SCHEMA ${quote(schema)}`);
      await admin.query(`CREATE ROLE ${quote(foreignRole)} NOLOGIN`);
      const migrations = join(process.cwd(), 'migrations');
      for (const name of (await readdir(migrations)).filter(
        (name) => name.endsWith('.sql')
          && name <= '0064_coordination_final_online_indexes.sql',
      )) await copyFile(join(migrations, name), join(through0064, name));
      await runMigrations(schemaPool, through0064);

      const continuumDefinition = String((await schemaPool.query(
        `SELECT pg_get_functiondef(
          'continuum_operator_scrub_coordination_principal(uuid,uuid,uuid,integer)'::regprocedure
        ) AS definition`,
      )).rows[0].definition).replaceAll(/(?<!\r)\n/g, '\r\n');
      await schemaPool.query(continuumDefinition);
      await schemaPool.query(
        `CREATE FUNCTION tenant_meaningful_cr() RETURNS text LANGUAGE sql
         AS $$ SELECT 'left${'\r'}right'::text $$`,
      );
      await schemaPool.query(
        `CREATE FUNCTION foreign_crlf() RETURNS integer LANGUAGE plpgsql
         AS $$ BEGIN${'\r\n'} RETURN 7;${'\r\n'}END $$`,
      );
      await schemaPool.query(
        `ALTER FUNCTION foreign_crlf() OWNER TO ${quote(foreignRole)}`,
      );
      await schemaPool.query(
        `CREATE FUNCTION continuum_extension_cr() RETURNS text LANGUAGE sql
         AS $$ SELECT 'extension${'\r'}member'::text $$`,
      );
      const existingExtension = await admin.query(
        `SELECT 1 FROM pg_extension WHERE extname = 'hstore'`,
      );
      if (!existingExtension.rowCount) {
        await admin.query(`CREATE EXTENSION hstore WITH SCHEMA ${quote(schema)}`);
        extensionCreated = true;
      }
      await admin.query(
        `ALTER EXTENSION hstore ADD FUNCTION ${quote(schema)}.continuum_extension_cr()`,
      );
      extensionMember = true;

      await runMigrations(schemaPool, join(process.cwd(), 'migrations'));
      expect((await schemaPool.query(
        `SELECT proname, position(chr(13) IN prosrc) > 0 AS raw_cr
           FROM pg_proc
          WHERE pronamespace = quote_ident(current_schema())::regnamespace
            AND proname IN (
              'continuum_operator_scrub_coordination_principal',
              'tenant_meaningful_cr', 'foreign_crlf', 'continuum_extension_cr')
          ORDER BY proname`,
      )).rows).toEqual([
        { proname: 'continuum_extension_cr', raw_cr: true },
        { proname: 'continuum_operator_scrub_coordination_principal', raw_cr: false },
        { proname: 'foreign_crlf', raw_cr: true },
        { proname: 'tenant_meaningful_cr', raw_cr: true },
      ]);
      expect((await schemaPool.query('SELECT tenant_meaningful_cr() AS value')).rows)
        .toEqual([{ value: `left${'\r'}right` }]);
    } finally {
      if (extensionMember) {
        await admin.query(
          `ALTER EXTENSION hstore DROP FUNCTION ${quote(schema)}.continuum_extension_cr()`,
        ).catch(() => undefined);
      }
      if (extensionCreated) {
        await admin.query('DROP EXTENSION hstore CASCADE').catch(() => undefined);
      }
      await schemaPool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${quote(foreignRole)}`).catch(() => undefined);
      await admin.end();
      await rm(through0064, { recursive: true, force: true });
    }
  }, 60_000);

  it('verifies sync-role retirement on a genuinely fresh isolated database', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const databaseName = `review_2_sync_${suffix}`;
    const roles = {
      old: `review_2_sync_old_${suffix}`,
      next: `review_2_sync_next_${suffix}`,
      application: `review_2_sync_app_${suffix}`,
      operator: `review_2_sync_operator_${suffix}`,
    };
    const base = (pool as unknown as { options: PoolConfig }).options;
    const maintenanceUrl = new URL(base.connectionString!);
    maintenanceUrl.pathname = '/postgres';
    const databaseUrl = new URL(base.connectionString!);
    databaseUrl.pathname = `/${databaseName}`;
    const maintenance = new pg.Pool({
      connectionString: maintenanceUrl.toString(), ssl: base.ssl, max: 1,
    });
    let fresh: pg.Pool | undefined;
    try {
      await maintenance.query(`CREATE DATABASE ${quoteRole(databaseName)} TEMPLATE template0`);
      fresh = new pg.Pool({ connectionString: databaseUrl.toString(), ssl: base.ssl, max: 2 });
      await runMigrations(fresh, join(process.cwd(), 'migrations'));
      for (const [name, login] of [
        [roles.old, true], [roles.next, true],
        [roles.application, false], [roles.operator, false],
      ] as const) {
        await fresh.query(`CREATE ROLE ${quoteRole(name)} ${login ? 'LOGIN' : 'NOLOGIN'}`);
      }
      const operatorId = randomUUID();
      const firstServiceId = randomUUID();
      const secondServiceId = randomUUID();
      await fresh.query(
        `INSERT INTO principals (id, external_id, kind, display_name) VALUES
         ($1, $2, 'user', 'Fresh operator'),
         ($3, $4, 'service', 'First sync'),
         ($5, $6, 'service', 'Second sync')`,
        [operatorId, `fresh-operator:${suffix}`, firstServiceId, `fresh-first:${suffix}`,
          secondServiceId, `fresh-second:${suffix}`],
      );
      await fresh.query(
        `INSERT INTO scope_memberships (principal_id, scope_id, role, active)
         VALUES ($1, continuum_org_scope_id(), 'admin', TRUE)`, [operatorId],
      );
      await applyGrantScript(fresh, 'grant-application-role.sql', {
        continuum_app_role: roles.application,
      });
      await applyGrantScript(fresh, 'grant-application-role.sql', {
        continuum_app_role: roles.operator,
      });
      await applyGrantScript(fresh, 'grant-operator-role.sql', {
        continuum_operator_role: roles.operator, continuum_principal_id: operatorId,
      });
      await fresh.query(
        `SELECT continuum_register_trusted_database_identity($1, $2, FALSE, TRUE)`,
        [roles.old, firstServiceId],
      );
      await fresh.query(
        `SELECT continuum_register_trusted_database_identity($1, $2, FALSE, TRUE)`,
        [roles.next, secondServiceId],
      );
      const oldOid = String((await fresh.query(
        `SELECT oid FROM pg_roles WHERE rolname = $1`, [roles.old],
      )).rows[0].oid);
      await applyGrantScript(fresh, 'retire-sync-role.sql', {
        continuum_schema: 'public', retired_sync_role: roles.old,
        confirm_retired_sync_role_oid: oldOid, confirm_legacy_unrecorded_sync_role: '',
      });
      await fresh.query(
        `GRANT ${quoteRole(roles.old)} TO CURRENT_USER
         WITH ADMIN OPTION, SET FALSE, INHERIT FALSE`,
      );
      await expect(applyGrantScript(fresh, 'verify-database-identities.sql', {
        continuum_schema: 'public', continuum_app_role: roles.application,
        continuum_sync_role: roles.next, continuum_operator_role: roles.operator,
        retired_sync_role: roles.old,
      })).resolves.toBeUndefined();
      expect((await fresh.query(
        `SELECT role.rolcanlogin, history.database_role_oid::text = role.oid::text AS oid_bound
           FROM continuum_retired_sync_database_identities history
           JOIN pg_roles role ON role.oid = history.database_role_oid
          WHERE history.database_role = $1::name`, [roles.old],
      )).rows).toEqual([{ rolcanlogin: false, oid_bound: true }]);
    } finally {
      await fresh?.end();
      await maintenance.query(
        `DROP DATABASE IF EXISTS ${quoteRole(databaseName)} WITH (FORCE)`,
      ).catch(() => undefined);
      for (const role of Object.values(roles)) {
        await maintenance.query(`REVOKE ${quoteRole(role)} FROM CURRENT_USER`)
          .catch(() => undefined);
      }
      for (const role of Object.values(roles).reverse()) {
        await maintenance.query(`DROP ROLE IF EXISTS ${quoteRole(role)}`)
          .catch(() => undefined);
      }
      await maintenance.end();
    }
  }, 60_000);

  it('makes a mapping added after legacy FALSE eligibility discoverable', async () => {
    const value = await fixture('mapping-change-operator');
    const target = await createPrincipal(pool, {
      externalId: `target:mapping-change:${randomUUID()}`,
      kind: 'user', displayName: 'Mapping target',
    });
    const owned = await createScope(pool, {
      kind: 'user', name: `mapping-change-owned-${randomUUID()}`,
    });
    await pool.query('UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1', [
      target.id,
    ]);
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, completed_at)
       VALUES ($1, $2, 2, NULL)`, [target.id, detachedPrincipalId],
    );
    await pool.query(
      `UPDATE coordination_principal_privacy_progress SET repair_eligible = FALSE
        WHERE principal_id = $1`, [target.id],
    );
    await pool.query(
      `INSERT INTO principal_user_scopes
         (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
          acknowledged_evidence_hash)
       VALUES ($1, $2, $3, ARRAY[$1::uuid], repeat('a', 64))`,
      [target.id, owned.id, value.operator.id],
    );
    expect((await pool.query(
      `SELECT repair_eligible FROM coordination_principal_privacy_progress
        WHERE principal_id = $1`, [target.id],
    )).rows).toEqual([{ repair_eligible: true }]);
    expect((await pool.query(
      `SELECT principal_id::text FROM continuum_coordination_privacy_repair_candidates(
         NULL, $1, 1)`, [target.id],
    )).rows).toEqual([{ principal_id: target.id }]);
  });
});
