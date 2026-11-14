import type { Queryable } from './queryable.js';

export async function evidenceDatabaseTime(queryable: Queryable): Promise<number> {
  // Existing membership predicates use transaction time. Do not label an old
  // caller transaction or repeatable snapshot as current operation authority.
  const { rows } = await queryable.query<{ at: Date | null }>(
    `SELECT CASE WHEN pg_catalog.current_setting('transaction_isolation') = 'read committed'
         AND pg_catalog.transaction_timestamp() = pg_catalog.statement_timestamp()
       THEN pg_catalog.clock_timestamp() END AS at`,
  );
  return rows[0].at?.getTime() ?? NaN;
}
