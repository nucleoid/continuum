import pg from 'pg';
import { runMigrations } from './migrator.js';

const DEFAULT_URL = 'postgres://continuum:continuum@localhost:5433/continuum';

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
  `);
  try {
    await pool.query(`
      TRUNCATE TABLE
        ingest_deliveries,
        principal_aliases,
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
    `);
  }
  // Re-seed static rows inserted by migrations.
  await pool.query(
    `INSERT INTO scopes (id, kind, name) VALUES (gen_random_uuid(), 'org', '')`,
  );
  await pool.query(
    `INSERT INTO principals (id, external_id, kind, display_name)
     VALUES ('00000000-0000-4000-8000-000000000011',
             NULL, 'service', 'system:lifecycle')`,
  );
  await pool.query('INSERT INTO entra_sync_state (singleton) VALUES (TRUE)');
}
