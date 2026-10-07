import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from './migrator.js';

const DATABASE_URL =
  process.env.CONTINUUM_TEST_DATABASE_URL ??
  'postgres://continuum:continuum@localhost:5433/continuum';

const pools: pg.Pool[] = [];
const directories: string[] = [];

async function migrationDirectory(sql: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-migrator-'));
  directories.push(directory);
  await writeFile(join(directory, '001_test.sql'), sql);
  return directory;
}

function schemaPool(schema: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    max: 1,
    options: `-c search_path=${schema},public`,
  });
  pools.push(pool);
  return pool;
}

async function grantApplicationRole(
  pool: pg.Pool,
  schema: string,
  role: string,
): Promise<void> {
  const source = await readFile(
    join(process.cwd(), 'scripts/grant-application-role.sql'), 'utf8',
  );
  const sql = source.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n')
    .replaceAll(':"continuum_schema"', `"${schema}"`)
    .replaceAll(':"continuum_app_role"', `"${role}"`)
    .replaceAll(":'continuum_app_role'", `'${role}'`);
  await pool.query(sql);
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('runMigrations', () => {
  it('ships coordination tables and review repair as ordinary transactional migrations', async () => {
    const files = (await readdir(join(process.cwd(), 'migrations')))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(files.slice(-12)).toEqual([
      '0054_coordination_leases.sql',
      '0055_coordination_review_remediation.sql',
      '0056_coordination_final_remediation.sql',
      '0057_coordination_privacy_race_remediation.sql',
      '0058_coordination_online_prep.sql',
      '0059_coordination_bounded_privacy.sql',
      '0060_coordination_online_finish.sql',
      '0061_coordination_forward_security_repair.sql',
      '0062_coordination_forward_online_finish.sql',
      '0063_coordination_final_privacy_repair.sql',
      '0064_coordination_final_online_indexes.sql',
      '0065_coordination_review_remediation.sql',
    ]);
    const migration = await readFile(
      join(process.cwd(), 'migrations/0054_coordination_leases.sql'),
      'utf8',
    );
    expect(migration.trimStart()).not.toMatch(/^-- continuum:no-transaction/);
    for (const table of [
      'coordination_resources', 'coordination_leases',
      'coordination_operation_receipts', 'coordination_scope_usage',
      'coordination_principal_usage',
    ]) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
    }
    expect(migration).toMatch(/DEFERRABLE INITIALLY DEFERRED/);
    expect(migration).toMatch(/fencing_token\s+BIGINT/);
  });

  it('reopens a 0064-complete offboarding and re-scrubs lock audit under the narrowed rule', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const schema = `coordination_v1_rescrub_${suffix}`;
    const role = `coordination_v1_operator_${suffix}`;
    const quotedRole = `"${role}"`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE ROLE ${quotedRole} NOLOGIN`);
    const pool = schemaPool(schema);
    const before = await mkdtemp(join(tmpdir(), 'continuum-before-0065-'));
    directories.push(before);
    const source = new URL('../../migrations/', import.meta.url);
    const files = (await readdir(source)).filter((name) => name.endsWith('.sql')).sort();
    await Promise.all(files
      .filter((name) => name <= '0064_coordination_final_online_indexes.sql')
      .map((name) => copyFile(new URL(name, source), join(before, name))));
    try {
      await runMigrations(pool, before);
      const operatorId = randomUUID();
      const targetId = randomUUID();
      const ownedId = randomUUID();
      const sharedId = randomUUID();
      const auditRequestId = randomUUID();
      const auditRunId = randomUUID();
      await pool.query(
        `INSERT INTO principals (id, external_id, kind, display_name) VALUES
         ($1, $2, 'user', 'Upgrade operator'),
         ($3, $4, 'user', 'Upgrade target')`,
        [operatorId, `operator:${suffix}`, targetId, `target:${suffix}`],
      );
      await pool.query(
        `INSERT INTO scopes (id, kind, name) VALUES
         ($1, 'user', $2), ($3, 'project', $4)`,
        [ownedId, `owned-${suffix}`, sharedId, `shared-${suffix}`],
      );
      await pool.query(
        `INSERT INTO scope_memberships (principal_id, scope_id, role, active) VALUES
         ($1, continuum_org_scope_id(), 'admin', TRUE),
         ($2, $3, 'writer', FALSE), ($2, $4, 'writer', FALSE)`,
        [operatorId, targetId, ownedId, sharedId],
      );
      await pool.query(
        `INSERT INTO principal_user_scopes
           (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
            acknowledged_evidence_hash)
         VALUES ($1, $2, $3, '{}'::uuid[], repeat('a', 64))`,
        [targetId, ownedId, operatorId],
      );
      const auditId = String((await pool.query(
        `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
         VALUES ($1, 'write', $2, jsonb_build_object(
           'operation', 'lock_acquire', 'outcome', 'acquired',
           'request_id', $3::uuid, 'run_id', $4::uuid,
           'lease_id', gen_random_uuid(), 'fencing_token', '8',
           'resource_bytes', 12, 'transport', 'rest', 'own_lease', TRUE,
           'resource_sha256', repeat('c', 64))) RETURNING id`,
        [targetId, sharedId, auditRequestId, auditRunId],
      )).rows[0].id);
      await pool.query(
        `UPDATE audit_log
            SET metadata = continuum_offboarding_expected_audit_metadata(metadata)
          WHERE id = $1`, [auditId],
      );
      await pool.query(
        `UPDATE principals SET disabled_at = clock_timestamp(),
                offboarded_at = clock_timestamp(),
                display_name = 'erased-' || left(replace(id::text, '-', ''), 12)
          WHERE id = $1`, [targetId],
      );
      await pool.query(
        `UPDATE scopes SET name = 'erased-user-' || id::text WHERE id = $1`, [ownedId],
      );
      const approvalId = String((await pool.query(
        `INSERT INTO principal_user_scope_approvals
           (principal_id, scope_id, approved_by, acknowledged_principal_ids,
            acknowledged_evidence_hash)
         VALUES ($1, $2, $3, '{}'::uuid[], repeat('a', 64)) RETURNING id`,
        [targetId, ownedId, operatorId],
      )).rows[0].id);
      const completedRunId = String((await pool.query(
        `INSERT INTO principal_offboarding_runs
           (principal_id, scope_id, initiated_by, approval_id,
            initial_memories, initial_embeddings, initial_memberships,
            initial_aliases, initial_entra_bindings, initial_audit_rows,
            initial_audit_queries, approval_evidence_hash,
            initial_count_truncated, audit_fence_id, audit_memory_complete,
            audit_linked_request_exhausted, audit_linked_complete,
            memory_complete, scope_cleanup_complete, completed_at)
         VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 0, 1, 0, repeat('a', 64),
                 '{}'::text[], $5, TRUE, TRUE, TRUE, TRUE, TRUE, clock_timestamp())
         RETURNING run_id`,
        [targetId, ownedId, operatorId, approvalId, auditId],
      )).rows[0].run_id);
      await pool.query(
        `INSERT INTO coordination_principal_privacy_progress
           (principal_id, detached_principal_id, privacy_version, audit_cursor_id,
            completed_at)
         VALUES ($1, '00000000-0000-4000-8000-000000000012', 2, $2,
                 clock_timestamp())`,
        [targetId, auditId],
      );
      expect((await pool.query(
        'SELECT continuum_offboarding_actual_state_is_erased($1::uuid) AS erased',
        [completedRunId],
      )).rows).toEqual([{ erased: true }]);
      await pool.query(
        'SELECT continuum_register_trusted_database_identity($1::name, $2, TRUE, FALSE)',
        [role, operatorId],
      );
      await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${quotedRole}`);
      await pool.query(
        `GRANT EXECUTE ON FUNCTION continuum_operator_scrub_coordination_principal(
           UUID, UUID, UUID, INTEGER
         ) TO ${quotedRole}`,
      );
      await admin.query(
        `GRANT ${quotedRole} TO CURRENT_USER WITH ADMIN OPTION, SET FALSE, INHERIT FALSE`,
      );

      await runMigrations(pool, join(process.cwd(), 'migrations'));
      expect((await pool.query(
        `SELECT privacy_version, completed_at IS NULL AS reopened,
                audit_cursor_id::text AS audit_cursor_id
           FROM coordination_principal_privacy_progress WHERE principal_id = $1`,
        [targetId],
      )).rows).toEqual([{ privacy_version: 2, reopened: true, audit_cursor_id: '0' }]);
      expect((await pool.query(
        'SELECT continuum_offboarding_actual_state_is_erased($1::uuid) AS erased',
        [completedRunId],
      )).rows).toEqual([{ erased: false }]);
      const rolePool = new pg.Pool({
        connectionString: DATABASE_URL,
        max: 1,
        options: `-c search_path=${schema},public -c role=${role}`,
      });
      pools.push(rolePool);
      await expect(rolePool.query(
        `SELECT continuum_operator_scrub_coordination_principal($1, $2, $3, 1)`,
        [operatorId, targetId, ownedId],
      )).resolves.toBeDefined();
      expect((await pool.query(
        'SELECT metadata FROM audit_log WHERE id = $1', [auditId],
      )).rows).toEqual([{ metadata: {
        operation: 'lock_acquire', outcome: 'acquired', fencing_token: '8',
        resource_bytes: 12, transport: 'rest', own_lease: true,
      } }]);
      expect((await pool.query(
        'SELECT continuum_offboarding_actual_state_is_erased($1::uuid) AS erased',
        [completedRunId],
      )).rows).toEqual([{ erased: true }]);
    } finally {
      await admin.query(`REVOKE ${quotedRole} FROM CURRENT_USER`).catch(() => undefined);
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${quotedRole}`).catch(() => undefined);
    }
  }, 60_000);

  it('profiles coordination grants against the configured custom schema', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const schema = `coordination_custom_${suffix}`;
    const role = `coordination_custom_app_${suffix}`;
    const quotedRole = `"${role}"`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE ROLE ${quotedRole} NOLOGIN`);
    const pool = schemaPool(schema);
    try {
      await runMigrations(pool, join(process.cwd(), 'migrations'));
      await grantApplicationRole(pool, schema, role);
      await expect(pool.query(
        'SELECT continuum_assert_application_role_allowlist($1::name)', [role],
      )).resolves.toBeDefined();
      const privileges = await pool.query(
        `SELECT
           has_table_privilege($1, format('%I.coordination_scope_usage', $2::text), 'UPDATE')
             AS scope_update,
           has_table_privilege($1, format('%I.coordination_principal_usage', $2::text), 'UPDATE')
             AS principal_update,
           has_table_privilege($1, format('%I.coordination_scope_fencing_floors', $2::text), 'SELECT')
             AS floor_select,
           has_function_privilege($1,
             format('%I.continuum_coordination_scope_fencing_floor(uuid)', $2::text), 'EXECUTE')
             AS floor_execute`,
        [role, schema],
      );
      expect(privileges.rows[0]).toEqual({
        scope_update: false,
        principal_update: false,
        floor_select: false,
        floor_execute: true,
      });
    } finally {
      await admin.query(`DROP OWNED BY ${quotedRole}`);
      await admin.query(`DROP ROLE ${quotedRole}`);
    }
  }, 30_000);

  it('pins the published 0052 bytes and rejects a modified ledgered copy', async () => {
    const published = await readFile(
      join(process.cwd(), 'migrations/0052_offboarding_review_repair.sql'), 'utf8',
    );
    expect(createHash('sha256').update(published).digest('hex')).toBe(
      '136cbd834277ca4fbfb48162644738ba2f96f7a5705290cc0c585e3ce7c82079',
    );

    const directory = await mkdtemp(join(tmpdir(), 'continuum-published-migration-'));
    directories.push(directory);
    await writeFile(
      join(directory, '0052_offboarding_review_repair.sql'),
      published + '\n-- modified after publication\n',
    );
    await writeFile(join(directory, '0053_offboarding_restore_contract.sql'), 'SELECT 1;\n');
    const schema = `migrator_published_checksum_${Date.now()}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    await pool.query(`
      CREATE TABLE _continuum_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO _continuum_migrations (name)
      VALUES ('0052_offboarding_review_repair.sql');
    `);

    await expect(runMigrations(pool, directory)).rejects.toThrow(
      /0052.*checksum|published migration.*modified/i,
    );
  });

  it('accepts Git CRLF conversion of ledgered 0052 without accepting substantive changes', async () => {
    const published = await readFile(
      join(process.cwd(), 'migrations/0052_offboarding_review_repair.sql'), 'utf8',
    );
    const windowsCheckout = published.replaceAll('\n', '\r\n');
    const directory = await mkdtemp(join(tmpdir(), 'continuum-published-migration-crlf-'));
    directories.push(directory);
    await writeFile(join(directory, '0052_offboarding_review_repair.sql'), windowsCheckout);
    await writeFile(
      join(directory, '0053_offboarding_restore_contract.sql'),
      'CREATE TABLE continuum_crlf_checksum_probe (applied boolean NOT NULL);\r\n',
    );
    const schema = `migrator_published_checksum_crlf_${Date.now()}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    await pool.query(`
      CREATE TABLE _continuum_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO _continuum_migrations (name)
      VALUES ('0052_offboarding_review_repair.sql');
    `);

    await expect(runMigrations(pool, directory)).resolves.toEqual([
      expect.objectContaining({ name: '0053_offboarding_restore_contract.sql' }),
    ]);

    const invalidCheckouts = [
      windowsCheckout.replace('\r\n', '\r'),
      windowsCheckout.replace('\r\n', '\r\r\n'),
      windowsCheckout.replace('Forward-only', 'Forward\r-only'),
      windowsCheckout + '-- substantive change\r\n',
    ];
    for (const invalidCheckout of invalidCheckouts) {
      await writeFile(
        join(directory, '0052_offboarding_review_repair.sql'),
        invalidCheckout,
      );
      await expect(runMigrations(pool, directory)).rejects.toThrow(
        /0052.*checksum|published migration.*modified/i,
      );
    }
  });

  it('applies 0053 when the published 0052 is already ledgered', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-forward-0053-'));
    directories.push(directory);
    await copyFile(
      join(process.cwd(), 'migrations/0052_offboarding_review_repair.sql'),
      join(directory, '0052_offboarding_review_repair.sql'),
    );
    await writeFile(
      join(directory, '0053_offboarding_restore_contract.sql'),
      `CREATE TABLE continuum_0053_forward_probe (applied boolean NOT NULL);\n`,
    );
    const schema = `migrator_forward_0053_${Date.now()}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    await pool.query(`
      CREATE TABLE _continuum_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO _continuum_migrations (name)
      VALUES ('0052_offboarding_review_repair.sql');
    `);

    await expect(runMigrations(pool, directory)).resolves.toEqual([
      expect.objectContaining({ name: '0053_offboarding_restore_contract.sql' }),
    ]);
    expect((await pool.query(
      `SELECT namespace.nspname AS schema
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid = format('%I.continuum_0053_forward_probe', current_schema())::regclass`,
    )).rows[0]).toEqual({ schema });
  });

  it('refuses to apply 0053 before 0052 is ledgered', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-forward-0053-prerequisite-'));
    directories.push(directory);
    await writeFile(
      join(directory, '0053_offboarding_restore_contract.sql'),
      'SELECT 1;\n',
    );
    const schema = `migrator_forward_0053_prerequisite_${Date.now()}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);

    await expect(runMigrations(pool, directory)).rejects.toThrow(
      /0053.*requires.*0052|0052.*prerequisite/i,
    );
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM _continuum_migrations`,
    )).rows[0]).toEqual({ count: 0 });
  });

  it('keeps the principal alter short and builds offboarding audit indexes concurrently', async () => {
    const migrations = join(process.cwd(), 'migrations');
    const principal = await readFile(
      join(migrations, '0022_offboarding_principal_lifecycle.sql'), 'utf8',
    );
    const erasure = await readFile(join(migrations, '0023_offboarding_erasure.sql'), 'utf8');
    const indexes = await readFile(join(migrations, '0025_offboarding_audit_indexes.sql'), 'utf8');

    expect(principal).toMatch(/ALTER TABLE principals/i);
    expect(principal).not.toMatch(/CREATE TABLE|CREATE INDEX|CREATE FUNCTION/i);
    expect(erasure).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!principal_offboarding_events)/i);
    expect(indexes.trimStart()).toMatch(/^-- continuum:no-transaction/);
    expect(indexes.match(/continuum:repair-invalid-index/gi)).toHaveLength(5);
    expect(indexes.match(/CREATE INDEX CONCURRENTLY/gi)).toHaveLength(5);
    expect(indexes.match(/continuum:require-valid-index/gi)).toHaveLength(5);
  });
  it('keeps selector installation short and makes backfill and indexes retry-safe', async () => {
    const migrations = join(process.cwd(), 'migrations');
    const selectors = await readFile(
      join(migrations, '0033_offboarding_bounded_selectors.sql'), 'utf8',
    );
    const selectorIndexes = await readFile(
      join(migrations, '0035_offboarding_selector_cursor_indexes.sql'), 'utf8',
    );

    expect(selectors).toMatch(/audit_log_offboarding_backfill_state/i);
    expect(selectors).toMatch(/continuum_backfill_audit_offboarding_scopes\s*\(/i);
    expect(selectors).not.toMatch(
      /INSERT INTO audit_log_offboarding_scopes[\s\S]*FROM audit_log audit[\s\S]*ON CONFLICT DO NOTHING/i,
    );
    expect(selectorIndexes.trimStart()).toMatch(/^-- continuum:no-transaction/);
    expect(selectorIndexes).toMatch(/continuum:backfill-offboarding-selectors/i);
    expect(selectorIndexes.match(/CREATE INDEX CONCURRENTLY/gi)).toHaveLength(2);
    expect(selectorIndexes.match(/continuum:require-valid-index/gi)).toHaveLength(2);
  });
  it('hardens round-six offboarding without a caller-spoofable reactivation GUC', async () => {
    const hardening = await readFile(
      join(process.cwd(), 'migrations/0027_offboarding_bounded_completion.sql'), 'utf8',
    );
    expect(hardening).toMatch(/ADD COLUMN audit_fence_id BIGINT/i);
    expect(hardening).toMatch(/SECURITY DEFINER/i);
    expect(hardening).not.toMatch(/current_setting|set_config/i);
    const authorization = await readFile(
      join(process.cwd(), 'migrations/0028_offboarding_reactivation_authorization.sql'), 'utf8',
    );
    expect(authorization).toMatch(/continuum_membership_is_effective/i);
    expect(authorization).toMatch(/principal_reactivated/i);
    expect(authorization).toMatch(/SECURITY DEFINER/i);
    const trustBoundary = await readFile(
      join(process.cwd(), 'migrations/0029_offboarding_reactivation_trust_boundary.sql'), 'utf8',
    );
    expect(trustBoundary).toMatch(
      /REVOKE ALL ON FUNCTION continuum_reactivate_principal\(UUID, UUID\) FROM PUBLIC/i,
    );
    expect(trustBoundary).toMatch(/principal_reactivation_guarded/i);
    expect(trustBoundary).toMatch(/00000000-0000-4000-8000-000000000011/i);
  });
  it('ships one bounded final verification path and names the exact rollout migration', async () => {
    const migration = await readFile(
      join(process.cwd(), 'migrations/0042_offboarding_final_remediation.sql'), 'utf8',
    );
    const completion = migration.match(
      /CREATE OR REPLACE FUNCTION continuum_complete_offboarding_run[\s\S]*?\n\$\$;/i,
    )?.[0] ?? '';
    const completionTrigger = migration.match(
      /CREATE OR REPLACE FUNCTION continuum_require_actual_offboarding_erasure[\s\S]*?\n\$\$;/i,
    )?.[0] ?? '';
    expect(completion).not.toMatch(/continuum_offboarding_actual_state_is_erased\s*\(/i);
    expect(completionTrigger.match(/continuum_offboarding_actual_state_is_erased\s*\(/gi))
      .toHaveLength(1);
    const docs = await readFile(join(process.cwd(), 'docs/offboarding.md'), 'utf8');
    expect(docs).toMatch(/through[\s\S]*`0053_offboarding_restore_contract\.sql`/i);
    expect(docs).not.toMatch(/all nineteen offboarding migrations/i);
  });
  it('applies round-seven integrity and online cursor-index migrations from a fresh schema', async () => {
    const schema = `migrator_offboarding_round7_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    try {
      await pool.query(`
        CREATE FUNCTION vendor_shared_guard() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
        BEGIN RETURN NEW; END;
        $$;
      `);
      const applied = await runMigrations(pool, join(process.cwd(), 'migrations'));
      expect(applied.slice(-36).map((migration) => migration.name)).toEqual([
        '0030_offboarding_round7_integrity.sql',
        '0031_offboarding_round7_indexes.sql',
        '0032_offboarding_round7_compatibility.sql',
        '0033_offboarding_bounded_selectors.sql',
        '0034_offboarding_completion_invariants.sql',
        '0035_offboarding_selector_cursor_indexes.sql',
        '0036_offboarding_round8_upgrade.sql',
        '0037_offboarding_round8_online_finish.sql',
        '0038_offboarding_search_path_hardening.sql',
        '0039_offboarding_completion_state.sql',
        '0040_offboarding_post_completion_integrity.sql',
        '0041_offboarding_completion_trust.sql',
        '0042_offboarding_final_remediation.sql',
        '0043_audit_retention_selection_order.sql',
        '0044_offboarding_restart_evidence.sql',
        '0045_offboarding_trust_boundary.sql',
        '0046_offboarding_authority_remediation.sql',
        '0047_offboarding_role_boundary.sql',
        '0048_offboarding_independent_review.sql',
        '0049_offboarding_review_remediation.sql',
        '0050_offboarding_startup_verification_fix.sql',
        '0051_offboarding_security_contract.sql',
        '0052_offboarding_review_repair.sql',
        '0053_offboarding_restore_contract.sql',
        '0054_coordination_leases.sql',
        '0055_coordination_review_remediation.sql',
        '0056_coordination_final_remediation.sql',
        '0057_coordination_privacy_race_remediation.sql',
        '0058_coordination_online_prep.sql',
        '0059_coordination_bounded_privacy.sql',
        '0060_coordination_online_finish.sql',
        '0061_coordination_forward_security_repair.sql',
        '0062_coordination_forward_online_finish.sql',
        '0063_coordination_final_privacy_repair.sql',
        '0064_coordination_final_online_indexes.sql',
        '0065_coordination_review_remediation.sql',
      ]);
      expect((await pool.query(
        `SELECT disabled_at IS NOT NULL AS disabled FROM principals
          WHERE id = '00000000-0000-4000-8000-000000000012'`,
      )).rows).toEqual([{ disabled: true }]);
      expect((await pool.query(
        `SELECT indisvalid AS valid FROM pg_index
          WHERE indexrelid = 'memories_scope_id_cursor_idx'::regclass`,
      )).rows).toEqual([{ valid: true }]);
      expect((await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'principal_offboarding_runs'
            AND column_name IN (
              'audit_memory_key_cursor', 'audit_linked_request_cursor',
              'audit_linked_complete'
            ) ORDER BY column_name`,
      )).rows.map((row) => row.column_name)).toEqual([
        'audit_linked_complete', 'audit_linked_request_cursor', 'audit_memory_key_cursor',
      ]);
      expect((await pool.query(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'audit_log_offboarding_scopes_pkey'`,
      )).rows[0].indexdef).toMatch(/selector_kind, scope_id, audit_id/i);
      expect((await pool.query(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname IN (
              'audit_log_offboarding_memory_cursor_idx',
              'audit_log_offboarding_scope_ids_cursor_idx'
            ) ORDER BY indexname`,
      )).rows.map((row) => row.indexname)).toEqual([
        'audit_log_offboarding_memory_cursor_idx',
        'audit_log_offboarding_scope_ids_cursor_idx',
      ]);
      expect((await pool.query(
        `SELECT proname, proconfig
           FROM pg_proc
          WHERE pronamespace = current_schema()::regnamespace
            AND proname IN (
              'continuum_complete_offboarding_run',
              'continuum_guard_offboarding_run_progress',
              'continuum_guard_principal_reactivation',
              'continuum_reject_offboarded_principal_audit',
              'continuum_require_embeddable_memory',
              'continuum_reactivate_principal'
            ) ORDER BY proname`,
      )).rows).toEqual([
        expect.objectContaining({
          proname: 'continuum_complete_offboarding_run',
          proconfig: [`search_path=pg_catalog, ${schema}, pg_temp`],
        }),
        expect.objectContaining({
          proname: 'continuum_guard_offboarding_run_progress',
          proconfig: [`search_path=pg_catalog, ${schema}, pg_temp`],
        }),
        expect.objectContaining({
          proname: 'continuum_guard_principal_reactivation',
          proconfig: [`search_path=pg_catalog, ${schema}, pg_temp`],
        }),
        expect.objectContaining({
          proname: 'continuum_reactivate_principal',
          proconfig: [`search_path=pg_catalog, ${schema}, pg_temp`],
        }),
        expect.objectContaining({
          proname: 'continuum_reject_offboarded_principal_audit',
          proconfig: [`search_path=pg_catalog, ${schema}, pg_temp`],
        }),
        expect.objectContaining({
          proname: 'continuum_require_embeddable_memory',
          proconfig: [`search_path=pg_catalog, ${schema}, pg_temp`],
        }),
      ]);
      expect((await pool.query(
        `SELECT proname
           FROM pg_proc
          WHERE pronamespace = current_schema()::regnamespace
            AND (proname LIKE 'continuum\\_%' ESCAPE '\\'
                 OR proname = 'reject_lifecycle_principal_membership')
            AND proowner = current_user::regrole
            AND NOT (proconfig @> ARRAY[
              format('search_path=pg_catalog, %s, pg_temp', current_schema())
            ])
          ORDER BY proname`,
      )).rows).toEqual([]);
      expect((await pool.query(
        `SELECT proconfig FROM pg_proc
          WHERE pronamespace = current_schema()::regnamespace
            AND proname = 'vendor_shared_guard'`,
      )).rows).toEqual([{ proconfig: ['search_path=public'] }]);
      expect(await runMigrations(pool, join(process.cwd(), 'migrations'))).toEqual([]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  }, 60_000);
  it('fails closed when a foreign owner leaves a Continuum definer unsafe', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const schema = `migrator_foreign_owner_${suffix}`;
    const role = `continuum_foreign_owner_${suffix}`;
    const quotedRole = `"${role}"`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE ROLE ${quotedRole} NOLOGIN`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const directory = await mkdtemp(join(tmpdir(), 'continuum-foreign-owner-'));
    directories.push(directory);
    const source = new URL('../../migrations/', import.meta.url);
    const files = (await readdir(source)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files.filter((name) => name < '0042_offboarding_final_remediation.sql')) {
      await copyFile(new URL(file, source), join(directory, file));
    }
    try {
      await runMigrations(pool, directory);
      await pool.query(
        `CREATE FUNCTION continuum_foreign_unsafe() RETURNS boolean
         LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT TRUE $$`,
      );
      await pool.query(`ALTER FUNCTION continuum_foreign_unsafe() OWNER TO ${quotedRole}`);
      await copyFile(
        new URL('0042_offboarding_final_remediation.sql', source),
        join(directory, '0042_offboarding_final_remediation.sql'),
      );
      await expect(runMigrations(pool, directory)).rejects.toThrow(/foreign-owned.*unsafe/i);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`DROP ROLE ${quotedRole}`);
    }
  }, 60_000);
  it('rejects canonical audit-evidence tampering by the application role', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const schema = `migrator_audit_tamper_${suffix}`;
    const role = `continuum_audit_tamper_${suffix}`;
    const quotedRole = `"${role}"`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    let rolePool: pg.Pool | undefined;
    let roleCreated = false;
    try {
      await runMigrations(pool, join(process.cwd(), 'migrations'));
      const tombstoneGuardSource = (await pool.query(
        `SELECT prosrc FROM pg_proc
          WHERE oid = 'continuum_protect_offboarded_audit_tombstone()'::regprocedure`,
      )).rows[0].prosrc as string;
      expect(tombstoneGuardSource).toMatch(
        /continuum_offboarding_expected_audit_metadata\(OLD\.metadata\)/,
      );
      expect(tombstoneGuardSource).not.toMatch(
        /continuum_offboarding_expected_audit_metadata\(NEW\.metadata\)/,
      );
      const targetId = (await pool.query(
        `INSERT INTO principals
           (id, external_id, kind, display_name)
         VALUES
           (gen_random_uuid(), 'audit-tamper-target', 'user', 'Audit tamper target')
         RETURNING id`,
      )).rows[0].id as string;
      const auditRows = await pool.query(
        `INSERT INTO audit_log (principal_id, action, query, metadata)
         VALUES
           ($1::uuid, 'archive', NULL,
            jsonb_build_object('operation', 'principal_offboarded',
                               'principal_id', $1::text,
                               'approval_id', 7,
                               'acknowledged_evidence_hash', repeat('a', 64),
                               'memories', 0, 'audit_rows', 0, 'batches', 1)),
           ($1::uuid, 'read', NULL, '{"redacted":"principal_offboarding"}'::jsonb)
         RETURNING id`,
        [targetId],
      );
      await pool.query(
        `UPDATE principals
            SET display_name = 'erased-' || left(replace(id::text, '-', ''), 12),
                disabled_at = now(), offboarded_at = now()
          WHERE id = $1`,
        [targetId],
      );
      await pool.query(`CREATE ROLE ${quotedRole} NOLOGIN`);
      roleCreated = true;
      await pool.query(`GRANT ${quotedRole} TO CURRENT_USER`);
      await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${quotedRole}`);
      await pool.query(`GRANT SELECT, UPDATE ON ${schema}.audit_log TO ${quotedRole}`);
      rolePool = new pg.Pool({
        connectionString: DATABASE_URL,
        max: 1,
        options: `-c search_path=${schema} -c role=${role}`,
      });

      await expect(rolePool.query(
        `UPDATE audit_log
            SET metadata = jsonb_set(metadata, '{approval_id}', '999'::jsonb)
          WHERE id = $1`,
        [auditRows.rows[0].id],
      )).rejects.toThrow(/preserved offboarding audit evidence is immutable/i);
      await expect(rolePool.query(
        `UPDATE audit_log SET metadata = $2::jsonb WHERE id = $1`,
        [auditRows.rows[1].id, JSON.stringify({
          operation: 'service_principal_provisioned',
          service_principal_id: '00000000-0000-4000-8000-000000000099',
          external_id: 'restored@example.test',
        })],
      )).rejects.toThrow(/offboarded audit tombstone is immutable/i);
    } finally {
      await rolePool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (roleCreated) {
        await admin.query(`REVOKE ${quotedRole} FROM CURRENT_USER`);
        await admin.query(`DROP ROLE ${quotedRole}`);
      }
    }
  }, 60_000);
  it('applies completion and integrity hardening after ledgered 0038 and 0039', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const schema = `migrator_offboarding_0039_${suffix}`;
    const role = `continuum_upgrade_app_${suffix}`;
    const quotedRole = `"${role}"`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    let rolePool: pg.Pool | undefined;
    let roleCreated = false;
    const directory = await mkdtemp(join(tmpdir(), 'continuum-offboarding-0039-'));
    directories.push(directory);
    const source = new URL('../../migrations/', import.meta.url);
    const files = (await readdir(source)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files.filter((name) =>
      name !== '0039_offboarding_completion_state.sql'
      && name !== '0040_offboarding_post_completion_integrity.sql'
      && name !== '0041_offboarding_completion_trust.sql'
      && name !== '0042_offboarding_final_remediation.sql'
      && name !== '0043_audit_retention_selection_order.sql'
      && name !== '0044_offboarding_restart_evidence.sql'
      && name !== '0045_offboarding_trust_boundary.sql'
      && name !== '0046_offboarding_authority_remediation.sql'
      && name !== '0047_offboarding_role_boundary.sql'
      && name !== '0048_offboarding_independent_review.sql'
      && name !== '0049_offboarding_review_remediation.sql'
      && name !== '0050_offboarding_startup_verification_fix.sql'
      && name !== '0051_offboarding_security_contract.sql'
      && name !== '0052_offboarding_review_repair.sql'
      && name !== '0053_offboarding_restore_contract.sql'
      && name !== '0054_coordination_leases.sql'
      && name !== '0055_coordination_review_remediation.sql'
      && name !== '0056_coordination_final_remediation.sql'
      && name !== '0057_coordination_privacy_race_remediation.sql'
      && name !== '0058_coordination_online_prep.sql'
      && name !== '0059_coordination_bounded_privacy.sql'
      && name !== '0060_coordination_online_finish.sql'
      && name !== '0061_coordination_forward_security_repair.sql'
      && name !== '0062_coordination_forward_online_finish.sql'
      && name !== '0063_coordination_final_privacy_repair.sql'
      && name !== '0064_coordination_final_online_indexes.sql'
      && name !== '0065_coordination_review_remediation.sql')) {
      if (file === '0038_offboarding_search_path_hardening.sql') {
        await copyFile(
          new URL(
            'fixtures/7499ada-0038_offboarding_search_path_hardening.sql',
            import.meta.url,
          ),
          join(directory, file),
        );
      } else {
        await copyFile(new URL(file, source), join(directory, file));
      }
    }
    try {
      const oldApplied = await runMigrations(pool, directory);
      expect(oldApplied.at(-1)?.name).toBe('0038_offboarding_search_path_hardening.sql');
      const orgScopeId = (await pool.query(
        `SELECT id FROM scopes WHERE kind = 'org' AND name = ''`,
      )).rows[0].id as string;
      const adminId = (await pool.query(
        `INSERT INTO principals (id, external_id, kind, display_name)
         VALUES (gen_random_uuid(), 'upgrade-admin', 'user', 'Upgrade admin')
         RETURNING id`,
      )).rows[0].id as string;
      await pool.query(
        `INSERT INTO scope_memberships (principal_id, scope_id, role)
         VALUES ($1, $2, 'admin')`,
        [adminId, orgScopeId],
      );

      const seedRun = async (name: string, completed: boolean) => {
        const principalId = (await pool.query(
          `INSERT INTO principals (id, external_id, kind, display_name)
           VALUES (gen_random_uuid(), $1, 'user', $2) RETURNING id`,
          [`upgrade-${name}`, `Upgrade ${name}`],
        )).rows[0].id as string;
        const scopeId = (await pool.query(
          `INSERT INTO scopes (id, kind, name)
           VALUES (gen_random_uuid(), 'user', $1) RETURNING id`,
          [`upgrade-${name}`],
        )).rows[0].id as string;
        const approvalId = (await pool.query(
          `INSERT INTO principal_user_scope_approvals
             (principal_id, scope_id, approved_by, acknowledged_principal_ids,
              acknowledged_evidence_hash)
           VALUES ($1, $2, $3, '{}', repeat($4, 64)) RETURNING id::text AS id`,
          [principalId, scopeId, adminId, completed ? 'b' : 'a'],
        )).rows[0].id as string;
        await pool.query(
          `INSERT INTO principal_user_scopes
             (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
              acknowledged_evidence_hash)
           VALUES ($1, $2, $3, '{}', repeat($4, 64))`,
          [principalId, scopeId, adminId, completed ? 'b' : 'a'],
        );
        if (completed) {
          await pool.query(
            `UPDATE scopes SET name = 'erased-user-' || id::text WHERE id = $1`,
            [scopeId],
          );
          await pool.query(
            `UPDATE principals
                SET display_name = 'erased-' || left(replace(id::text, '-', ''), 12),
                    disabled_at = now(), offboarded_at = now()
              WHERE id = $1`,
            [principalId],
          );
        }
        const run = (await pool.query(
          `INSERT INTO principal_offboarding_runs
             (principal_id, scope_id, initiated_by, approval_id,
              initial_memories, initial_embeddings, initial_memberships,
              initial_aliases, initial_entra_bindings, initial_audit_rows,
              initial_audit_queries, initial_audit_selection,
              approval_evidence_hash, initial_count_truncated,
              memories_processed, embeddings_processed, memberships_processed,
              aliases_processed, entra_bindings_processed, audit_rows_processed,
              audit_queries_processed, batches, memory_cursor, audit_fence_id,
              audit_principal_cursor, audit_scope_cursor, audit_memory_cursor,
              audit_scope_ids_cursor, audit_linked_cursor,
              audit_memory_key_cursor, audit_memory_item_cursor,
              audit_memory_complete, audit_linked_request_cursor,
              audit_linked_request_item_cursor, audit_linked_request_exhausted,
              audit_linked_complete, memory_complete, scope_cleanup_complete)
           VALUES
             ($1, $2, $3, $4, 5, 2, 1, 1, 0, 7, 3, '{"source":"upgrade"}',
              repeat($5, 64), '{}', $6, $7, $8, $9, $10, $11, $12, $13,
              $14::uuid, $15, $16, $17, $18, $19, $20, $21::uuid, $22,
              $23, $24, $25, $26, $27, $28, TRUE)
           RETURNING run_id::text AS run_id`,
          completed
            ? [principalId, scopeId, adminId, approvalId, 'b', 5, 2, 1, 1, 0, 7, 3, 4,
              null, 0, 0, 0, 0, 0, 0, null, 0, true, null, 0, true, true, true]
            : [principalId, scopeId, adminId, approvalId, 'a', 2, 1, 1, 0, 0, 3, 1, 2,
              '10000000-0000-4000-8000-000000000001', 9, 4, 3, 2, 1, 0,
              '20000000-0000-4000-8000-000000000002', 2, false,
              'upgrade-request', 3, false, false, false],
        )).rows[0];
        await pool.query(
          `INSERT INTO principal_offboarding_run_events
             (run_id, principal_id, scope_id, phase, initiated_by, finalized_by,
              approval_id, approval_evidence_hash, evidence)
           VALUES ($1, $2, $3, 'started', $4, NULL, $5, repeat($6, 64),
                   '{"source":"upgrade"}')`,
          [run.run_id, principalId, scopeId, adminId, approvalId, completed ? 'b' : 'a'],
        );
        if (completed) {
          await pool.query(
            `SELECT continuum_complete_offboarding_run($1::uuid, $2::uuid, $3::jsonb)`,
            [run.run_id, adminId, JSON.stringify({
              run_id: run.run_id,
              initiated_by: adminId,
              finalized_by: adminId,
              approval_id: approvalId,
              approval_evidence_hash: 'b'.repeat(64),
              counts_exact: true,
              memories_processed: 5,
              embeddings_processed: 2,
              memberships_processed: 1,
              aliases_processed: 1,
              entra_bindings_processed: 0,
              audit_rows_processed: 7,
              audit_queries_processed: 3,
              batches: 4,
            })],
          );
        }
        return run.run_id as string;
      };

      const inProgressRunId = await seedRun('in-progress', false);
      const completedRunId = await seedRun('completed', true);
      const readRunState = async () => (await pool.query(
        `SELECT run.run_id::text, principal.external_id,
                run.memories_processed, run.audit_rows_processed, run.batches,
                run.memory_cursor::text, run.audit_fence_id::text,
                run.audit_principal_cursor::text, run.audit_scope_cursor::text,
                run.audit_memory_cursor::text, run.audit_scope_ids_cursor::text,
                run.audit_memory_key_cursor::text,
                run.audit_memory_item_cursor::text,
                run.audit_memory_complete, run.audit_linked_request_cursor,
                run.audit_linked_request_item_cursor::text,
                run.audit_linked_request_exhausted, run.audit_linked_complete,
                run.memory_complete, run.scope_cleanup_complete,
                run.completed_at IS NOT NULL AS completed,
                ARRAY(SELECT event.phase
                        FROM principal_offboarding_run_events event
                       WHERE event.run_id = run.run_id ORDER BY event.id) AS phases
           FROM principal_offboarding_runs run
           JOIN principals principal ON principal.id = run.principal_id
          ORDER BY principal.external_id`,
      )).rows;
      const historicalState = await readRunState();
      expect(historicalState).toEqual([
        expect.objectContaining({
          run_id: completedRunId, external_id: 'upgrade-completed',
          memories_processed: 5, audit_rows_processed: 7, batches: 4,
          audit_fence_id: '0', audit_memory_complete: true,
          audit_linked_complete: true, memory_complete: true,
          scope_cleanup_complete: true, completed: true,
          phases: ['started', 'completed'],
        }),
        expect.objectContaining({
          run_id: inProgressRunId, external_id: 'upgrade-in-progress',
          memories_processed: 2, audit_rows_processed: 3, batches: 2,
          memory_cursor: '10000000-0000-4000-8000-000000000001',
          audit_fence_id: '9', audit_principal_cursor: '4',
          audit_scope_cursor: '3', audit_memory_cursor: '2',
          audit_scope_ids_cursor: '1',
          audit_memory_key_cursor: '20000000-0000-4000-8000-000000000002',
          audit_memory_item_cursor: '2', audit_memory_complete: false,
          audit_linked_request_cursor: 'upgrade-request',
          audit_linked_request_item_cursor: '3',
          audit_linked_request_exhausted: false, audit_linked_complete: false,
          memory_complete: false, scope_cleanup_complete: true,
          completed: false, phases: ['started'],
        }),
      ]);
      await copyFile(
        new URL('0039_offboarding_completion_state.sql', source),
        join(directory, '0039_offboarding_completion_state.sql'),
      );
      expect((await runMigrations(pool, directory)).map((migration) => migration.name))
        .toEqual(['0039_offboarding_completion_state.sql']);
      expect(await readRunState()).toEqual(historicalState);
      expect((await pool.query(
        `SELECT proname FROM pg_proc
          WHERE pronamespace = current_schema()::regnamespace
            AND proname IN (
              'continuum_write_offboarding_run',
              'continuum_offboarding_actual_state_is_erased',
              'continuum_require_actual_offboarding_erasure'
            ) ORDER BY proname`,
      )).rows.map((row) => row.proname)).toEqual([
        'continuum_offboarding_actual_state_is_erased',
        'continuum_require_actual_offboarding_erasure',
        'continuum_write_offboarding_run',
      ]);
      expect((await pool.query(
        `SELECT tgname FROM pg_trigger
          WHERE tgrelid = 'principal_offboarding_run_events'::regclass
            AND tgname = 'require_actual_offboarding_erasure' AND NOT tgisinternal`,
      )).rows).toEqual([{ tgname: 'require_actual_offboarding_erasure' }]);
      await copyFile(
        new URL('0040_offboarding_post_completion_integrity.sql', source),
        join(directory, '0040_offboarding_post_completion_integrity.sql'),
      );
      expect((await runMigrations(pool, directory)).map((migration) => migration.name))
        .toEqual(['0040_offboarding_post_completion_integrity.sql']);
      expect(await readRunState()).toEqual(historicalState);
      expect((await pool.query(
        `SELECT proname, prosrc
           FROM pg_proc
          WHERE pronamespace = current_schema()::regnamespace
            AND proname IN (
              'continuum_offboarding_actual_state_is_erased',
              'continuum_protect_offboarded_audit_tombstone'
            )
          ORDER BY proname`,
      )).rows).toEqual([
        expect.objectContaining({
          proname: 'continuum_offboarding_actual_state_is_erased',
          prosrc: expect.stringContaining('FROM linked_request request'),
        }),
        expect.objectContaining({
          proname: 'continuum_protect_offboarded_audit_tombstone',
          prosrc: expect.stringContaining(
            'continuum_offboarding_expected_audit_metadata(OLD.metadata)',
          ),
        }),
      ]);
      expect((await pool.query(
        `SELECT continuum_offboarding_actual_state_is_erased($1::uuid) AS erased`,
        [completedRunId],
      )).rows).toEqual([{ erased: true }]);
      await copyFile(
        new URL('0041_offboarding_completion_trust.sql', source),
        join(directory, '0041_offboarding_completion_trust.sql'),
      );
      expect((await runMigrations(pool, directory)).map((migration) => migration.name))
        .toEqual(['0041_offboarding_completion_trust.sql']);
      expect(await readRunState()).toEqual(historicalState);
      await copyFile(
        new URL('0042_offboarding_final_remediation.sql', source),
        join(directory, '0042_offboarding_final_remediation.sql'),
      );
      expect((await runMigrations(pool, directory)).map((migration) => migration.name))
        .toEqual(['0042_offboarding_final_remediation.sql']);
      expect(await readRunState()).toEqual(historicalState);
      await copyFile(
        new URL('0043_audit_retention_selection_order.sql', source),
        join(directory, '0043_audit_retention_selection_order.sql'),
      );
      expect((await runMigrations(pool, directory)).map((migration) => migration.name))
        .toEqual(['0043_audit_retention_selection_order.sql']);
      expect(await readRunState()).toEqual(historicalState);
      await copyFile(
        new URL('0044_offboarding_restart_evidence.sql', source),
        join(directory, '0044_offboarding_restart_evidence.sql'),
      );
      expect((await runMigrations(pool, directory)).map((migration) => migration.name))
        .toEqual(['0044_offboarding_restart_evidence.sql']);
      expect(await readRunState()).toEqual(historicalState);
      await copyFile(
        new URL('0045_offboarding_trust_boundary.sql', source),
        join(directory, '0045_offboarding_trust_boundary.sql'),
      );
      expect((await runMigrations(pool, directory)).map((migration) => migration.name))
        .toEqual(['0045_offboarding_trust_boundary.sql']);
      expect(await readRunState()).toEqual(historicalState);
      await copyFile(
        new URL('0046_offboarding_authority_remediation.sql', source),
        join(directory, '0046_offboarding_authority_remediation.sql'),
      );
      expect((await runMigrations(pool, directory)).map((migration) => migration.name))
        .toEqual(['0046_offboarding_authority_remediation.sql']);
      expect(await readRunState()).toEqual(historicalState);
      await copyFile(
        new URL('0047_offboarding_role_boundary.sql', source),
        join(directory, '0047_offboarding_role_boundary.sql'),
      );
      expect((await runMigrations(pool, directory)).map((migration) => migration.name))
        .toEqual(['0047_offboarding_role_boundary.sql']);
      expect(await readRunState()).toEqual(historicalState);
      await copyFile(
        new URL('0048_offboarding_independent_review.sql', source),
        join(directory, '0048_offboarding_independent_review.sql'),
      );
      expect((await runMigrations(pool, directory)).map((migration) => migration.name))
        .toEqual(['0048_offboarding_independent_review.sql']);
      expect(await readRunState()).toEqual(historicalState);
      await copyFile(
        new URL('0049_offboarding_review_remediation.sql', source),
        join(directory, '0049_offboarding_review_remediation.sql'),
      );
      expect((await runMigrations(pool, directory)).map((migration) => migration.name))
        .toEqual(['0049_offboarding_review_remediation.sql']);
      expect(await readRunState()).toEqual(historicalState);
      await copyFile(
        new URL('0050_offboarding_startup_verification_fix.sql', source),
        join(directory, '0050_offboarding_startup_verification_fix.sql'),
      );
      expect((await runMigrations(pool, directory)).map((migration) => migration.name))
        .toEqual(['0050_offboarding_startup_verification_fix.sql']);
      expect(await readRunState()).toEqual(historicalState);
      await copyFile(
        new URL('0051_offboarding_security_contract.sql', source),
        join(directory, '0051_offboarding_security_contract.sql'),
      );
      expect((await runMigrations(pool, directory)).map((migration) => migration.name))
        .toEqual(['0051_offboarding_security_contract.sql']);
      expect(await readRunState()).toEqual(historicalState);
      await copyFile(
        new URL('0052_offboarding_review_repair.sql', source),
        join(directory, '0052_offboarding_review_repair.sql'),
      );
      expect((await runMigrations(pool, directory)).map((migration) => migration.name))
        .toEqual(['0052_offboarding_review_repair.sql']);
      expect(await readRunState()).toEqual(historicalState);

      await admin.query(`CREATE ROLE ${quotedRole} NOLOGIN`);
      roleCreated = true;
      await admin.query(`GRANT ${quotedRole} TO CURRENT_USER`);
      await grantApplicationRole(pool, schema, role);
      rolePool = new pg.Pool({
        connectionString: DATABASE_URL,
        max: 1,
        options: `-c search_path=${schema} -c role=${role}`,
      });
      expect((await rolePool.query(
        `SELECT has_function_privilege(current_user,
                  'continuum_write_offboarding_run(uuid,uuid,text,jsonb)', 'EXECUTE')
                  AS write_execute,
                has_function_privilege(current_user,
                  'continuum_get_offboarding_run(uuid,uuid)', 'EXECUTE')
                  AS get_execute,
                has_function_privilege(current_user,
                  'continuum_start_offboarding_run(uuid,uuid,jsonb)', 'EXECUTE')
                  AS start_execute,
                has_function_privilege(current_user,
                  'continuum_complete_offboarding_run(uuid,uuid,jsonb)', 'EXECUTE')
                  AS complete_execute,
                has_function_privilege(current_user,
                  'continuum_offboarding_actual_state_is_erased(uuid)', 'EXECUTE')
                  AS verifier_execute`,
      )).rows).toEqual([{
        write_execute: false,
        get_execute: false,
        start_execute: false,
        complete_execute: false,
        verifier_execute: false,
      }]);
      await expect(rolePool.query(
        `SELECT continuum_offboarding_actual_state_is_erased($1::uuid)`,
        [completedRunId],
      )).rejects.toThrow(/permission denied/i);
      expect(await runMigrations(pool, directory)).toEqual([]);
      expect(await readRunState()).toEqual(historicalState);
    } finally {
      await rolePool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (roleCreated) {
        await admin.query(`REVOKE ${quotedRole} FROM CURRENT_USER`);
        await admin.query(`DROP ROLE ${quotedRole}`);
      }
    }
  }, 60_000);

  it('upgrades the 5e0ab45 intermediate state where 0035 lacks its backfill function', async () => {
    const schema = `migrator_missing_backfill_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 1,
      options: `-c search_path=${schema}`,
    });
    pools.push(pool);
    const directory = await mkdtemp(join(tmpdir(), 'continuum-missing-backfill-'));
    directories.push(directory);
    await writeFile(join(directory, '0034_setup.sql'), `
      CREATE TABLE audit_log_offboarding_scopes (
        selector_kind TEXT NOT NULL,
        scope_id UUID NOT NULL,
        audit_id BIGINT NOT NULL,
        PRIMARY KEY (selector_kind, scope_id, audit_id)
      );
    `);
    await copyFile(
      new URL('../../migrations/0035_offboarding_selector_cursor_indexes.sql', import.meta.url),
      join(directory, '0035_offboarding_selector_cursor_indexes.sql'),
    );
    try {
      await expect(runMigrations(pool, directory)).resolves.toEqual([
        expect.objectContaining({ name: '0034_setup.sql' }),
        expect.objectContaining({ name: '0035_offboarding_selector_cursor_indexes.sql' }),
      ]);
      expect((await pool.query(
        `SELECT indisvalid FROM pg_index
          WHERE indexrelid = 'audit_log_offboarding_memory_cursor_idx'::regclass`,
      )).rows).toEqual([{ indisvalid: true }]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });
  it('pins migration-owned functions in a canonically quoted schema search path', async () => {
    const schema = `Migrator-Quoted-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    pools.push(pool);
    await pool.query(`SET search_path TO "${schema}", public`);
    try {
      await expect(runMigrations(pool)).resolves.toBeDefined();
      const expected = `search_path=pg_catalog, "${schema}", pg_temp`;
      const unsafe = await pool.query(
        `SELECT proname, proconfig
           FROM pg_proc
          WHERE pronamespace = quote_ident(current_schema())::regnamespace
            AND (proname LIKE 'continuum\\_%' ESCAPE '\\'
                 OR proname = 'reject_lifecycle_principal_membership')
            AND proowner = current_user::regrole
            AND NOT COALESCE(proconfig @> ARRAY[$1], FALSE)`,
        [expected],
      );
      expect(unsafe.rows).toEqual([]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  }, 60_000);

  it('backfills ordered offboarding selectors on upgrade and retries idempotently', async () => {
    const schema = `migrator_selector_upgrade_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const directory = await mkdtemp(join(tmpdir(), 'continuum-selector-upgrade-'));
    directories.push(directory);
    const source = new URL('../../migrations/', import.meta.url);
    const files = (await readdir(source)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files.filter((name) => name <= '0032_offboarding_round7_compatibility.sql')) {
      await copyFile(new URL(file, source), join(directory, file));
    }
    try {
      await runMigrations(pool, directory);
      const principalId = (await pool.query(
        `INSERT INTO principals (id, external_id, kind, display_name)
         VALUES (gen_random_uuid(), 'selector-upgrade', 'user', 'Selector') RETURNING id`,
      )).rows[0].id;
      const scopeId = (await pool.query(
        `INSERT INTO scopes (id, kind, name)
         VALUES (gen_random_uuid(), 'user', 'selector-upgrade') RETURNING id`,
      )).rows[0].id;
      const memoryId = (await pool.query(
        `INSERT INTO memories (id, scope_id, type, title, body, author_id, source)
         VALUES (gen_random_uuid(), $1, 'context', 'private', 'private', $2, 'manual')
         RETURNING id`, [scopeId, principalId],
      )).rows[0].id;
      await pool.query(
        `INSERT INTO audit_log (principal_id, action, memory_id, metadata)
         VALUES ($1, 'read', $2, $3::jsonb)`,
        [principalId, memoryId, JSON.stringify({ scope_ids: [scopeId] })],
      );
      await pool.query(
        `INSERT INTO principal_user_scopes
           (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
            acknowledged_evidence_hash)
         VALUES ($1, $2, $1, '{}', repeat('0', 64))`, [principalId, scopeId],
      );
      const approvalId = (await pool.query(
        `INSERT INTO principal_user_scope_approvals
           (principal_id, scope_id, approved_by, acknowledged_principal_ids,
            acknowledged_evidence_hash)
         VALUES ($1, $2, $1, '{}', repeat('0', 64)) RETURNING id`,
        [principalId, scopeId],
      )).rows[0].id;
      await pool.query(
        `INSERT INTO principal_offboarding_runs
           (principal_id, scope_id, initiated_by, approval_id,
            initial_memories, initial_embeddings, initial_memberships,
            initial_aliases, initial_entra_bindings, initial_audit_rows,
            initial_audit_queries, audit_fence_id, audit_memory_cursor,
            audit_scope_ids_cursor, audit_linked_cursor,
            audit_memory_item_cursor, audit_memory_complete,
            audit_linked_request_cursor, audit_linked_request_item_cursor,
            audit_linked_complete)
         VALUES ($1, $2, $1, $3, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1,
                 1, TRUE, 'old-request', 1, TRUE)`,
        [principalId, scopeId, approvalId],
      );
      await copyFile(
        new URL('0033_offboarding_bounded_selectors.sql', source),
        join(directory, '0033_offboarding_bounded_selectors.sql'),
      );

      await expect(runMigrations(pool, directory)).resolves.toEqual([
        expect.objectContaining({ name: '0033_offboarding_bounded_selectors.sql' }),
      ]);
      expect((await pool.query(
        `SELECT cursor_id::text, completed
           FROM audit_log_offboarding_backfill_state WHERE singleton = TRUE`,
      )).rows).toEqual([{ cursor_id: '0', completed: false }]);
      expect((await pool.query(
        `SELECT audit_memory_cursor::text, audit_scope_ids_cursor::text,
                audit_memory_item_cursor::text, audit_memory_complete,
                audit_linked_request_cursor, audit_linked_complete
           FROM principal_offboarding_runs WHERE principal_id = $1`, [principalId],
      )).rows).toEqual([{
        audit_memory_cursor: '0', audit_scope_ids_cursor: '0',
        audit_memory_item_cursor: '0', audit_memory_complete: false,
        audit_linked_request_cursor: null, audit_linked_complete: false,
      }]);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM audit_log_offboarding_scopes`,
      )).rows[0].count).toBe(0);
      await copyFile(
        new URL('0034_offboarding_completion_invariants.sql', source),
        join(directory, '0034_offboarding_completion_invariants.sql'),
      );
      await copyFile(
        new URL('0035_offboarding_selector_cursor_indexes.sql', source),
        join(directory, '0035_offboarding_selector_cursor_indexes.sql'),
      );
      await expect(runMigrations(pool, directory)).resolves.toEqual([
        expect.objectContaining({ name: '0034_offboarding_completion_invariants.sql' }),
        expect.objectContaining({ name: '0035_offboarding_selector_cursor_indexes.sql' }),
      ]);
      expect((await pool.query(
        `SELECT selector_kind, scope_id::text
           FROM audit_log_offboarding_scopes ORDER BY selector_kind`,
      )).rows).toEqual([
        { selector_kind: 'memory', scope_id: scopeId },
        { selector_kind: 'scope_ids', scope_id: scopeId },
      ]);
      expect((await pool.query(
        `SELECT cursor_id = fence_id AS caught_up, completed
           FROM audit_log_offboarding_backfill_state WHERE singleton = TRUE`,
      )).rows).toEqual([{ caught_up: true, completed: true }]);
      await expect(runMigrations(pool, directory)).resolves.toEqual([]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('removes pre-existing embeddings for archived memories during the offboarding migration', async () => {
    const schema = `migrator_offboarding_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const directory = await mkdtemp(join(tmpdir(), 'continuum-offboarding-migrations-'));
    directories.push(directory);
    const source = new URL('../../migrations/', import.meta.url);
    const files = (await readdir(source)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files.filter((name) => name < '0022_offboarding_principal_lifecycle.sql')) {
      await copyFile(new URL(file, source), join(directory, file));
    }
    try {
      await runMigrations(pool, directory);
      const principalId = (await pool.query(
        `INSERT INTO principals (id, external_id, kind, display_name)
         VALUES (gen_random_uuid(), 'archived-owner', 'user', 'Owner') RETURNING id`,
      )).rows[0].id;
      const scopeId = (await pool.query(
        `INSERT INTO scopes (id, kind, name) VALUES (gen_random_uuid(), 'user', 'archived-scope')
         RETURNING id`,
      )).rows[0].id;
      const memoryId = (await pool.query(
        `INSERT INTO memories (id, scope_id, type, title, body, author_id, source, state)
         VALUES (gen_random_uuid(), $1, 'fact', 'Archived', 'Archived', $2, 'manual', 'archived')
         RETURNING id`, [scopeId, principalId],
      )).rows[0].id;
      await pool.query(
        `INSERT INTO memory_embeddings (memory_id, provider, dim, embedding)
         VALUES ($1, 'test', 768, $2::vector)`,
        [memoryId, `[${Array(768).fill(0).join(',')}]`],
      );
      await copyFile(
        new URL('0022_offboarding_principal_lifecycle.sql', source),
        join(directory, '0022_offboarding_principal_lifecycle.sql'),
      );
      await copyFile(
        new URL('0023_offboarding_erasure.sql', source),
        join(directory, '0023_offboarding_erasure.sql'),
      );
      expect(await readFile(new URL('0022_offboarding_principal_lifecycle.sql', source), 'utf8'))
        .toMatch(/SET LOCAL lock_timeout = '5s'/i);
      expect(await readFile(new URL('0023_offboarding_erasure.sql', source), 'utf8'))
        .not.toMatch(/DELETE FROM memory_embeddings e USING memories m/);
      await runMigrations(pool, directory);
      await copyFile(
        new URL('0024_offboarding_embedding_cleanup.sql', source),
        join(directory, '0024_offboarding_embedding_cleanup.sql'),
      );
      await copyFile(
        new URL('0025_offboarding_audit_indexes.sql', source),
        join(directory, '0025_offboarding_audit_indexes.sql'),
      );
      expect(await readFile(new URL('0024_offboarding_embedding_cleanup.sql', source), 'utf8'))
        .toMatch(/SET LOCAL statement_timeout = '30s'/i);
      await runMigrations(pool, directory);
      expect((await pool.query('SELECT 1 FROM memory_embeddings WHERE memory_id = $1', [memoryId])).rowCount)
        .toBe(0);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  }, 30_000);
  it('aliases exact review-era Entra ledger names without replaying renamed migrations', async () => {
    const schema = `migrator_entra_rename_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const directory = await mkdtemp(join(tmpdir(), 'continuum-entra-rename-'));
    directories.push(directory);
    await writeFile(
      join(directory, '0010_entra_auth.sql'),
      "DO $$ BEGIN RAISE EXCEPTION 'renamed migration replayed'; END $$;",
    );
    try {
      await pool.query(
        `CREATE TABLE _continuum_migrations (
           name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
         );
         INSERT INTO _continuum_migrations (name) VALUES ('0005_entra_auth.sql')`,
      );

      await expect(runMigrations(pool, directory)).resolves.toEqual([]);
      expect((await pool.query(
        `SELECT name FROM _continuum_migrations
          WHERE name IN ('0005_entra_auth.sql', '0010_entra_auth.sql')
          ORDER BY name`,
      )).rows).toEqual([
        { name: '0005_entra_auth.sql' },
        { name: '0010_entra_auth.sql' },
      ]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('seeds Entra freshness from durable successful-sync evidence, never migration time', async () => {
    const schema = `migrator_entra_freshness_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const migration = await readFile(
      join(process.cwd(), 'migrations/0019_entra_sync_freshness.sql'),
      'utf8',
    );
    const directory = await migrationDirectory(migration);
    try {
      await pool.query(
        `CREATE TABLE scope_memberships (
           source_kind TEXT NOT NULL, active BOOLEAN NOT NULL, synced_at TIMESTAMPTZ
         );
         CREATE TABLE audit_log (
           at TIMESTAMPTZ NOT NULL, metadata JSONB
         );
         INSERT INTO scope_memberships (source_kind, active, synced_at)
         VALUES ('entra', TRUE, now());
         INSERT INTO audit_log (at, metadata)
         VALUES (now() - interval '72 hours', '{"operation":"entra_membership_sync"}')`,
      );

      await runMigrations(pool, directory);

      expect((await pool.query(
        `SELECT last_success_at = (
           SELECT max(at) FROM audit_log
            WHERE metadata->>'operation' = 'entra_membership_sync'
         ) AS derived,
         now() >= last_success_at + max_staleness AS stale
         FROM entra_sync_state WHERE singleton`,
      )).rows).toEqual([{ derived: true, stale: true }]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('repairs review-era freshness state from durable sync evidence on upgrade', async () => {
    const schema = `migrator_entra_upgrade_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const migration = await readFile(
      join(process.cwd(), 'migrations/0020_entra_review_hardening.sql'),
      'utf8',
    );
    const directory = await migrationDirectory(migration);
    try {
      await pool.query(
        `CREATE TABLE audit_log (
           at TIMESTAMPTZ NOT NULL, metadata JSONB
         );
         CREATE TABLE entra_sync_state (
           singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
           last_success_at TIMESTAMPTZ NOT NULL DEFAULT now(),
           max_staleness INTERVAL NOT NULL DEFAULT interval '24 hours'
         );
         INSERT INTO audit_log (at, metadata)
         VALUES (now() - interval '72 hours', '{"operation":"entra_membership_sync"}');
         INSERT INTO entra_sync_state (singleton) VALUES (TRUE)`,
      );

      await runMigrations(pool, directory);

      expect((await pool.query(
        `SELECT last_success_at = (
           SELECT max(at) FROM audit_log
            WHERE metadata->>'operation' = 'entra_membership_sync'
         ) AS derived,
         now() >= last_success_at + max_staleness AS stale,
         max_staleness = interval '48 hours' AS two_day_default
         FROM entra_sync_state WHERE singleton`,
      )).rows).toEqual([{ derived: true, stale: true, two_day_default: true }]);

      await pool.query('DELETE FROM entra_sync_state');
      expect((await pool.query(
        `INSERT INTO entra_sync_state (singleton) VALUES (TRUE)
         RETURNING last_success_at = TIMESTAMPTZ '1970-01-01 00:00:00+00' AS fail_closed,
                   max_staleness = interval '48 hours' AS two_day_default`,
      )).rows).toEqual([{ fail_closed: true, two_day_default: true }]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('ships decision constraints after ingestion with nonblocking validation and indexing', async () => {
    const migrations = (await readdir(join(process.cwd(), 'migrations')))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    expect(migrations).toContain('0007_decision_supersession_constraints.sql');
    expect(migrations).toContain('0008_decision_supersession_validation.sql');
    expect(migrations).toContain('0009_decision_supersession_unique_index.sql');
    const sequenceNumbers = migrations.map((file) => file.slice(0, 4));
    expect(new Set(sequenceNumbers).size).toBe(sequenceNumbers.length);
    expect(migrations).toContain('0010_entra_auth.sql');

    const constraints = await readFile(
      join(process.cwd(), 'migrations/0007_decision_supersession_constraints.sql'),
      'utf8',
    );
    expect(constraints).toMatch(/ADD CONSTRAINT memories_supersedes_not_self[\s\S]+NOT VALID/i);
    expect(constraints).not.toMatch(/VALIDATE CONSTRAINT memories_supersedes_not_self/i);
    expect(constraints).not.toMatch(/CREATE\s+UNIQUE\s+INDEX/i);

    const validation = await readFile(
      join(process.cwd(), 'migrations/0008_decision_supersession_validation.sql'),
      'utf8',
    );
    expect(validation).toMatch(/VALIDATE CONSTRAINT memories_supersedes_not_self/i);
    expect(validation).not.toMatch(/ADD CONSTRAINT/i);
    expect(validation).not.toMatch(/CREATE\s+UNIQUE\s+INDEX/i);

    const uniqueIndex = await readFile(
      join(process.cwd(), 'migrations/0009_decision_supersession_unique_index.sql'),
      'utf8',
    );
    expect(uniqueIndex.trimStart()).toMatch(/^-- continuum:no-transaction/);
    expect(uniqueIndex).toMatch(/CREATE UNIQUE INDEX CONCURRENTLY memories_supersedes_unique_idx/i);
  });

  it('deactivates pre-approval Entra memberships during the approval migration', async () => {
    const schema = `migrator_entra_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const directory = await mkdtemp(join(tmpdir(), 'continuum-entra-migrations-'));
    directories.push(directory);
    const source = new URL('../../migrations/', import.meta.url);
    const files = (await readdir(source)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files.filter((name) => name <= '0010_entra_auth.sql')) {
      await copyFile(new URL(file, source), join(directory, file));
    }

    try {
      await runMigrations(pool, directory);
      const scope = (await pool.query("SELECT id FROM scopes WHERE kind = 'org' AND name = ''")).rows[0].id;
      const principal = (await pool.query(
        "INSERT INTO principals (id, external_id, kind, display_name) VALUES (gen_random_uuid(), 'legacy-user', 'user', 'Legacy') RETURNING id",
      )).rows[0].id;
      const groupId = '22222222-2222-4222-8222-222222222222';
      await pool.query(
        "INSERT INTO entra_groups (external_id, display_name, scope_id, role) VALUES ($1, 'continuum-org-admin', $2, 'admin')",
        [groupId, scope],
      );
      await pool.query(
        "INSERT INTO scope_memberships (principal_id, scope_id, role, source_kind, source_id) VALUES ($1, $2, 'admin', 'entra', $3)",
        [principal, scope, groupId],
      );
      for (const file of files.filter((name) => name > '0010_entra_auth.sql')) {
        await copyFile(new URL(file, source), join(directory, file));
      }
      await runMigrations(pool, directory);
      expect((await pool.query(
        "SELECT active, deactivated_at IS NOT NULL AS deactivated FROM scope_memberships WHERE source_kind = 'entra'",
      )).rows).toEqual([{ active: false, deactivated: true }]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('repairs orphaned active memberships before installing binding guards', async () => {
    const schema = `migrator_binding_guard_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const directory = await mkdtemp(join(tmpdir(), 'continuum-binding-migrations-'));
    directories.push(directory);
    const source = new URL('../../migrations/', import.meta.url);
    const files = (await readdir(source)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files.filter((name) => name <= '0014_lock_entra_binding_invariant.sql')) {
      await copyFile(new URL(file, source), join(directory, file));
    }

    try {
      await runMigrations(pool, directory);
      const scope = (await pool.query(
        "INSERT INTO scopes (id, kind, name) VALUES (gen_random_uuid(), 'team', 'repair') RETURNING id",
      )).rows[0].id;
      const approver = (await pool.query(
        "INSERT INTO principals (id, external_id, kind, display_name) VALUES (gen_random_uuid(), 'approver', 'user', 'Approver') RETURNING id",
      )).rows[0].id;
      const member = (await pool.query(
        "INSERT INTO principals (id, external_id, kind, display_name) VALUES (gen_random_uuid(), 'member', 'user', 'Member') RETURNING id",
      )).rows[0].id;
      const groupId = '22222222-2222-4222-8222-222222222222';
      await pool.query(
        `INSERT INTO entra_groups
           (external_id, display_name, scope_id, role, active, approved_by, approved_at)
         VALUES ($1, 'repair', $2, 'reader', TRUE, $3, now())`,
        [groupId, scope, approver],
      );
      await pool.query(
        `INSERT INTO scope_memberships
           (principal_id, scope_id, role, source_kind, source_id, active)
         VALUES ($1, $2, 'reader', 'entra', $3, TRUE)`,
        [member, scope, groupId],
      );
      await pool.query(
        'UPDATE entra_groups SET active = FALSE, deactivated_at = now() WHERE external_id = $1',
        [groupId],
      );

      for (const file of files.filter((name) => name > '0014_lock_entra_binding_invariant.sql')) {
        await copyFile(new URL(file, source), join(directory, file));
      }
      await runMigrations(pool, directory);

      expect((await pool.query(
        `SELECT active, deactivated_at IS NOT NULL AS deactivated
           FROM scope_memberships WHERE source_kind = 'entra'`,
      )).rows).toEqual([{ active: false, deactivated: true }]);
      await pool.query(
        `UPDATE entra_groups
            SET active = TRUE, deactivated_at = NULL,
                quarantined_at = NULL, quarantine_reason = NULL
          WHERE external_id = $1`,
        [groupId],
      );
      await pool.query(
        `UPDATE scope_memberships SET active = TRUE, deactivated_at = NULL
          WHERE source_kind = 'entra' AND source_id = $1`,
        [groupId],
      );
      await expect(pool.query(
        "UPDATE entra_groups SET role = 'writer' WHERE external_id = $1", [groupId],
      )).rejects.toThrow(/active Entra memberships must match an approved binding/);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('canonicalizes legacy Entra IDs and fail-closed consolidates case collisions', async () => {
    const schema = `migrator_entra_case_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const directory = await mkdtemp(join(tmpdir(), 'continuum-entra-case-migrations-'));
    directories.push(directory);
    const source = new URL('../../migrations/', import.meta.url);
    const files = (await readdir(source)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files.filter((name) => name <= '0015_harden_entra_binding_invariants.sql')) {
      await copyFile(new URL(file, source), join(directory, file));
    }

    try {
      await runMigrations(pool, directory);
      const scope = (await pool.query(
        "INSERT INTO scopes (id, kind, name) VALUES (gen_random_uuid(), 'team', 'case') RETURNING id",
      )).rows[0].id;
      const approver = (await pool.query(
        "INSERT INTO principals (id, external_id, kind, display_name) VALUES (gen_random_uuid(), 'approver', 'user', 'Approver') RETURNING id",
      )).rows[0].id;
      const member = (await pool.query(
        "INSERT INTO principals (id, external_id, kind, display_name) VALUES (gen_random_uuid(), 'member', 'user', 'Member') RETURNING id",
      )).rows[0].id;
      const collision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const ordinary = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      for (const id of [collision, collision.toUpperCase(), ordinary.toUpperCase()]) {
        await pool.query(
          `INSERT INTO entra_groups
             (external_id, display_name, scope_id, role, active, approved_by, approved_at)
           VALUES ($1, $1, $2, 'reader', TRUE, $3, now())`,
          [id, scope, approver],
        );
        await pool.query(
          `INSERT INTO scope_memberships
             (principal_id, scope_id, role, source_kind, source_id, active)
           VALUES ($1, $2, 'reader', 'entra', $3, TRUE)`,
          [member, scope, id],
        );
      }

      for (const file of files.filter((name) => name > '0015_harden_entra_binding_invariants.sql')) {
        await copyFile(new URL(file, source), join(directory, file));
      }
      await runMigrations(pool, directory);

      expect((await pool.query(
        `SELECT external_id, active, quarantine_reason FROM entra_groups ORDER BY external_id`,
      )).rows).toEqual([
        { external_id: collision, active: false, quarantine_reason: 'LEGACY_INACTIVE_REVIEW' },
        { external_id: ordinary, active: true, quarantine_reason: null },
      ]);
      expect((await pool.query(
        `SELECT source_id, active FROM scope_memberships
          WHERE source_kind = 'entra' ORDER BY source_id`,
      )).rows).toEqual([
        { source_id: collision, active: false },
        { source_id: ordinary, active: true },
      ]);
      await expect(pool.query(
        `INSERT INTO entra_groups
           (external_id, display_name, scope_id, role, active, approved_by, approved_at)
         VALUES ($1, 'upper', $2, 'reader', TRUE, $3, now())`,
        ['CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC', scope, approver],
      )).rejects.toThrow();
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('canonicalizes UUID-shaped principal identities and enforces the invariant', async () => {
    const schema = `migrator_principal_case_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const migration = await readFile(
      join(process.cwd(), 'migrations/0018_canonicalize_principal_external_ids.sql'),
      'utf8',
    );
    const directory = await migrationDirectory(migration);
    const lower = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    try {
      await pool.query(
        `CREATE TABLE principals (
           id UUID PRIMARY KEY, external_id TEXT UNIQUE, kind TEXT, display_name TEXT
         )`,
      );
      await pool.query(
        `INSERT INTO principals (id, external_id, kind, display_name) VALUES
         (gen_random_uuid(), $1, 'user', 'UUID'),
         (gen_random_uuid(), 'Service:Opaque', 'service', 'Opaque')`,
        [lower.toUpperCase()],
      );

      await runMigrations(pool, directory);

      expect((await pool.query('SELECT external_id FROM principals ORDER BY external_id')).rows)
        .toEqual([{ external_id: lower }, { external_id: 'Service:Opaque' }]);
      await expect(pool.query(
        `INSERT INTO principals (id, external_id, kind, display_name)
         VALUES (gen_random_uuid(), 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB', 'user', 'Invalid')`,
      )).rejects.toThrow();
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('preflights principal UUID case collisions without changing rows', async () => {
    const schema = `migrator_principal_collision_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const migration = await readFile(
      join(process.cwd(), 'migrations/0018_canonicalize_principal_external_ids.sql'),
      'utf8',
    );
    const directory = await migrationDirectory(migration);
    const lower = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    try {
      await pool.query(
        `CREATE TABLE principals (
           id UUID PRIMARY KEY, external_id TEXT UNIQUE, kind TEXT, display_name TEXT
         )`,
      );
      await pool.query(
        `INSERT INTO principals (id, external_id, kind, display_name) VALUES
         (gen_random_uuid(), $1, 'user', 'Lower'),
         (gen_random_uuid(), $2, 'user', 'Upper')`,
        [lower, lower.toUpperCase()],
      );

      await expect(runMigrations(pool, directory))
        .rejects.toThrow(/collide after lowercase canonicalization/);
      expect((await pool.query('SELECT external_id FROM principals ORDER BY external_id')).rows)
        .toEqual([{ external_id: lower }, { external_id: lower.toUpperCase() }]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('recounts zero-receipt principals during the 0057 forward repair', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const schema = `coordination_0057_recount_${suffix}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const directory = await mkdtemp(join(tmpdir(), 'continuum-before-0057-'));
    directories.push(directory);
    const source = new URL('../../migrations/', import.meta.url);
    const files = (await readdir(source))
      .filter((name) => name.endsWith('.sql')
        && name < '0057_coordination_privacy_race_remediation.sql')
      .sort();
    await Promise.all(files.map((name) => copyFile(
      new URL(name, source), join(directory, name),
    )));
    await runMigrations(pool, directory);
    const principalId = '00000000-0000-4000-8000-000000005057';
    await pool.query(
      `INSERT INTO principals (id, external_id, kind, display_name)
       VALUES ($1, 'service:0057-zero-recount', 'service', '0057 recount')`,
      [principalId],
    );
    await pool.query(
      `INSERT INTO coordination_principal_usage (
         principal_id, acquire_receipt_count, mutation_receipt_count
       ) VALUES ($1, 9, 8)`,
      [principalId],
    );
    await runMigrations(pool, join(process.cwd(), 'migrations'));
    expect((await pool.query(
      `SELECT acquire_receipt_count, contended_receipt_count, mutation_receipt_count
         FROM coordination_principal_usage WHERE principal_id = $1`,
      [principalId],
    )).rows).toEqual([{
      acquire_receipt_count: 0, contended_receipt_count: 0, mutation_receipt_count: 0,
    }]);
  });

  it('upgrades mixed 0057 rows and resumes 0062 cleanup state', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const schema = `coordination_issue7_upgrade_${suffix}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = schemaPool(schema);
    const blocker = schemaPool(schema);
    const before = await mkdtemp(join(tmpdir(), 'continuum-issue7-before-'));
    const forward = await mkdtemp(join(tmpdir(), 'continuum-issue7-forward-'));
    directories.push(before, forward);
    const source = new URL('../../migrations/', import.meta.url);
    const files = (await readdir(source)).filter((name) => name.endsWith('.sql')).sort();
    await Promise.all(files.filter((name) => name <= '0057_coordination_privacy_race_remediation.sql')
      .map((name) => copyFile(new URL(name, source), join(before, name))));
    await Promise.all(files.filter((name) => name <= '0062_coordination_forward_online_finish.sql')
      .map((name) => copyFile(new URL(name, source), join(forward, name))));
    try {
      await runMigrations(pool, before);
      const principalId = (await pool.query(
        `INSERT INTO principals (id, external_id, kind, display_name)
         VALUES (gen_random_uuid(), $1, 'service', 'large upgrade writer')
         RETURNING id`, [`service:large-upgrade-${suffix}`],
      )).rows[0].id as string;
      const scopeId = (await pool.query(
        `INSERT INTO scopes (id, kind, name)
         VALUES (gen_random_uuid(), 'project', $1) RETURNING id`,
        [`large-upgrade-${suffix}`],
      )).rows[0].id as string;
      await pool.query(
        `INSERT INTO coordination_resources (scope_id, resource, fencing_token)
         VALUES ($1, 'large-upgrade-history', 5000)`, [scopeId],
      );
      await pool.query(
        `INSERT INTO coordination_leases (
           lease_id, scope_id, resource, principal_id, run_id, fencing_token,
           acquired_at, expires_at, released_at
         ) SELECT gen_random_uuid(), $1, 'large-upgrade-history', $2,
                  gen_random_uuid(), series, clock_timestamp() - interval '3 days',
                  clock_timestamp() - interval '2 days',
                  clock_timestamp() - interval '2 days'
             FROM generate_series(1, 5000) series`,
        [scopeId, principalId],
      );
      await pool.query(
        `UPDATE coordination_resources resource SET current_lease_id = lease.lease_id
          FROM coordination_leases lease
         WHERE resource.scope_id = $1 AND lease.scope_id = resource.scope_id
           AND lease.resource = resource.resource AND lease.fencing_token = 5000`,
        [scopeId],
      );

      const locked = await blocker.connect();
      try {
        await locked.query('BEGIN');
        await locked.query(
          'LOCK TABLE coordination_leases IN SHARE UPDATE EXCLUSIVE MODE',
        );
        await pool.query(
          `INSERT INTO coordination_resources (scope_id, resource, fencing_token)
           VALUES ($1, 'online-lock-control', 1)`, [scopeId],
        );
        const writer = await pool.connect();
        try {
          await writer.query('BEGIN');
          await writer.query("SET LOCAL lock_timeout = '500ms'");
          await expect(writer.query(
            `INSERT INTO coordination_leases (
               lease_id, scope_id, resource, principal_id, run_id, fencing_token,
               acquired_at, expires_at, released_at
             ) VALUES (gen_random_uuid(), $1, 'online-lock-control', $2,
                       gen_random_uuid(), 1, clock_timestamp(),
                       clock_timestamp() + interval '1 minute', NULL)`,
            [scopeId, principalId],
          )).resolves.toBeDefined();
          await writer.query('ROLLBACK');
        } finally {
          writer.release();
        }
      } finally {
        await locked.query('ROLLBACK');
        locked.release();
      }
      const started = performance.now();
      await runMigrations(pool, forward);
      expect(performance.now() - started).toBeLessThan(5_000);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM coordination_leases
          WHERE cleanup_eligible_at IS NOT NULL`,
      )).rows).toEqual([{ count: 4999 }]);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM coordination_leases
          WHERE cleanup_eligible_at IS NULL`,
      )).rows).toEqual([{ count: 1 }]);
      expect((await pool.query(
        `SELECT rows_processed::int, last_lease_id IS NOT NULL AS cursor,
                completed_at IS NOT NULL AS complete
           FROM coordination_migration_progress
          WHERE name = 'issue7-cleanup-eligibility'`,
      )).rows).toEqual([{ rows_processed: 4999, cursor: true, complete: true }]);
      await pool.query(
        `UPDATE coordination_resources SET current_lease_id = NULL
          WHERE scope_id = $1`, [scopeId],
      );
      await pool.query(
        `DELETE FROM _continuum_migrations
          WHERE name = '0062_coordination_forward_online_finish.sql'`,
      );
      await expect(runMigrations(pool, forward)).resolves.toMatchObject([
        expect.objectContaining({ name: '0062_coordination_forward_online_finish.sql' }),
      ]);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM coordination_leases
          WHERE cleanup_eligible_at IS NULL`,
      )).rows).toEqual([{ count: 0 }]);
      await pool.query('ANALYZE coordination_leases');
      await pool.query('ANALYZE coordination_operation_receipts');
      const plan = await pool.query(
        `EXPLAIN (FORMAT JSON)
         SELECT lease.lease_id FROM coordination_leases lease
          WHERE lease.cleanup_eligible_at
                <= clock_timestamp() - interval '24 hours'
            AND NOT EXISTS (
              SELECT 1 FROM coordination_operation_receipts receipt
               WHERE receipt.lease_id = lease.lease_id)
          ORDER BY lease.cleanup_eligible_at, lease.lease_id
          LIMIT 1000 FOR UPDATE OF lease SKIP LOCKED`,
      );
      expect(JSON.stringify(plan.rows)).toContain('LockRows');
      expect((await pool.query(
        `SELECT indexrelid::regclass::text AS name, indisvalid AS valid
           FROM pg_index WHERE indexrelid =
             'coordination_leases_cleanup_ready_idx'::regclass`,
      )).rows).toEqual([{
        name: 'coordination_leases_cleanup_ready_idx', valid: true,
      }]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  }, 60_000);

  it('runs marked concurrent-index migrations outside a transaction', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (query: string) => {
        queries.push(query.trim());
        if (query.includes('SELECT 1 FROM _continuum_migrations')) {
          return { rowCount: 0, rows: [] };
        }
        if (query.includes('pg_advisory_unlock')) {
          return { rowCount: 1, rows: [{ unlocked: true }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const directory = await migrationDirectory(
      '-- continuum:no-transaction\nDROP INDEX CONCURRENTLY IF EXISTS test_idx;\nCREATE INDEX CONCURRENTLY test_idx ON test_table (id);',
    );

    await runMigrations({ connect: vi.fn(async () => client) } as unknown as pg.Pool, directory);

    expect(queries).not.toContain('BEGIN');
    expect(queries).not.toContain('COMMIT');
    expect(queries).not.toContain('ROLLBACK');
    const index = queries.findIndex((query) => query.includes('CREATE INDEX CONCURRENTLY'));
    const drop = queries.findIndex((query) => query.includes('DROP INDEX CONCURRENTLY'));
    const ledger = queries.findIndex((query) => query.includes('INSERT INTO _continuum_migrations'));
    expect(drop).toBeGreaterThan(-1);
    expect(index).toBeGreaterThan(drop);
    expect(ledger).toBeGreaterThan(index);
  });

  it('runs a commented selector-backfill directive until its watermark completes', async () => {
    let batches = 0;
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (query: string) => {
        queries.push(query.trim());
        if (query.includes('SELECT 1 FROM _continuum_migrations')) {
          return { rowCount: 0, rows: [] };
        }
        if (query.includes('to_regprocedure')) {
          return { rowCount: 1, rows: [{ available: true }] };
        }
        if (query.includes('continuum_backfill_audit_offboarding_scopes')) {
          batches += 1;
          return { rowCount: 1, rows: [{ completed: batches === 2 }] };
        }
        if (query.includes('pg_advisory_unlock')) {
          return { rowCount: 1, rows: [{ unlocked: true }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const directory = await migrationDirectory(
      `-- continuum:no-transaction
-- explanatory rollout comment
-- continuum:backfill-offboarding-selectors;`,
    );

    await runMigrations({ connect: vi.fn(async () => client) } as unknown as pg.Pool, directory);

    expect(batches).toBe(2);
    expect(queries).toContain("SET statement_timeout = '30s'");
    expect(queries).toContain('RESET statement_timeout');
  });

  it('drops only an invalid exact-schema index and verifies the replacement before ledgering', async () => {
    const queries: string[] = [];
    let stateChecks = 0;
    const client = {
      query: vi.fn(async (query: string) => {
        queries.push(query.trim());
        if (query.includes('SELECT 1 FROM _continuum_migrations')) return { rowCount: 0, rows: [] };
        if (query.includes('JOIN pg_index')) {
          stateChecks += 1;
          return { rowCount: 1, rows: [{ schema: 'tenant_exact', valid: stateChecks > 1 }] };
        }
        if (query.includes('pg_advisory_unlock')) {
          return { rowCount: 1, rows: [{ unlocked: true }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const directory = await migrationDirectory(
      `-- continuum:no-transaction
-- continuum:repair-invalid-index exact_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS exact_idx ON exact_table (id);
-- continuum:require-valid-index exact_idx;`,
    );

    await runMigrations({ connect: vi.fn(async () => client) } as unknown as pg.Pool, directory);

    expect(queries).toContain('DROP INDEX CONCURRENTLY "tenant_exact"."exact_idx"');
    const drop = queries.findIndex((query) => query.startsWith('DROP INDEX CONCURRENTLY'));
    const create = queries.findIndex((query) => query.startsWith('CREATE INDEX CONCURRENTLY'));
    const ledger = queries.findIndex((query) => query.includes('INSERT INTO _continuum_migrations'));
    expect(drop).toBeLessThan(create);
    expect(create).toBeLessThan(ledger);
    expect(stateChecks).toBe(2);
  });

  it('refuses to ledger a no-transaction migration when a required index remains invalid', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (query: string) => {
        queries.push(query.trim());
        if (query.includes('SELECT 1 FROM _continuum_migrations')) return { rowCount: 0, rows: [] };
        if (query.includes('JOIN pg_index')) {
          return { rowCount: 1, rows: [{ schema: 'tenant_exact', valid: false }] };
        }
        if (query.includes('pg_advisory_unlock')) {
          return { rowCount: 1, rows: [{ unlocked: true }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const directory = await migrationDirectory(
      `-- continuum:no-transaction
-- continuum:require-valid-index exact_idx;`,
    );

    await expect(runMigrations(
      { connect: vi.fn(async () => client) } as unknown as pg.Pool, directory,
    )).rejects.toThrow(/required index exact_idx is missing or invalid/);
    expect(queries.some((query) => query.includes(
      'INSERT INTO _continuum_migrations (name) VALUES',
    ))).toBe(false);
  });

  it('uses one dedicated client and locks before inspecting the ledger', async () => {
    const queries: string[] = [];
    const release = vi.fn();
    const client = {
      query: vi.fn(async (query: string) => {
        queries.push(query.trim());
        if (query.includes('SELECT 1 FROM _continuum_migrations')) {
          return { rowCount: 0, rows: [] };
        }
        if (query.includes('pg_advisory_unlock')) {
          return { rowCount: 1, rows: [{ unlocked: true }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release,
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(() => {
        throw new Error('pool.query must not be used during migrations');
      }),
    };
    const directory = await migrationDirectory('SELECT 42;');

    const applied = await runMigrations(pool as unknown as pg.Pool, directory);

    expect(applied).toHaveLength(1);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(queries[0]).toContain('pg_advisory_lock');
    expect(queries[1]).toContain('CREATE TABLE IF NOT EXISTS _continuum_migrations');
    expect(queries.at(-1)).toContain('pg_advisory_unlock');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('destroys the client when lock acquisition fails', async () => {
    const release = vi.fn();
    const client = {
      query: vi.fn(async () => {
        throw new Error('lock unavailable');
      }),
      release,
    };
    const pool = { connect: vi.fn(async () => client) };
    const directory = await migrationDirectory('SELECT 42;');

    await expect(
      runMigrations(pool as unknown as pg.Pool, directory),
    ).rejects.toThrow('lock unavailable');
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });

  it('preserves migration and unlock errors while still releasing the client', async () => {
    const release = vi.fn();
    const client = {
      query: vi.fn(async (query: string) => {
        if (query.includes('SELECT 1 FROM _continuum_migrations')) {
          return { rowCount: 0, rows: [] };
        }
        if (query === 'SELECT 42;') throw new Error('migration exploded');
        if (query.includes('pg_advisory_unlock')) {
          throw new Error('unlock exploded');
        }
        return { rowCount: 1, rows: [] };
      }),
      release,
    };
    const pool = { connect: vi.fn(async () => client) };
    const directory = await migrationDirectory('SELECT 42;');

    const error = await runMigrations(
      pool as unknown as pg.Pool,
      directory,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as AggregateError).errors[0]).toMatchObject({
      message: 'Migration 001_test.sql failed: migration exploded',
    });
    expect((error as AggregateError).errors[1]).toMatchObject({
      message: 'unlock exploded',
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });

  it('serializes concurrent runners so a migration executes exactly once', async () => {
    const schema = `migrator_concurrent_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const firstPool = schemaPool(schema);
    const secondPool = schemaPool(schema);
    const directory = await migrationDirectory(`
      SELECT pg_sleep(0.25);
      CREATE TABLE migration_effects (id integer PRIMARY KEY);
      INSERT INTO migration_effects (id) VALUES (1);
    `);

    try {
      const results = await Promise.all([
        runMigrations(firstPool, directory),
        runMigrations(secondPool, directory),
      ]);

      expect(results.map((result) => result.length).sort()).toEqual([0, 1]);
      const effect = await admin.query(
        `SELECT count(*)::int AS count FROM ${schema}.migration_effects`,
      );
      expect(effect.rows[0].count).toBe(1);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('releases the lock after failure so another runner can retry', async () => {
    const schema = `migrator_retry_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const failingPool = schemaPool(schema);
    const retryPool = schemaPool(schema);
    const directory = await migrationDirectory(
      "DO $$ BEGIN RAISE EXCEPTION 'expected failure'; END $$;",
    );

    try {
      await expect(runMigrations(failingPool, directory)).rejects.toThrow(
        'Migration 001_test.sql failed: expected failure',
      );

      await writeFile(
        join(directory, '001_test.sql'),
        'CREATE TABLE retry_succeeded (id integer PRIMARY KEY);',
      );
      await retryPool.query('SET statement_timeout = 2000');

      await expect(runMigrations(retryPool, directory)).resolves.toHaveLength(1);
      const ledger = await admin.query(
        `SELECT name FROM ${schema}._continuum_migrations`,
      );
      expect(ledger.rows).toEqual([{ name: '001_test.sql' }]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });
});
