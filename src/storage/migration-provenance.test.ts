import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from './migrator.js';

describe('migration execution provenance', () => {
  it('executes the verified source snapshot when the file changes after verification', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-provenance-race-'));
    const name = '0052_offboarding_review_repair.sql';
    const path = join(directory, name);
    await copyFile(join(process.cwd(), 'migrations', name), path);
    const original = await readFile(path, 'utf8');
    const marker = 'UNVERIFIED_MIGRATION_FILE_REPLACEMENT';
    const submitted: string[] = [];
    let changed = false;
    const client = {
      query: vi.fn(async (sql: string) => {
        submitted.push(sql);
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }], rowCount: 1 };
        if (!changed && sql.includes('CREATE TABLE IF NOT EXISTS _continuum_migrations')) {
          changed = true;
          await writeFile(path, original + `\nSELECT '${marker}';\n`);
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    try {
      await expect(runMigrations(pool, directory)).resolves.toHaveLength(1);
      expect(changed).toBe(true);
      expect(submitted.some((sql) => sql.includes(marker))).toBe(false);
      expect(submitted).toContain(original.replaceAll('\r\n', '\n'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
