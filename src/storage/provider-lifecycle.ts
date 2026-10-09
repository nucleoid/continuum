import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/** Reconcile and verify the current tenant's exact pgvector provider profile. */
export async function reconcilePgvectorProviderGrants(db: Queryable): Promise<void> {
  const readiness = await db.query<{ owner: boolean; helper: boolean }>(`
    SELECT relation.relowner = current_user::regrole::oid AS owner,
           to_regprocedure('continuum_assert_current_pgvector_profile()') IS NOT NULL
             AS helper
      FROM pg_class relation
     WHERE relation.oid = 'memories'::regclass
  `);
  const state = readiness.rows[0];
  if (!state?.helper) return;

  // Owners can read the ledger directly. Check it before the SECURITY DEFINER
  // helper touches the provider catalog so a new binary remains compatible
  // with a database whose 0080 transaction has not committed yet.
  if (state.owner) {
    const migration = await db.query<{ applied: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM _continuum_migrations
         WHERE name = '0080_pgvector_provider_grants.sql'
      ) AS applied
    `);
    if (migration.rows[0]?.applied !== true) return;
  }

  // Runtime roles cannot inspect the owner-only registry. The definer gate
  // resolves the real session/SET ROLE identity and validates only that role.
  await db.query('SELECT continuum_assert_current_pgvector_profile()');
}
