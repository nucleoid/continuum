import pg from 'pg';
import { runMigrations } from './migrator.js';
import { promoteMemoryWithAudit } from './promote.js';

const DEFAULT_URL = 'postgres://continuum:continuum@localhost:5433/continuum';

/** Normal fixture cleanup must not terminate clients whose sockets are ending. */
export async function dropIsolatedTestDatabase(
  maintenance: pg.Pool,
  database: string,
  options: { cleanupTimeoutMs?: number } = {},
): Promise<void> {
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 60_000;
  if (!Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 90_000) {
    throw new Error('Fixture cleanup timeout must be an integer from 1 to 90000 milliseconds');
  }
  const cleanupDeadline = Date.now() + cleanupTimeoutMs;
  const client = await maintenance.connect();
  let original: { statement: string; lock: string; database: string; statement_ms: string; lock_ms: string } | undefined;
  let failure: unknown;
  let discard = false;
  try {
    original = (await client.query<{ statement: string; lock: string; database: string; statement_ms: string; lock_ms: string }>(
      `SELECT pg_catalog.current_setting('statement_timeout') AS statement,
              pg_catalog.current_setting('lock_timeout') AS lock,
              pg_catalog.current_database() AS database,
              (SELECT setting FROM pg_catalog.pg_settings WHERE name='statement_timeout') AS statement_ms,
              (SELECT setting FROM pg_catalog.pg_settings WHERE name='lock_timeout') AS lock_ms`,
    )).rows[0];
    if (!database || database.includes('\0') || database === original.database) {
      throw new Error('Fixture cleanup requires a separate, nonempty database name');
    }
    const statementCap = Number(original.statement_ms) > 0 ? Math.min(5_000, Number(original.statement_ms)) : 5_000;
    const lockCap = Number(original.lock_ms) > 0 ? Math.min(1_000, Number(original.lock_ms)) : 1_000;
    const setLimits = async (statementMs: number): Promise<void> => {
      await client.query("SELECT pg_catalog.set_config('statement_timeout',$1,FALSE), pg_catalog.set_config('lock_timeout',$2,FALSE)",
        [`${Math.max(1, Math.floor(statementMs))}ms`, `${lockCap}ms`]);
    };
    const sessions = async (): Promise<number> => {
      await setLimits(Math.min(1_000, statementCap, Math.max(1, cleanupDeadline - Date.now())));
      return (await client.query<{ sessions: number }>(
        'SELECT count(*)::int AS sessions FROM pg_catalog.pg_stat_activity WHERE datname=$1::text', [database],
      )).rows[0].sessions;
    };
    const deadline = Math.min(cleanupDeadline, Date.now() + 5_000);
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Fixture database sessions did not drain within 5 seconds');
      if (await sessions() === 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
    }
    const identifier = '"' + database.replaceAll('"', '""') + '"';
    let lastCancellation: unknown;
    for (;;) {
      const remaining = cleanupDeadline - Date.now();
      if (remaining <= 0) throw lastCancellation ?? new Error(`Fixture database cleanup exceeded its ${cleanupTimeoutMs}-millisecond deadline`);
      // Check again on every attempt. Never evict a newly connected session or
      // substitute FORCE/termination for orderly fixture socket shutdown.
      if (await sessions() !== 0) throw new Error('Fixture database acquired active sessions during cleanup');
      const dropRemaining = cleanupDeadline - Date.now();
      if (dropRemaining <= 0) throw lastCancellation ?? new Error(`Fixture database cleanup exceeded its ${cleanupTimeoutMs}-millisecond deadline`);
      await setLimits(Math.min(statementCap, dropRemaining));
      if (Date.now() >= cleanupDeadline) throw lastCancellation ?? new Error(`Fixture database cleanup exceeded its ${cleanupTimeoutMs}-millisecond deadline`);
      try {
        await client.query(`DROP DATABASE IF EXISTS ${identifier}`);
        break;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== '57014' && code !== '55P03') throw error;
        // Disk-backed checkpoints can outlive one bounded DROP statement.
        // IF EXISTS is safe to retry after its autocommit cancellation, but
        // the original SQL error wins when the aggregate deadline is spent.
        lastCancellation = error;
        const pause = Math.min(20, cleanupDeadline - Date.now());
        if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
      }
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      if (original) await client.query(
        "SELECT pg_catalog.set_config('statement_timeout',$1,FALSE), pg_catalog.set_config('lock_timeout',$2,FALSE)",
        [original.statement, original.lock],
      );
    } catch (restoreError) {
      discard = true;
      if (failure !== undefined) throw new AggregateError([failure, restoreError],
        'Fixture database cleanup and session restoration failed', { cause: failure });
      throw restoreError;
    } finally { client.release(discard); }
  }
}

export async function makeTestPool(): Promise<pg.Pool> {
  const url = process.env.CONTINUUM_TEST_DATABASE_URL ?? DEFAULT_URL;
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  await runMigrations(pool);
  return pool;
}

