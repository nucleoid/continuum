import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { makeTestPool, resetData } from './test-helpers.js';
import {
  acquireLease,
  inspectLease,
  releaseLease,
  renewLease,
} from '../services/coordination.js';
import { ServiceError } from '../services/errors.js';

function expectCode(code: string) {
  return expect.objectContaining({ code });
}

describe('coordination storage and service', () => {
  let pool: pg.Pool;
  let otherPool: pg.Pool;
  let principal: Awaited<ReturnType<typeof createPrincipal>>;
  let scope: Awaited<ReturnType<typeof createScope>>;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    otherPool ??= new pg.Pool({
      connectionString: pool.options.connectionString,
      max: 2,
    });
    await resetData(pool);
    principal = await createPrincipal(pool, {
      externalId: 'service:coordination-owner',
      kind: 'service',
      displayName: 'Coordination owner',
    });
    scope = await createScope(pool, { kind: 'project', name: 'coordination-tests' });
    await addMembership(pool, principal.id, scope.id, 'writer');
  }, 30_000);

  afterAll(async () => {
    await otherPool?.end();
    await pool?.end();
  });

  function acquire(
    selectedPool: pg.Pool,
    resource: string,
    requestId = randomUUID(),
    runId = randomUUID(),
  ) {
    return acquireLease(selectedPool, principal, {
      scope: 'project:coordination-tests',
      resource,
      runId,
      requestId,
      ttlSeconds: 300,
    });
  }

  it('serializes a cross-pool race and keeps fencing as a decimal string', async () => {
    const runId = randomUUID();
    const results = await Promise.all([
      acquire(pool, 'github:nucleoid/continuum:issue:7', randomUUID(), runId),
      acquire(otherPool, 'github:nucleoid/continuum:issue:7', randomUUID(), runId),
    ]);
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    expect(results.filter((result) => !result.acquired)).toHaveLength(1);
    const winner = results.find((result) => result.acquired)!;
    expect(winner.acquired && winner.fencingToken).toBe('1');
    const state = await pool.query(
      `SELECT r.fencing_token::text AS token, count(l.*)::int AS leases
         FROM coordination_resources r
         JOIN coordination_leases l USING (scope_id, resource)
        WHERE r.scope_id = $1 AND r.resource = $2
        GROUP BY r.fencing_token`,
      [scope.id, 'github:nucleoid/continuum:issue:7'],
    );
    expect(state.rows).toEqual([{ token: '1', leases: 1 }]);
  });

  it('serializes concurrent duplicate request IDs into one exact replay', async () => {
    const requestId = randomUUID();
    const runId = randomUUID();
    const [first, second] = await Promise.all([
      acquire(pool, 'duplicate-request', requestId, runId),
      acquire(otherPool, 'duplicate-request', requestId, runId),
    ]);
    expect(second).toEqual(first);
    expect((await pool.query(
      `SELECT 1 FROM coordination_operation_receipts
        WHERE principal_id = $1 AND operation = 'acquire' AND request_id = $2`,
      [principal.id, requestId],
    )).rowCount).toBe(1);
  });

  it('is non-reentrant for fresh requests and exactly replays the original acquire', async () => {
    const runId = randomUUID();
    const requestId = randomUUID();
    const first = await acquire(pool, 'same-run', requestId, runId);
    const replay = await acquire(pool, 'same-run', requestId, runId);
    const fresh = await acquire(pool, 'same-run', randomUUID(), runId);
    expect(first).toEqual(replay);
    expect(fresh).toMatchObject({ acquired: false, reason: 'LOCK_HELD' });
    await expect(acquire(pool, 'different-input', requestId, runId))
      .rejects.toEqual(expectCode('IDEMPOTENCY_CONFLICT'));
  });

  it('replays a committed receipt and preserves fencing across process-pool restart', async () => {
    const requestId = randomUUID();
    const runId = randomUUID();
    const crashedProcessPool = new pg.Pool({
      connectionString: pool.options.connectionString,
      max: 1,
    });
    const first = await acquire(
      crashedProcessPool, 'restart-recovery', requestId, runId,
    );
    await crashedProcessPool.end();

    const replacementProcessPool = new pg.Pool({
      connectionString: pool.options.connectionString,
      max: 1,
    });
    try {
      expect(await acquire(
        replacementProcessPool, 'restart-recovery', requestId, runId,
      )).toEqual(first);
      await pool.query(
        `UPDATE coordination_leases
            SET acquired_at = clock_timestamp() - interval '2 seconds',
                expires_at = clock_timestamp() - interval '1 second'
          WHERE lease_id = $1`,
        [first.acquired ? first.leaseId : null],
      );
      expect(await acquire(replacementProcessPool, 'restart-recovery'))
        .toMatchObject({ acquired: true, fencingToken: '2' });
    } finally {
      await replacementProcessPool.end();
    }
  });

  it('takes over after expiry, increments fencing, and masks stale operations', async () => {
    const firstRun = randomUUID();
    const first = await acquire(pool, 'expiry', randomUUID(), firstRun);
    expect(first.acquired).toBe(true);
    await pool.query(
      `UPDATE coordination_leases
          SET acquired_at = clock_timestamp() - interval '2 seconds',
              expires_at = clock_timestamp() - interval '1 second'
        WHERE lease_id = $1`,
      [first.acquired ? first.leaseId : null],
    );
    const secondRun = randomUUID();
    const second = await acquire(pool, 'expiry', randomUUID(), secondRun);
    expect(second).toMatchObject({ acquired: true, fencingToken: '2' });
    await expect(renewLease(pool, principal, {
      leaseId: first.acquired ? first.leaseId : '',
      runId: firstRun,
      requestId: randomUUID(),
    })).rejects.toEqual(expectCode('LEASE_LOST'));
    await expect(releaseLease(pool, principal, {
      leaseId: first.acquired ? first.leaseId : '',
      runId: firstRun,
      requestId: randomUUID(),
    })).rejects.toEqual(expectCode('LEASE_LOST'));
    const inspected = await inspectLease(pool, principal, {
      scope: 'project:coordination-tests',
      resource: 'expiry',
    });
    expect(inspected).toMatchObject({
      held: true,
      leaseId: second.acquired ? second.leaseId : undefined,
      fencingToken: '2',
    });
  });

  it('replays renew and release without a late mutation or successor damage', async () => {
    const runId = randomUUID();
    const acquired = await acquire(pool, 'replay-mutations', randomUUID(), runId);
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) throw new Error('expected acquisition');
    const renewRequest = randomUUID();
    const renewed = await renewLease(pool, principal, {
      leaseId: acquired.leaseId,
      runId,
      requestId: renewRequest,
      ttlSeconds: 400,
    });
    const renewReplay = await renewLease(pool, principal, {
      leaseId: acquired.leaseId,
      runId,
      requestId: renewRequest,
      ttlSeconds: 400,
    });
    expect(renewReplay).toEqual(renewed);

    const releaseRequest = randomUUID();
    expect(await releaseLease(pool, principal, {
      leaseId: acquired.leaseId,
      runId,
      requestId: releaseRequest,
    })).toEqual({ released: true });
    const successor = await acquire(pool, 'replay-mutations');
    expect(successor).toMatchObject({ acquired: true, fencingToken: '2' });
    expect(await releaseLease(pool, principal, {
      leaseId: acquired.leaseId,
      runId,
      requestId: releaseRequest,
    })).toEqual({ released: true, alreadyReleased: true });
    expect(await inspectLease(pool, principal, {
      scope: 'project:coordination-tests',
      resource: 'replay-mutations',
    })).toMatchObject({
      held: true,
      leaseId: successor.acquired ? successor.leaseId : undefined,
    });
  });

  it('revalidates current authorization and masks revoked holders', async () => {
    const runId = randomUUID();
    const acquired = await acquire(pool, 'revocation', randomUUID(), runId);
    expect(acquired.acquired).toBe(true);
    await pool.query(
      `UPDATE scope_memberships SET active = FALSE, deactivated_at = clock_timestamp()
        WHERE principal_id = $1 AND scope_id = $2`,
      [principal.id, scope.id],
    );
    await expect(renewLease(pool, principal, {
      leaseId: acquired.acquired ? acquired.leaseId : '',
      runId,
      requestId: randomUUID(),
    })).rejects.toEqual(expectCode('LEASE_LOST'));
    await expect(inspectLease(pool, principal, {
      scope: 'project:coordination-tests',
      resource: 'revocation',
    })).rejects.toEqual(expectCode('SCOPE_NOT_FOUND'));
  });

  it('masks another holder identity in inspect and contention', async () => {
    const acquired = await acquire(pool, 'masked');
    expect(acquired.acquired).toBe(true);
    const other = await createPrincipal(pool, {
      externalId: 'service:coordination-other',
      kind: 'service',
      displayName: 'Other',
    });
    await addMembership(pool, other.id, scope.id, 'admin');
    const inspected = await inspectLease(pool, other, {
      scope: 'project:coordination-tests',
      resource: 'masked',
    });
    expect(inspected).toEqual({
      held: true,
      scope: 'project:coordination-tests',
      resource: 'masked',
      serverTime: expect.any(String),
      expiresAt: expect.any(String),
    });
    const contention = await acquireLease(pool, other, {
      scope: 'project:coordination-tests',
      resource: 'masked',
      runId: randomUUID(),
      requestId: randomUUID(),
    });
    expect(contention).toEqual({
      acquired: false,
      reason: 'LOCK_HELD',
      scope: 'project:coordination-tests',
      resource: 'masked',
      expiresAt: expect.any(String),
      retryAfterSeconds: expect.any(Number),
      serverTime: expect.any(String),
    });
    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log
        WHERE principal_id = $1
          AND metadata->>'operation' IN ('lock_inspect', 'lock_acquire')
        ORDER BY id`,
      [other.id],
    );
    expect(audit.rows).toHaveLength(2);
    expect(JSON.stringify(audit.rows)).not.toContain('masked');
    for (const row of audit.rows) {
      expect(row.metadata.resource_bytes).toBe(6);
      expect(row.metadata.resource_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.metadata).not.toHaveProperty('lease_id');
      expect(row.metadata).not.toHaveProperty('run_id');
      expect(row.metadata).not.toHaveProperty('fencing_token');
    }
  });

  it('rolls back lease, receipt, quota, and audit together on audit failure', async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION coordination_test_reject_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.metadata->>'operation' = 'lock_acquire' THEN
          RAISE EXCEPTION 'injected audit failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER coordination_test_reject_audit
      BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION coordination_test_reject_audit();
    `);
    try {
      await expect(acquire(pool, 'audit-rollback')).rejects.toBeInstanceOf(ServiceError);
      const counts = await pool.query(`
        SELECT
          (SELECT count(*)::int FROM coordination_resources WHERE scope_id = $1) AS resources,
          (SELECT count(*)::int FROM coordination_leases WHERE scope_id = $1) AS leases,
          (SELECT count(*)::int FROM coordination_operation_receipts
            WHERE scope_id = $1) AS receipts,
          (SELECT resource_count FROM coordination_scope_usage
            WHERE scope_id = $1) AS resource_count
      `, [scope.id]);
      expect(counts.rows[0]).toEqual({
        resources: 0,
        leases: 0,
        receipts: 0,
        resource_count: null,
      });
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS coordination_test_reject_audit ON audit_log');
      await pool.query('DROP FUNCTION IF EXISTS coordination_test_reject_audit()');
    }
  });

  it('maps database constraint violations to stable INVALID_INPUT', async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION coordination_test_reject_resource()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.resource = 'database-rejected' THEN
          RAISE check_violation USING MESSAGE = 'injected storage validation';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER coordination_test_reject_resource
      BEFORE INSERT ON coordination_resources
      FOR EACH ROW EXECUTE FUNCTION coordination_test_reject_resource();
    `);
    try {
      await expect(acquire(pool, 'database-rejected'))
        .rejects.toEqual(expectCode('INVALID_INPUT'));
    } finally {
      await pool.query(
        'DROP TRIGGER IF EXISTS coordination_test_reject_resource ON coordination_resources',
      );
      await pool.query('DROP FUNCTION IF EXISTS coordination_test_reject_resource()');
    }
  });

  it('enforces resource, receipt, and fencing exhaustion without partial mutation', async () => {
    const first = await acquire(pool, 'existing');
    expect(first.acquired).toBe(true);
    await pool.query(
      `UPDATE coordination_leases SET acquired_at = clock_timestamp() - interval '2 seconds',
          expires_at = clock_timestamp() - interval '1 second'
        WHERE lease_id = $1`,
      [first.acquired ? first.leaseId : null],
    );
    await pool.query(
      'UPDATE coordination_scope_usage SET resource_count = 10000 WHERE scope_id = $1',
      [scope.id],
    );
    await expect(acquire(pool, 'new-over-quota'))
      .rejects.toEqual(expectCode('COORDINATION_QUOTA_EXCEEDED'));
    expect((await acquire(pool, 'existing')).acquired).toBe(true);

    await pool.query(
      `UPDATE coordination_principal_usage
          SET acquire_receipt_count = 10000 WHERE principal_id = $1`,
      [principal.id],
    );
    await expect(acquire(pool, 'receipt-over-quota'))
      .rejects.toEqual(expectCode('COORDINATION_QUOTA_EXCEEDED'));
    expect((await pool.query(
      `SELECT 1 FROM coordination_resources
        WHERE scope_id = $1 AND resource = 'receipt-over-quota'`,
      [scope.id],
    )).rowCount).toBe(0);

    await pool.query(
      `UPDATE coordination_resources SET fencing_token = 9223372036854775807
        WHERE scope_id = $1 AND resource = 'existing'`,
      [scope.id],
    );
    await pool.query(
      `UPDATE coordination_leases SET acquired_at = clock_timestamp() - interval '2 seconds',
          expires_at = clock_timestamp() - interval '1 second'
        WHERE lease_id = (SELECT current_lease_id FROM coordination_resources
          WHERE scope_id = $1 AND resource = 'existing')`,
      [scope.id],
    );
    await expect(acquire(pool, 'existing'))
      .rejects.toEqual(expectCode('FENCING_TOKEN_EXHAUSTED'));
  });

  it('fails closed when Entra freshness expires while waiting on a resource row', async () => {
    const first = await acquire(pool, 'freshness-wait');
    expect(first.acquired).toBe(true);
    await pool.query(
      `UPDATE coordination_leases
          SET acquired_at = clock_timestamp() - interval '2 seconds',
              expires_at = clock_timestamp() - interval '1 second'
        WHERE lease_id = $1`,
      [first.acquired ? first.leaseId : null],
    );
    const groupId = randomUUID();
    await pool.query(
      `INSERT INTO entra_groups
         (external_id, display_name, scope_id, role, approved_by, approved_at)
       VALUES ($1, 'Coordination test group', $2, 'writer', $3, clock_timestamp())`,
      [groupId, scope.id, principal.id],
    );
    await pool.query(
      `UPDATE scope_memberships
          SET source_kind = 'entra', source_id = $3, synced_at = clock_timestamp()
        WHERE principal_id = $1 AND scope_id = $2 AND source_kind = 'manual'`,
      [principal.id, scope.id, groupId],
    );
    await pool.query(
      `UPDATE entra_sync_state
          SET max_staleness = interval '1 hour',
              last_success_at = clock_timestamp() - interval '59 minutes 59.7 seconds'`,
    );

    const blocker = await otherPool.connect();
    const requestId = randomUUID();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `SELECT 1 FROM coordination_resources
          WHERE scope_id = $1 AND resource = 'freshness-wait' FOR UPDATE`,
        [scope.id],
      );
      const attempt = acquire(pool, 'freshness-wait', requestId);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await blocker.query('COMMIT');
      await expect(attempt).rejects.toEqual(expectCode('SCOPE_NOT_FOUND'));
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    expect((await pool.query(
      'SELECT 1 FROM coordination_operation_receipts WHERE request_id = $1',
      [requestId],
    )).rowCount).toBe(0);
  });

  it('holds authorization locks through commit so a waiting revocation applies afterward', async () => {
    const first = await acquire(pool, 'revocation-wait');
    expect(first.acquired).toBe(true);
    await pool.query(
      `UPDATE coordination_leases
          SET acquired_at = clock_timestamp() - interval '2 seconds',
              expires_at = clock_timestamp() - interval '1 second'
        WHERE lease_id = $1`,
      [first.acquired ? first.leaseId : null],
    );
    const blocker = await otherPool.connect();
    const revoker = await otherPool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `SELECT 1 FROM coordination_resources
          WHERE scope_id = $1 AND resource = 'revocation-wait' FOR UPDATE`,
        [scope.id],
      );
      const attempt = acquire(pool, 'revocation-wait');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const pid = (await revoker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]!.pid;
      const revocation = revoker.query(
        `UPDATE scope_memberships
            SET active = FALSE, deactivated_at = clock_timestamp()
          WHERE principal_id = $1 AND scope_id = $2`,
        [principal.id, scope.id],
      );
      let waiting = false;
      for (let index = 0; index < 25 && !waiting; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const state = await blocker.query<{ wait_event_type: string | null }>(
          'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
          [pid],
        );
        waiting = state.rows[0]?.wait_event_type === 'Lock';
      }
      expect(waiting).toBe(true);
      await blocker.query('COMMIT');
      expect(await attempt).toMatchObject({ acquired: true, fencingToken: '2' });
      await revocation;
      await expect(inspectLease(pool, principal, {
        scope: 'project:coordination-tests',
        resource: 'revocation-wait',
      })).rejects.toEqual(expectCode('SCOPE_NOT_FOUND'));
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      revoker.release();
    }
  });

  it('ends idempotency at the retained receipt boundary and permits key reuse', async () => {
    const requestId = randomUUID();
    const runId = randomUUID();
    expect(await acquire(pool, 'old-receipt', requestId, runId))
      .toMatchObject({ acquired: true });
    await pool.query(
      `UPDATE coordination_operation_receipts
          SET retain_until = clock_timestamp() - interval '1 microsecond'
        WHERE principal_id = $1 AND operation = 'acquire' AND request_id = $2`,
      [principal.id, requestId],
    );
    expect(await acquire(pool, 'new-receipt', requestId, runId))
      .toMatchObject({ acquired: true, resource: 'new-receipt' });
    const retained = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM coordination_operation_receipts
        WHERE principal_id = $1 AND operation = 'acquire' AND request_id = $2`,
      [principal.id, requestId],
    );
    expect(retained.rows[0]!.count).toBe(1);
  });

  it('reuses an exact expired key even when bounded cleanup cannot reach it', async () => {
    const requestId = randomUUID();
    const runId = randomUUID();
    await acquire(pool, 'expired-key-old', requestId, runId);
    await pool.query(
      `UPDATE coordination_operation_receipts
          SET retain_until = clock_timestamp() - interval '1 microsecond'
        WHERE principal_id = $1 AND operation = 'acquire' AND request_id = $2`,
      [principal.id, requestId],
    );
    await pool.query(
      `INSERT INTO coordination_operation_receipts (
         principal_id, operation, request_id, payload_hash, outcome,
         scope_id, resource, expires_at, server_time, retry_after_seconds, retain_until
       )
       SELECT $1, 'acquire', gen_random_uuid(), sha256(convert_to(series::text, 'UTF8')),
              'contended', $2, 'expired-key-old', clock_timestamp(),
              clock_timestamp() - interval '2 days', 0,
              clock_timestamp() - interval '2 days' + interval '60 seconds'
         FROM generate_series(1, 101) series`,
      [principal.id, scope.id],
    );
    await pool.query(
      `UPDATE coordination_principal_usage
          SET acquire_receipt_count = (
            SELECT count(*) FROM coordination_operation_receipts
             WHERE principal_id = $1 AND operation = 'acquire'
          )
        WHERE principal_id = $1`,
      [principal.id],
    );
    expect(await acquire(pool, 'expired-key-new', requestId, runId))
      .toMatchObject({ acquired: true, resource: 'expired-key-new' });
  });

  it('keeps renew and release available when acquire receipts are saturated', async () => {
    const runId = randomUUID();
    const held = await acquire(pool, 'saturated-maintenance', randomUUID(), runId);
    expect(held.acquired).toBe(true);
    if (!held.acquired) throw new Error('expected acquisition');
    await pool.query(
      `UPDATE coordination_principal_usage SET acquire_receipt_count = 10000
        WHERE principal_id = $1`,
      [principal.id],
    );
    await expect(acquire(pool, 'saturated-new'))
      .rejects.toEqual(expectCode('COORDINATION_QUOTA_EXCEEDED'));
    await expect(renewLease(pool, principal, {
      leaseId: held.leaseId, runId, requestId: randomUUID(),
    })).resolves.toMatchObject({ renewed: true, leaseId: held.leaseId });
    await expect(releaseLease(pool, principal, {
      leaseId: held.leaseId, runId, requestId: randomUUID(),
    })).resolves.toEqual({ released: true });
  });

  it('keeps realistic multi-lease renewal independent of the principal usage lock', async () => {
    const leases: Array<{ leaseId: string; runId: string }> = [];
    for (let index = 0; index < 12; index += 1) {
      const runId = randomUUID();
      const acquired = await acquire(
        pool, `steady-renew-${index}`, randomUUID(), runId,
      );
      if (!acquired.acquired) throw new Error('expected acquisition');
      leases.push({ leaseId: acquired.leaseId, runId });
    }
    await pool.query(
      `UPDATE coordination_principal_usage SET mutation_receipt_count = 10000
        WHERE principal_id = $1`,
      [principal.id],
    );
    const blocker = await otherPool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT 1 FROM coordination_principal_usage WHERE principal_id = $1 FOR UPDATE',
        [principal.id],
      );
      const renewed = await Promise.all(leases.map((lease) =>
        renewLease(pool, principal, {
          ...lease, requestId: randomUUID(), ttlSeconds: 30,
        })));
      expect(renewed).toHaveLength(12);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const retention = await pool.query<{ maximum: number; mutation_count: number }>(
      `SELECT max(extract(epoch FROM (receipt.retain_until - receipt.server_time)))::int
                AS maximum,
              usage.mutation_receipt_count AS mutation_count
         FROM coordination_operation_receipts receipt
         JOIN coordination_principal_usage usage
           ON usage.principal_id = receipt.principal_id
        WHERE receipt.principal_id = $1 AND receipt.operation = 'renew'
        GROUP BY usage.mutation_receipt_count`,
      [principal.id],
    );
    expect(retention.rows).toEqual([{ maximum: 90, mutation_count: 10000 }]);
  });

  it('enforces the new-resource rate limit without blocking existing resources', async () => {
    const held = await acquire(pool, 'rate-existing');
    expect(held.acquired).toBe(true);
    await pool.query(
      `UPDATE coordination_principal_usage
          SET resource_window_started_at = clock_timestamp(), resource_window_count = 100
        WHERE principal_id = $1`,
      [principal.id],
    );
    await expect(acquire(pool, 'rate-new'))
      .rejects.toEqual(expectCode('COORDINATION_QUOTA_EXCEEDED'));
    await expect(acquire(pool, 'rate-existing'))
      .resolves.toMatchObject({ acquired: false, reason: 'LOCK_HELD' });
  });

  it('uses locale-independent checks and indexed bounded cleanup plans', async () => {
    const planHolder = await acquire(pool, 'line\u2028paragraph\u2029separators');
    expect(planHolder).toMatchObject({ acquired: true });
    if (!planHolder.acquired) throw new Error('expected plan fixture acquisition');
    await expect(pool.query(
      `INSERT INTO coordination_resources (scope_id, resource) VALUES ($1, $2)`,
      [scope.id, 'bad\u0085key'],
    )).rejects.toMatchObject({ code: '23514' });

    // Give the planner a bounded but representative distribution: one receipt
    // for the selected resource among many globally expired receipts.
    await pool.query(
      `WITH fixture AS (
         SELECT value,
                CASE WHEN value = 1 THEN 'plan-resource'
                     ELSE 'plan-noise-' || value::text END AS resource
           FROM generate_series(1, 512) AS value
       ), inserted_resources AS (
         INSERT INTO coordination_resources (scope_id, resource)
         SELECT $1, resource FROM fixture
         RETURNING resource
       )
       INSERT INTO coordination_operation_receipts (
         principal_id, operation, request_id, payload_hash, outcome,
         scope_id, resource, lease_id, run_id, fencing_token,
         expires_at, server_time, retry_after_seconds, retain_until
       )
       SELECT $2, 'release',
              ('00000000-0000-4000-8000-' || lpad(to_hex(f.value), 12, '0'))::uuid,
              decode(repeat('00', 32), 'hex'), 'released',
              $1, f.resource, $3, '00000000-0000-4000-8000-000000000001', 1,
              NULL, clock_timestamp() - interval '2 days', NULL,
              clock_timestamp() - interval '1 day'
         FROM fixture f
         JOIN inserted_resources r USING (resource)`,
      [scope.id, principal.id, planHolder.leaseId],
    );

    await pool.query(
      `INSERT INTO coordination_resources (scope_id, resource, fencing_token)
       VALUES ($1, 'plan-history', 100000)`, [scope.id],
    );
    const planNoisePrincipal = randomUUID();
    await pool.query(
      `INSERT INTO principals (id, external_id, kind, display_name)
       VALUES ($1, $2, 'service', 'Plan noise')`,
      [planNoisePrincipal, `service:plan-noise:${planNoisePrincipal}`],
    );
    await pool.query(
      `INSERT INTO coordination_leases (
         lease_id, scope_id, resource, principal_id, run_id, fencing_token,
         acquired_at, expires_at, released_at, cleanup_eligible_at
       )
       SELECT gen_random_uuid(), $1, 'plan-history', $2, gen_random_uuid(), series,
              clock_timestamp() - interval '4 days',
              clock_timestamp() - interval '3 days',
              clock_timestamp() - interval '3 days',
              clock_timestamp() - interval '3 days'
         FROM generate_series(1, 100000) series`,
      [scope.id, planNoisePrincipal],
    );
    await pool.query(
      `INSERT INTO coordination_operation_receipts (
         principal_id, operation, request_id, payload_hash, outcome,
         scope_id, resource, lease_id, run_id, fencing_token,
         expires_at, server_time, retry_after_seconds, retain_until
       )
       SELECT $2, 'release', gen_random_uuid(), decode(repeat('00', 32), 'hex'),
              'released', $1, lease.resource, lease.lease_id, lease.run_id,
              lease.fencing_token, NULL, clock_timestamp() - interval '2 days',
              NULL, CASE WHEN lease.fencing_token % 10 = 0
                         THEN clock_timestamp() - interval '1 day'
                         ELSE clock_timestamp() + interval '1 day' END
         FROM coordination_leases lease
        WHERE lease.scope_id = $1 AND lease.resource = 'plan-history'
        ORDER BY lease.fencing_token LIMIT 10000`,
      [scope.id, planNoisePrincipal],
    );

    const plans = await pool.connect();
    try {
      // Refresh statistics after the bounded seed so EXPLAIN represents the
      // indexed production cleanup paths rather than tiny-table estimates.
      await plans.query('ANALYZE coordination_operation_receipts');
      await plans.query('ANALYZE coordination_leases');
      const leasePlan = await plans.query(
        `EXPLAIN (FORMAT JSON)
         SELECT lease_id FROM coordination_leases
          WHERE principal_id = $1
            AND cleanup_eligible_at <= clock_timestamp()
          ORDER BY cleanup_eligible_at, lease_id LIMIT 100`,
        [principal.id],
      );
      const resourcePlan = await plans.query(
        `EXPLAIN (FORMAT JSON)
         SELECT 1 FROM coordination_resources WHERE current_lease_id = $1`,
        [randomUUID()],
      );
      const receiptPlan = await plans.query(
        `EXPLAIN (FORMAT JSON)
         SELECT principal_id, operation, request_id
           FROM coordination_operation_receipts
          WHERE scope_id = $1 AND resource = $2
            AND retain_until <= clock_timestamp()
          ORDER BY retain_until, principal_id, operation, request_id LIMIT 1000`,
        [scope.id, 'plan-resource'],
      );
      const globalReceiptPlan = await plans.query(
        `EXPLAIN (FORMAT JSON)
         SELECT principal_id, operation, request_id
           FROM coordination_operation_receipts
          WHERE retain_until <= clock_timestamp()
          ORDER BY retain_until, principal_id, operation, request_id LIMIT 1000`,
      );
      const globalLeasePlan = await plans.query(
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
      expect(JSON.stringify(leasePlan.rows)).toContain(
        'coordination_leases_principal_cleanup_idx',
      );
      expect(JSON.stringify(resourcePlan.rows)).toContain(
        'coordination_resources_current_lease_idx',
      );
      expect(JSON.stringify(receiptPlan.rows)).toContain(
        'coordination_receipts_resource_idx',
      );
      expect(JSON.stringify(globalReceiptPlan.rows)).toContain(
        'coordination_receipts_global_sweep_idx',
      );
      expect(JSON.stringify(globalLeasePlan.rows)).toContain(
        'coordination_leases_cleanup_ready_idx',
      );
      expect(JSON.stringify(globalLeasePlan.rows)).toContain(
        'coordination_receipts_lease_idx',
      );
    } finally {
      plans.release();
    }
  });

  it('enforces nondecreasing fencing tokens in the database', async () => {
    const acquired = await acquire(pool, 'monotonic-db-guard');
    expect(acquired).toMatchObject({ acquired: true, fencingToken: '1' });
    await expect(pool.query(
      `UPDATE coordination_resources SET fencing_token = fencing_token - 1
        WHERE scope_id = $1 AND resource = 'monotonic-db-guard'`,
      [scope.id],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('does not complete cleanup while a skipped row is locked and resumes from its cursor', async () => {
    await pool.query(
      `INSERT INTO coordination_resources (scope_id, resource, fencing_token)
       VALUES ($1, 'cursor-history', 3)`, [scope.id],
    );
    await pool.query(
      `INSERT INTO coordination_leases (
         lease_id, scope_id, resource, principal_id, run_id, fencing_token,
         acquired_at, expires_at, released_at, cleanup_eligible_at
       ) SELECT gen_random_uuid(), $1, 'cursor-history', $2, gen_random_uuid(), series,
                clock_timestamp() - interval '3 days',
                clock_timestamp() - interval '2 days',
                clock_timestamp() - interval '2 days', NULL
           FROM generate_series(1, 3) series`,
      [scope.id, principal.id],
    );
    const locker = await pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query(
        `SELECT lease_id FROM coordination_leases
          WHERE resource = 'cursor-history' ORDER BY lease_id LIMIT 1 FOR UPDATE`,
      );
      for (let batch = 0; batch < 3; batch += 1) {
        expect((await pool.query(
          'SELECT continuum_backfill_coordination_cleanup(1) AS complete',
        )).rows[0]?.complete).toBe(false);
      }
      expect((await pool.query(
        `SELECT completed_at IS NOT NULL AS complete, last_lease_id
           FROM coordination_migration_progress
          WHERE name = 'issue7-cleanup-eligibility'`,
      )).rows).toEqual([{ complete: false, last_lease_id: null }]);
      await locker.query('COMMIT');
      expect((await pool.query(
        'SELECT continuum_backfill_coordination_cleanup(1) AS complete',
      )).rows[0]?.complete).toBe(false);
      expect((await pool.query(
        'SELECT continuum_backfill_coordination_cleanup(1) AS complete',
      )).rows[0]?.complete).toBe(true);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM coordination_leases
          WHERE resource = 'cursor-history' AND cleanup_eligible_at IS NULL`,
      )).rows).toEqual([{ count: 0 }]);
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined);
      locker.release();
    }
  });

  it('separates short-lived contention receipts from acquired receipt quota', async () => {
    const held = await acquire(pool, 'contention-retention');
    expect(held.acquired).toBe(true);
    const contended = await acquire(pool, 'contention-retention');
    expect(contended).toMatchObject({ acquired: false, reason: 'LOCK_HELD' });
    const usage = await pool.query<{
      acquired_count: number; contended_count: number; maximum: number;
    }>(
      `SELECT usage.acquire_receipt_count AS acquired_count,
              usage.contended_receipt_count AS contended_count,
              max(extract(epoch FROM (receipt.retain_until - receipt.server_time)))
                FILTER (WHERE receipt.outcome = 'contended')::int AS maximum
         FROM coordination_principal_usage usage
         JOIN coordination_operation_receipts receipt
           ON receipt.principal_id = usage.principal_id
        WHERE usage.principal_id = $1
        GROUP BY usage.acquire_receipt_count, usage.contended_receipt_count`,
      [principal.id],
    );
    expect(usage.rows).toEqual([{
      acquired_count: 1, contended_count: 1, maximum: 90,
    }]);
  });

  it('bounds retained renew receipts per lease', async () => {
    const runId = randomUUID();
    const held = await acquire(pool, 'bounded-renew-receipts', randomUUID(), runId);
    if (!held.acquired) throw new Error('expected acquisition');
    for (let index = 0; index < 105; index += 1) {
      await renewLease(pool, principal, {
        leaseId: held.leaseId, runId, requestId: randomUUID(), ttlSeconds: 300,
      });
    }
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM coordination_operation_receipts
        WHERE lease_id = $1 AND operation = 'renew'`,
      [held.leaseId],
    )).rows[0]?.count).toBeLessThanOrEqual(100);
  });

  it('uses server lock timeout and leaves no late receipt after a blocked request', async () => {
    const first = await acquire(pool, 'blocked');
    expect(first.acquired).toBe(true);
    const blocker = await otherPool.connect();
    const requestId = randomUUID();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `SELECT 1 FROM coordination_resources
          WHERE scope_id = $1 AND resource = 'blocked' FOR UPDATE`,
        [scope.id],
      );
      await expect(acquire(pool, 'blocked', requestId))
        .rejects.toEqual(expectCode('COORDINATION_TIMEOUT'));
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await pool.query(
      'SELECT 1 FROM coordination_operation_receipts WHERE request_id = $1',
      [requestId],
    )).rowCount).toBe(0);
  });

  it('honors pre-cancellation without creating state', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquireLease(pool, principal, {
      scope: 'project:coordination-tests',
      resource: 'cancelled',
      runId: randomUUID(),
      requestId: randomUUID(),
    }, { signal: controller.signal })).rejects.toEqual(expectCode('COORDINATION_TIMEOUT'));
    expect((await pool.query(
      `SELECT 1 FROM coordination_resources
        WHERE scope_id = $1 AND resource = 'cancelled'`,
      [scope.id],
    )).rowCount).toBe(0);
  });

  it('reports cancellation after commit as ambiguous and replays the committed receipt', async () => {
    const controller = new AbortController();
    const requestId = randomUUID();
    const runId = randomUUID();
    const commitInterceptPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (query: string, values?: unknown[]) => {
            const result = await client.query(query, values);
            if (query === 'COMMIT') controller.abort();
            return result;
          },
          release: (destroy?: boolean) => client.release(destroy),
        } as unknown as pg.PoolClient;
      },
    } as pg.Pool;
    await expect(acquireLease(commitInterceptPool, principal, {
      scope: 'project:coordination-tests', resource: 'commit-cancelled',
      runId, requestId,
    }, { signal: controller.signal })).rejects.toEqual(expectCode('COORDINATION_TIMEOUT'));

    await expect(acquire(pool, 'commit-cancelled', requestId, runId))
      .resolves.toMatchObject({ acquired: true, fencingToken: '1' });
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM coordination_operation_receipts WHERE request_id = $1',
      [requestId],
    )).rows[0]?.count).toBe(1);
  });
});
