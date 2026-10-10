import type pg from 'pg';

/** Verify startup profiles without changing live provider privileges. */
export async function reconcilePgvectorProviderGrants(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    // Keep a stricter caller timeout. These limits run on the server and the
    // checked-out connection holds them through every verification statement.
    await client.query(`
      SELECT set_config('statement_timeout', CASE
               WHEN setting::bigint BETWEEN 1 AND 5000 THEN setting || 'ms'
               ELSE '5000ms' END, TRUE)
        FROM pg_settings WHERE name = 'statement_timeout'
    `);
    await client.query("SET LOCAL lock_timeout = '1s'");
    const readiness = await client.query<{ owner: boolean; helper: boolean }>(`
    SELECT relation.relowner = current_user::regrole::oid AS owner,
           to_regprocedure('continuum_assert_current_pgvector_profile()') IS NOT NULL
             AS helper
      FROM pg_class relation
     WHERE relation.oid = 'memories'::regclass
  `);
    const state = readiness.rows[0];
    if (!state?.helper) {
      await client.query('COMMIT');
      return;
    }

    // Owners can read the ledger directly. Check it before the SECURITY DEFINER
    // helper touches the provider catalog so a new binary remains compatible
    // with a database whose 0080 transaction has not committed yet.
    if (state.owner) {
      const migration = await client.query<{ applied: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM _continuum_migrations
         WHERE name = '0080_pgvector_provider_grants.sql'
      ) AS applied
    `);
      if (migration.rows[0]?.applied !== true) {
        await client.query('COMMIT');
        return;
      }
    }

    // Runtime roles cannot inspect the owner-only registry. The definer gate
    // resolves the real session/SET ROLE identity and validates only that role.
    await client.query('SELECT continuum_assert_current_pgvector_profile()');
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { destroyClient = true; }
    throw error;
  } finally {
    client.release(destroyClient);
  }
}
