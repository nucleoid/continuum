import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg, { type PoolConfig } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { offboardPrincipal, mapOwnedUserScope } from '../services/offboarding.js';
import { acquireLease, releaseLease, renewLease } from '../services/coordination.js';
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
    const lockRequestId = randomUUID();
    const lockRunId = randomUUID();
    const retentionRequestId = randomUUID();
    const retentionRunId = randomUUID();
    const offboardingRequestId = randomUUID();
    const offboardingRunId = randomUUID();
    const ids = (await pool.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, metadata) VALUES
       ($1, 'write', $2, jsonb_build_object('operation', 'lock_acquire',
         'request_id', $3::uuid, 'run_id', $4::uuid,
         'resource_sha256', repeat('c', 64))),
       ($1, 'write', NULL, jsonb_build_object('source', 'audit-retention',
         'run_id', $5::uuid, 'request_id', $6::uuid, 'evidence', 'retain-me')),
       ($1, 'write', NULL, jsonb_build_object('operation', 'offboarding_scope_access_closed',
         'run_id', $7::uuid, 'request_id', $8::uuid, 'evidence', 'offboarding-intact'))
       RETURNING id::text`, [
        value.target.id, shared.id, lockRequestId, lockRunId,
        retentionRunId, retentionRequestId, offboardingRunId, offboardingRequestId,
      ],
    )).rows.map((row) => row.id as string);
    await pool.query(
      `UPDATE principals SET disabled_at = clock_timestamp(),
              offboarded_at = clock_timestamp()
        WHERE id = $1`, [value.target.id],
    );
    const operator = await createOperator(value.operator.id);
    try {
      await expect(operator.query(
        'SELECT continuum_operator_scrub_coordination_principal($1, $2, $3, 10)',
        [value.operator.id, value.target.id, value.owned.id],
      )).resolves.toBeDefined();
      const rows = (await pool.query(
        'SELECT id::text, metadata FROM audit_log WHERE id = ANY($1::bigint[]) ORDER BY id', [ids],
      )).rows;
      expect(rows[0].metadata).toEqual({ operation: 'lock_acquire' });
      expect(rows[1].metadata).toEqual({
        source: 'audit-retention', evidence: 'retain-me',
        request_id: retentionRequestId, run_id: retentionRunId,
      });
      expect(rows[2].metadata).toEqual({
        operation: 'offboarding_scope_access_closed', evidence: 'offboarding-intact',
        request_id: offboardingRequestId, run_id: offboardingRunId,
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
      )).resolves.toMatchObject({ rows: [{
        continuum_operator_scrub_coordination_principal: {
          complete: false, progressed: false, reason: 'lock_busy',
        },
      }] });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await operator.end();
    }
  });

  it('offboards real lock audit rows across batches and reports repair work honestly', async () => {
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
    for (const resource of ['completed-v1-a', 'completed-v1-b']) {
      const runId = randomUUID();
      const acquired = await acquireLease(pool, target, {
        scope: 'project:completed-v1-shared', resource, runId,
        requestId: randomUUID(), ttlSeconds: 300,
      });
      if (!acquired.acquired) throw new Error('expected real coordination acquisition');
      await renewLease(pool, target, {
        leaseId: acquired.leaseId, runId, requestId: randomUUID(), ttlSeconds: 300,
      });
      await releaseLease(pool, target, {
        leaseId: acquired.leaseId, runId, requestId: randomUUID(),
      });
    }
    const evidenceRequestId = randomUUID();
    const evidenceRunId = randomUUID();
    const evidenceId = String((await pool.query(
      `INSERT INTO audit_log (principal_id, action, metadata)
       VALUES ($1, 'write', jsonb_build_object(
         'operation', 'principal_offboarded', 'evidence', 'unrelated-offboarding-evidence',
         'request_id', $2::uuid, 'run_id', $3::uuid)) RETURNING id`,
      [admin.id, evidenceRequestId, evidenceRunId],
    )).rows[0].id);
    const realAuditRows = Number((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE principal_id = $1 AND metadata->>'operation' LIKE 'lock_%'`,
      [target.id],
    )).rows[0].count);
    expect(realAuditRows).toBeGreaterThan(1);

    let result = await offboardPrincipal(pool, admin, target.id, {
      confirmationScopeId: owned.id, batchSize: 1,
    });
    expect(result.alreadyOffboarded).toBe(false);
    let calls = 1;
    while (!result.complete && calls < 100) {
      result = await offboardPrincipal(pool, admin, target.id, {
        confirmationScopeId: owned.id, batchSize: 1,
      });
      calls += 1;
    }
    expect(result.complete).toBe(true);
    expect(result.alreadyOffboarded).toBe(false);
    expect(calls).toBeGreaterThan(1);
    expect((await pool.query(
      `SELECT bool_and(NOT metadata ?| ARRAY[
         'request_id','run_id','lease_id','resource','resource_sha256'
       ]) AS scrubbed
         FROM audit_log
        WHERE principal_id = $1 AND metadata->>'operation' LIKE 'lock_%'`,
      [target.id],
    )).rows).toEqual([{ scrubbed: true }]);
    expect((await pool.query(
      'SELECT metadata FROM audit_log WHERE id = $1', [evidenceId],
    )).rows[0].metadata).toEqual({
      operation: 'principal_offboarded', evidence: 'unrelated-offboarding-evidence',
      request_id: evidenceRequestId, run_id: evidenceRunId,
    });

  });
  it('uses principal-before-scope lock order with membership insertion without deadlock', async () => {
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
      await membershipWriter.query('SELECT 1 FROM principals WHERE id = $1 FOR UPDATE', [
        value.target.id,
      ]);
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

  it('orders cross-principal acquire with production offboarding in a shared user scope', async () => {
    const value = await privacyFixture('cross-principal-deadlock');
    const member = await createPrincipal(pool, {
      externalId: 'user:cross-principal-member', kind: 'user', displayName: 'Member',
    });
    await addMembership(pool, member.id, value.owned.id, 'writer');
    await mapOwnedUserScope(pool, value.operator, value.target.id, value.owned.id, true);
    const operator = await createOperator(value.operator.id);
    const appRole = `coord_exact_app_${Date.now()}_${roles.length}`;
    roles.push(appRole);
    await pool.query('CREATE ROLE ' + quoteRole(appRole) + ' NOLOGIN');
    await applyGrantScript(pool, 'grant-application-role.sql', { continuum_app_role: appRole });
    await pool.query(
      'GRANT ' + quoteRole(appRole)
      + ' TO CURRENT_USER WITH ADMIN OPTION, SET FALSE, INHERIT FALSE',
    );
    const schema = String((await pool.query('SELECT current_schema() AS schema')).rows[0].schema);
    const application = new pg.Pool({
      ...(pool as unknown as { options: PoolConfig }).options,
      max: 2, options: `-c search_path=${schema},public -c role=${appRole}`,
    });
    const blocker = await pool.connect();
    try {
      const operatorPid = Number((await operator.query(
        'SELECT pg_backend_pid() AS pid',
      )).rows[0].pid);
      const applicationPid = Number((await application.query(
        'SELECT pg_backend_pid() AS pid',
      )).rows[0].pid);
      const approvalId = (await pool.query(
        `SELECT id FROM principal_user_scope_approvals
          WHERE principal_id = $1 AND scope_id = $2 ORDER BY id DESC LIMIT 1`,
        [value.target.id, value.owned.id],
      )).rows[0].id;
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT 1 FROM principal_user_scope_approvals WHERE id = $1 FOR UPDATE',
        [approvalId],
      );
      const offboarding = offboardPrincipal(operator, value.operator, value.target.id, {
        confirmationScopeId: value.owned.id, batchSize: 10,
      }).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      let ownerLocked = false;
      for (let attempt = 0; attempt < 100 && !ownerLocked; attempt += 1) {
        ownerLocked = Boolean((await pool.query(
          `SELECT wait_event_type = 'Lock' AS locked
             FROM pg_stat_activity WHERE pid = $1`, [operatorPid],
        )).rows[0]?.locked);
        if (!ownerLocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(ownerLocked).toBe(true);
      const acquire = acquireLease(application, member, {
        scope: `user:${value.owned.name}`, resource: 'cross-principal',
        runId: randomUUID(), requestId: randomUUID(), ttlSeconds: 300,
      }).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      let acquireWaiting = false;
      for (let attempt = 0; attempt < 100 && !acquireWaiting; attempt += 1) {
        acquireWaiting = Boolean((await pool.query(
          `SELECT wait_event_type = 'Lock' AS waiting
             FROM pg_stat_activity WHERE pid = $1`, [applicationPid],
        )).rows[0]?.waiting);
        if (!acquireWaiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(acquireWaiting).toBe(true);
      await blocker.query('COMMIT');
      const [offboardOutcome, acquireOutcome] = await Promise.all([offboarding, acquire]);
      expect(offboardOutcome).toMatchObject({ ok: true });
      expect(acquireOutcome).toMatchObject({
        ok: false, error: { code: 'SCOPE_NOT_FOUND' },
      });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await application.end();
      await operator.end();
    }
  }, 30_000);

  it('lets an acquire already holding principal authorization finish before offboarding', async () => {
    const value = await privacyFixture('acquire-first');
    await mapOwnedUserScope(pool, value.operator, value.target.id, value.owned.id);
    const applicationRole = `coord_acquire_first_${Date.now()}_${roles.length}`;
    roles.push(applicationRole);
    await pool.query('CREATE ROLE ' + quoteRole(applicationRole) + ' NOLOGIN');
    await applyGrantScript(pool, 'grant-application-role.sql', {
      continuum_app_role: applicationRole,
    });
    await pool.query(
      'GRANT ' + quoteRole(applicationRole)
      + ' TO CURRENT_USER WITH ADMIN OPTION, SET FALSE, INHERIT FALSE',
    );
    const schema = String((await pool.query('SELECT current_schema() AS schema')).rows[0].schema);
    const application = new pg.Pool({
      ...(pool as unknown as { options: PoolConfig }).options,
      max: 1, options: `-c search_path=${schema},public -c role=${applicationRole}`,
    });
    const blocker = await pool.connect();
    try {
      const applicationPid = Number((await application.query(
        'SELECT pg_backend_pid() AS pid',
      )).rows[0].pid);
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 604692072))',
        [value.owned.id],
      );
      const acquireRunId = randomUUID();
      const acquire = acquireLease(application, value.target, {
        scope: `user:${value.owned.name}`, resource: 'acquire-first',
        runId: acquireRunId, requestId: randomUUID(), ttlSeconds: 300,
      });
      let acquireWaiting = false;
      for (let attempt = 0; attempt < 100 && !acquireWaiting; attempt += 1) {
        acquireWaiting = Boolean((await pool.query(
          `SELECT wait_event_type = 'Lock' AS waiting
             FROM pg_stat_activity WHERE pid = $1`, [applicationPid],
        )).rows[0]?.waiting);
        if (!acquireWaiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(acquireWaiting).toBe(true);
      let offboardingSettled = false;
      const offboarding = offboardPrincipal(pool, value.operator, value.target.id, {
        confirmationScopeId: value.owned.id, batchSize: 100,
      }).finally(() => { offboardingSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(offboardingSettled).toBe(false);
      await blocker.query('COMMIT');
      const acquired = await acquire;
      expect(acquired).toMatchObject({ acquired: true });
      await expect(offboarding).rejects.toThrow(/live coordination leases/i);
      if (!acquired.acquired) throw new Error('expected acquire-first lease');
      await releaseLease(application, value.target, {
        leaseId: acquired.leaseId, runId: acquireRunId, requestId: randomUUID(),
      });
      let result = await offboardPrincipal(pool, value.operator, value.target.id, {
        confirmationScopeId: value.owned.id, batchSize: 100,
      });
      for (let attempt = 0; !result.complete && attempt < 10; attempt += 1) {
        result = await offboardPrincipal(pool, value.operator, value.target.id, {
          confirmationScopeId: value.owned.id, batchSize: 100,
        });
      }
      expect(result.complete).toBe(true);
      expect((await pool.query(
        `SELECT count(*)::int AS live FROM coordination_leases
          WHERE principal_id = $1 AND released_at IS NULL AND expires_at > now()`,
        [value.target.id],
      )).rows).toEqual([{ live: 0 }]);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await application.end();
    }
  }, 30_000);
});
