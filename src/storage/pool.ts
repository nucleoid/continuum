import pg from 'pg';

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.CONTINUUM_DATABASE_URL;
    if (!url) {
      throw new Error('CONTINUUM_DATABASE_URL is not set');
    }
    pool = new pg.Pool({ connectionString: url });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
