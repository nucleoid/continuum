import type pg from 'pg';
import { ServiceError } from '../services/errors.js';

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

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
    const readiness = await client.query<{
      owner: boolean; helper: boolean; trusted: boolean; schema: string;
    }>(`
    SELECT relation.relowner = current_user::regrole::oid AS owner,
           namespace.nspname AS schema,
           verifier.oid IS NOT NULL AS helper,
           COALESCE(verifier.proowner=relation.relowner AND verifier.prosecdef
             AND verifier.proconfig @> ARRAY[pg_catalog.format(
               'search_path=pg_catalog, %I, pg_temp',namespace.nspname)]
             AND NOT EXISTS (
               SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
                 verifier.proacl,pg_catalog.acldefault('f',verifier.proowner))) privilege
                WHERE privilege.grantee=0 AND privilege.privilege_type='EXECUTE'
             ),FALSE) AS trusted
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
      LEFT JOIN pg_catalog.pg_proc verifier ON verifier.oid=pg_catalog.to_regprocedure(
        pg_catalog.format('%I.continuum_assert_current_pgvector_profile()',namespace.nspname))
     WHERE relation.oid = pg_catalog.to_regclass('memories')
  `);
    const state = readiness.rows[0];
    if (!state?.schema) {
      throw new Error('Pgvector startup memories relation is missing');
    }

    // Owners can read the ledger directly. Check it before the SECURITY DEFINER
    // helper touches the provider catalog so a new binary remains compatible
    // with a database whose 0080 transaction has not committed yet.
    if (state.owner) {
      const migration = await client.query<{ applied: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM ${quoteIdentifier(state.schema)}._continuum_migrations
         WHERE name = '0080_pgvector_provider_grants.sql'
      ) AS applied
    `);
      if (migration.rows[0]?.applied === false) {
        await client.query('COMMIT');
        return;
      }
    }

    // Runtime roles cannot prove a pre-0080 ledger state. Current binaries
    // require the owner to finish the documented upgrade before startup.
    if (!state.helper) throw new Error('Pgvector startup verifier is missing');
    if (!state.trusted) throw new Error('Pgvector startup verifier trust drift');

    // Runtime roles cannot inspect the owner-only registry. The definer gate
    // resolves the real session/SET ROLE identity and validates only that role.
    await client.query(`SELECT ${quoteIdentifier(state.schema)}.continuum_assert_current_pgvector_profile()`);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { destroyClient = true; }
    throw error;
  } finally {
    client.release(destroyClient);
  }
}


/** REST/MCP startup requires the current contract without repairing it. */
export async function requireCoordinationContractReady(pool: pg.Pool): Promise<void> {
  const unavailable = () => new ServiceError('DEPENDENCY_UNAVAILABLE',
    'Coordination contract readiness is unavailable; finish migrations before starting runtimes');
  const incomplete = () => new ServiceError('DEPENDENCY_UNAVAILABLE',
    'Coordination contract repair is incomplete; finish migrations before starting runtimes');
  const client = await pool.connect().catch(() => { throw unavailable(); });
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('statement_timeout', CASE
      WHEN setting::bigint BETWEEN 1 AND 5000 THEN setting || 'ms'
      ELSE '5000ms' END, TRUE) FROM pg_settings WHERE name='statement_timeout'`);
    await client.query("SET LOCAL lock_timeout = '1s'");
    const metadata = await client.query<{ schema: string; trusted: boolean }>(`
      SELECT namespace.nspname AS schema,
        COALESCE(helper.proowner=relation.relowner AND helper.prosecdef AND helper.provolatile='s'
          AND helper.prorettype='pg_catalog.bool'::regtype AND helper.pronargs=0
          AND helper.proconfig @> ARRAY[pg_catalog.format(
            'search_path=pg_catalog, %I, pg_temp', namespace.nspname)]
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
            helper.proacl,pg_catalog.acldefault('f',helper.proowner))) privilege
            WHERE privilege.grantee=0 AND privilege.privilege_type='EXECUTE'),FALSE) AS trusted
        FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
        LEFT JOIN pg_catalog.pg_proc helper ON helper.oid=pg_catalog.to_regprocedure(
          pg_catalog.format('%I.continuum_coordination_contract_is_ready()',namespace.nspname))
        WHERE relation.oid=pg_catalog.to_regclass('memories')
    `);
    const state = metadata.rows[0];
    if (!state?.trusted) throw unavailable();
    const result = await client.query<{ ready: boolean }>(
      `SELECT ${quoteIdentifier(state.schema)}.continuum_coordination_contract_is_ready() AS ready`,
    );
    if (result.rows[0]?.ready !== true) throw incomplete();
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { destroyClient = true; }
    if (error instanceof ServiceError) throw error;
    if ((error as { code?: unknown })?.code === '55000') throw incomplete();
    throw unavailable();
  } finally { client.release(destroyClient); }
}
