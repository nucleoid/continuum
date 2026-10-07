import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg, { type PoolConfig } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addMembership } from '../storage/memberships.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { acquireLease } from './coordination.js';
import {
  listCoordinationPrivacyRepairs, mapOwnedUserScope,
} from './offboarding.js';

const execFileAsync = promisify(execFile);
const detachedPrincipalId = '00000000-0000-4000-8000-000000000012';

describe('coordination final review remediation', () => {
  let pool: pg.Pool;

  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
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

  async function adminCli(
    operator: Awaited<ReturnType<typeof fixture>>['operator'], args: string[], timeout = 30_000,
  ): Promise<{ exitCode: number; payload: Record<string, unknown>; stderr: string }> {
    const connectionString = (pool as unknown as { options: PoolConfig }).options.connectionString;
    const options = {
      cwd: process.cwd(), timeout,
      env: {
        ...process.env,
        CONTINUUM_DATABASE_URL: connectionString,
        CONTINUUM_ADMIN_ACTOR: operator.externalId,
        CONTINUUM_DB_POOL_MAX: '1',
      },
    };
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [
        'dist/identity/admin-cli.js', ...args,
      ], options);
      return {
        exitCode: 0,
        payload: JSON.parse(stdout.trim()) as Record<string, unknown>,
        stderr,
      };
    } catch (error) {
      const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
      if (typeof failed.code !== 'number' || !failed.stdout?.trim()) throw error;
      return {
        exitCode: failed.code,
        payload: JSON.parse(failed.stdout.trim()) as Record<string, unknown>,
        stderr: failed.stderr ?? '',
      };
    }
  }

  const principalId = (ordinal: number) =>
    `10000000-0000-4000-8000-${ordinal.toString(16).padStart(12, '0')}`;

  it('fills stable pages from eligible disabled principals beyond 1000 rows during mutations', async () => {
    const value = await fixture('eligible-pages');
    const label = randomUUID();
    await pool.query(
      `INSERT INTO principals (id, external_id, kind, display_name, disabled_at, reactivated_at)
       SELECT ('10000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $1 || ':' || n, 'user', 'Page target',
              CASE WHEN n > 10 THEN clock_timestamp() ELSE NULL END,
              CASE WHEN n <= 10 THEN clock_timestamp() ELSE NULL END
         FROM generate_series(1, 1015) n`,
      [`page-target:${label}`],
    );
    await pool.query(
      `INSERT INTO scopes (id, kind, name)
       SELECT ('20000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              'user', $1 || ':' || n
         FROM generate_series(1, 1015) n`,
      [`page-scope:${label}`],
    );
    await pool.query(
      `INSERT INTO principal_user_scopes
         (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
          acknowledged_evidence_hash)
       SELECT ('10000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              ('20000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $1, ARRAY[('10000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid],
              repeat('a', 64)
         FROM generate_series(1, 1015) n`,
      [value.operator.id],
    );
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, completed_at)
       SELECT ('10000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $1, 2, NULL
         FROM generate_series(1, 1015) n`,
      [detachedPrincipalId],
    );

    const first = await listCoordinationPrivacyRepairs(pool, value.operator, 100);
    expect(first).toHaveLength(100);
    expect(first[0].principalId).toBe(principalId(11));

    await pool.query(
      `UPDATE principals SET disabled_at = NULL, reactivated_at = clock_timestamp()
        WHERE id = $1`,
      [principalId(500)],
    );
    await pool.query(
      `INSERT INTO principals (id, external_id, kind, display_name, disabled_at)
       VALUES ($1, $2, 'user', 'Concurrent page target', clock_timestamp())`,
      [principalId(2000), `page-concurrent:${label}`],
    );
    await pool.query(
      `INSERT INTO scopes (id, kind, name) VALUES ($1, 'user', $2)`,
      ['20000000-0000-4000-8000-0000000007d0', `page-concurrent-scope:${label}`],
    );
    await pool.query(
      `INSERT INTO principal_user_scopes
         (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
          acknowledged_evidence_hash)
       VALUES ($1, $2, $3, ARRAY[$1::uuid], repeat('b', 64))`,
      [principalId(2000), '20000000-0000-4000-8000-0000000007d0', value.operator.id],
    );
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, completed_at)
       VALUES ($1, $2, 2, NULL)`,
      [principalId(2000), detachedPrincipalId],
    );

    const seen = first.map((candidate) => candidate.principalId);
    let after = seen.at(-1)!;
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const page = await listCoordinationPrivacyRepairs(pool, value.operator, 100, after);
      seen.push(...page.map((candidate) => candidate.principalId));
      if (page.length < 100) break;
      after = page.at(-1)!.principalId;
    }
    const expected = Array.from({ length: 1005 }, (_, index) => principalId(index + 11))
      .filter((id) => id !== principalId(500));
    expected.push(principalId(2000));
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  }, 60_000);

  it('keeps completed-dirty cursors stable across reactivation and later dirty mutations', async () => {
    const value = await fixture('dirty-cursor-mutations');
    const label = randomUUID();
    await pool.query(
      `INSERT INTO principals (id, external_id, kind, display_name, disabled_at)
       SELECT ('11000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $1 || ':' || n, 'user', 'Dirty cursor target', clock_timestamp()
         FROM generate_series(1, 4) n`,
      [`dirty-cursor:${label}`],
    );
    await pool.query(
      `INSERT INTO scopes (id, kind, name)
       SELECT ('21000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              'user', $1 || ':' || n
         FROM generate_series(1, 4) n`,
      [`dirty-cursor-scope:${label}`],
    );
    await pool.query(
      `INSERT INTO principal_user_scopes
         (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
          acknowledged_evidence_hash)
       SELECT ('11000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              ('21000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $1,
              ARRAY[('11000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid],
              repeat('d', 64)
         FROM generate_series(1, 4) n`,
      [value.operator.id],
    );
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, completed_at)
       SELECT ('11000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $1, 3, clock_timestamp()
         FROM generate_series(1, 4) n`,
      [detachedPrincipalId],
    );
    const dirtyId = (ordinal: number) =>
      `11000000-0000-4000-8000-${ordinal.toString(16).padStart(12, '0')}`;
    const dirtyScopeId = (ordinal: number) =>
      `21000000-0000-4000-8000-${ordinal.toString(16).padStart(12, '0')}`;
    for (const ordinal of [1, 2, 3]) {
      await pool.query(
        `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
         VALUES ($1, 'write', $2, jsonb_build_object(
           'operation', 'lock_inspect', 'request_id', gen_random_uuid()))`,
        [dirtyId(ordinal), dirtyScopeId(ordinal)],
      );
    }

    const first = await listCoordinationPrivacyRepairs(pool, value.operator, 2);
    expect(first.map(({ principalId }) => principalId)).toEqual([dirtyId(1), dirtyId(2)]);
    await pool.query(
      `UPDATE principals SET disabled_at = NULL, reactivated_at = clock_timestamp()
        WHERE id = $1`, [dirtyId(3)],
    );
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
       VALUES ($1, 'write', $2, jsonb_build_object(
         'operation', 'lock_inspect', 'request_id', gen_random_uuid()))`,
      [dirtyId(4), dirtyScopeId(4)],
    );
    expect((await listCoordinationPrivacyRepairs(
      pool, value.operator, 2, dirtyId(2),
    )).map(({ principalId }) => principalId)).toEqual([dirtyId(4)]);

    await pool.query(
      'UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1', [dirtyId(3)],
    );
    expect((await listCoordinationPrivacyRepairs(
      pool, value.operator, 2, dirtyId(2),
    )).map(({ principalId }) => principalId)).toEqual([dirtyId(3), dirtyId(4)]);
    expect((await listCoordinationPrivacyRepairs(
      pool, value.operator, 10,
    )).map(({ principalId }) => principalId)).toEqual([
      dirtyId(1), dirtyId(2), dirtyId(3), dirtyId(4),
    ]);
  }, 30_000);

  it('plans the generic production function from dirty indexes with 50000 clean rows', async () => {
    const dirty = await fixture('disabled-dirty-candidate');
    await pool.query(
      'UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1',
      [dirty.target.id],
    );
    await pool.query(
      `INSERT INTO principals (id, external_id, kind, display_name, disabled_at)
       SELECT ('30000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $1 || ':' || n, 'user', 'Clean completed target', clock_timestamp()
         FROM generate_series(1, 50000) n`,
      [`clean-completed:${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO scopes (id, kind, name)
       SELECT ('40000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              'user', $1 || ':' || n
         FROM generate_series(1, 50000) n`,
      [`clean-completed-scope:${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO principal_user_scopes
         (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
          acknowledged_evidence_hash)
       SELECT ('30000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              ('40000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $1,
              ARRAY[('30000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid],
              repeat('c', 64)
         FROM generate_series(1, 50000) n`,
      [dirty.operator.id],
    );
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, completed_at)
       SELECT ('30000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $1, 3, clock_timestamp()
         FROM generate_series(1, 50000) n`,
      [detachedPrincipalId],
    );
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, completed_at)
       VALUES ($1, $2, 3, clock_timestamp())`,
      [dirty.target.id, detachedPrincipalId],
    );
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
       VALUES ($1, 'write', $2, jsonb_build_object(
         'operation', 'lock_release', 'request_id', gen_random_uuid(),
         'run_id', gen_random_uuid(), 'lease_id', gen_random_uuid(),
         'resource', 'dirty', 'resource_sha256', repeat('b', 64)))`,
      [dirty.target.id, dirty.shared.id],
    );
    await pool.query('ANALYZE principals');
    await pool.query('ANALYZE principal_user_scopes');
    await pool.query('ANALYZE audit_log');
    await pool.query('ANALYZE coordination_principal_privacy_progress');

    await pool.query('SELECT pg_stat_force_next_flush()');
    const scansBefore = BigInt((await pool.query(
      `SELECT COALESCE(idx_scan, 0)::text AS scans
         FROM pg_stat_user_indexes
        WHERE schemaname = current_schema()
          AND indexrelname = 'coordination_principal_privacy_repair_idx'`,
    )).rows[0]?.scans ?? '0');
    await pool.query('SET plan_cache_mode = force_generic_plan');
    await pool.query(
      `PREPARE production_privacy_repairs(uuid, uuid, uuid, integer) AS
       SELECT * FROM continuum_operator_list_coordination_privacy_repairs($1, $2, $3, $4)`,
    );
    const plan = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       EXECUTE production_privacy_repairs(
         '${dirty.operator.id}'::uuid, NULL::uuid, NULL::uuid, 100)`,
    );
    const root = plan.rows[0]['QUERY PLAN'][0].Plan as Record<string, unknown>;
    const buffers = Number(root['Shared Hit Blocks'] ?? 0)
      + Number(root['Shared Read Blocks'] ?? 0);
    expect(root['Actual Rows']).toBe(1);
    expect(buffers).toBeLessThan(2_000);
    await pool.query('SELECT pg_stat_force_next_flush()');
    const scansAfter = BigInt((await pool.query(
      `SELECT COALESCE(idx_scan, 0)::text AS scans
         FROM pg_stat_user_indexes
        WHERE schemaname = current_schema()
          AND indexrelname = 'coordination_principal_privacy_repair_idx'`,
    )).rows[0]?.scans ?? '0');
    expect(scansAfter).toBeGreaterThan(scansBefore);
    expect(await listCoordinationPrivacyRepairs(pool, dirty.operator, 100)).toEqual([{
      principalId: dirty.target.id, scopeId: dirty.owned.id, state: 'disabled_only',
    }]);
  }, 120_000);

  it('skips a locked expired detached receipt under a caller-owned timeout', async () => {
    const value = await fixture('detached-purge-lock');
    await pool.query(
      `INSERT INTO coordination_resources (scope_id, resource) VALUES ($1, 'expired')`,
      [value.shared.id],
    );
    await pool.query(
      `INSERT INTO coordination_operation_receipts
         (principal_id, operation, request_id, payload_hash, outcome, scope_id,
          resource, expires_at, server_time, retry_after_seconds, retain_until)
       VALUES ($2, 'acquire', $3, sha256(convert_to('expired', 'UTF8')),
               'contended', $1, 'expired', clock_timestamp() - interval '2 minutes',
               clock_timestamp() - interval '2 minutes', 0,
               clock_timestamp() - interval '1 minute')`,
      [value.shared.id, detachedPrincipalId, randomUUID()],
    );
    await pool.query(
      'UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1',
      [value.target.id],
    );
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, completed_at)
       VALUES ($1, $2, 2, NULL)`,
      [value.target.id, detachedPrincipalId],
    );
    const blocker = await pool.connect();
    const caller = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `SELECT 1 FROM coordination_operation_receipts
          WHERE principal_id = $1 FOR UPDATE`,
        [detachedPrincipalId],
      );
      await caller.query('BEGIN');
      await caller.query("SET LOCAL statement_timeout = '1000ms'");
      const scrub = await caller.query(
        `SELECT continuum_operator_scrub_coordination_principal($1, $2, $3, 10) AS result`,
        [value.operator.id, value.target.id, value.owned.id],
      );
      expect(scrub.rows[0].result.expired_detached_receipts_purged).toBe(0);
      await caller.query('COMMIT');
    } finally {
      await caller.query('ROLLBACK').catch(() => undefined);
      await blocker.query('ROLLBACK').catch(() => undefined);
      caller.release();
      blocker.release();
    }
  }, 15_000);

  it('returns promptly when a different scrub holds the detached usage row', async () => {
    const value = await fixture('detached-usage-contention');
    await pool.query(
      'UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1',
      [value.target.id],
    );
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, completed_at)
       VALUES ($1, $2, 2, NULL)`,
      [value.target.id, detachedPrincipalId],
    );
    await pool.query(
      `INSERT INTO coordination_principal_usage (principal_id)
       VALUES ($1) ON CONFLICT (principal_id) DO NOTHING`,
      [detachedPrincipalId],
    );
    const blocker = await pool.connect();
    const caller = await pool.connect();
    let pending: Promise<pg.QueryResult> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT 1 FROM coordination_principal_usage WHERE principal_id = $1 FOR UPDATE',
        [detachedPrincipalId],
      );
      await caller.query('BEGIN');
      pending = caller.query(
        `SELECT continuum_operator_scrub_coordination_principal($1, $2, $3, 10) AS result`,
        [value.operator.id, value.target.id, value.owned.id],
      );
      const outcome = await Promise.race([
        pending.then((result) => ({ timedOut: false as const, result })),
        new Promise<{ timedOut: true }>((resolve) => {
          setTimeout(() => resolve({ timedOut: true }), 500);
        }),
      ]);
      if (outcome.timedOut) {
        await blocker.query('ROLLBACK');
        await pending;
      }
      expect(outcome.timedOut).toBe(false);
      if (!outcome.timedOut) {
        expect(outcome.result.rows[0].result).toMatchObject({
          complete: false, progressed: false, reason: 'lock_busy',
        });
      }
    } finally {
      await caller.query('ROLLBACK').catch(() => undefined);
      await blocker.query('ROLLBACK').catch(() => undefined);
      if (pending) await pending.catch(() => undefined);
      caller.release();
      blocker.release();
    }
  }, 15_000);

  it('uses one bounded lock order for two principals scrubbing the same scope', async () => {
    const first = await fixture('shared-scope-first');
    const second = await createPrincipal(pool, {
      externalId: `target:shared-scope-second:${randomUUID()}`,
      kind: 'user', displayName: 'Second target',
    });
    const secondOwned = await createScope(pool, {
      kind: 'user', name: `shared-scope-second-owned-${randomUUID()}`,
    });
    await addMembership(pool, second.id, secondOwned.id, 'writer');
    await addMembership(pool, second.id, first.shared.id, 'writer');
    await mapOwnedUserScope(pool, first.operator, second.id, secondOwned.id);
    await pool.query(
      `INSERT INTO coordination_resources (scope_id, resource) VALUES ($1, 'shared')`,
      [first.shared.id],
    );
    for (const target of [first.target, second]) {
      await pool.query(
        'UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1', [target.id],
      );
      await pool.query(
        `INSERT INTO coordination_principal_privacy_progress
           (principal_id, detached_principal_id, privacy_version, completed_at)
         VALUES ($1, $2, 2, NULL)`,
        [target.id, detachedPrincipalId],
      );
      await pool.query(
        `INSERT INTO coordination_operation_receipts
           (principal_id, operation, request_id, payload_hash, outcome, scope_id,
            resource, expires_at, server_time, retry_after_seconds, retain_until)
         VALUES ($1::uuid, 'acquire', gen_random_uuid(),
                 sha256(convert_to(($1::uuid)::text, 'UTF8')),
                 'contended', $2, 'shared', clock_timestamp() + interval '1 minute',
                 clock_timestamp(), 1,
                 clock_timestamp() + interval '1 minute')`,
        [target.id, first.shared.id],
      );
    }

    const firstCaller = await pool.connect();
    const secondCaller = await pool.connect();
    let pending: Promise<pg.QueryResult> | undefined;
    try {
      await firstCaller.query('BEGIN');
      const firstResult = await firstCaller.query(
        `SELECT continuum_operator_scrub_coordination_principal($1, $2, $3, 10) AS result`,
        [first.operator.id, first.target.id, first.owned.id],
      );
      expect(firstResult.rows[0].result.progressed).toBe(true);

      await secondCaller.query('BEGIN');
      pending = secondCaller.query(
        `SELECT continuum_operator_scrub_coordination_principal($1, $2, $3, 10) AS result`,
        [first.operator.id, second.id, secondOwned.id],
      );
      const outcome = await Promise.race([
        pending.then((result) => ({ timedOut: false as const, result })),
        new Promise<{ timedOut: true }>((resolve) => {
          setTimeout(() => resolve({ timedOut: true }), 500);
        }),
      ]);
      if (outcome.timedOut) {
        await firstCaller.query('COMMIT');
        await pending;
      }
      expect(outcome.timedOut).toBe(false);
      if (!outcome.timedOut) {
        expect(outcome.result.rows[0].result).toMatchObject({
          complete: false, progressed: false, reason: 'lock_busy',
        });
      }
    } finally {
      await secondCaller.query('ROLLBACK').catch(() => undefined);
      await firstCaller.query('ROLLBACK').catch(() => undefined);
      if (pending) await pending.catch(() => undefined);
      secondCaller.release();
      firstCaller.release();
    }
  }, 15_000);

  it('keeps the real CLI running through cursor and phase-only batches', async () => {
    const value = await fixture('cli-durable-progress');
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
       SELECT $1, 'write', $2,
              jsonb_build_object('operation', 'principal_user_scope_mapped')
         FROM generate_series(1, 20)`,
      [value.target.id, value.owned.id],
    );
    const first = await adminCli(value.operator, [
      'offboard-principal', value.target.id,
      '--confirm-scope', value.owned.id, '--batch-size', '1', '--once',
    ]);
    expect(first).toMatchObject({
      exitCode: 2,
      payload: { complete: false, incompleteReason: 'single_batch', attempts: 1 },
      stderr: '',
    });
    const completed = await adminCli(value.operator, [
      'offboard-principal', value.target.id,
      '--confirm-scope', value.owned.id, '--batch-size', '1',
    ]);
    expect(completed.exitCode).toBe(0);
    expect(completed.payload.complete).toBe(true);
    expect(Number(completed.payload.attempts)).toBeGreaterThan(2);
    expect((await pool.query(
      `SELECT memory_complete, scope_cleanup_complete, audit_memory_complete,
              audit_linked_complete, completed_at IS NOT NULL AS completed
         FROM principal_offboarding_runs WHERE principal_id = $1`,
      [value.target.id],
    )).rows).toEqual([{
      memory_complete: true, scope_cleanup_complete: true,
      audit_memory_complete: true, audit_linked_complete: true, completed: true,
    }]);
  }, 60_000);

  it('reports a shared-lease block and the real CLI resumes after expiry', async () => {
    const value = await fixture('cli-block-resume');
    const held = await acquireLease(pool, value.target, {
      scope: `project:${value.shared.name}`, resource: 'held', runId: randomUUID(),
      requestId: randomUUID(), ttlSeconds: 300,
    });
    expect(held).toMatchObject({ acquired: true });
    const blocked = await adminCli(value.operator, [
      'offboard-principal', value.target.id,
      '--confirm-scope', value.owned.id, '--batch-size', '10',
    ]);
    expect(blocked).toMatchObject({
      exitCode: 3,
      payload: {
        complete: false, reason: 'live_lease', incompleteReason: 'blocked',
        blockedUntil: expect.any(String),
      },
      stderr: '',
    });
    await pool.query(
      `UPDATE coordination_leases
          SET acquired_at = clock_timestamp() - interval '10 minutes',
              expires_at = clock_timestamp() - interval '1 second'
        WHERE lease_id = $1`,
      [(held as { leaseId: string }).leaseId],
    );
    const resumed = await adminCli(value.operator, [
      'offboard-principal', value.target.id,
      '--confirm-scope', value.owned.id, '--batch-size', '10',
    ]);
    expect(resumed.exitCode).toBe(0);
    expect(resumed.payload.complete).toBe(true);
    expect(Number(resumed.payload.attempts)).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('returns nonzero structured repair CLI status while blocked and succeeds after resume', async () => {
    const value = await fixture('repair-cli-block-resume');
    const held = await acquireLease(pool, value.target, {
      scope: `project:${value.shared.name}`, resource: 'held-repair', runId: randomUUID(),
      requestId: randomUUID(), ttlSeconds: 300,
    });
    expect(held).toMatchObject({ acquired: true });
    await pool.query(
      'UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1',
      [value.target.id],
    );
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, completed_at)
       VALUES ($1, $2, 2, NULL)`,
      [value.target.id, detachedPrincipalId],
    );

    const blocked = await adminCli(value.operator, [
      'repair-coordination-privacy', value.target.id,
      '--confirm-scope', value.owned.id, '--batch-size', '10',
    ]);
    expect(blocked).toMatchObject({
      exitCode: 3,
      payload: {
        complete: false, reason: 'live_lease', incompleteReason: 'blocked',
        blockedUntil: expect.any(String),
      },
      stderr: '',
    });

    await pool.query(
      `UPDATE coordination_leases
          SET acquired_at = clock_timestamp() - interval '10 minutes',
              expires_at = clock_timestamp() - interval '1 second'
        WHERE lease_id = $1`,
      [(held as { leaseId: string }).leaseId],
    );
    const resumed = await adminCli(value.operator, [
      'repair-coordination-privacy', value.target.id,
      '--confirm-scope', value.owned.id, '--batch-size', '10',
    ]);
    expect(resumed.exitCode).toBe(0);
    expect(resumed.payload).toMatchObject({ complete: true, incompleteReason: null });
  }, 60_000);
});
