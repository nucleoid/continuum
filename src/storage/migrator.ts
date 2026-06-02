import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = resolve(here, '../../migrations');

export interface AppliedMigration {
  name: string;
  appliedAt: Date;
}

export async function runMigrations(
  pool: pg.Pool,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<AppliedMigration[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _continuum_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: AppliedMigration[] = [];

  for (const file of files) {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM _continuum_migrations WHERE name = $1',
      [file],
    );
    if (rowCount && rowCount > 0) continue;

    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO _continuum_migrations (name) VALUES ($1)',
        [file],
      );
      await client.query('COMMIT');
      applied.push({ name: file, appliedAt: new Date() });
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  return applied;
}
