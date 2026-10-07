import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg, { type PoolConfig } from 'pg';
import { LIFECYCLE_PRINCIPAL_ID } from '../lifecycle/principal.js';
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';
import { processIngestDelivery } from '../storage/ingest-deliveries.js';
import { addMembership } from '../storage/memberships.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { issueApiKey } from './api-keys.js';
import { captureOne } from './capture.js';
import { provisionEntraGroupBinding, syncEntraMemberships } from './membership-sync.js';
import { provisionServicePrincipal, reactivatePrincipal } from './principal-admin.js';
import { mapOwnedUserScope, offboardPrincipal } from './offboarding.js';

async function applyApplicationRoleGrants(pool: pg.Pool, role: string): Promise<void> {
  const source = await readFile(
    join(process.cwd(), 'scripts/grant-application-role.sql'), 'utf8',
  );
  const sql = source.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n')
    .replaceAll(':"continuum_schema"', '"public"')
    .replaceAll(':"continuum_app_role"', `"${role}"`)
    .replaceAll(":'continuum_app_role'", `'${role}'`);
  await pool.query(sql);
}

async function applyOperatorRoleGrants(
  pool: pg.Pool, role: string, principalId: string,
): Promise<void> {
  const source = await readFile(
    join(process.cwd(), 'scripts/grant-operator-role.sql'), 'utf8',
  );
  const sql = source.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n')
    .replaceAll(':"continuum_schema"', '"public"')
    .replaceAll(':"continuum_operator_role"', `"${role}"`)
    .replaceAll(":'continuum_operator_role'", `'${role}'`)
    .replaceAll(":'continuum_principal_id'", `'${principalId}'`);
  await pool.query(sql);
}

