import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg, { type PoolConfig } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { offboardPrincipal, mapOwnedUserScope } from '../services/offboarding.js';
import { addMembership } from './memberships.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { makeTestPool, resetData } from './test-helpers.js';

const quoteRole = (role: string) => `"${role.replaceAll('"', '""')}"`;

async function applyGrantScript(
  pool: pg.Pool, filename: string, variables: Record<string, string>,
): Promise<void> {
  const source = await readFile(join(process.cwd(), 'scripts', filename), 'utf8');
  const schema = String((await pool.query('SELECT current_schema() AS schema')).rows[0].schema);
  let sql = source.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n').replaceAll(':"continuum_schema"', quoteRole(schema));
  for (const [name, value] of Object.entries(variables)) {
    sql = sql.replaceAll(':"' + name + '"', quoteRole(value));
    sql = sql.replaceAll(":'" + name + "'", "'" + value.replaceAll("'", "''") + "'");
  }
  await pool.query(sql);
}

describe('coordination exact-head review regressions', () => {
  let pool: pg.Pool;
  const roles: string[] = [];

  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => {
    for (const role of roles.reverse()) {
      await pool.query('DROP OWNED BY ' + quoteRole(role));
      await pool.query('REVOKE ' + quoteRole(role) + ' FROM CURRENT_USER CASCADE');
      await pool.query('DROP ROLE ' + quoteRole(role));
    }
    await pool?.end();
  });

  async function createOperator(principalId: string) {
    const role = `coord_exact_${Date.now()}_${roles.length}`;
    roles.push(role);
    await pool.query('CREATE ROLE ' + quoteRole(role) + ' NOLOGIN');
    await applyGrantScript(pool, 'grant-application-role.sql', { continuum_app_role: role });
    await applyGrantScript(pool, 'grant-operator-role.sql', {
      continuum_operator_role: role, continuum_principal_id: principalId,
    });
    await pool.query('GRANT ' + quoteRole(role) + ' TO CURRENT_USER WITH ADMIN OPTION, SET FALSE, INHERIT FALSE');
    const schema = String((await pool.query('SELECT current_schema() AS schema')).rows[0].schema);
    return new pg.Pool({
      ...(pool as unknown as { options: PoolConfig }).options,
      max: 2, options: `-c search_path=${schema},public -c role=${role}`,
    });
  }

  async function privacyFixture(label: string) {
    const operator = await createPrincipal(pool, {
      externalId: `operator:${label}`, kind: 'user', displayName: 'Operator',
    });
    const target = await createPrincipal(pool, {
      externalId: `user:${label}`, kind: 'user', displayName: 'Target',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const owned = await createScope(pool, { kind: 'user', name: `${label}-owned` });
    await addMembership(pool, operator.id, org.id, 'admin');
    await addMembership(pool, target.id, owned.id, 'writer');
    await pool.query(
      `INSERT INTO principal_user_scopes
         (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
          acknowledged_evidence_hash)
       VALUES ($1, $2, $3, '{}'::uuid[], repeat('a', 64))`,
      [target.id, owned.id, operator.id],
    );
    return { operator, target, owned };
  }

  it('preserves audit-retention and offboarding evidence while scrubbing coordination metadata', async () => {
    const value = await privacyFixture('audit-selector');
    const shared = await createScope(pool, { kind: 'project', name: 'audit-selector-shared' });
    const ids = (await pool.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, metadata) VALUES
       ($1, 'write', $2, jsonb_build_object('operation', 'lock_acquire',
         'request_id', gen_random_uuid(), 'run_id', gen_random_uuid(),
         'resource_sha256', repeat('c', 64))),
       ($1, 'write', NULL, jsonb_build_object('source', 'audit-retention',
         'run_id', gen_random_uuid(), 'request_id', gen_random_uuid(), 'evidence', 'retain-me')),
       ($1, 'write', NULL, jsonb_build_object('operation', 'offboarding_scope_access_closed',
         'run_id', gen_random_uuid(), 'request_id', gen_random_uuid(), 'evidence', 'offboarding-intact'))
       RETURNING id::text`, [value.target.id, shared.id],
    )).rows.map((row) => row.id as string);
    await pool.query('UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1', [value.target.id]);
    const operator = await createOperator(value.operator.id);
    try {
      await expect(operator.query(
        'SELECT continuum_operator_scrub_coordination_principal($1, $2, $3, 10)',
        [value.operator.id, value.target.id, value.owned.id],
      )).resolves.toBeDefined();
      const rows = (await pool.query(
        'SELECT id::text, metadata FROM audit_log WHERE id = ANY($1::bigint[]) ORDER BY id', [ids],
      )).rows;
      expect(rows[0].metadata).not.toHaveProperty('run_id');
      expect(rows[1].metadata).toMatchObject({ source: 'audit-retention', evidence: 'retain-me' });
      expect(rows[2].metadata).toMatchObject({
        operation: 'offboarding_scope_access_closed', evidence: 'offboarding-intact',
      });
    } finally { await operator.end(); }
  });

  it('locks exactly the selected receipt scope before mutating a one-row batch', async () => {
    const value = await privacyFixture('exact-scope');
    const first = await createScope(pool, { kind: 'project', name: 'exact-scope-a' });
    const second = await createScope(pool, { kind: 'project', name: 'exact-scope-b' });
    const [lower, higher] = (await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM scopes WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[first.id, second.id]],
    )).rows;
    await pool.query(
      `INSERT INTO coordination_resources (scope_id, resource) VALUES
       ($1, 'lower'), ($2, 'higher')`, [lower.id, higher.id],
    );
    await pool.query(
      `INSERT INTO coordination_operation_receipts
         (principal_id, operation, request_id, payload_hash, outcome, scope_id,
          resource, expires_at, server_time, retry_after_seconds, retain_until) VALUES
       ($1, 'acquire', 'ffffffff-ffff-4fff-8fff-ffffffffffff', sha256(convert_to('lower', 'UTF8')),
        'contended', $2, 'lower', now(), now(), 1, now() + interval '1 day'),
       ($1, 'acquire', '00000000-0000-4000-8000-000000000001', sha256(convert_to('higher', 'UTF8')),
        'contended', $3, 'higher', now(), now(), 1, now() + interval '1 day')`,
      [value.target.id, lower.id, higher.id],
    );
    await pool.query('UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1', [value.target.id]);
    const operator = await createOperator(value.operator.id);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 761))', [higher.id]);
      await operator.query("SET lock_timeout = '100ms'");
      await expect(operator.query(
        'SELECT continuum_operator_scrub_coordination_principal($1, $2, $3, 1)',
        [value.operator.id, value.target.id, value.owned.id],
      )).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await operator.end();
    }
  });

  it('re-scrubs completed-v1 coordination privacy before reporting complete', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'operator:completed-v1', kind: 'user', displayName: 'Operator',
    });
    const target = await createPrincipal(pool, {
      externalId: 'user:completed-v1', kind: 'user', displayName: 'Target',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const owned = await createScope(pool, { kind: 'user', name: 'completed-v1-owned' });
    const shared = await createScope(pool, { kind: 'project', name: 'completed-v1-shared' });
    await addMembership(pool, admin.id, org.id, 'admin');
    await addMembership(pool, target.id, owned.id, 'writer');
    await addMembership(pool, target.id, shared.id, 'writer');
    await mapOwnedUserScope(pool, admin, target.id, owned.id);
    let result = await offboardPrincipal(pool, admin, target.id, { confirmationScopeId: owned.id });
    while (!result.complete) {
      result = await offboardPrincipal(pool, admin, target.id, { confirmationScopeId: owned.id });
    }
    await pool.query('ALTER TABLE coordination_resources DISABLE TRIGGER USER');
    await pool.query('ALTER TABLE coordination_leases DISABLE TRIGGER USER');
    try {
      await pool.query(
        `INSERT INTO coordination_resources (scope_id, resource, fencing_token)
         VALUES ($1, 'completed-v1-stale', 7)`, [shared.id],
      );
      await pool.query(
        `INSERT INTO coordination_leases
           (lease_id, scope_id, resource, principal_id, run_id, fencing_token,
            acquired_at, expires_at, released_at, cleanup_eligible_at)
         VALUES (gen_random_uuid(), $1, 'completed-v1-stale', $2, gen_random_uuid(), 7,
                 '2000-01-01', '2000-01-01', '2000-01-01', '2000-01-01')`,
        [shared.id, target.id],
      );
    } finally {
      await pool.query('ALTER TABLE coordination_leases ENABLE TRIGGER USER');
      await pool.query('ALTER TABLE coordination_resources ENABLE TRIGGER USER');
    }
    await pool.query(
      `UPDATE coordination_principal_privacy_progress
          SET privacy_version = 1, completed_at = clock_timestamp(), audit_cursor_id = 0
        WHERE principal_id = $1`, [target.id],
    );
    result = await offboardPrincipal(pool, admin, target.id, {
      confirmationScopeId: owned.id, batchSize: 1,
    });
    while (!result.complete) {
      result = await offboardPrincipal(pool, admin, target.id, {
        confirmationScopeId: owned.id, batchSize: 1,
      });
    }
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM coordination_leases WHERE principal_id = $1',
      [target.id],
    )).rows).toEqual([{ count: 0 }]);
    expect((await pool.query(
      `SELECT privacy_version, completed_at IS NOT NULL AS complete
         FROM coordination_principal_privacy_progress WHERE principal_id = $1`, [target.id],
    )).rows).toEqual([{ privacy_version: 2, complete: true }]);
  });
  it('shares advisory-before-principal lock order with membership insertion without deadlock', async () => {
    const value = await privacyFixture('deadlock-order');
    const shared = await createScope(pool, { kind: 'project', name: 'deadlock-order-shared' });
    await pool.query(
      `INSERT INTO coordination_resources (scope_id, resource) VALUES ($1, 'deadlock')`,
      [shared.id],
    );
    await pool.query(
      `INSERT INTO coordination_operation_receipts
         (principal_id, operation, request_id, payload_hash, outcome, scope_id,
          resource, expires_at, server_time, retry_after_seconds, retain_until)
       VALUES ($1, 'acquire', gen_random_uuid(), sha256(convert_to('deadlock', 'UTF8')),
               'contended', $2, 'deadlock', now(), now(), 1, now() + interval '1 day')`,
      [value.target.id, shared.id],
    );
    await pool.query('UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1', [value.target.id]);
    const operator = await createOperator(value.operator.id);
    const scrubber = await operator.connect();
    const membershipWriter = await pool.connect();
    try {
      const scrubberPid = Number((await scrubber.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await membershipWriter.query('BEGIN');
      await membershipWriter.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 761))', [shared.id],
      );
      const scrubResult = scrubber.query(
        'SELECT continuum_operator_scrub_coordination_principal($1, $2, $3, 1)',
        [value.operator.id, value.target.id, value.owned.id],
      ).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      let waiting = false;
      for (let attempt = 0; attempt < 50 && !waiting; attempt += 1) {
        waiting = Boolean((await pool.query(
          `SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1`,
          [scrubberPid],
        )).rows[0]?.waiting);
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await expect(membershipWriter.query(
        `INSERT INTO scope_memberships (principal_id, scope_id, role, active)
         VALUES ($1, $2, 'writer', FALSE)`, [value.target.id, shared.id],
      )).resolves.toBeDefined();
      await membershipWriter.query('COMMIT');
      expect(await scrubResult).toEqual({ ok: true });
    } finally {
      await membershipWriter.query('ROLLBACK').catch(() => undefined);
      membershipWriter.release();
      scrubber.release();
      await operator.end();
    }
  });
});
