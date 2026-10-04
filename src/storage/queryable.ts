import type pg from 'pg';

// The SQL-only storage layer accepts either a pool or a transaction client.
export type Queryable = Pick<pg.PoolClient, 'query'>;
