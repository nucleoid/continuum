import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg, { type PoolConfig } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addMembership } from '../storage/memberships.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { acquireLease } from './coordination.js';
import {
  listCoordinationPrivacyRepairs, mapOwnedUserScope, offboardPrincipal,
  repairCoordinationPrivacy,
} from './offboarding.js';

describe('coordination independent review regressions', () => {
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

  async function completeOffboarding(value: Awaited<ReturnType<typeof fixture>>) {
    let result = await offboardPrincipal(pool, value.operator, value.target.id, {
      confirmationScopeId: value.owned.id, batchSize: 100,
    });
    for (let attempt = 0; !result.complete && attempt < 100; attempt += 1) {
      result = await offboardPrincipal(pool, value.operator, value.target.id, {
        confirmationScopeId: value.owned.id, batchSize: 100,
      });
    }
    expect(result.complete).toBe(true);
  }

  it('does not complete a pre-0065 run until owned-scope lock metadata is canonicalized', async () => {
    const value = await fixture('owned-audit-upgrade');
    await completeOffboarding(value);

    await pool.query('ALTER TABLE audit_log DISABLE TRIGGER reject_offboarded_principal_audit');
    try {
      await pool.query(
        `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
         SELECT $1, 'write', $2, jsonb_build_object(
           'operation', 'lock_acquire', 'request_id', gen_random_uuid(),
           'run_id', gen_random_uuid(), 'lease_id', gen_random_uuid(),
           'resource', 'legacy-owned-' || n, 'resource_sha256', repeat('a', 64))
           FROM generate_series(1, 2) n`,
        [value.target.id, value.owned.id],
      );
    } finally {
      await pool.query('ALTER TABLE audit_log ENABLE TRIGGER reject_offboarded_principal_audit');
    }
    await pool.query(
      `UPDATE coordination_principal_privacy_progress
          SET privacy_version = 2, audit_cursor_id = 0,
              completed_at = NULL, updated_at = clock_timestamp()
        WHERE principal_id = $1`,
      [value.target.id],
    );

    const first = await offboardPrincipal(pool, value.operator, value.target.id, {
      confirmationScopeId: value.owned.id, batchSize: 1,
    });
    expect(first).toMatchObject({ complete: false, alreadyOffboarded: false });
    expect((await pool.query(
      `SELECT count(*)::int AS dirty FROM audit_log
        WHERE principal_id = $1 AND metadata->>'operation' = 'lock_acquire'
          AND metadata ?| ARRAY['request_id','run_id','lease_id','resource','resource_sha256']`,
      [value.target.id],
    )).rows).toEqual([{ dirty: 1 }]);

    const second = await offboardPrincipal(pool, value.operator, value.target.id, {
      confirmationScopeId: value.owned.id, batchSize: 1,
    });
    expect(second).toMatchObject({ complete: false, alreadyOffboarded: false });
    expect((await pool.query(
      `SELECT count(*)::int AS dirty FROM audit_log
        WHERE principal_id = $1 AND metadata->>'operation' = 'lock_acquire'
          AND metadata ?| ARRAY['request_id','run_id','lease_id','resource','resource_sha256']`,
      [value.target.id],
    )).rows).toEqual([{ dirty: 0 }]);
    const exhausted = await offboardPrincipal(pool, value.operator, value.target.id, {
      confirmationScopeId: value.owned.id, batchSize: 1,
    });
    expect(exhausted).toMatchObject({ complete: true, alreadyOffboarded: false });
  });

  it('reports a live-lease block without appending no-progress batch evidence', async () => {
    const value = await fixture('blocked-live-lease');
    const held = await acquireLease(pool, value.target, {
      scope: `project:${value.shared.name}`, resource: 'held', runId: randomUUID(),
      requestId: randomUUID(), ttlSeconds: 300,
    });
    expect(held.acquired).toBe(true);
    await pool.query(
      'UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1', [value.target.id],
    );
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, audit_cursor_id, completed_at)
       VALUES ($1, '00000000-0000-4000-8000-000000000012', 2, 0, NULL)`,
      [value.target.id],
    );

    let blocked: Awaited<ReturnType<typeof repairCoordinationPrivacy>> | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await repairCoordinationPrivacy(pool, value.operator, value.target.id, {
        confirmationScopeId: value.owned.id, batchSize: 10,
      });
      if (result.blockedUntil) { blocked = result; break; }
    }
    expect(blocked).toMatchObject({ complete: false, progressed: false });
    expect(blocked?.blockedUntil).toBeInstanceOf(Date);
    const before = Number((await pool.query(
      `SELECT count(*)::int AS count FROM coordination_operator_events
        WHERE scope_id = $1 AND operation = 'coordination_principal_scrub'
          AND metadata->>'phase' = 'batch'`, [value.owned.id],
    )).rows[0].count);
    const retry = await repairCoordinationPrivacy(pool, value.operator, value.target.id, {
      confirmationScopeId: value.owned.id, batchSize: 10,
    });
    const after = Number((await pool.query(
      `SELECT count(*)::int AS count FROM coordination_operator_events
        WHERE scope_id = $1 AND operation = 'coordination_principal_scrub'
          AND metadata->>'phase' = 'batch'`, [value.owned.id],
    )).rows[0].count);
    expect(retry).toMatchObject({ complete: false, progressed: false });
    expect(retry.blockedUntil).toBeInstanceOf(Date);
    expect(after).toBe(before);
  });

  it('takes privacy advisory lock 762 before the principal row lock', async () => {
    const value = await fixture('repair-lock-order');
    await pool.query(
      'UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1', [value.target.id],
    );
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, audit_cursor_id, completed_at)
       VALUES ($1, '00000000-0000-4000-8000-000000000012', 2, 0, NULL)`,
      [value.target.id],
    );
    const blocker = await pool.connect();
    const probe = await pool.connect();
    const repairPool = new pg.Pool({
      ...(pool as unknown as { options: PoolConfig }).options, max: 1,
    });
    try {
      const repairPid = Number((await repairPool.query(
        'SELECT pg_backend_pid() AS pid',
      )).rows[0].pid);
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 762))', [value.target.id],
      );
      const repair = repairCoordinationPrivacy(repairPool, value.operator, value.target.id, {
        confirmationScopeId: value.owned.id, batchSize: 10,
      }).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        waiting = Boolean((await pool.query(
          `SELECT wait_event_type = 'Lock' AS waiting
             FROM pg_stat_activity WHERE pid = $1`, [repairPid],
        )).rows[0]?.waiting);
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await probe.query('BEGIN');
      await expect(probe.query(
        'SELECT 1 FROM principals WHERE id = $1 FOR UPDATE NOWAIT', [value.target.id],
      )).resolves.toBeDefined();
      await probe.query('ROLLBACK');
      await blocker.query('COMMIT');
      expect((await repair).ok).toBe(true);
    } finally {
      await probe.query('ROLLBACK').catch(() => undefined);
      await blocker.query('ROLLBACK').catch(() => undefined);
      probe.release();
      blocker.release();
      await repairPool.end();
    }
  });

  it('keeps lifecycle predicates shared and DB-fences create/start repair bypasses', async () => {
    const migration = await readFile('migrations/0069_coordination_independent_review.sql', 'utf8');
    expect(migration).toMatch(/continuum_offboarding_state_is_erased\s*\(/);
    expect(migration).toMatch(/continuum_offboarding_actual_state_is_erased[\s\S]+continuum_offboarding_state_is_erased/);
    expect(migration).toMatch(/continuum_offboarding_noncoordination_state_is_erased[\s\S]+continuum_offboarding_state_is_erased/);
    expect(migration).toMatch(/pending disabled-only privacy repair[\s\S]+(?:create|start)/i);
    expect(migration).toMatch(/CREATE INDEX[\s\S]+coordination_principal_privacy_progress[\s\S]+WHERE[\s\S]+privacy_version/i);
  });

  it('database-rejects direct offboarding create and start during disabled-only repair', async () => {
    const createValue = await fixture('direct-create-fence');
    const createApproval = (await pool.query(
      `SELECT id, acknowledged_evidence_hash FROM principal_user_scope_approvals
        WHERE principal_id = $1 AND scope_id = $2 ORDER BY id DESC LIMIT 1`,
      [createValue.target.id, createValue.owned.id],
    )).rows[0];
    await pool.query(
      'UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1',
      [createValue.target.id],
    );
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, completed_at)
       VALUES ($1, '00000000-0000-4000-8000-000000000012', 2, NULL)`,
      [createValue.target.id],
    );
    await expect(pool.query(
      `INSERT INTO principal_offboarding_runs
         (principal_id, scope_id, initiated_by, approval_id,
          initial_memories, initial_embeddings, initial_memberships,
          initial_aliases, initial_entra_bindings, initial_audit_rows,
          initial_audit_queries, approval_evidence_hash)
       VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 0, 0, 0, $5)`,
      [createValue.target.id, createValue.owned.id, createValue.operator.id,
        createApproval.id, createApproval.acknowledged_evidence_hash],
    )).rejects.toThrow(/pending disabled-only privacy repair.*create\/start/i);

    const startValue = await fixture('direct-start-fence');
    const startApproval = (await pool.query(
      `SELECT id, acknowledged_evidence_hash FROM principal_user_scope_approvals
        WHERE principal_id = $1 AND scope_id = $2 ORDER BY id DESC LIMIT 1`,
      [startValue.target.id, startValue.owned.id],
    )).rows[0];
    const run = (await pool.query(
      `INSERT INTO principal_offboarding_runs
         (principal_id, scope_id, initiated_by, approval_id,
          initial_memories, initial_embeddings, initial_memberships,
          initial_aliases, initial_entra_bindings, initial_audit_rows,
          initial_audit_queries, approval_evidence_hash)
       VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 0, 0, 0, $5)
       RETURNING run_id`,
      [startValue.target.id, startValue.owned.id, startValue.operator.id,
        startApproval.id, startApproval.acknowledged_evidence_hash],
    )).rows[0];
    await pool.query(
      'UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1',
      [startValue.target.id],
    );
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, completed_at)
       VALUES ($1, '00000000-0000-4000-8000-000000000012', 2, NULL)`,
      [startValue.target.id],
    );
    await expect(pool.query(
      `INSERT INTO principal_offboarding_run_events
         (run_id, principal_id, scope_id, phase, initiated_by, approval_id,
          approval_evidence_hash, evidence)
       VALUES ($1, $2, $3, 'started', $4, $5, $6, '{}'::jsonb)`,
      [run.run_id, startValue.target.id, startValue.owned.id, startValue.operator.id,
        startApproval.id, startApproval.acknowledged_evidence_hash],
    )).rejects.toThrow(/pending disabled-only privacy repair.*create\/start/i);
  });

  it('pins every ledgered issue-7 migration checksum and chains 0069 forward', async () => {
    const migrator = await readFile('src/storage/migrator.ts', 'utf8');
    for (let number = 54; number <= 68; number += 1) {
      expect(migrator).toMatch(new RegExp(`\\['00${number}_[^']+\\.sql',\\s*'[0-9a-f]{64}'`));
    }
    expect(migrator).toMatch(/0069_coordination_independent_review\.sql[\s\S]+0068_coordination_production_repair\.sql/);
  });

  it('discovers repair pages by cursor and plans incomplete progress with the partial index', async () => {
    const first = await fixture('cursor-a');
    const second = await fixture('cursor-b');
    const ordered = [first, second].sort((left, right) =>
      left.target.id.localeCompare(right.target.id));
    for (const value of ordered) {
      await pool.query(
        'UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1',
        [value.target.id],
      );
      await pool.query(
        `INSERT INTO coordination_principal_privacy_progress
           (principal_id, detached_principal_id, privacy_version, completed_at)
         VALUES ($1, '00000000-0000-4000-8000-000000000012', 2, NULL)`,
        [value.target.id],
      );
    }
    const page = await listCoordinationPrivacyRepairs(pool, first.operator, 1);
    expect(page).toHaveLength(1);
    const next = await listCoordinationPrivacyRepairs(
      pool, first.operator, 10, page[0].principalId,
    );
    expect(next.map((candidate) => candidate.principalId))
      .not.toContain(page[0].principalId);

    await pool.query(
      `WITH inserted AS (
         INSERT INTO principals (id, external_id, kind, display_name)
         SELECT gen_random_uuid(), 'repair-plan-' || n, 'user', 'Repair plan'
           FROM generate_series(1, 10000) n
         RETURNING id
       )
       INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, completed_at)
       SELECT id, '00000000-0000-4000-8000-000000000012', 2, NULL FROM inserted`,
    );
    await pool.query('ANALYZE coordination_principal_privacy_progress');
    const plan = (await pool.query(
      `EXPLAIN (FORMAT JSON)
       SELECT principal_id FROM coordination_principal_privacy_progress
        WHERE (privacy_version < 3 OR completed_at IS NULL)
          AND principal_id > '00000000-0000-0000-0000-000000000000'::uuid
        ORDER BY principal_id LIMIT 100`,
    )).rows[0]['QUERY PLAN'][0].Plan as Record<string, unknown>;
    const indexes: string[] = [];
    const visit = (node: Record<string, unknown>) => {
      if (node['Index Name']) indexes.push(String(node['Index Name']));
      for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) visit(child);
    };
    visit(plan);
    expect(indexes).toContain('coordination_principal_privacy_repair_idx');
  });
});
