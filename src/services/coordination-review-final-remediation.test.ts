import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg, { type PoolConfig } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addMembership } from '../storage/memberships.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { acquireLease } from './coordination.js';
import { reactivatePrincipal } from './principal-admin.js';
import { runAuditRetention } from '../maintenance/audit-retention.js';
import {
  listCoordinationPrivacyRepairs, mapOwnedUserScope, offboardPrincipal, repairCoordinationPrivacy,
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

  async function pendingAccessEvidence(label: string) {
    const value = await fixture(label);
    await pool.query("UPDATE coordination_contract_backfill_state SET phase = 'usage' WHERE singleton");
    await offboardPrincipal(pool, value.operator, value.target.id, { confirmationScopeId: value.owned.id });
    const event = (await pool.query(
      `SELECT metadata FROM audit_log WHERE metadata->>'operation' = 'principal_offboarding_access_revoked'
         AND metadata->>'principal_id' = $1`, [value.target.id],
    )).rows[0];
    return { ...value, metadata: event.metadata as Record<string, unknown> };
  }

  it('access evidence review: an approved access-only open run fences reactivation with no existing coordination data', async () => {
    const value = await pendingAccessEvidence('open-run-reactivation');
    try {
      expect((await pool.query(
        `SELECT disabled_at IS NOT NULL AS disabled, offboarded_at
           FROM principals WHERE id = $1`, [value.target.id],
      )).rows[0]).toEqual({ disabled: true, offboarded_at: null });
      expect((await pool.query(`SELECT
        (SELECT count(*)::int FROM coordination_resources) AS resources,
        (SELECT count(*)::int FROM coordination_leases) AS leases,
        (SELECT count(*)::int FROM coordination_operation_receipts) AS receipts`)).rows[0])
        .toEqual({ resources: 0, leases: 0, receipts: 0 });
      await expect(reactivatePrincipal(pool, value.operator, value.target.id)).rejects.toMatchObject({
        code: 'P0001', message: 'principal offboarding is incomplete',
      });
      expect((await pool.query(
        'SELECT disabled_at IS NOT NULL AS disabled FROM principals WHERE id = $1', [value.target.id],
      )).rows[0].disabled).toBe(true);
    } finally {
      await pool.query("UPDATE coordination_contract_backfill_state SET phase = 'complete' WHERE singleton");
    }
  });

  it.each(['application', 'sync'] as const)('access evidence review: rejects a canonical forged %s insert', async (profile) => {
    const value = await pendingAccessEvidence(`forged-access-${profile}`);
    const role = `continuum_access_evidence_${randomUUID().replaceAll('-', '')}`;
    const password = randomUUID();
    const quoteRole = (name: string) => `"${name.replaceAll('"', '""')}"`;
    let connection: pg.Pool | undefined;
    await pool.query(`CREATE ROLE ${quoteRole(role)} LOGIN PASSWORD '${password}'`);
    try {
      const syncActor = profile === 'sync' ? await createPrincipal(pool, {
        externalId: `access-evidence-sync:${randomUUID()}`, kind: 'service', displayName: 'Sync',
      }) : null;
      if (syncActor) {
        await pool.query(`GRANT ${quoteRole(role)} TO CURRENT_USER WITH ADMIN OPTION, SET FALSE, INHERIT FALSE`);
      }
      const schema = (await pool.query('SELECT current_schema() AS name')).rows[0].name as string;
      const file = profile === 'sync' ? 'grant-sync-role.sql' : 'grant-application-role.sql';
      let sql = (await readFile(join(process.cwd(), 'scripts', file), 'utf8'))
        .split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\')).join('\n');
      for (const [name, text] of Object.entries({ continuum_schema: schema,
        continuum_app_role: role, continuum_sync_role: role, continuum_principal_id: syncActor?.id ?? '' })) {
        sql = sql.replaceAll(`:"${name}"`, quoteRole(text))
          .replaceAll(`:'${name}'`, `'${text.replaceAll("'", "''")}'`);
      }
      const grant = await pool.connect();
      let discardGrant = false;
      try { await grant.query(sql); }
      catch (error) {
        try { await grant.query('ROLLBACK'); } catch { discardGrant = true; }
        throw error;
      } finally { grant.release(discardGrant); }
      const base = (pool as unknown as { options: PoolConfig }).options;
      const url = new URL(base.connectionString!);
      url.username = role; url.password = password;
      connection = new pg.Pool({ connectionString: url.toString(), ssl: base.ssl, max: 1 });
      await expect(connection.query(
        `INSERT INTO audit_log(principal_id, action, scope_id, metadata)
         VALUES($1, 'archive', $2, $3::jsonb)`, [value.operator.id, value.owned.id, JSON.stringify(value.metadata)],
      )).rejects.toThrow();
    } finally {
      await connection?.end();
      await pool.query("UPDATE coordination_contract_backfill_state SET phase = 'complete' WHERE singleton");
      await pool.query('DELETE FROM continuum_pgvector_role_profiles WHERE database_role_oid = $1::regrole::oid', [role]);
      await pool.query('DELETE FROM continuum_trusted_database_identities WHERE database_role = $1::name', [role]);
      await pool.query(`DROP OWNED BY ${quoteRole(role)}`);
      await pool.query(`REVOKE ${quoteRole(role)} FROM CURRENT_USER`);
      await pool.query(`DROP ROLE ${quoteRole(role)}`);
    }
  });

  it.each(['approval_id', 'run_id'] as const)('access evidence review: rejects an operator event with mismatched %s', async (field) => {
    const value = await pendingAccessEvidence(`mismatched-access-${field}`);
    try {
      const metadata = { ...value.metadata, [field]: field === 'approval_id' ? '999999999' : randomUUID() };
      await expect(pool.query(
        `INSERT INTO audit_log(principal_id, action, scope_id, metadata)
         VALUES($1, 'archive', $2, $3::jsonb)`, [value.operator.id, value.owned.id, JSON.stringify(metadata)],
      )).rejects.toThrow();
    } finally {
      await pool.query("UPDATE coordination_contract_backfill_state SET phase = 'complete' WHERE singleton");
    }
  });

  it('access evidence review: retention skips approved historical access evidence and deletes ordinary eligible rows', async () => {
    const value = await pendingAccessEvidence('access-retention');
    try {
      // Trusted owner import of a retained historical event, with current
      // approved canonical linkage. Never alter an immutable existing event.
      const protectedRow = (await pool.query(
        `INSERT INTO audit_log(at, principal_id, action, scope_id, metadata)
         VALUES(clock_timestamp() - interval '200 days', $1, 'archive', $2, $3::jsonb) RETURNING id::text`,
        [value.operator.id, value.owned.id, JSON.stringify(value.metadata)],
      )).rows[0];
      const ordinary = (await pool.query(
        `INSERT INTO audit_log(at, principal_id, action, query, metadata)
         VALUES(clock_timestamp() - interval '200 days', $1, 'read', 'ordinary historical query', '{}'::jsonb)
         RETURNING id::text`, [value.operator.id],
      )).rows[0];
      const options = { retentionDays: 30, principalExternalId: value.operator.externalId!,
        batchSize: 1, maxBatches: 2, maxRows: 2 };
      expect(await runAuditRetention(pool, { ...options, dryRun: true })).toMatchObject({ eligible: 1 });
      expect(await runAuditRetention(pool, options)).toMatchObject({ status: 'completed', deleted: 1 });
      expect((await pool.query('SELECT metadata FROM audit_log WHERE id = $1', [protectedRow.id]))
        .rows[0]?.metadata).toEqual(value.metadata);
      expect((await pool.query('SELECT id FROM audit_log WHERE id = $1', [ordinary.id])).rowCount).toBe(0);
    } finally {
      await pool.query("UPDATE coordination_contract_backfill_state SET phase = 'complete' WHERE singleton");
    }
  });

  it('blocked privacy CLI review: drains lifecycle batches before reporting a shared live lease block', async () => {
    const value = await fixture('shared-lease-lifecycle');
    const held = await acquireLease(pool, value.target, {
      scope: `project:${value.shared.name}`, resource: 'held-shared', runId: randomUUID(),
      requestId: randomUUID(), ttlSeconds: 900,
    });
    expect(held.acquired).toBe(true);
    await pool.query(
      `INSERT INTO memories(id, scope_id, type, title, body, author_id, source)
       SELECT gen_random_uuid(), $1, 'context', 'private ' || n, 'secret ' || n, $2, 'manual'
         FROM generate_series(1, 7) n`, [value.owned.id, value.target.id],
    );
    await pool.query(
      `INSERT INTO audit_log(principal_id, action, scope_id, query, metadata)
       SELECT $1, 'read', $2, 'secret query ' || n, '{}'::jsonb FROM generate_series(1, 7) n`,
      [value.target.id, value.owned.id],
    );
    const blocked = await adminCli(value.operator, [
      'offboard-principal', value.target.id, '--confirm-scope', value.owned.id, '--batch-size', '2',
    ], 60_000);
    expect(blocked).toMatchObject({ exitCode: 3, payload: { complete: false, reason: 'live_lease' } });
    expect(Number(blocked.payload.attempts)).toBeGreaterThan(1);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM memories WHERE scope_id = $1 AND body <> '[erased]'", [value.owned.id],
    )).rows[0].count).toBe(0);
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM audit_log WHERE query IS NOT NULL AND (principal_id = $1 OR scope_id = $2)',
      [value.target.id, value.owned.id],
    )).rows[0].count).toBe(0);
  }, 60_000);

  it.each(['detached_quota', 'migration_pending'] as const)(
    'round5 blocked lifecycle CLI review: preserves reachable work boundaries under %s', async (reason) => {
      const value = await fixture(`lifecycle-${reason}`);
      await pool.query(
        `INSERT INTO memories(id, scope_id, type, title, body, author_id, source)
         SELECT gen_random_uuid(), $1, 'context', 'private ' || n, 'secret ' || n, $2, 'manual'
           FROM generate_series(1, 7) n`, [value.owned.id, value.target.id],
      );
      await pool.query(
        `INSERT INTO audit_log(principal_id, action, scope_id, query, metadata)
         SELECT $1, 'read', $2, 'secret query ' || n, '{}'::jsonb FROM generate_series(1, 7) n`,
        [value.target.id, value.owned.id],
      );
      try {
        if (reason === 'migration_pending') {
          // Pending initial privacy cannot establish durable scope cleanup.
          // Access revocation commits, but lifecycle erasure must stay gated.
          await pool.query("UPDATE coordination_contract_backfill_state SET phase='usage' WHERE singleton");
        } else {
          await pool.query('SELECT continuum_operator_set_coordination_principal_quota($1,$2,1,1)',
            [value.operator.id, detachedPrincipalId]);
          await pool.query("INSERT INTO coordination_resources(scope_id,resource) VALUES($1,'lifecycle-quota')", [value.shared.id]);
          for (const principalId of [detachedPrincipalId, value.target.id]) {
            await pool.query(
              `INSERT INTO coordination_operation_receipts(principal_id,operation,request_id,payload_hash,
                 outcome,scope_id,resource,expires_at,server_time,retry_after_seconds,retain_until)
               VALUES($1::uuid,'acquire',gen_random_uuid(),sha256(convert_to(($1::uuid)::text,'UTF8')),
                 'contended',$2,'lifecycle-quota',clock_timestamp()-interval '1 day',
                 clock_timestamp()-interval '1 day',0,clock_timestamp()+interval '1 day')`,
              [principalId, value.shared.id],
            );
          }
        }
        const blocked = await adminCli(value.operator, [
          'offboard-principal', value.target.id, '--confirm-scope', value.owned.id, '--batch-size', '2',
        ], 60_000);
        expect(blocked).toMatchObject({ exitCode: 3, payload: { complete: false, reason } });
        if (reason === 'detached_quota') expect(Number(blocked.payload.attempts)).toBeGreaterThan(1);
        else {
          expect(Number(blocked.payload.attempts)).toBeGreaterThanOrEqual(1);
          expect(Number(blocked.payload.attempts)).toBeLessThanOrEqual(2);
          expect((await pool.query(
            `SELECT memories_processed::int, audit_rows_processed::int, scope_cleanup_complete,
               completed_at IS NOT NULL AS complete FROM principal_offboarding_runs WHERE principal_id=$1`,
            [value.target.id],
          )).rows[0]).toEqual({ memories_processed: 0, audit_rows_processed: 0,
            scope_cleanup_complete: false, complete: false });
          expect((await pool.query(
            'SELECT disabled_at IS NOT NULL AS disabled, offboarded_at IS NOT NULL AS offboarded FROM principals WHERE id=$1',
            [value.target.id],
          )).rows[0]).toEqual({ disabled: true, offboarded: false });
        }
        expect((await pool.query(
          "SELECT count(*)::int AS count FROM memories WHERE scope_id=$1 AND body<>'[erased]'", [value.owned.id],
        )).rows[0].count).toBe(reason === 'detached_quota' ? 0 : 7);
        expect((await pool.query(
          'SELECT count(*)::int AS count FROM audit_log WHERE query IS NOT NULL AND (principal_id=$1 OR scope_id=$2)',
          [value.target.id, value.owned.id],
        )).rows[0].count).toBe(reason === 'detached_quota' ? 0 : 7);
      } finally {
        await pool.query("UPDATE coordination_contract_backfill_state SET phase='complete' WHERE singleton");
      }
    }, 60_000,
  );

  it.each([true, false])('blocked privacy CLI review: retries only when detached purge frees quota, expired=%s', async (expired) => {
    const value = await fixture('detached-quota-purge');
    await pool.query('SELECT continuum_disable_principal($1, $2)', [value.operator.id, value.target.id]);
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress(principal_id, detached_principal_id, privacy_version, completed_at)
       VALUES($1, $2, 3, NULL)`, [value.target.id, detachedPrincipalId],
    );
    await pool.query(
      'SELECT continuum_operator_set_coordination_principal_quota($1, $2, 1, 1)',
      [value.operator.id, detachedPrincipalId],
    );
    await pool.query("INSERT INTO coordination_resources(scope_id, resource) VALUES($1, 'quota-shared')", [value.shared.id]);
    for (const principalId of [detachedPrincipalId, value.target.id]) {
      await pool.query(
        `INSERT INTO coordination_operation_receipts(principal_id, operation, request_id, payload_hash,
           outcome, scope_id, resource, expires_at, server_time, retry_after_seconds, retain_until, created_at)
         VALUES($1::uuid, 'acquire', gen_random_uuid(), sha256(convert_to(($1::uuid)::text, 'UTF8')),
           'contended', $2, 'quota-shared', clock_timestamp() - interval '2 days',
           clock_timestamp() - interval '2 days', 0,
           CASE WHEN $3::boolean THEN clock_timestamp() - interval '1 day'
                ELSE clock_timestamp() + interval '1 day' END,
           clock_timestamp() - interval '2 days')`,
        [principalId, value.shared.id, principalId !== detachedPrincipalId || expired],
      );
    }
    const result = await adminCli(value.operator, [
      'repair-coordination-privacy', value.target.id, '--confirm-scope', value.owned.id, '--batch-size', '1',
    ], 60_000);
    expect(result).toMatchObject({ exitCode: expired ? 0 : 3, payload: { complete: expired } });
    if (expired) expect(Number(result.payload.attempts)).toBeGreaterThan(1);
    else expect(result.payload).toMatchObject({ attempts: 1, reason: 'detached_quota', incompleteReason: 'blocked' });
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM coordination_operation_receipts WHERE principal_id = $1', [value.target.id],
    )).rows[0].count).toBe(expired ? 0 : 1);
  }, 60_000);

  it('contract offboarding review: durably revokes access while backfill is pending and resumes after readiness', async () => {
    const value = await fixture('pending-contract-access');
    try {
      await pool.query("UPDATE coordination_contract_backfill_state SET phase = 'usage' WHERE singleton");
      const pending = await offboardPrincipal(pool, value.operator, value.target.id, {
        confirmationScopeId: value.owned.id,
      });
      expect(pending).toMatchObject({ complete: false, reason: 'migration_pending' });
      expect((await pool.query(
        `SELECT disabled_at IS NOT NULL AS disabled, offboarded_at IS NOT NULL AS offboarded
           FROM principals WHERE id = $1`, [value.target.id],
      )).rows[0]).toEqual({ disabled: true, offboarded: false });
      expect((await pool.query(
        'SELECT active FROM scope_memberships WHERE principal_id = $1 AND scope_id = $2',
        [value.target.id, value.owned.id],
      )).rows[0].active).toBe(false);
      expect((await pool.query(
        `SELECT completed_at IS NOT NULL AS complete FROM principal_offboarding_runs WHERE principal_id = $1`,
        [value.target.id],
      )).rows[0].complete).toBe(false);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM audit_log
          WHERE metadata->>'operation' = 'principal_offboarding_access_revoked'
            AND metadata->>'principal_id' = $1`, [value.target.id],
      )).rows[0].count).toBe(1);
      const accessEvidence = (await pool.query(
        `SELECT id::text, metadata FROM audit_log
          WHERE metadata->>'operation' = 'principal_offboarding_access_revoked'
            AND metadata->>'principal_id' = $1`, [value.target.id],
      )).rows[0];
      await pool.query("UPDATE coordination_contract_backfill_state SET phase = 'complete' WHERE singleton");
      let result = pending;
      for (let attempt = 0; attempt < 12 && !result.complete; attempt += 1) {
        result = await offboardPrincipal(pool, value.operator, value.target.id, {
          confirmationScopeId: value.owned.id,
        });
      }
      expect(result.complete).toBe(true);
      expect((await pool.query('SELECT metadata FROM audit_log WHERE id = $1', [accessEvidence.id]))
        .rows[0]?.metadata).toEqual(accessEvidence.metadata);
      expect((await pool.query(
        'SELECT count(*)::int AS count FROM coordination_resources WHERE scope_id = $1', [value.owned.id],
      )).rows[0].count).toBe(0);
    } finally {
      await pool.query("UPDATE coordination_contract_backfill_state SET phase = 'complete' WHERE singleton");
    }
  });

  it('contract offboarding review: rolls back pending-window access revocation when its audit fails', async () => {
    const value = await fixture('pending-contract-audit');
    await pool.query(`CREATE FUNCTION fail_contract_access_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.metadata->>'operation' = 'principal_offboarding_access_revoked' THEN
          RAISE EXCEPTION 'contract access audit unavailable';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_contract_access_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION fail_contract_access_audit()`);
    try {
      await pool.query("UPDATE coordination_contract_backfill_state SET phase = 'usage' WHERE singleton");
      await expect(offboardPrincipal(pool, value.operator, value.target.id, {
        confirmationScopeId: value.owned.id,
      })).rejects.toThrow('contract access audit unavailable');
      expect((await pool.query(
        'SELECT disabled_at FROM principals WHERE id = $1', [value.target.id],
      )).rows[0].disabled_at).toBeNull();
      expect((await pool.query(
        'SELECT active FROM scope_memberships WHERE principal_id = $1 AND scope_id = $2',
        [value.target.id, value.owned.id],
      )).rows[0].active).toBe(true);
      expect((await pool.query(
        'SELECT count(*)::int AS count FROM principal_offboarding_runs WHERE principal_id = $1', [value.target.id],
      )).rows[0].count).toBe(0);
    } finally {
      await pool.query('DROP TRIGGER fail_contract_access_audit ON audit_log; DROP FUNCTION fail_contract_access_audit()');
      await pool.query("UPDATE coordination_contract_backfill_state SET phase = 'complete' WHERE singleton");
    }
  });

  it.each([false, true])('schema dependency review: sanitizes missing owned-scope helper for disabled=%s before mutation', async (disabled) => {
    const value = await fixture(`missing-scope-helper-${disabled}`);
    if (disabled) {
      await pool.query('SELECT continuum_disable_principal($1, $2)', [value.operator.id, value.target.id]);
    }
    const before = (await pool.query(
      'SELECT disabled_at, offboarded_at, display_name FROM principals WHERE id = $1', [value.target.id],
    )).rows[0];
    await pool.query(`ALTER FUNCTION continuum_operator_coordination_scope_privacy_state(UUID, UUID)
      RENAME TO fixture_missing_coordination_scope_privacy_state`);
    try {
      await expect(offboardPrincipal(pool, value.operator, value.target.id, {
        confirmationScopeId: value.owned.id,
      })).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', status: 503 });
      expect((await pool.query(
        'SELECT disabled_at, offboarded_at, display_name FROM principals WHERE id = $1', [value.target.id],
      )).rows[0]).toEqual(before);
      expect((await pool.query(
        'SELECT count(*)::int AS count FROM principal_offboarding_runs WHERE principal_id = $1', [value.target.id],
      )).rows[0].count).toBe(0);
    } finally {
      await pool.query(`ALTER FUNCTION fixture_missing_coordination_scope_privacy_state(UUID, UUID)
        RENAME TO continuum_operator_coordination_scope_privacy_state`);
    }
  });

  it('contract offboarding review: CLI continues while bounded owned-scope batches delete resources', async () => {
    const value = await fixture('owned-coordination-progress');
    await pool.query(
      `INSERT INTO coordination_resources(scope_id, resource)
       SELECT $1, 'owned-resource-' || n FROM generate_series(1, 2501) n`, [value.owned.id],
    );
    const result = await adminCli(value.operator, [
      'offboard-principal', value.target.id, '--confirm-scope', value.owned.id,
    ], 60_000);
    expect(result).toMatchObject({ exitCode: 0, payload: { complete: true } });
    expect(Number(result.payload.attempts)).toBeGreaterThan(2);
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM coordination_resources WHERE scope_id = $1', [value.owned.id],
    )).rows[0].count).toBe(0);
  }, 60_000);

  it('contract offboarding review: retains access revocation and reports an owned live lease before resumable cleanup', async () => {
    const value = await fixture('owned-live-lease-block');
    const held = await acquireLease(pool, value.target, {
      scope: `user:${value.owned.name}`, resource: 'owned-held', runId: randomUUID(),
      requestId: randomUUID(), ttlSeconds: 300,
    });
    expect(held.acquired).toBe(true);
    let result = await offboardPrincipal(pool, value.operator, value.target.id, {
      confirmationScopeId: value.owned.id,
    });
    expect(result).toMatchObject({ complete: false, reason: 'owned_live_lease' });
    expect((await pool.query(
      'SELECT disabled_at IS NOT NULL AS disabled FROM principals WHERE id = $1', [value.target.id],
    )).rows[0].disabled).toBe(true);
    const initialBatch = result.progress.batch;
    const retry = await offboardPrincipal(pool, value.operator, value.target.id, {
      confirmationScopeId: value.owned.id,
    });
    expect(retry).toMatchObject({ complete: false, reason: 'owned_live_lease', progressed: false });
    expect(retry.progress.batch).toBe(initialBatch);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE metadata->>'operation'='principal_offboarding_access_revoked'
          AND metadata->>'principal_id'=$1::text`, [value.target.id],
    )).rows[0].count).toBe(1);
    await pool.query(
      `UPDATE coordination_leases SET acquired_at = clock_timestamp() - interval '10 minutes',
              expires_at = clock_timestamp() - interval '1 second' WHERE lease_id = $1`,
      [(held as { leaseId: string }).leaseId],
    );
    for (let attempt = 0; attempt < 12 && !result.complete; attempt += 1) {
      result = await offboardPrincipal(pool, value.operator, value.target.id, {
        confirmationScopeId: value.owned.id,
      });
    }
    expect(result.complete).toBe(true);
  });

  it('contract offboarding review: disabled-only repair resumes an existing authorized owned-scope phase', async () => {
    const value = await fixture('disabled-existing-scope-repair');
    await pool.query(
      `INSERT INTO coordination_resources(scope_id, resource)
       SELECT $1, 'legacy-disabled-resource-' || n FROM generate_series(1, 2501) n`, [value.owned.id],
    );
    await pool.query('SELECT continuum_disable_principal($1, $2)', [value.operator.id, value.target.id]);
    await pool.query('SELECT continuum_operator_pseudonymize_scope_v2($1, $2, $3)', [
      value.operator.id, value.owned.id, 'erased-authorized-existing-scope',
    ]);
    expect((await pool.query(
      'SELECT completed_at FROM coordination_scope_privacy_progress WHERE scope_id = $1', [value.owned.id],
    )).rows[0].completed_at).toBeNull();
    let result = await repairCoordinationPrivacy(pool, value.operator, value.target.id, {
      confirmationScopeId: value.owned.id,
    });
    const remaining = (await pool.query(
      'SELECT count(*)::int AS count FROM coordination_resources WHERE scope_id = $1', [value.owned.id],
    )).rows[0].count;
    expect(result.complete && remaining > 0).toBe(false);
    for (let attempt = 0; attempt < 12 && !result.complete; attempt += 1) {
      result = await repairCoordinationPrivacy(pool, value.operator, value.target.id, {
        confirmationScopeId: value.owned.id,
      });
    }
    expect(result.complete).toBe(true);
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM coordination_resources WHERE scope_id = $1', [value.owned.id],
    )).rows[0].count).toBe(0);
  });

  it('contract offboarding review: resumes an owned scope reopened by the contract backfill before claiming completion', async () => {
    const value = await fixture('reopened-owned-scope');
    let result = await offboardPrincipal(pool, value.operator, value.target.id, {
      confirmationScopeId: value.owned.id,
    });
    for (let attempt = 0; attempt < 12 && !result.complete; attempt += 1) {
      result = await offboardPrincipal(pool, value.operator, value.target.id, {
        confirmationScopeId: value.owned.id,
      });
    }
    expect(result.complete).toBe(true);
    // Reconstruct a pre-0081 completed scope with a leftover plaintext key.
    // Owner-only transactional fixture setup restores all triggers atomically.
    const setup = await pool.connect();
    try {
      await setup.query('BEGIN');
      await setup.query('ALTER TABLE coordination_resources DISABLE TRIGGER USER');
      await setup.query(
        "INSERT INTO coordination_resources(scope_id, resource) VALUES($1, 'legacy-personal-resource')",
        [value.owned.id],
      );
      await setup.query('SET CONSTRAINTS ALL IMMEDIATE');
      await setup.query('ALTER TABLE coordination_resources ENABLE TRIGGER USER');
      await setup.query(
        `INSERT INTO coordination_scope_usage(scope_id, resource_count) VALUES($1, 1)
         ON CONFLICT(scope_id) DO UPDATE SET resource_count = 1`, [value.owned.id],
      );
      await setup.query("UPDATE coordination_contract_backfill_state SET phase = 'scopes', scope_cursor = NULL WHERE singleton");
      await setup.query('COMMIT');
    } catch (error) {
      await setup.query('ROLLBACK');
      throw error;
    } finally { setup.release(); }
    try {
      let ready = false;
      for (let attempt = 0; attempt < 12 && !ready; attempt += 1) {
        ready = (await pool.query('SELECT continuum_backfill_coordination_contract(100) AS ready')).rows[0].ready;
      }
      expect(ready).toBe(true);
      expect((await pool.query(
        'SELECT completed_at FROM coordination_scope_privacy_progress WHERE scope_id = $1', [value.owned.id],
      )).rows[0].completed_at).toBeNull();
      result = await offboardPrincipal(pool, value.operator, value.target.id, {
        confirmationScopeId: value.owned.id,
      });
      // Either bounded work has removed the key, or completion must be false.
      const remaining = (await pool.query(
        'SELECT count(*)::int AS count FROM coordination_resources WHERE scope_id = $1', [value.owned.id],
      )).rows[0].count;
      expect(result.complete && remaining > 0).toBe(false);
      for (let attempt = 0; attempt < 12 && !result.complete; attempt += 1) {
        result = await offboardPrincipal(pool, value.operator, value.target.id, {
          confirmationScopeId: value.owned.id,
        });
      }
      expect(result.complete).toBe(true);
      expect((await pool.query(
        'SELECT count(*)::int AS count FROM coordination_resources WHERE scope_id = $1', [value.owned.id],
      )).rows[0].count).toBe(0);
    } finally {
      await pool.query("UPDATE coordination_contract_backfill_state SET phase = 'complete' WHERE singleton");
    }
  });

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

  it.each([
    { label: 'empty', firstEligible: false },
    { label: 'short', firstEligible: true },
  ])('discovery page review: continues after a $label filtered page without filling an unbounded scan', async ({ label, firstEligible }) => {
    const value = await fixture(`filtered-discovery-${label}`);
    const nonce = randomUUID();
    await pool.query(
      `INSERT INTO principals (id, external_id, kind, display_name, disabled_at, reactivated_at)
       SELECT ('10000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $1 || ':' || n, 'user', 'Filtered page target',
              CASE WHEN n = 5 OR ($2 AND n = 2) THEN clock_timestamp() ELSE NULL END,
              CASE WHEN n < 5 AND NOT ($2 AND n = 2) THEN clock_timestamp() ELSE NULL END
         FROM generate_series(1, 5) n`,
      [`filtered-page:${nonce}`, firstEligible],
    );
    await pool.query(
      `INSERT INTO scopes (id, kind, name)
       SELECT ('20000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              'user', $1 || ':' || n FROM generate_series(1, 5) n`,
      [`filtered-page-scope:${nonce}`],
    );
    await pool.query(
      `INSERT INTO principal_user_scopes
         (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
          acknowledged_evidence_hash)
       SELECT ('10000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              ('20000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $1, ARRAY[('10000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid],
              repeat('a', 64) FROM generate_series(1, 5) n`,
      [value.operator.id],
    );
    await pool.query(
      `INSERT INTO coordination_principal_privacy_progress
         (principal_id, detached_principal_id, privacy_version, completed_at)
       SELECT ('10000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $1, 2, NULL FROM generate_series(1, 5) n`,
      [detachedPrincipalId],
    );
    // Reproduce the stale derived flag covered by 0079's legacy branch.
    // Updating this field alone does not run the insert/lifecycle trigger.
    await pool.query(
      'UPDATE coordination_principal_privacy_progress SET repair_eligible = FALSE WHERE principal_id = $1',
      [principalId(5)],
    );
    expect((await pool.query(
      'SELECT repair_eligible FROM coordination_principal_privacy_progress WHERE principal_id = $1',
      [principalId(5)],
    )).rows).toEqual([{ repair_eligible: false }]);

    const first = await adminCli(value.operator, [
      'list-coordination-privacy-repairs', '--limit', '2',
    ]);
    expect(first.exitCode).toBe(0);
    const firstRepairs = first.payload.repairs as Array<{ principalId: string }>;
    expect(firstRepairs.map(({ principalId }) => principalId))
      .toEqual(firstEligible ? [principalId(2)] : []);
    // The current CLI incorrectly reports NULL here because returned rows
    // were filtered after the SQL limit. Raw scan progress must survive.
    expect(first.payload.nextCursor).toBe(principalId(2));
    expect(first.payload).toMatchObject({ hasMore: true, scannedCount: 2 });

    const second = await adminCli(value.operator, [
      'list-coordination-privacy-repairs', '--limit', '2',
      '--after', first.payload.nextCursor as string,
    ]);
    expect(second.exitCode).toBe(0);
    expect(second.payload).toMatchObject({
      repairs: [], nextCursor: principalId(4), hasMore: true, scannedCount: 2,
    });
    const third = await adminCli(value.operator, [
      'list-coordination-privacy-repairs', '--limit', '2',
      '--after', second.payload.nextCursor as string,
    ]);
    expect(third.exitCode).toBe(0);
    const lastRepairs = third.payload.repairs as Array<{ principalId: string }>;
    expect(lastRepairs.map(({ principalId }) => principalId)).toEqual([principalId(5)]);
    expect(third.payload).toMatchObject({ nextCursor: null, hasMore: false, scannedCount: 1 });
    const seen = [...firstRepairs, ...lastRepairs].map(({ principalId }) => principalId);
    expect(seen).toEqual(firstEligible ? [principalId(2), principalId(5)] : [principalId(5)]);
    expect(new Set(seen).size).toBe(seen.length);
    const audits = await pool.query(
      `SELECT action, query, metadata FROM audit_log
        WHERE principal_id = $1 AND metadata->>'view' = 'coordination-privacy-repairs'
        ORDER BY id`,
      [value.operator.id],
    );
    expect(audits.rows).toEqual([
      { action: 'read', query: null, metadata: {
        view: 'coordination-privacy-repairs', limit: 2,
        resultCount: firstEligible ? 1 : 0, scannedCount: 2, hasMore: true,
      } },
      { action: 'read', query: null, metadata: {
        view: 'coordination-privacy-repairs', limit: 2,
        resultCount: 0, scannedCount: 2, hasMore: true,
      } },
      { action: 'read', query: null, metadata: {
        view: 'coordination-privacy-repairs', limit: 2,
        resultCount: 1, scannedCount: 1, hasMore: false,
      } },
    ]);
  }, 30_000);

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

  it('plans the generic production function with 50000 clean and reactivated rows', async () => {
    const dirty = await fixture('disabled-dirty-candidate');
    const client = await pool.connect();
    const original = (await client.query(
      `SELECT current_setting('statement_timeout') AS timeout,
              current_setting('plan_cache_mode') AS cache, pg_backend_pid() AS pid`,
    )).rows[0];
    const deadline = performance.now() + 75_000;
    let phase = 0;
    let discard = false;
    let prepared = false;
    let operationFailed = false;
    const preparedName = `production_privacy_repairs_${randomUUID().replaceAll('-', '')}`;
    const query = async (sql: string, values: unknown[] = []) => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 1) throw new Error('privacy scale diagnostic reached its bounded fixture deadline');
      await client.query("SELECT set_config('statement_timeout', $1, FALSE)", [`${Math.min(15_000, remaining)}ms`]);
      const label = sql.trim().split('\n')[0];
      const started = performance.now();
      const currentPhase = ++phase;
      console.info('privacy-scale-phase-start', JSON.stringify({ phase: currentPhase, label, pid: original.pid }));
      try { return await client.query(sql, values); }
      finally {
        console.info('privacy-scale-phase-end', JSON.stringify({ phase: currentPhase, label,
          elapsedMs: Math.round(performance.now() - started) }));
      }
    };
    try {
      await query('BEGIN');
      await query("SET LOCAL lock_timeout = '1s'");
      await query(
        'UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1',
        [dirty.target.id],
      );
      await query(
        `INSERT INTO principals
           (id, external_id, kind, display_name, disabled_at, reactivated_at)
         SELECT ('30000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
                $1 || ':' || n, 'user', 'Clean or reactivated target',
                CASE WHEN n <= 25000 THEN clock_timestamp() ELSE NULL END,
                CASE WHEN n > 25000 THEN clock_timestamp() ELSE NULL END
           FROM generate_series(1, 50000) n`,
        [`clean-completed:${randomUUID()}`],
      );
      await query(
        `INSERT INTO scopes (id, kind, name)
         SELECT ('40000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
                'user', $1 || ':' || n
           FROM generate_series(1, 50000) n`,
        [`clean-completed-scope:${randomUUID()}`],
      );
      // The owner-mapping validator was warmed on the tiny initial fixture.
      // Refresh both referenced tables before its 50k PK lookups so stale
      // cached plans do not model the new dataset as a tiny sequential scan.
      await query('ANALYZE principals');
      await query('ANALYZE scopes');
      for (let first = 1; first <= 50_000; first += 5_000) {
        const last = Math.min(first + 4_999, 50_000);
        await query(
          `INSERT INTO principal_user_scopes
           (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
            acknowledged_evidence_hash)
         SELECT ('30000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
                ('40000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
                $1,
                ARRAY[('30000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid],
                repeat('c', 64)
           FROM generate_series($2::integer, $3::integer) n`,
          [dirty.operator.id, first, last],
        );
        console.info('privacy-scale-mapping-chunk', JSON.stringify({ first, last, seeded: last }));
      }
      for (let first = 1; first <= 50_000; first += 5_000) {
        const last = Math.min(first + 4_999, 50_000);
        await query(
          `INSERT INTO coordination_principal_privacy_progress
           (principal_id, detached_principal_id, privacy_version, completed_at)
         SELECT ('30000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
                $1, 3, clock_timestamp()
           FROM generate_series($2::integer, $3::integer) n`,
          [detachedPrincipalId, first, last],
        );
      }
      await query(
        `INSERT INTO coordination_principal_privacy_progress
           (principal_id, detached_principal_id, privacy_version, completed_at)
         VALUES ($1, $2, 2, NULL)`,
        [dirty.target.id, detachedPrincipalId],
      );
      await query(
        `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
         VALUES ($1, 'write', $2, jsonb_build_object(
           'operation', 'lock_release', 'request_id', gen_random_uuid(),
           'run_id', gen_random_uuid(), 'lease_id', gen_random_uuid(),
           'resource', 'dirty', 'resource_sha256', repeat('b', 64)))`,
        [dirty.target.id, dirty.shared.id],
      );
      await query('ANALYZE principals');
      await query('ANALYZE principal_user_scopes');
      await query('ANALYZE audit_log');
      await query('ANALYZE coordination_principal_privacy_progress');

      await query('COMMIT');
      await query('SELECT pg_stat_force_next_flush()');
      const scansBefore = BigInt((await query(
        `SELECT COALESCE(idx_scan, 0)::text AS scans
           FROM pg_stat_user_indexes
          WHERE schemaname = current_schema()
            AND indexrelname = 'coordination_privacy_repair_eligible_idx'`,
      )).rows[0]?.scans ?? '0');
      await query('SET plan_cache_mode = force_generic_plan');
      await query(
        `PREPARE ${preparedName}(uuid, uuid, uuid, integer) AS
         SELECT * FROM continuum_operator_list_coordination_privacy_repairs($1, $2, $3, $4)`,
      );
      prepared = true;
      const plan = await query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         EXECUTE ${preparedName}(
           '${dirty.operator.id}'::uuid, NULL::uuid, NULL::uuid, 100)`,
      );
      const root = plan.rows[0]['QUERY PLAN'][0].Plan as Record<string, unknown>;
      const buffers = Number(root['Shared Hit Blocks'] ?? 0)
        + Number(root['Shared Read Blocks'] ?? 0);
      expect(root['Actual Rows']).toBe(1);
      expect(buffers).toBeLessThan(2_000);
      await query('SELECT pg_stat_force_next_flush()');
      const scansAfter = BigInt((await query(
        `SELECT COALESCE(idx_scan, 0)::text AS scans
           FROM pg_stat_user_indexes
          WHERE schemaname = current_schema()
            AND indexrelname = 'coordination_privacy_repair_eligible_idx'`,
      )).rows[0]?.scans ?? '0');
      expect(scansAfter).toBeGreaterThan(scansBefore);
      const serviceBudget = Math.min(15_000, Math.floor(deadline - performance.now()));
      if (serviceBudget < 1) throw new Error('privacy scale service probe reached its bounded deadline');
      const base = (pool as unknown as { options: PoolConfig }).options;
      const servicePool = new pg.Pool({ ...base, max: 1,
        options: `${base.options ?? ''} -c statement_timeout=${serviceBudget} -c lock_timeout=1000`,
      });
      try {
        expect(await listCoordinationPrivacyRepairs(servicePool, dirty.operator, 100)).toEqual([{
          principalId: dirty.target.id, scopeId: dirty.owned.id, state: 'disabled_only',
        }]);
      } finally { await servicePool.end(); }
    } catch (error) {
      operationFailed = true;
      discard = true;
      throw error;
    } finally {
      try {
        await client.query('ROLLBACK');
        if (prepared) await client.query(`DEALLOCATE ${preparedName}`);
        await client.query(`SELECT set_config('statement_timeout', $1, FALSE),
                                  set_config('plan_cache_mode', $2, FALSE)`, [original.timeout, original.cache]);
      } catch { discard = true; }
      client.release(discard);
      // The SQL deadline ends the query before Vitest's hard wall. Rollback and
      // clearing imported test data prevent a failed fixture blocking TRUNCATE.
      const base = (pool as unknown as { options: PoolConfig }).options;
      const cleanup = new pg.Pool({ ...base, max: 1,
        options: `${base.options ?? ''} -c statement_timeout=10000 -c lock_timeout=1000`,
      });
      try { await resetData(cleanup); }
      catch (cleanupError) {
        if (!operationFailed) throw cleanupError;
        console.error('privacy-scale-cleanup-failed', (cleanupError as { code?: string }).code ?? 'unknown');
      } finally { await cleanup.end(); }
    }
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
      await caller.query("SET LOCAL continuum.client_coordination_privacy_version = '4'");
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
      await firstCaller.query("SET LOCAL continuum.client_coordination_privacy_version = '4'");
      const firstResult = await firstCaller.query(
        `SELECT continuum_operator_scrub_coordination_principal($1, $2, $3, 10) AS result`,
        [first.operator.id, first.target.id, first.owned.id],
      );
      expect(firstResult.rows[0].result.progressed).toBe(true);

      await secondCaller.query('BEGIN');
      await secondCaller.query("SET LOCAL continuum.client_coordination_privacy_version = '4'");
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
