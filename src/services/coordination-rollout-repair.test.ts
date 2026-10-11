import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addMembership } from '../storage/memberships.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import type { Principal } from '../types.js';
import * as offboarding from './offboarding.js';

type RepairCandidate = {
  principalId: string;
  scopeId: string;
  state: 'disabled_only' | 'offboarded';
};

type RepairResult = RepairCandidate & { complete: boolean };

type RepairService = {
  listCoordinationPrivacyRepairs(
    pool: pg.Pool, actor: Principal, limit?: number,
  ): Promise<RepairCandidate[]>;
  repairCoordinationPrivacy(
    pool: pg.Pool, actor: Principal, principalId: string,
    options: { confirmationScopeId: string; batchSize?: number },
  ): Promise<RepairResult>;
};

const repairService = offboarding as unknown as typeof offboarding & RepairService;

describe('coordination rollout privacy repair', () => {
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
    await offboarding.mapOwnedUserScope(pool, operator, target.id, owned.id);
    return { operator, target, owned, shared };
  }

  async function reopenPrivacy(target: Principal, sharedId: string, auditRows: number) {
    await pool.query(
      'UPDATE principals SET disabled_at = COALESCE(disabled_at, clock_timestamp()) WHERE id = $1',
      [target.id],
    );
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, audit_cursor_id, completed_at)
       VALUES ($1, '00000000-0000-4000-8000-000000000012', 2, 0, NULL)
       ON CONFLICT (principal_id) DO UPDATE
         SET privacy_version = 2, audit_cursor_id = 0, completed_at = NULL`,
      [target.id],
    );
    if (auditRows > 0) {
      await pool.query('ALTER TABLE audit_log DISABLE TRIGGER reject_offboarded_principal_audit');
      try {
        await pool.query(
          `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
           SELECT $1, 'write', $2, jsonb_build_object(
             'operation', 'lock_acquire', 'request_id', gen_random_uuid(),
             'run_id', gen_random_uuid(), 'lease_id', gen_random_uuid(),
             'resource', 'repair-' || n, 'resource_sha256', repeat('c', 64))
             FROM generate_series(1, $3::int) n`,
          [target.id, sharedId, auditRows],
        );
      } finally {
        await pool.query('ALTER TABLE audit_log ENABLE TRIGGER reject_offboarded_principal_audit');
      }
    }
  }

  it('refuses to turn a disabled-only privacy repair into irreversible offboarding', async () => {
    const value = await fixture('disabled-refusal');
    await reopenPrivacy(value.target, value.shared.id, 1);

    await expect(offboarding.offboardPrincipal(pool, value.operator, value.target.id, {
      confirmationScopeId: value.owned.id, batchSize: 1,
    })).rejects.toThrow(/privacy repair.*repair-coordination-privacy/i);

    expect((await pool.query(
      `SELECT offboarded_at, display_name FROM principals WHERE id = $1`, [value.target.id],
    )).rows).toEqual([{ offboarded_at: null, display_name: 'Target' }]);
  });

  it.each([
    ['zero-batch', 0, 10],
    ['single-batch', 1, 10],
    ['multi-batch', 3, 1],
  ] as const)('discovers and safely converges disabled-only %s repair', async (
    _label, auditRows, batchSize,
  ) => {
    const value = await fixture(`disabled-${auditRows}`);
    await reopenPrivacy(value.target, value.shared.id, auditRows);

    await expect(repairService.listCoordinationPrivacyRepairs(pool, value.operator, 100))
      .resolves.toContainEqual({
        principalId: value.target.id, scopeId: value.owned.id, state: 'disabled_only',
      });
    let result = await repairService.repairCoordinationPrivacy(
      pool, value.operator, value.target.id,
      { confirmationScopeId: value.owned.id, batchSize },
    );
    let calls = 1;
    while (!result.complete && calls < 10) {
      result = await repairService.repairCoordinationPrivacy(
        pool, value.operator, value.target.id,
        { confirmationScopeId: value.owned.id, batchSize },
      );
      calls += 1;
    }
    expect(result).toMatchObject({ state: 'disabled_only', complete: true });
    if (auditRows > batchSize) expect(calls).toBeGreaterThan(1);
    expect((await pool.query(
      `SELECT offboarded_at, display_name FROM principals WHERE id = $1`, [value.target.id],
    )).rows).toEqual([{ offboarded_at: null, display_name: 'Target' }]);
    await expect(repairService.repairCoordinationPrivacy(
      pool, value.operator, value.target.id,
      { confirmationScopeId: value.owned.id, batchSize },
    )).resolves.toMatchObject({ complete: true });
  });

  it('does not report a completed run repaired while unrelated erasure state remains dirty', async () => {
    const value = await fixture('mixed-drift');
    let completed = await offboarding.offboardPrincipal(pool, value.operator, value.target.id, {
      confirmationScopeId: value.owned.id, batchSize: 100,
    });
    while (!completed.complete) {
      completed = await offboarding.offboardPrincipal(pool, value.operator, value.target.id, {
        confirmationScopeId: value.owned.id, batchSize: 100,
      });
    }
    await reopenPrivacy(value.target, value.shared.id, 1);
    await pool.query('ALTER TABLE scope_memberships DISABLE TRIGGER USER');
    try {
      await pool.query(
        `UPDATE scope_memberships SET active = TRUE
          WHERE principal_id = $1 AND scope_id = $2`,
        [value.target.id, value.owned.id],
      );
    } finally {
      await pool.query('ALTER TABLE scope_memberships ENABLE TRIGGER USER');
    }

    let repaired = await offboarding.offboardPrincipal(pool, value.operator, value.target.id, {
      confirmationScopeId: value.owned.id, batchSize: 100,
    });
    expect(repaired.complete).toBe(false);
    for (let attempt = 0; !repaired.complete && attempt < 10; attempt += 1) {
      repaired = await offboarding.offboardPrincipal(pool, value.operator, value.target.id, {
        confirmationScopeId: value.owned.id, batchSize: 100,
      });
    }
    expect(repaired.complete).toBe(true);
    expect((await pool.query(
      `SELECT count(*)::int AS active FROM scope_memberships
        WHERE scope_id = $1 AND active`, [value.owned.id],
    )).rows).toEqual([{ active: 0 }]);
  });

  it('refuses the pre-0067 restart path when only coordination privacy is dirty', async () => {
    const value = await fixture('mixed-version');
    let completed = await offboarding.offboardPrincipal(pool, value.operator, value.target.id, {
      confirmationScopeId: value.owned.id, batchSize: 100,
    });
    while (!completed.complete) {
      completed = await offboarding.offboardPrincipal(pool, value.operator, value.target.id, {
        confirmationScopeId: value.owned.id, batchSize: 100,
      });
    }
    await reopenPrivacy(value.target, value.shared.id, 0);
    const run = (await pool.query(
      `SELECT run_id, approval_id, approval_evidence_hash
         FROM principal_offboarding_runs WHERE principal_id = $1`, [value.target.id],
    )).rows[0];

    await expect(pool.query(
      `SELECT * FROM continuum_operator_restart_offboarding_run($1, $2, $3::jsonb)`,
      [value.target.id, value.operator.id, JSON.stringify({
        approval_id: String(run.approval_id),
        approval_evidence_hash: run.approval_evidence_hash,
        initial_memories: 0, initial_embeddings: 0, initial_memberships: 0,
        initial_aliases: 0, initial_entra_bindings: 0, initial_audit_rows: 0,
        initial_audit_queries: 0, initial_audit_selection: {}, initial_count_truncated: [],
      })],
    )).rejects.toThrow(/coordination privacy repair.*restart refused/i);
    expect((await pool.query(
      `SELECT completed_at IS NOT NULL AS completed FROM principal_offboarding_runs
        WHERE run_id = $1`, [run.run_id],
    )).rows).toEqual([{ completed: true }]);
  });
});
