import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg, { type PoolConfig } from 'pg';
import { addMembership } from '../storage/memberships.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { reactivatePrincipal } from './principal-admin.js';
import { mapOwnedUserScope, offboardPrincipal } from './offboarding.js';

async function applyApplicationRoleGrants(pool: pg.Pool, role: string): Promise<void> {
  const source = await readFile(
    join(process.cwd(), 'scripts/grant-application-role.sql'), 'utf8',
  );
  const sql = source.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n')
    .replaceAll(':"continuum_schema"', '"public"')
    .replaceAll(':"continuum_app_role"', `"${role}"`);
  await pool.query(sql);
}

describe('final offboarding authorization and evidence boundary', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => { await pool?.end(); });

  async function fixture() {
    const initiator = await createPrincipal(pool, {
      externalId: 'final-remediation-initiator', kind: 'user', displayName: 'Initiator',
    });
    const takeover = await createPrincipal(pool, {
      externalId: 'final-remediation-takeover', kind: 'user', displayName: 'Takeover',
    });
    const target = await createPrincipal(pool, {
      externalId: 'final-remediation-target', kind: 'user', displayName: 'Target',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const scope = await createScope(pool, { kind: 'user', name: 'final-remediation-owned' });
    await addMembership(pool, initiator.id, org!.id, 'admin');
    await addMembership(pool, takeover.id, org!.id, 'admin');
    await addMembership(pool, target.id, scope.id, 'writer');
    await mapOwnedUserScope(pool, initiator, target.id, scope.id);
    await pool.query(
      `INSERT INTO memories (id, scope_id, type, title, body, author_id, source)
       SELECT gen_random_uuid(), $1, 'context', 'private ' || n, 'secret ' || n, $2, 'manual'
         FROM generate_series(1, 3) n`,
      [scope.id, target.id],
    );
    return { initiator, takeover, target, org: org!, scope };
  }

  it.each(['demoted', 'disabled'] as const)(
    'lets a second current administrator resume after the initiator is %s', async (loss) => {
    const value = await fixture();
    const first = await offboardPrincipal(pool, value.initiator, value.target.id, {
      confirmationScopeId: value.scope.id, batchSize: 1,
    });
    expect(first.complete).toBe(false);
    if (loss === 'demoted') {
      await pool.query(
        `UPDATE scope_memberships SET role = 'writer'
          WHERE principal_id = $1 AND scope_id = $2 AND source_kind = 'manual'`,
        [value.initiator.id, value.org.id],
      );
    } else {
      await pool.query(
        'UPDATE principals SET disabled_at = now() WHERE id = $1', [value.initiator.id],
      );
    }

    let result = first;
    for (let attempt = 0; attempt < 30 && !result.complete; attempt += 1) {
      result = await offboardPrincipal(pool, value.takeover, value.target.id, {
        confirmationScopeId: value.scope.id, batchSize: 1,
      });
    }
    expect(result.complete).toBe(true);
    expect((await pool.query(
      `SELECT phase, initiated_by::text, finalized_by::text, evidence
         FROM principal_offboarding_run_events
        WHERE principal_id = $1 ORDER BY id`,
      [value.target.id],
    )).rows).toEqual([
      expect.objectContaining({
        phase: 'started', initiated_by: value.initiator.id, finalized_by: null,
      }),
      expect.objectContaining({
        phase: 'resumed', initiated_by: value.initiator.id,
        finalized_by: value.takeover.id,
        evidence: expect.objectContaining({
          resumed_by: value.takeover.id, takeover_from: value.initiator.id,
        }),
      }),
      expect.objectContaining({
        phase: 'completed', initiated_by: value.initiator.id,
        finalized_by: value.takeover.id,
        evidence: expect.objectContaining({ finalized_by: value.takeover.id }),
      }),
    ]);
    },
  );

  it('keeps fresh-run authorization separate and rejects direct app-role forgery', async () => {
    const value = await fixture();
    let completed = await offboardPrincipal(pool, value.initiator, value.target.id, {
      confirmationScopeId: value.scope.id,
    });
    while (!completed.complete) {
      completed = await offboardPrincipal(pool, value.initiator, value.target.id, {
        confirmationScopeId: value.scope.id,
      });
    }
    await reactivatePrincipal(pool, value.takeover, value.target.id);

    const role = `continuum_final_${Date.now()}`;
    const quotedRole = `"${role}"`;
    await pool.query(`CREATE ROLE ${quotedRole} NOLOGIN`);
    let rolePool: pg.Pool | undefined;
    try {
      await pool.query(`GRANT ${quotedRole} TO CURRENT_USER`);
      await applyApplicationRoleGrants(pool, role);
      rolePool = new pg.Pool({
        ...(pool as unknown as { options: PoolConfig }).options,
        max: 1,
        options: `-c role=${role}`,
      });

      await expect(rolePool.query(
        `INSERT INTO scope_memberships
           (principal_id, scope_id, role, source_kind, source_id, active)
         VALUES ($1, $2, 'admin', 'manual', 'forged', TRUE)`,
        [value.target.id, value.org.id],
      )).rejects.toThrow(/guarded|permission denied/i);
      await expect(rolePool.query(
        `INSERT INTO principal_offboarding_events
           (principal_id, scope_id, actor_principal_id, repair, memories, embeddings,
            memberships, aliases, entra_bindings, audit_rows, audit_queries,
            approval_id, batches, evidence)
         SELECT principal_id, scope_id, $2, TRUE, 0, 0, 0, 0, 0, 0, 0,
                approval_id, 1, '{}'::jsonb
           FROM principal_offboarding_runs WHERE principal_id = $1`,
        [value.target.id, value.target.id],
      )).rejects.toThrow(/permission denied/i);
      await expect(rolePool.query(
        `SELECT * FROM continuum_write_offboarding_run(
           $1, $2, 'restart',
           '{"approval_id":1,"approval_evidence_hash":"forged",
             "initial_memories":0,"initial_embeddings":0,"initial_memberships":0,
             "initial_aliases":0,"initial_entra_bindings":0,"initial_audit_rows":0,
             "initial_audit_queries":0,"initial_audit_selection":{},
             "initial_count_truncated":[]}'::jsonb)`,
        [value.target.id, value.takeover.id],
      )).rejects.toThrow(/permission denied|fresh offboarding|unsupported offboarding progress command/i);
      await expect(rolePool.query(
        `UPDATE principal_offboarding_run_events SET finalized_by = $2
          WHERE principal_id = $1`,
        [value.target.id, value.target.id],
      )).rejects.toThrow(/permission denied|immutable/i);
      await expect(rolePool.query(
        `DELETE FROM principal_offboarding_run_events WHERE principal_id = $1`,
        [value.target.id],
      )).rejects.toThrow(/permission denied|immutable/i);
    } finally {
      await rolePool?.end();
      await pool.query(`DROP OWNED BY ${quotedRole}`);
      await pool.query(`REVOKE ${quotedRole} FROM CURRENT_USER`);
      await pool.query(`DROP ROLE ${quotedRole}`);
    }
  });

  it('accepts a bounded completion verification timeout without duplicating the state proof', async () => {
    const value = await fixture();
    const boundedOptions = {
      confirmationScopeId: value.scope.id, verificationTimeoutMs: 5_000,
    };
    let result = await offboardPrincipal(pool, value.initiator, value.target.id, boundedOptions);
    while (!result.complete) {
      result = await offboardPrincipal(pool, value.initiator, value.target.id, boundedOptions);
    }
    expect(result.complete).toBe(true);
    const invalidOptions = {
      confirmationScopeId: value.scope.id, verificationTimeoutMs: 0,
    };
    await expect(offboardPrincipal(pool, value.initiator, value.target.id, invalidOptions))
      .rejects.toThrow(/verification timeout/i);
  });
});
