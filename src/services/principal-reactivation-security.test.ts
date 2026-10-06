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
    .replaceAll(':"continuum_app_role"', `"${role}"`);
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
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); });
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
      /GRANT SELECT, INSERT, UPDATE ON TABLE[\s\S]*principal_offboarding_runs/i,
    );
    expect(grants).toMatch(
      /GRANT SELECT, INSERT ON TABLE[\s\S]*principal_offboarding_run_events/i,
    );
    expect(grants).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON TABLE[\s\S]*principal_offboarding_runs/i,
    );
    expect(grants).toMatch(
      /GRANT SELECT, INSERT ON TABLE[\s\S]*principal_offboarding_run_events/i,
    );
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
  });

  it('supports lifecycle functions as a separately granted non-owner role', async () => {
    const { admin, target } = await fixture(pool);
    const role = `continuum_app_test_${Date.now()}`;
    const quotedRole = `"${role}"`;
    await pool.query(`CREATE ROLE ${quotedRole} NOLOGIN`);
    try {
      await pool.query(`GRANT ${quotedRole} TO CURRENT_USER`);
      await applyApplicationRoleGrants(pool, role);

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
                    'continuum_complete_offboarding_run(uuid,uuid,jsonb)', 'EXECUTE')
                    AS complete_execute,
                  has_function_privilege(current_user,
                    'continuum_reactivate_principal(uuid,uuid)', 'EXECUTE')
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
          `SELECT continuum_reactivate_principal($1::uuid, $2::uuid)`,
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
      await provisionEntraGroupBinding(rolePool, admin, {
        externalId: groupId, scopeId: project.id, role: 'reader',
      });
      await expect(syncEntraMemberships(rolePool, admin, [{
        id: groupId, status: 'present', displayName: 'Runtime Group',
        memberObjectIds: ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
      }], { allowMassDeactivation: true })).resolves.toMatchObject({ groupsSeen: 1 });
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
        const attack = async (setup: string, sql: string, parameters: unknown[]) => {
          await client.query('BEGIN');
          await client.query(`SET LOCAL ROLE ${quotedRole}`);
          await client.query('SET LOCAL search_path = pg_temp, public');
          await client.query(setup);
          await expect(client.query(sql, parameters)).rejects.toThrow();
          await client.query('ROLLBACK');
        };
        await attack(
          `CREATE TEMP TABLE principal_offboarding_run_events (run_id UUID, phase TEXT);
           INSERT INTO principal_offboarding_run_events VALUES ('${runId}', 'completed')`,
          'UPDATE principal_offboarding_runs SET completed_at = now() WHERE run_id = $1',
          [runId],
        );
        await attack(
          `CREATE TEMP TABLE continuum_principal_reactivation_requests
             (principal_id UUID, backend_pid INTEGER, transaction_id BIGINT);
           INSERT INTO continuum_principal_reactivation_requests
             VALUES ('${target.id}', pg_backend_pid(), txid_current())`,
          `UPDATE principals SET disabled_at = NULL, offboarded_at = NULL,
             reactivated_at = now() WHERE id = $1`,
          [target.id],
        );
        await attack(
          `CREATE TEMP TABLE principals (id UUID, offboarded_at TIMESTAMPTZ);
           CREATE TEMP TABLE principal_user_scopes (principal_id UUID, scope_id UUID)`,
          `INSERT INTO audit_log (principal_id, action, scope_id, query, metadata)
           VALUES ($1, 'read', $2, 'late secret', '{}'::jsonb)`,
          [admin.id, scope.id],
        );
        await attack(
          `CREATE TEMP TABLE memories (id UUID, state TEXT);
           INSERT INTO memories VALUES ('${memoryId}', 'live')`,
          `INSERT INTO memory_embeddings (memory_id, provider, dim, embedding)
           VALUES ($1, 'forged', 768, $2::vector)`,
          [memoryId, `[${Array(768).fill(0).join(',')}]`],
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