async function fixture(pool: pg.Pool, complete = true) {
  const admin = await createPrincipal(pool, {
    externalId: 'reactivation-security-admin', kind: 'user', displayName: 'Admin',
  });
  const target = await createPrincipal(pool, {
    externalId: 'reactivation-security-target', kind: 'user', displayName: 'Target',
  });
  const org = await getScopeByRef(pool, { kind: 'org', name: '' });
  await addMembership(pool, admin.id, org!.id, 'admin');
  const scope = await createScope(pool, { kind: 'user', name: 'reactivation-security-owned' });
  await addMembership(pool, target.id, scope.id, 'writer');
  await mapOwnedUserScope(pool, admin, target.id, scope.id);
  if (!complete) {
    await pool.query(
      `INSERT INTO memories (id, scope_id, type, title, body, author_id, source)
       VALUES (gen_random_uuid(), $1, 'context', 'private', 'private', $2, 'manual')`,
      [scope.id, target.id],
    );
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, query, metadata)
       SELECT $1, 'read', $2, 'private ' || n, '{}'::jsonb FROM generate_series(1, 5) n`,
      [admin.id, scope.id],
    );
  }
  let offboarded = await offboardPrincipal(pool, admin, target.id, {
    confirmationScopeId: scope.id, batchSize: complete ? undefined : 1,
  });
  while (complete && !offboarded.complete) {
    offboarded = await offboardPrincipal(pool, admin, target.id, {
      confirmationScopeId: scope.id,
    });
  }
  return { admin, target, scope, offboarded };
}

describe('principal reactivation database trust boundary', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => { await pool?.end(); });

  it('revokes the security-definer capability from PUBLIC', async () => {
    const result = await pool.query(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_proc proc
           CROSS JOIN LATERAL aclexplode(
             COALESCE(proc.proacl, acldefault('f', proc.proowner))
           ) privilege
          WHERE proc.oid = 'continuum_reactivate_principal(uuid,uuid)'::regprocedure
            AND privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
       ) AS public_execute`,
    );
    expect(result.rows[0].public_execute).toBe(false);
  });

  it('ships explicit non-owner grants without capability-table forgery privileges', async () => {
    const grants = await readFile(
      join(process.cwd(), 'scripts/grant-application-role.sql'), 'utf8',
    );
    expect(grants).toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*continuum_complete_offboarding_run\(UUID, UUID, JSONB\)/i,
    );
    expect(grants).toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*continuum_reactivate_principal\(UUID, UUID\)/i,
    );
    expect(grants).toMatch(
      /REVOKE ALL ON TABLE[^\n]*continuum_offboarding_completion_requests/i,
    );
    expect(grants).toMatch(
      /REVOKE ALL ON TABLE[^\n]*continuum_principal_reactivation_requests/i,
    );
    expect(grants).toMatch(
      /GRANT SELECT ON TABLE[^\n]*principal_offboarding_runs/i,
    );
    expect(grants).toMatch(
      /GRANT SELECT ON TABLE[\s\S]*principal_offboarding_run_events/i,
    );
    expect(grants).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE[\s\S]*principal_offboarding_runs/i,
    );
    expect(grants).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE[\s\S]*principal_offboarding_run_events/i,
    );
    expect(grants).toMatch(/continuum_write_offboarding_run\(UUID, UUID, TEXT, JSONB\)/i);
    expect(grants).toMatch(/continuum_start_offboarding_run\(UUID, UUID, JSONB\)/i);
    for (const table of [
      'service_api_keys', 'ingest_deliveries', 'entra_sync_state',
    ]) {
      expect(grants).toMatch(new RegExp(`GRANT[\\s\\S]*${table}`, 'i'));
    }
    expect(grants).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE[\s\S]*scope_memberships/i,
    );
    expect(grants).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE[\s\S]*memory_embeddings/i,
    );
    expect(grants).toMatch(
      /GRANT SELECT, INSERT ON TABLE[^\n]*audit_log/i,
    );
    expect(grants).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON TABLE[^\n]*audit_log/i);
    expect(grants).toMatch(/continuum_apply_audit_retention\(/i);
    expect(grants).toMatch(/continuum_redact_offboarding_audit\(/i);
    expect(grants).toMatch(/continuum_record_offboarding_event\(UUID\)/i);
  });

  it('supports lifecycle functions as a separately granted non-owner operator role', async () => {
    const { admin, target } = await fixture(pool);
    const role = `continuum_app_test_${Date.now()}`;
    const quotedRole = `"${role}"`;
    await pool.query(`CREATE ROLE ${quotedRole} NOLOGIN`);
    try {
      await pool.query(
        `GRANT ${quotedRole} TO CURRENT_USER WITH ADMIN OPTION, SET FALSE, INHERIT FALSE`,
      );
      await applyApplicationRoleGrants(pool, role);
      await applyOperatorRoleGrants(pool, role, admin.id);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${quotedRole}`);
        expect((await client.query(
          `SELECT current_user <> tableowner AS non_owner
             FROM pg_tables WHERE schemaname = current_schema()
              AND tablename = 'principal_offboarding_runs'`,
        )).rows[0].non_owner).toBe(true);
        expect((await client.query(
          `SELECT has_function_privilege(current_user,
                    'continuum_operator_complete_offboarding_run(uuid,uuid,jsonb)', 'EXECUTE')
                    AS complete_execute,
                  has_function_privilege(current_user,
                    'continuum_operator_reactivate_principal(uuid,uuid)', 'EXECUTE')
                    AS reactivate_execute,
                  has_table_privilege(current_user,
                    'continuum_offboarding_completion_requests', 'INSERT')
                    AS forge_completion,
                  has_table_privilege(current_user,
                    'continuum_principal_reactivation_requests', 'INSERT')
                    AS forge_reactivation`,
        )).rows[0]).toEqual({
          complete_execute: true, reactivate_execute: true,
          forge_completion: false, forge_reactivation: false,
        });
        await expect(client.query(
          `INSERT INTO continuum_offboarding_completion_requests
             (run_id, backend_pid, transaction_id)
           VALUES (gen_random_uuid(), pg_backend_pid(), txid_current())`,
        )).rejects.toThrow(/permission denied/i);
        await client.query('ROLLBACK');

        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${quotedRole}`);
        await expect(client.query(
          `SELECT continuum_operator_reactivate_principal($1::uuid, $2::uuid)`,
          [target.id, admin.id],
        )).resolves.toBeDefined();
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    } finally {
      await pool.query(`DROP OWNED BY ${quotedRole}`);
      await pool.query(`REVOKE ${quotedRole} FROM CURRENT_USER`);
      await pool.query(`DROP ROLE ${quotedRole}`);
    }
  });

  it('fails promptly when a post-completion scope mutation meets the principal lock first and retries atomically', async () => {
    const { target, scope } = await fixture(pool);
    const principalClient = await pool.connect();
    const scopeClient = await pool.connect();
    try {
      await principalClient.query('BEGIN');
      await principalClient.query(
        'SELECT id FROM principals WHERE id = $1 FOR UPDATE',
        [target.id],
      );

      await scopeClient.query('BEGIN');
      // Keep a generous server-side escape hatch while proving the trigger's
      // NOWAIT lock fails materially sooner than the fallback timeout.
      await scopeClient.query("SET LOCAL lock_timeout = '5s'");
      const startedAt = Date.now();
      await expect(scopeClient.query(
        'UPDATE scopes SET name = name WHERE id = $1',
        [scope.id],
      )).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      await scopeClient.query('ROLLBACK');

      await principalClient.query('COMMIT');
      await scopeClient.query('BEGIN');
      await scopeClient.query("SET LOCAL lock_timeout = '5s'");
      await expect(scopeClient.query(
        'UPDATE scopes SET name = name WHERE id = $1 RETURNING id',
        [scope.id],
      )).resolves.toMatchObject({ rowCount: 1 });
      await scopeClient.query('COMMIT');
    } finally {
      await Promise.allSettled([
        principalClient.query('ROLLBACK'),
        scopeClient.query('ROLLBACK'),
      ]);
      principalClient.release();
      scopeClient.release();
    }
  });

  it('does not let the application role rewrite or restart a completed erased run', async () => {
    const { admin, target } = await fixture(pool);
    const role = `continuum_completed_run_${Date.now()}`;
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
      const before = (await rolePool.query(
        `SELECT run_id::text, initiated_by::text, completed_at,
                memories_processed, batches
           FROM principal_offboarding_runs WHERE principal_id = $1`,
        [target.id],
      )).rows[0];

      await expect(rolePool.query(
        `SELECT * FROM continuum_write_offboarding_run(
           $1, $2, 'add_progress',
           '{"memories":999,"audit_rows":999,"embeddings":999,
             "memberships":999,"aliases":999,"entra_bindings":999,
             "audit_queries":999}'::jsonb)`,
        [target.id, admin.id],
      )).rejects.toThrow(/permission denied|completed offboarding run is immutable/i);
      await expect(rolePool.query(
        `SELECT * FROM continuum_write_offboarding_run(
           $1, $2, 'restart',
           '{"approval_id":1,"approval_evidence_hash":"forged",
             "initial_memories":999,"initial_embeddings":999,
             "initial_memberships":999,"initial_aliases":999,
             "initial_entra_bindings":999,"initial_audit_rows":999,
             "initial_audit_queries":999,"initial_audit_selection":{},
             "initial_count_truncated":[]}'::jsonb)`,
        [target.id, admin.id],
      )).rejects.toThrow(/permission denied|fresh offboarding restart requires the guarded restart function/i);

      expect((await rolePool.query(
        `SELECT run_id::text, initiated_by::text, completed_at,
                memories_processed, batches
           FROM principal_offboarding_runs WHERE principal_id = $1`,
        [target.id],
      )).rows[0]).toEqual(before);
    } finally {
      await rolePool?.end();
      await pool.query(`DROP OWNED BY ${quotedRole}`);
      await pool.query(`REVOKE ${quotedRole} FROM CURRENT_USER`);
      await pool.query(`DROP ROLE ${quotedRole}`);
    }
  });

  it('does not let the operator forge completion from caller-controlled progress', async () => {
    const { admin, target, scope } = await fixture(pool, false);
    const role = `continuum_forgery_${Date.now()}`;
    const quotedRole = `"${role}"`;
    await pool.query(`CREATE ROLE ${quotedRole} NOLOGIN`);
    let rolePool: pg.Pool | undefined;
    try {
      await pool.query(
        `GRANT ${quotedRole} TO CURRENT_USER WITH ADMIN OPTION, SET FALSE, INHERIT FALSE`,
      );
      await applyApplicationRoleGrants(pool, role);
      await applyOperatorRoleGrants(pool, role, admin.id);
      rolePool = new pg.Pool({
        ...(pool as unknown as { options: PoolConfig }).options,
        max: 2,
        options: `-c role=${role}`,
      });
      await expect(rolePool.query(
        `UPDATE principal_offboarding_runs
            SET memory_complete = TRUE,
                scope_cleanup_complete = TRUE,
                audit_principal_cursor = audit_fence_id,
                audit_scope_cursor = audit_fence_id,
                audit_scope_ids_cursor = audit_fence_id,
                audit_memory_complete = TRUE,
                audit_linked_request_exhausted = TRUE,
                audit_linked_complete = TRUE,
                audit_linked_cursor = audit_fence_id
          WHERE principal_id = $1
          RETURNING *`,
        [target.id],
      )).rejects.toThrow(/permission denied/i);
      await expect(rolePool.query(
        `INSERT INTO principal_offboarding_run_events
           (run_id, principal_id, scope_id, phase, initiated_by, approval_id,
            approval_evidence_hash, evidence)
         SELECT run_id, principal_id, scope_id, 'completed', initiated_by,
                approval_id, approval_evidence_hash, '{}'::jsonb
           FROM principal_offboarding_runs WHERE principal_id = $1`,
        [target.id],
      )).rejects.toThrow(/permission denied/i);

      for (const command of ['scope_complete', 'set_fence', 'memory_complete']) {
        await rolePool.query(
          `SELECT * FROM continuum_operator_write_offboarding_run($1, $2, $3, '{}'::jsonb)`,
          [target.id, admin.id, command],
        );
      }
      const fence = (await rolePool.query(
        'SELECT audit_fence_id FROM principal_offboarding_runs WHERE principal_id = $1',
        [target.id],
      )).rows[0].audit_fence_id;
      for (const column of [
        'audit_principal_cursor', 'audit_scope_cursor', 'audit_scope_ids_cursor',
      ]) {
        await rolePool.query(
          `SELECT * FROM continuum_operator_write_offboarding_run($1, $2, 'audit_cursor', $3::jsonb)`,
          [target.id, admin.id, JSON.stringify({ column, cursor: fence })],
        );
      }
      for (const command of ['audit_memory_complete', 'linked_complete']) {
        await rolePool.query(
          `SELECT * FROM continuum_operator_write_offboarding_run($1, $2, $3, '{}'::jsonb)`,
          [target.id, admin.id, command],
        );
      }
      await pool.query(
        `UPDATE memories SET type = 'context', title = '[erased]', body = '[erased]',
                metadata = '{}'::jsonb, tags = '{}'::text[], source = 'erased',
                source_ref = NULL, state = 'archived', supersedes_id = NULL,
                promoted_to_id = NULL, expires_at = NULL, last_verified = NULL
          WHERE scope_id = $1`,
        [scope.id],
      );
      await pool.query(
        `DELETE FROM memory_embeddings embedding USING memories memory
          WHERE embedding.memory_id = memory.id AND memory.scope_id = $1`,
        [scope.id],
      );
      await pool.query(
        `UPDATE scope_memberships SET active = FALSE,
                deactivated_at = COALESCE(deactivated_at, now())
          WHERE scope_id = $1`,
        [scope.id],
      );
      await pool.query('DELETE FROM principal_aliases WHERE principal_id = $1', [target.id]);
      await pool.query(
        `UPDATE entra_groups SET active = FALSE, approval_revoked_at = COALESCE(
                approval_revoked_at, now()) WHERE scope_id = $1`,
        [scope.id],
      );
      const principalPseudonym = `erased-${target.id.replaceAll('-', '').slice(0, 12)}`;
      const scopePseudonym = `erased-user-${scope.id}`;
      await pool.query(
        `UPDATE principals SET display_name = $2, disabled_at = COALESCE(disabled_at, now()),
                offboarded_at = COALESCE(offboarded_at, now()), reactivated_at = NULL
          WHERE id = $1`,
        [target.id, principalPseudonym],
      );
      await pool.query('UPDATE scopes SET name = $2 WHERE id = $1', [scope.id, scopePseudonym]);
      await pool.query(
        `UPDATE audit_log audit SET query = NULL,
                metadata = continuum_offboarding_expected_audit_metadata(audit.metadata)
          FROM principal_offboarding_runs run
         WHERE run.principal_id = $1 AND audit.id <= run.audit_fence_id
           AND audit.scope_id = run.scope_id
           AND COALESCE(audit.metadata->>'operation', '') <> ALL($2::text[])`,
        [target.id, [
          'principal_user_scope_mapped',
          'principal_user_scope_acknowledgement_replaced',
          'principal_memory_erased',
          'principal_offboarded',
          'principal_offboarding_repaired',
        ]],
      );
      const forged = (await rolePool.query(
        'SELECT * FROM principal_offboarding_runs WHERE principal_id = $1', [target.id],
      )).rows[0];
      const evidence = {
        run_id: forged.run_id,
        initiated_by: forged.initiated_by,
        finalized_by: admin.id,
        approval_id: forged.approval_id,
        approval_evidence_hash: forged.approval_evidence_hash,
        counts_exact: true,
        memories_processed: Number(forged.memories_processed),
        embeddings_processed: Number(forged.embeddings_processed),
        memberships_processed: Number(forged.memberships_processed),
        aliases_processed: Number(forged.aliases_processed),
        entra_bindings_processed: Number(forged.entra_bindings_processed),
        audit_rows_processed: Number(forged.audit_rows_processed),
        audit_queries_processed: Number(forged.audit_queries_processed),
        batches: Number(forged.batches),
      };
      const completion = () => rolePool!.query(
        `SELECT continuum_operator_complete_offboarding_run($1::uuid, $2::uuid, $3::jsonb)`,
        [forged.run_id, admin.id, JSON.stringify(evidence)],
      );
      const actualStateIsErased = async () => (await pool.query(
        'SELECT continuum_offboarding_actual_state_is_erased($1::uuid) AS erased',
        [forged.run_id],
      )).rows[0].erased as boolean;
      const expectGuardRejects = async () => {
        expect(await actualStateIsErased()).toBe(false);
        await expect(completion()).rejects.toThrow(
          /actual indexed erasure state is incomplete|current effective org administrator/i,
        );
      };

      expect((await pool.query(
        `SELECT continuum_offboarding_actual_state_is_erased(
           '00000000-0000-4000-8000-000000000099'::uuid
         ) AS erased`,
      )).rows[0].erased).toBe(false);
      expect(await actualStateIsErased()).toBe(true);
      const postFenceAuditId = (await pool.query(
        `INSERT INTO audit_log (principal_id, action, query, metadata)
         VALUES ($1, 'read', 'post-fence identity is outside this run', '{}'::jsonb)
         RETURNING id::text AS id`,
        [admin.id],
      )).rows[0].id as string;
      await pool.query(
        `INSERT INTO audit_log_offboarding_scopes (selector_kind, scope_id, audit_id)
         VALUES ('scope_ids', $1, $2)`,
        [scope.id, postFenceAuditId],
      );
      expect(BigInt(postFenceAuditId)).toBeGreaterThan(BigInt(fence));
      expect(await actualStateIsErased()).toBe(true);
      await expect(rolePool.query(
        `SELECT continuum_operator_complete_offboarding_run($1::uuid, $2::uuid, $3::jsonb)`,
        [forged.run_id, target.id, JSON.stringify({
          ...evidence, finalized_by: target.id, memories_processed: 999,
        })],
      )).rejects.toThrow(
        /DB-bound trusted approve identity|role-name\/OID-bound trusted approve identity|current effective org administrator/i,
      );

      await pool.query(
        'ALTER TABLE principals DISABLE TRIGGER protect_offboarded_principal_identity',
      );
      await pool.query('UPDATE principals SET display_name = $2 WHERE id = $1', [
        target.id, 'identity still present',
      ]);
      await pool.query(
        'ALTER TABLE principals ENABLE TRIGGER protect_offboarded_principal_identity',
      );
      await expectGuardRejects();
      await pool.query('UPDATE principals SET display_name = $2 WHERE id = $1', [
        target.id, principalPseudonym,
      ]);
      expect(await actualStateIsErased()).toBe(true);

      await pool.query('ALTER TABLE scopes DISABLE TRIGGER protect_offboarded_scope_identity');
      await pool.query('UPDATE scopes SET name = $2 WHERE id = $1', [
        scope.id, 'owned identity still present',
      ]);
      await pool.query('ALTER TABLE scopes ENABLE TRIGGER protect_offboarded_scope_identity');
      await expectGuardRejects();
      await pool.query('UPDATE scopes SET name = $2 WHERE id = $1', [scope.id, scopePseudonym]);
      expect(await actualStateIsErased()).toBe(true);

      await pool.query('ALTER TABLE scopes DISABLE TRIGGER protect_offboarded_scope_identity');
      await pool.query("UPDATE scopes SET kind = 'team' WHERE id = $1", [scope.id]);
      await pool.query('ALTER TABLE scopes ENABLE TRIGGER protect_offboarded_scope_identity');
      await expectGuardRejects();
      await pool.query("UPDATE scopes SET kind = 'user' WHERE id = $1", [scope.id]);
      expect(await actualStateIsErased()).toBe(true);

      const auditId = (await pool.query(
        `SELECT audit.id::text AS id
           FROM audit_log audit
           JOIN principal_offboarding_runs run ON run.principal_id = $1
          WHERE audit.scope_id = run.scope_id AND audit.id <= run.audit_fence_id
            AND COALESCE(audit.metadata->>'operation', '') <> ALL($2::text[])
          ORDER BY audit.id LIMIT 1`,
        [target.id, [
          'principal_user_scope_mapped',
          'principal_user_scope_acknowledgement_replaced',
          'principal_memory_erased',
          'principal_offboarded',
          'principal_offboarding_repaired',
        ]],
      )).rows[0].id as string;
      await pool.query(
        'ALTER TABLE audit_log DISABLE TRIGGER protect_offboarded_audit_tombstone',
      );
      await pool.query('UPDATE audit_log SET query = $2 WHERE id = $1', [
        auditId, 'audit identity still present',
      ]);
      await pool.query(
        'ALTER TABLE audit_log ENABLE TRIGGER protect_offboarded_audit_tombstone',
      );
      await expectGuardRejects();
      await pool.query('UPDATE audit_log SET query = NULL WHERE id = $1', [auditId]);
      expect(await actualStateIsErased()).toBe(true);

      await pool.query(
        'ALTER TABLE audit_log DISABLE TRIGGER protect_offboarded_audit_tombstone',
      );
      await pool.query(
        `UPDATE audit_log SET metadata =
           '{"redacted":"principal_offboarding","identity":"still present"}'::jsonb
          WHERE id = $1`,
        [auditId],
      );
      await pool.query(
        'ALTER TABLE audit_log ENABLE TRIGGER protect_offboarded_audit_tombstone',
      );
      await expectGuardRejects();
      await pool.query(
        `UPDATE audit_log SET metadata = '{"redacted":"principal_offboarding"}'::jsonb
          WHERE id = $1`,
        [auditId],
      );
      expect(await actualStateIsErased()).toBe(true);

      await pool.query(
        'ALTER TABLE audit_log DISABLE TRIGGER protect_offboarded_audit_tombstone',
      );
      await pool.query('UPDATE audit_log SET metadata = NULL WHERE id = $1', [auditId]);
      await pool.query(
        'ALTER TABLE audit_log ENABLE TRIGGER protect_offboarded_audit_tombstone',
      );
      await expectGuardRejects();
      await pool.query(
        `UPDATE audit_log SET metadata = '{"redacted":"principal_offboarding"}'::jsonb
          WHERE id = $1`,
        [auditId],
      );
      expect(await actualStateIsErased()).toBe(true);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM principal_offboarding_run_events
          WHERE run_id = $1 AND phase = 'completed'`, [forged.run_id],
      )).rows[0].count).toBe(0);
      await expect(reactivatePrincipal(rolePool, admin, target.id))
        .rejects.toThrow(/incomplete|completion evidence/i);
    } finally {
      await rolePool?.end();
      await pool.query(`DROP OWNED BY ${quotedRole}`);
      await pool.query(`REVOKE ${quotedRole} FROM CURRENT_USER`);
      await pool.query(`DROP ROLE ${quotedRole}`);
    }
  });

  it('runs multi-batch erasure, reads, audit, and reactivation as the operator role', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'app-role-offboarding-admin', kind: 'user', displayName: 'Admin',
    });
    const target = await createPrincipal(pool, {
      externalId: 'app-role-offboarding-target', kind: 'user', displayName: 'Target',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    const scope = await createScope(pool, {
      kind: 'user', name: 'app-role-offboarding-owned',
    });
    await addMembership(pool, target.id, scope.id, 'writer');
    await mapOwnedUserScope(pool, admin, target.id, scope.id);
    const role = `continuum_offboard_${Date.now()}`;
    const quotedRole = `"${role}"`;
    await pool.query(`CREATE ROLE ${quotedRole} NOLOGIN`);
    let rolePool: pg.Pool | undefined;
    try {
      await pool.query(
        `GRANT ${quotedRole} TO CURRENT_USER WITH ADMIN OPTION, SET FALSE, INHERIT FALSE`,
      );
      await applyApplicationRoleGrants(pool, role);
      await applyOperatorRoleGrants(pool, role, admin.id);
      rolePool = new pg.Pool({
        ...(pool as unknown as { options: PoolConfig }).options,
        max: 2,
        options: `-c role=${role}`,
      });
      await rolePool.query(
        `INSERT INTO memories (id, scope_id, type, title, body, author_id, source)
         SELECT gen_random_uuid(), $1, 'context', 'private ' || n, 'secret ' || n,
                $2, 'manual'
           FROM generate_series(1, 3) n`,
        [scope.id, target.id],
      );
      await rolePool.query(
        `INSERT INTO audit_log (principal_id, action, scope_id, query, metadata)
         VALUES ($1, 'read', $2, 'direct secret', '{"request_id":"app-linked"}'),
                ($1, 'read', NULL, 'linked secret', '{"request_id":"app-linked"}')`,
        [admin.id, scope.id],
      );

      let result = await offboardPrincipal(rolePool, admin, target.id, {
        batchSize: 1, confirmationScopeId: scope.id,
      });
      for (let attempt = 0; attempt < 30 && !result.complete; attempt += 1) {
        result = await offboardPrincipal(rolePool, admin, target.id, {
          batchSize: 1, confirmationScopeId: scope.id,
        });
      }
      expect(result.complete).toBe(true);
      expect((await rolePool.query(
        `SELECT count(*)::int AS count FROM memories
          WHERE scope_id = $1 AND (title <> '[erased]' OR body <> '[erased]')`, [scope.id],
      )).rows[0].count).toBe(0);
      expect((await rolePool.query(
        `SELECT count(*)::int AS count FROM audit_log
          WHERE metadata->>'request_id' = 'app-linked' AND query IS NOT NULL`,
      )).rows[0].count).toBe(1);
      expect((await rolePool.query(
        `SELECT query FROM audit_log
          WHERE metadata->>'request_id' = 'app-linked' AND query IS NOT NULL`,
      )).rows).toEqual([{ query: 'linked secret' }]);
      expect((await rolePool.query(
        `SELECT count(*)::int AS count FROM audit_log
          WHERE metadata->>'operation' = 'principal_offboarded'`,
      )).rows[0].count).toBe(1);
      const completedRunId = (await rolePool.query(
        'SELECT run_id::text AS run_id FROM principal_offboarding_runs WHERE principal_id = $1',
        [target.id],
      )).rows[0].run_id as string;
      expect((await pool.query(
        'SELECT continuum_offboarding_actual_state_is_erased($1::uuid) AS erased',
        [completedRunId],
      )).rows[0].erased).toBe(true);
      await expect(rolePool.query(
        `UPDATE principals SET display_name = 'restored identity' WHERE id = $1`,
        [target.id],
      )).rejects.toThrow(/offboarded principal identity is immutable/i);
      await expect(rolePool.query(
        `UPDATE scopes SET name = 'restored owned identity' WHERE id = $1`,
        [scope.id],
      )).rejects.toThrow(/offboarded owned-scope identity is immutable|permission denied/i);
      const redactedAuditId = (await rolePool.query(
        `SELECT audit.id::text AS id
           FROM audit_log audit
          WHERE audit.scope_id = $1
            AND audit.metadata = '{"redacted":"principal_offboarding"}'::jsonb
          ORDER BY audit.id LIMIT 1`,
        [scope.id],
      )).rows[0].id as string;
      await expect(rolePool.query(
        `UPDATE audit_log SET query = 'restored audit identity' WHERE id = $1`,
        [redactedAuditId],
      )).rejects.toThrow(/permission denied/i);
      await expect(rolePool.query(
        'UPDATE audit_log SET scope_id = NULL WHERE id = $1',
        [redactedAuditId],
      )).rejects.toThrow(/permission denied/i);
      await expect(rolePool.query(
        'UPDATE audit_log SET metadata = $2::jsonb WHERE id = $1',
        [redactedAuditId, JSON.stringify({
          operation: 'service_principal_provisioned',
          service_principal_id: '00000000-0000-4000-8000-000000000099',
          external_id: 'restored@example.test',
        })],
      )).rejects.toThrow(/permission denied/i);
      const preservedAuditId = (await rolePool.query(
        `SELECT id::text AS id FROM audit_log
          WHERE metadata->>'operation' = 'principal_offboarded'
          ORDER BY id DESC LIMIT 1`,
      )).rows[0].id as string;
      await expect(rolePool.query(
        `UPDATE audit_log SET metadata = '{"redacted":"principal_offboarding"}'::jsonb
          WHERE id = $1`,
        [preservedAuditId],
      )).rejects.toThrow(/permission denied/i);
      await expect(reactivatePrincipal(rolePool, admin, target.id)).resolves.toBeUndefined();
      expect((await rolePool.query(
        `SELECT disabled_at, offboarded_at, reactivated_at IS NOT NULL AS reactivated
           FROM principals WHERE id = $1`, [target.id],
      )).rows[0]).toEqual({ disabled_at: null, offboarded_at: null, reactivated: true });
    } finally {
      await rolePool?.end();
      await pool.query(`DROP OWNED BY ${quotedRole}`);
      await pool.query(`REVOKE ${quotedRole} FROM CURRENT_USER`);
      await pool.query(`DROP ROLE ${quotedRole}`);
    }
  });

  it('supports representative runtime traffic through the documented non-owner grants', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'runtime-role-admin', kind: 'user', displayName: 'Runtime Admin',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    const role = `continuum_runtime_${Date.now()}`;
    const quotedRole = `"${role}"`;
    await pool.query(`CREATE ROLE ${quotedRole} NOLOGIN`);
    let rolePool: pg.Pool | undefined;
    try {
      await pool.query(`GRANT ${quotedRole} TO CURRENT_USER`);
      await applyApplicationRoleGrants(pool, role);
      rolePool = new pg.Pool({
        ...(pool as unknown as { options: PoolConfig }).options,
        max: 2,
        options: `-c role=${role}`,
      });
      await expect(rolePool.query(
        `INSERT INTO entra_groups
           (external_id, display_name, scope_id, role, active, approved_by, approved_at)
         VALUES ('99999999-9999-4999-8999-999999999999', 'forged-admin',
                 $1, 'admin', TRUE, $2, now())`,
        [org!.id, admin.id],
      )).rejects.toThrow(/permission denied|guarded database function/i);
      await expect(rolePool.query(
        `INSERT INTO principal_user_scope_approvals
           (principal_id, scope_id, approved_by, acknowledged_principal_ids,
            acknowledged_evidence_hash)
         VALUES ($1, $1, $1, '{}'::uuid[], repeat('0', 64))`,
        [admin.id],
      )).rejects.toThrow(/permission denied/i);
      const project = await createScope(rolePool, { kind: 'project', name: 'runtime-role' });
      const service = await provisionServicePrincipal(
        rolePool, admin, '12345678-1234-4234-8234-123456789abc', 'Runtime Service',
      );
      await addMembership(rolePool, service.id, project.id, 'writer');
      const delivery = await processIngestDelivery(
        rolePool, 'terminal-summary', 'runtime-role-delivery', 'a'.repeat(64),
        async (client) => [await captureOne(client, null, service, {
          scope: { kind: 'project', name: 'runtime-role' }, type: 'context',
          title: 'Runtime capture', body: 'Representative application traffic.',
          source: 'terminal-summary',
        })],
      );
      await storeMemoryEmbeddingVector(
        rolePool, delivery.memoryIds[0], Array(768).fill(0), { id: 'test', dim: 768 },
      );
      await expect(issueApiKey(rolePool, admin, service.id, 'terminal-summary'))
        .resolves.toMatchObject({ allowedSource: 'terminal-summary' });
      const groupId = '87654321-4321-4321-8321-cba987654321';
      await expect(provisionEntraGroupBinding(rolePool, admin, {
        externalId: groupId, scopeId: project.id, role: 'reader',
      })).rejects.toThrow(/trusted|permission denied|database identity/i);
      await expect(syncEntraMemberships(rolePool, admin, [{
        id: groupId, status: 'present', displayName: 'Runtime Group',
        memberObjectIds: ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
      }], { allowMassDeactivation: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await rolePool?.end();
      await pool.query(`DROP OWNED BY ${quotedRole}`);
      await pool.query(`REVOKE ${quotedRole} FROM CURRENT_USER`);
      await pool.query(`DROP ROLE ${quotedRole}`);
    }
  });

  it('rejects pg_temp shadow attempts from a non-owner application role', async () => {
    const { admin, target, scope } = await fixture(pool, false);
    const memoryId = (await pool.query(
      'SELECT id FROM memories WHERE scope_id = $1 ORDER BY id LIMIT 1', [scope.id],
    )).rows[0].id as string;
    const runId = (await pool.query(
      'SELECT run_id FROM principal_offboarding_runs WHERE principal_id = $1', [target.id],
    )).rows[0].run_id as string;
    const role = `continuum_shadow_${Date.now()}`;
    const quotedRole = `"${role}"`;
    await pool.query(`CREATE ROLE ${quotedRole} NOLOGIN`);
    try {
      await pool.query(`GRANT ${quotedRole} TO CURRENT_USER`);
      await applyApplicationRoleGrants(pool, role);
      const client = await pool.connect();
      try {
        const attack = async (
          setup: string, sql: string, parameters: unknown[], expected: RegExp,
        ) => {
          await client.query('BEGIN');
          await client.query(`SET LOCAL ROLE ${quotedRole}`);
          await client.query('SET LOCAL search_path = pg_temp, public');
          await client.query(setup);
          await expect(client.query(sql, parameters)).rejects.toThrow(expected);
          await client.query('ROLLBACK');
        };
        await attack(
          `CREATE TEMP TABLE principal_offboarding_run_events (run_id UUID, phase TEXT);
           INSERT INTO principal_offboarding_run_events VALUES ('${runId}', 'completed')`,
          'UPDATE principal_offboarding_runs SET completed_at = now() WHERE run_id = $1',
          [runId],
          /permission denied/i,
        );
        await attack(
          `CREATE TEMP TABLE continuum_principal_reactivation_requests
             (principal_id UUID, backend_pid INTEGER, transaction_id BIGINT);
           INSERT INTO continuum_principal_reactivation_requests
             VALUES ('${target.id}', pg_backend_pid(), txid_current())`,
          `UPDATE principals SET disabled_at = NULL, offboarded_at = NULL,
             reactivated_at = now() WHERE id = $1`,
          [target.id],
          /guarded database function/i,
        );
        await attack(
          `CREATE TEMP TABLE principals (id UUID, offboarded_at TIMESTAMPTZ);
           CREATE TEMP TABLE principal_user_scopes (principal_id UUID, scope_id UUID)`,
          `INSERT INTO audit_log (principal_id, action, scope_id, query, metadata)
           VALUES ($1, 'read', $2, 'late secret', '{}'::jsonb)`,
          [admin.id, scope.id],
          /audit insert forbidden for an offboarded owned scope/i,
        );
        await attack(
          `CREATE TEMP TABLE memories (id UUID, state TEXT);
           INSERT INTO memories VALUES ('${memoryId}', 'live')`,
          `INSERT INTO memory_embeddings (memory_id, provider, dim, embedding)
           VALUES ($1, 'forged', 768, $2::vector)`,
          [memoryId, `[${Array(768).fill(0).join(',')}]`],
          /embedding requires a live memory/i,
        );
      } finally {
        client.release();
      }
    } finally {
      await pool.query(`DROP OWNED BY ${quotedRole}`);
      await pool.query(`REVOKE ${quotedRole} FROM CURRENT_USER`);
      await pool.query(`DROP ROLE ${quotedRole}`);
    }
  });

  it('attributes direct capability use to the lifecycle guard, not the presented administrator', async () => {
    const { admin, target } = await fixture(pool);
    await expect(pool.query(
      'SELECT continuum_reactivate_principal($1::uuid, $2::uuid)',
      [target.id, admin.id],
    )).resolves.toBeDefined();

    expect((await pool.query(
      `SELECT disabled_at, offboarded_at, reactivated_at IS NOT NULL AS reactivated
         FROM principals WHERE id = $1`,
      [target.id],
    )).rows[0]).toEqual({ disabled_at: null, offboarded_at: null, reactivated: true });
    expect((await pool.query(
      `SELECT principal_id, metadata->>'operation' AS operation,
              metadata->>'authorization_principal_id' AS authorization_principal_id,
              metadata->>'previously_offboarded' AS previously_offboarded
         FROM audit_log
        WHERE metadata->>'operation' IN
          ('principal_reactivation_guarded', 'principal_reactivated')
        ORDER BY id`,
    )).rows).toEqual([{
      principal_id: LIFECYCLE_PRINCIPAL_ID,
      operation: 'principal_reactivation_guarded',
      authorization_principal_id: admin.id,
      previously_offboarded: 'true',
    }]);
  });

  it('rolls back direct capability use when its mandatory guard audit fails', async () => {
    const { admin, target } = await fixture(pool);
    await pool.query(`
      CREATE FUNCTION issue4_reject_reactivation_guard_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.metadata->>'operation' = 'principal_reactivation_guarded' THEN
          RAISE EXCEPTION 'forced guarded reactivation audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER issue4_reject_reactivation_guard_audit
      BEFORE INSERT ON audit_log FOR EACH ROW
      EXECUTE FUNCTION issue4_reject_reactivation_guard_audit();
    `);
    try {
      await expect(pool.query(
        'SELECT continuum_reactivate_principal($1::uuid, $2::uuid)',
        [target.id, admin.id],
      )).rejects.toThrow(/forced guarded reactivation audit failure/i);
    } finally {
      await pool.query(`
        DROP TRIGGER issue4_reject_reactivation_guard_audit ON audit_log;
        DROP FUNCTION issue4_reject_reactivation_guard_audit();
      `);
    }

    expect((await pool.query(
      `SELECT disabled_at IS NOT NULL AS disabled,
              offboarded_at IS NOT NULL AS offboarded, reactivated_at
         FROM principals WHERE id = $1`,
      [target.id],
    )).rows[0]).toEqual({ disabled: true, offboarded: true, reactivated_at: null });
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE metadata->>'operation' = 'principal_reactivation_guarded'`,
    )).rows[0].count).toBe(0);
  });

  it('keeps authenticated service actor truth in a separate same-transaction audit', async () => {
    const { admin, target } = await fixture(pool);
    await reactivatePrincipal(pool, admin, target.id);

    expect((await pool.query(
      `SELECT principal_id, metadata->>'operation' AS operation,
              metadata->>'authorization_principal_id' AS authorization_principal_id,
              metadata->>'previously_offboarded' AS previously_offboarded
         FROM audit_log
        WHERE metadata->>'operation' IN
          ('principal_reactivation_guarded', 'principal_reactivated')
        ORDER BY id`,
    )).rows).toEqual([
      {
        principal_id: LIFECYCLE_PRINCIPAL_ID,
        operation: 'principal_reactivation_guarded',
        authorization_principal_id: admin.id,
        previously_offboarded: 'true',
      },
      {
        principal_id: admin.id,
        operation: 'principal_reactivated',
        authorization_principal_id: null,
        previously_offboarded: 'true',
      },
    ]);
  });

  it('rolls back service reactivation when authenticated actor auditing fails', async () => {
    const { admin, target } = await fixture(pool);
    await pool.query(`
      CREATE FUNCTION issue4_reject_reactivation_actor_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.metadata->>'operation' = 'principal_reactivated' THEN
          RAISE EXCEPTION 'forced reactivation actor audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER issue4_reject_reactivation_actor_audit
      BEFORE INSERT ON audit_log FOR EACH ROW
      EXECUTE FUNCTION issue4_reject_reactivation_actor_audit();
    `);
    try {
      await expect(reactivatePrincipal(pool, admin, target.id))
        .rejects.toThrow(/forced reactivation actor audit failure/i);
    } finally {
      await pool.query(`
        DROP TRIGGER issue4_reject_reactivation_actor_audit ON audit_log;
        DROP FUNCTION issue4_reject_reactivation_actor_audit();
      `);
    }

    expect((await pool.query(
      `SELECT disabled_at IS NOT NULL AS disabled,
              offboarded_at IS NOT NULL AS offboarded, reactivated_at
         FROM principals WHERE id = $1`,
      [target.id],
    )).rows[0]).toEqual({ disabled: true, offboarded: true, reactivated_at: null });
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE metadata->>'operation' IN
          ('principal_reactivation_guarded', 'principal_reactivated')`,
    )).rows[0].count).toBe(0);
  });

  it('keeps direct updates and non-admin capability calls prohibited', async () => {
    const { target } = await fixture(pool);
    const outsider = await createPrincipal(pool, {
      externalId: 'reactivation-security-outsider', kind: 'user', displayName: 'Outsider',
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('continuum.reactivation_principal_id', $1, true)`,
        [target.id],
      );
      await expect(client.query(
        `UPDATE principals SET disabled_at = NULL, offboarded_at = NULL,
                reactivated_at = now() WHERE id = $1`,
        [target.id],
      )).rejects.toThrow(/guarded database function/i);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    await expect(pool.query(
      'SELECT continuum_reactivate_principal($1::uuid, $2::uuid)',
      [target.id, outsider.id],
    )).rejects.toThrow(/effective org administrator/i);
  });

  it('does not let pg_temp shadow the reactivation capability relation', async () => {
    const { target } = await fixture(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE continuum_principal_reactivation_requests (
        principal_id uuid, backend_pid integer, transaction_id bigint
      )`);
      await client.query(
        `INSERT INTO pg_temp.continuum_principal_reactivation_requests VALUES
         ($1, pg_backend_pid(), txid_current())`, [target.id],
      );
      await expect(client.query(
        `UPDATE principals SET disabled_at = NULL, offboarded_at = NULL,
                reactivated_at = now() WHERE id = $1`, [target.id],
      )).rejects.toThrow(/guarded database function/i);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects forged completed ledger events without the completion capability', async () => {
    const { admin, target } = await fixture(pool);
    const run = (await pool.query(
      'SELECT * FROM principal_offboarding_runs WHERE principal_id = $1', [target.id],
    )).rows[0];
    await expect(pool.query(
      `INSERT INTO principal_offboarding_run_events
         (run_id, principal_id, scope_id, phase, initiated_by, finalized_by,
          approval_id, approval_evidence_hash, evidence)
       VALUES ($1, $2, $3, 'completed', $4, $4, $5, $6, '{}'::jsonb)`,
      [run.run_id, target.id, run.scope_id, admin.id, run.approval_id,
        run.approval_evidence_hash],
    )).rejects.toThrow(/completion capability|immutable/i);
  });
});
