import pg from 'pg';

let pool: pg.Pool | undefined;

function positiveInteger(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value === undefined) return defaultValue;

  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

export function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.CONTINUUM_DATABASE_URL;
    if (!url) {
      throw new Error('CONTINUUM_DATABASE_URL is not set');
    }
    pool = new pg.Pool({
      connectionString: url,
      max: positiveInteger('CONTINUUM_DB_POOL_MAX', 10),
      idleTimeoutMillis: positiveInteger('CONTINUUM_DB_IDLE_TIMEOUT_MS', 10_000),
      connectionTimeoutMillis: positiveInteger('CONTINUUM_DB_CONNECTION_TIMEOUT_MS', 5_000),
    });
    pool.on('error', (error: Error) => {
      console.error(JSON.stringify({ event: 'pg_pool_idle_client_error', code: 'DEPENDENCY_UNAVAILABLE' }));
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** Separate remote serving pool. Initialization completes before any client is admitted. */
export function createMcpHttpPool(connectionString: string): pg.Pool {
  const options: pg.PoolConfig & { verify: (client: pg.PoolClient, done: (error?: Error) => void) => void } = {
    connectionString, max: 5, connectionTimeoutMillis: 1000, idleTimeoutMillis: 10000, query_timeout: 5000,
    verify(client, done) {
      void client.query(`SELECT pg_catalog.set_config('statement_timeout',
        (CASE WHEN setting::int > 0 THEN least(setting::int,5000) ELSE 5000 END)::text, false)
        FROM pg_catalog.pg_settings WHERE name='statement_timeout'`)
        .then(() => client.query(`SELECT pg_catalog.set_config('lock_timeout',
          (CASE WHEN setting::int > 0 THEN least(setting::int,1000) ELSE 1000 END)::text, false)
          FROM pg_catalog.pg_settings WHERE name='lock_timeout'`))
        .then(() => done(), () => done(new Error('Remote database initialization failed')));
    },
  };
  const remote = new pg.Pool(options);
  remote.on('error', () => console.error(JSON.stringify({ event: 'pg_pool_idle_client_error', code: 'DEPENDENCY_UNAVAILABLE' })));
  return remote;
}