export async function resetData(pool: pg.Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE principal_user_scope_approvals
      DISABLE TRIGGER preserve_user_scope_approval_truncate;
    ALTER TABLE principal_offboarding_events
      DISABLE TRIGGER preserve_offboarding_event_truncate;
    ALTER TABLE principal_offboarding_run_events
      DISABLE TRIGGER preserve_offboarding_run_event_truncate;
    ALTER TABLE principal_offboarding_takeover_events
      DISABLE TRIGGER preserve_offboarding_takeover_event;
    ALTER TABLE principal_offboarding_runs
      DISABLE TRIGGER guard_offboarding_run_truncate;
    ALTER TABLE coordination_operator_events
      DISABLE TRIGGER preserve_coordination_operator_event_truncate;
  `);
  try {
    await pool.query(`
      TRUNCATE TABLE
        coordination_operation_receipts,
        coordination_operator_events,
        coordination_scope_privacy_progress,
        coordination_principal_privacy_progress,
        coordination_migration_progress,
        coordination_scope_fencing_floors,
        coordination_principal_usage,
        coordination_scope_usage,
        coordination_leases,
        coordination_resources,
        ingest_deliveries,
        principal_aliases,
        promotion_event_deliveries,
        promotion_events,
        audit_log,
        service_api_keys,
        entra_sync_state,
        entra_groups,
        continuum_offboarding_completion_requests,
        principal_offboarding_audit_requests,
        audit_log_offboarding_scopes,
        principal_offboarding_takeover_events,
        principal_offboarding_run_events,
        principal_offboarding_runs,
        principal_offboarding_events,
        principal_user_scope_approvals,
        principal_user_scopes,
        tag_vocabularies,
        embedding_backfill_failures,
        embedding_backfill_checkpoints,
        memory_embeddings,
        memories,
        scope_memberships,
        scopes,
        principals
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await pool.query(`
      ALTER TABLE principal_user_scope_approvals
        ENABLE TRIGGER preserve_user_scope_approval_truncate;
      ALTER TABLE principal_offboarding_events
        ENABLE TRIGGER preserve_offboarding_event_truncate;
      ALTER TABLE principal_offboarding_run_events
        ENABLE TRIGGER preserve_offboarding_run_event_truncate;
    ALTER TABLE principal_offboarding_takeover_events
      ENABLE TRIGGER preserve_offboarding_takeover_event;
      ALTER TABLE principal_offboarding_runs
        ENABLE TRIGGER guard_offboarding_run_truncate;
      ALTER TABLE coordination_operator_events
        ENABLE TRIGGER preserve_coordination_operator_event_truncate;
    `);
  }

  await pool.query("UPDATE promotion_webhook_registry SET webhook_ids='{}'::text[] WHERE singleton");

  // All business rows are gone, so no prior repair cursor or pending phase
  // belongs to the next test. These are the completed states for empty data.
  await pool.query(`
    UPDATE coordination_contract_backfill_state SET phase='complete',
      principal_cursor=NULL,resource_scope_cursor=NULL,resource_key_cursor=NULL,
      resource_rows_processed=0,scope_cursor=NULL,receipt_principal_cursor=NULL,
      receipt_operation_cursor=NULL,receipt_request_cursor=NULL,updated_at=clock_timestamp()
      WHERE singleton;
    UPDATE coordination_v4_backfill_state SET completed=TRUE,last_principal_id=NULL,
      updated_at=clock_timestamp() WHERE singleton;
    UPDATE coordination_v5_backfill_state SET completed=TRUE,last_principal_id=NULL,
      updated_at=clock_timestamp() WHERE singleton;
  `);
  // Re-seed static rows inserted by migrations.
  await pool.query(
    `INSERT INTO scopes (id, kind, name) VALUES (gen_random_uuid(), 'org', '')`,
  );
  await pool.query(
    `INSERT INTO principals (id, external_id, kind, display_name)
     VALUES ('00000000-0000-4000-8000-000000000011',
             NULL, 'service', 'system:lifecycle')`,
  );
  await pool.query(
    `INSERT INTO principals (id, external_id, kind, display_name, disabled_at)
     VALUES ('00000000-0000-4000-8000-000000000012',
             gen_random_uuid()::text, 'service',
             'system:detached-coordination-history', clock_timestamp())`,
  );
  await pool.query(
    `INSERT INTO coordination_principal_usage
       (principal_id, acquire_receipt_limit, contended_receipt_limit)
     VALUES ('00000000-0000-4000-8000-000000000012', 10000, 10000)`,
  );
  await pool.query('INSERT INTO entra_sync_state (singleton) VALUES (TRUE)');
  await pool.query(`
    INSERT INTO tag_vocabularies (scope_kind, tag, description, is_system)
    SELECT scope_kind, tag, 'Built-in Continuum tag', true
      FROM unnest(ARRAY['org', 'team', 'project', 'user', 'role']) AS scope_kind
     CROSS JOIN unnest(ARRAY[
       'pr', 'merged', 'branch', 'github', 'ado', 'deploy', 'session', 'terminal', 'decision',
       'knowledge-gap'
     ]) AS tag
  `);
}

/** Owner-only fixture setup, followed by the unchanged production promotion.
 * Real-role tests configure IDs through the bound OP helper instead. */
export async function promoteWithConfiguredWebhooksForTest(
  ...args: Parameters<typeof promoteMemoryWithAudit>
): ReturnType<typeof promoteMemoryWithAudit> {
  const ids = [...new Set(args[5] ?? [])].sort();
  await args[0].query('UPDATE promotion_webhook_registry SET webhook_ids=$1::text[] WHERE singleton', [ids]);
  return promoteMemoryWithAudit(...args);
}
