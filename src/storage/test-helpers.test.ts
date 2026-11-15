import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPrincipal } from './principals.js';
import { makeTestPool, resetData } from './test-helpers.js';

let pool: pg.Pool;
beforeAll(async () => { pool = await makeTestPool(); await resetData(pool); }, 30000);
afterAll(async () => { await pool?.end(); });

it('rolls fixture cleanup back on seed failure and leaves every protected trigger enabled', async () => {
  const probe = await createPrincipal(pool, { externalId: 'fixture-reset-' + randomUUID(), kind: 'user', displayName: 'Cleanup probe' });
  await pool.query(`CREATE FUNCTION test_reset_seed_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Synthetic fixture seed failure'; END $$;
    REVOKE ALL ON FUNCTION test_reset_seed_failure() FROM PUBLIC;
    CREATE TRIGGER test_reset_seed_failure BEFORE INSERT ON principals FOR EACH ROW
      WHEN (NEW.id='00000000-0000-4000-8000-000000000011'::uuid) EXECUTE FUNCTION test_reset_seed_failure()`);
  try {
    await expect(resetData(pool)).rejects.toThrow('Synthetic fixture seed failure');
    expect((await pool.query('SELECT id FROM principals WHERE id=$1', [probe.id])).rowCount).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_trigger WHERE tgname=ANY($1::text[]) AND tgenabled='O'`, [[
      'preserve_user_scope_approval_truncate', 'preserve_offboarding_event_truncate',
      'preserve_offboarding_run_event_truncate', 'preserve_offboarding_takeover_event',
      'guard_offboarding_run_truncate', 'preserve_coordination_operator_event_truncate',
    ]])).rows[0].n).toBe(6);
  } finally {
    await pool.query('DROP TRIGGER test_reset_seed_failure ON principals; DROP FUNCTION test_reset_seed_failure()');
    await resetData(pool);
  }
  expect((await pool.query('SELECT id FROM principals WHERE id=$1', [probe.id])).rowCount).toBe(0);
  expect((await pool.query(`SELECT count(*)::int AS n FROM principals WHERE id IN
    ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000012')`)).rows[0].n).toBe(2);
}, 30000);

it('preserves the original truncate failure and restores protected triggers before reusing its Pool', async () => {
  const probe = await createPrincipal(pool, { externalId: 'fixture-truncate-' + randomUUID(), kind: 'user', displayName: 'Truncate probe' });
  await pool.query(`CREATE FUNCTION test_reset_truncate_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Synthetic fixture truncate failure'; END $$;
    REVOKE ALL ON FUNCTION test_reset_truncate_failure() FROM PUBLIC;
    CREATE TRIGGER test_reset_truncate_failure BEFORE TRUNCATE ON scopes
      FOR EACH STATEMENT EXECUTE FUNCTION test_reset_truncate_failure()`);
  try {
    await expect(resetData(pool)).rejects.toThrow('Synthetic fixture truncate failure');
    expect((await pool.query('SELECT id FROM principals WHERE id=$1', [probe.id])).rowCount).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_trigger WHERE tgname=ANY($1::text[]) AND tgenabled='O'`, [[
      'preserve_user_scope_approval_truncate', 'preserve_offboarding_event_truncate',
      'preserve_offboarding_run_event_truncate', 'preserve_offboarding_takeover_event',
      'guard_offboarding_run_truncate', 'preserve_coordination_operator_event_truncate',
    ]])).rows[0].n).toBe(6);
  } finally {
    await pool.query('DROP TRIGGER test_reset_truncate_failure ON scopes; DROP FUNCTION test_reset_truncate_failure()');
    await resetData(pool);
  }
  expect((await pool.query('SELECT id FROM principals WHERE id=$1', [probe.id])).rowCount).toBe(0);
}, 30000);
