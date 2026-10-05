import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from './migrator.js';

const DATABASE_URL = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:continuum@localhost:5433/continuum';
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

it('rewrites 25,000 mixed historical rows within the bounded migration budget', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const schema = `tag_migration_scale_${suffix}`;
  const before = await mkdtemp(join(tmpdir(), 'continuum-tags-scale-before-'));
  const after = await mkdtemp(join(tmpdir(), 'continuum-tags-scale-after-'));
  const admin = new pg.Pool({ connectionString: DATABASE_URL });
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    options: `-c search_path=${schema},public`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const name of [
      '0001_init.sql', '0002_lifecycle_principal.sql',
      '0003_lifecycle_expiry_index.sql', '0004_review_queue_index.sql',
    ]) {
      await writeFile(join(before, name), await readFile(join(MIGRATIONS, name), 'utf8'));
    }
    await writeFile(
      join(after, '0010_tag_vocabularies.sql'),
      await readFile(join(MIGRATIONS, '0010_tag_vocabularies.sql'), 'utf8'),
    );
    await runMigrations(pool, before);
    await pool.query(`
      INSERT INTO principals (id, external_id, kind, display_name)
      VALUES ('10000000-0000-4000-8000-000000000099', 'scale:writer', 'user', 'Scale Writer');
      INSERT INTO scopes (id, kind, name)
      VALUES ('20000000-0000-4000-8000-000000000099', 'project', 'scale');
      INSERT INTO memories (
        id, scope_id, type, title, body, author_id, source, tags, metadata
      )
      SELECT ('30000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
             '20000000-0000-4000-8000-000000000099',
             'fact', 'Scale ' || g, 'Historical body',
             '10000000-0000-4000-8000-000000000099', 'manual',
             CASE g % 3
               WHEN 0 THEN ARRAY['Decision', 'private-' || g, 'decision']
               WHEN 1 THEN ARRAY['pr', 'unknown value']
               ELSE ARRAY['deploy']
             END,
             CASE WHEN g % 10 = 0
               THEN '{"continuum_legacy_tags":"caller-owned"}'::jsonb
               ELSE '{}'::jsonb
             END
        FROM generate_series(1, 25000) AS generated(g)
    `);

    const started = performance.now();
    await runMigrations(pool, after);
    const elapsedMs = performance.now() - started;
    console.info(JSON.stringify({
      event: 'tag_migration_scale', rows: 25000, elapsedMs: Math.round(elapsedMs),
    }));

    expect(elapsedMs).toBeLessThan(20_000);
    const { rows } = await pool.query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE metadata ? 'continuum_tag_migration')::int AS provenance,
             count(*) FILTER (WHERE metadata ? 'continuum_legacy_tags')::int AS quarantined,
             count(*) FILTER (WHERE metadata ? 'continuum_migration_conflicts')::int AS conflicts
        FROM memories
    `);
    expect(rows).toEqual([{
      total: 25000,
      provenance: 17500,
      quarantined: 16667,
      conflicts: 2500,
    }]);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await Promise.all([
      rm(before, { recursive: true, force: true }),
      rm(after, { recursive: true, force: true }),
    ]);
  }
}, 30_000);
