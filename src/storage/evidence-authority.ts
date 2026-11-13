import type { Queryable } from './queryable.js';

export async function evidenceDatabaseTime(queryable: Queryable): Promise<number> {
  const { rows } = await queryable.query<{ at: Date }>('SELECT pg_catalog.clock_timestamp() AS at');
  return rows[0].at.getTime();
}
