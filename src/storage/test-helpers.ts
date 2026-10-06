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
    TRUNCATE TABLE
      ingest_deliveries,
      principal_aliases,
      audit_log,
      service_api_keys,
      entra_sync_state,
      entra_groups,
      principal_offboarding_events,
      principal_user_scopes,
      memory_embeddings,
      memories,
      scope_memberships,
      scopes,
      principals
    RESTART IDENTITY CASCADE
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
  await pool.query('INSERT INTO entra_sync_state (singleton) VALUES (TRUE)');
}
