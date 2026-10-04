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
      memory_embeddings,
      memories,
      tag_vocabularies,
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
  await pool.query(`
    INSERT INTO tag_vocabularies (scope_kind, tag, description, is_system)
    SELECT scope_kind, tag, 'Built-in Continuum tag', true
      FROM unnest(ARRAY['org', 'team', 'project', 'user', 'role']) AS scope_kind
     CROSS JOIN unnest(ARRAY[
       'pr', 'merged', 'branch', 'github', 'ado', 'deploy', 'session', 'terminal', 'decision'
     ]) AS tag
  `);
}
