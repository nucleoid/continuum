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
  ): Promise<Record<string, unknown>> {
    const connectionString = (pool as unknown as { options: PoolConfig }).options.connectionString;
    const { stdout } = await execFileAsync(process.execPath, [
      '--import', 'tsx', 'src/identity/admin-cli.ts', ...args,
    ], {
      cwd: process.cwd(), timeout,
      env: {
        ...process.env,
        CONTINUUM_DATABASE_URL: connectionString,
        CONTINUUM_ADMIN_ACTOR: operator.externalId,
        CONTINUUM_DB_POOL_MAX: '1',
      },
    });
    return JSON.parse(stdout.trim()) as Record<string, unknown>;
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
       VALUES ($1, $2, 'user', 'Concurrent page target', clock_timestamp());
       INSERT INTO scopes (id, kind, name) VALUES ($3, 'user', $4);
       INSERT INTO principal_user_scopes
         (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
          acknowledged_evidence_hash)
       VALUES ($1, $3, $5, ARRAY[$1::uuid], repeat('b', 64));
       INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, completed_at)
       VALUES ($1, $6, 2, NULL)`,
      [principalId(2000), `page-concurrent:${label}`,
        '20000000-0000-4000-8000-0000000007d0', `page-concurrent-scope:${label}`,
        value.operator.id, detachedPrincipalId],
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

  it('plans the production candidate query from disabled progress with bounded index probes', async () => {
    const active = await fixture('active-linkable-history');
    const dirty = await fixture('disabled-dirty-candidate');
    await pool.query(
      'UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1',
      [dirty.target.id],
    );
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, completed_at)
       VALUES ($1, $2, 3, clock_timestamp()),
              ($3, $2, 3, clock_timestamp())`,
      [dirty.target.id, detachedPrincipalId, active.target.id],
    );
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
       SELECT $1, 'write', $2, jsonb_build_object(
         'operation', 'lock_acquire', 'request_id', gen_random_uuid(),
         'run_id', gen_random_uuid(), 'lease_id', gen_random_uuid(),
         'resource', 'active-' || n, 'resource_sha256', repeat('a', 64))
         FROM generate_series(1, 20000) n`,
      [active.target.id, active.shared.id],
    );
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
       VALUES ($1, 'write', $2, jsonb_build_object(
         'operation', 'lock_release', 'request_id', gen_random_uuid(),
         'run_id', gen_random_uuid(), 'lease_id', gen_random_uuid(),
         'resource', 'dirty', 'resource_sha256', repeat('b', 64)))`,
      [dirty.target.id, dirty.shared.id],
    );
    await pool.query('ANALYZE audit_log');
    await pool.query('ANALYZE coordination_principal_privacy_progress');

    const plan = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT * FROM continuum_coordination_privacy_repair_candidates(
         NULL::uuid, NULL::uuid, 100)`,
    );
    const root = plan.rows[0]['QUERY PLAN'][0].Plan as Record<string, unknown>;
    const auditNodes: Array<Record<string, unknown>> = [];
    const indexes: string[] = [];
    const visit = (node: Record<string, unknown>) => {
      if (node['Relation Name'] === 'audit_log') auditNodes.push(node);
      if (node['Index Name']) indexes.push(String(node['Index Name']));
      for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) visit(child);
    };
    visit(root);
    expect(indexes).toContain('audit_log_coordination_privacy_linkable_idx');
    expect(auditNodes.every((node) => Number(node['Actual Rows'] ?? 0) <= 1)).toBe(true);
    expect(await listCoordinationPrivacyRepairs(pool, dirty.operator, 100)).toEqual([{
      principalId: dirty.target.id, scopeId: dirty.owned.id, state: 'disabled_only',
    }]);
  }, 60_000);

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

  it('keeps the real CLI running through cursor and phase-only batches', async () => {
    const value = await fixture('cli-durable-progress');
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
       SELECT $1, 'write', $2,
              jsonb_build_object('operation', 'principal_user_scope_mapped')
         FROM generate_series(1, 20)`,
      [value.target.id, value.owned.id],
    );
    const result = await adminCli(value.operator, [
      'offboard-principal', value.target.id,
      '--confirm-scope', value.owned.id, '--batch-size', '1',
    ]);
    expect(result.complete).toBe(true);
    expect(Number(result.attempts)).toBeGreaterThan(2);
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
    expect(blocked).toMatchObject({ complete: false, reason: 'live_lease' });
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
    expect(resumed.complete).toBe(true);
    expect(Number(resumed.attempts)).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
