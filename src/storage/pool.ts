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
      console.error('pg pool idle client error', error);
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
