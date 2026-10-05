import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrator.js';

const DATABASE_URL = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:continuum@localhost:5433/continuum';

describe('controlled-tag mixed-version operations', () => {
  it('documents a pause, drain, migrate, compatible deploy, and idempotent replay sequence', async () => {
    const documentation = await readFile(
      join(process.cwd(), 'docs/tag-vocabularies.md'),
      'utf8',
    );

    const orderedSteps = [
      /pause webhook intake/i,
      /drain in-flight/i,
      /continuum-migrate/i,
      /deploy the vocabulary-aware application/i,
      /resume webhook intake/i,
      /replay[\s\S]+original delivery identit/i,
    ];
    let previous = -1;
    for (const step of orderedSteps) {
      const match = step.exec(documentation.slice(previous + 1));
      expect(match, `missing rollout step ${step}`).not.toBeNull();
      previous += 1 + match!.index;
    }
    expect(documentation).toMatch(/replay(?:ed|ing)?[\s\S]+idempotent/i);
  });

  it('ships an exact pre-rollback trigger procedure for every legacy writer', async () => {
    const procedure = await readFile(
      join(process.cwd(), 'scripts/enable-tag-legacy-writer-compat.sql'),
      'utf8',
    );
    const documentation = await readFile(
      join(process.cwd(), 'docs/tag-vocabularies.md'),
      'utf8',
    );

    expect(procedure).toContain('CREATE OR REPLACE FUNCTION enforce_memory_tag_vocabulary()');
    expect(procedure).not.toMatch(/NEW\.source\s+IN/i);
    expect(procedure).toContain('continuum_legacy_tags');
    expect(procedure).toContain('FOR KEY SHARE');
    expect(documentation).toContain('scripts/enable-tag-legacy-writer-compat.sql');
    expect(documentation).toMatch(/pause webhook intake[\s\S]+drain in-flight[\s\S]+application rollback/i);
    expect(documentation).toContain('$env:CONTINUUM_DATABASE_URL');
    expect(documentation).toContain('.\\scripts\\enable-tag-legacy-writer-compat.sql');
  });

  it('ships and documents strict trigger restoration before a forward redeploy resumes writes', async () => {
    const procedure = await readFile(
      join(process.cwd(), 'scripts/restore-tag-strict-enforcement.sql'),
      'utf8',
    );
    const documentation = await readFile(
      join(process.cwd(), 'docs/tag-vocabularies.md'),
      'utf8',
    );

    expect(procedure).toContain('CREATE OR REPLACE FUNCTION enforce_memory_tag_vocabulary()');
    expect(procedure).toContain('CREATE TRIGGER memories_tags_controlled_vocabulary');
    expect(procedure).toContain("SET LOCAL lock_timeout = '5s';");
    expect(procedure).toContain("SET LOCAL statement_timeout = '60s';");
    expect(documentation).toContain('scripts/restore-tag-strict-enforcement.sql');
    expect(documentation).toMatch(
      /deploy the vocabulary-aware application[\s\S]+restore-tag-strict-enforcement\.sql[\s\S]+resume webhook intake/i,
    );
  });

  it('quarantines unknown tags from every legacy writer without losing originals', async () => {
    const schema = `tag_rollback_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    const pool = new pg.Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await runMigrations(pool);
      const procedure = await readFile(
        join(process.cwd(), 'scripts/enable-tag-legacy-writer-compat.sql'),
        'utf8',
      );
      await pool.query(procedure);
      await pool.query(`
        INSERT INTO principals (id, external_id, kind, display_name)
        VALUES ('10000000-0000-4000-8000-000000000030', 'rollback:writer', 'user', 'Old Writer');
        INSERT INTO scopes (id, kind, name)
        VALUES ('20000000-0000-4000-8000-000000000030', 'project', 'rollback');
        INSERT INTO memories (
          id, scope_id, type, title, body, author_id, source, tags, metadata
        ) VALUES (
          '30000000-0000-4000-8000-000000000030',
          '20000000-0000-4000-8000-000000000030',
          'fact', 'Legacy ADO', 'Dynamic tags are private provenance',
          '10000000-0000-4000-8000-000000000030', 'ado-workitem',
          ARRAY['ado', 'active', 'secret team', 'decision', 'decision'],
          '{"keep":"yes"}'::jsonb
        )
      `);
      const stored = await pool.query(
        `SELECT tags, metadata FROM memories
          WHERE id = '30000000-0000-4000-8000-000000000030'`,
      );
      expect(stored.rows).toEqual([{
        tags: ['ado', 'decision'],
        metadata: {
          keep: 'yes',
          continuum_legacy_tags: ['active', 'secret team', 'decision'],
          continuum_tag_rollback_compat: {
            version: 1,
            original_tags: ['ado', 'active', 'secret team', 'decision', 'decision'],
          },
        },
      }]);

      await pool.query(`
        INSERT INTO memories (
          id, scope_id, type, title, body, author_id, source, tags, metadata
        ) VALUES (
          '30000000-0000-4000-8000-000000000031',
          '20000000-0000-4000-8000-000000000030',
          'fact', 'Manual', 'Manual writers are safely normalized',
          '10000000-0000-4000-8000-000000000030', 'manual',
          ARRAY['Deploy', 'active', 'deploy'],
          '{"continuum_tag_migration":"forged"}'::jsonb
        )
      `);
      const manual = await pool.query(
        `SELECT tags, metadata FROM memories
          WHERE id = '30000000-0000-4000-8000-000000000031'`,
      );
      expect(manual.rows).toEqual([{
        tags: ['deploy'],
        metadata: {
          continuum_legacy_tags: ['active', 'deploy'],
          continuum_tag_rollback_compat: {
            version: 1,
            original_tags: ['Deploy', 'active', 'deploy'],
          },
          continuum_migration_conflicts: [
            { key: 'continuum_tag_migration', value: 'forged' },
          ],
        },
      }]);

      const migrationProvenance = {
        version: 1,
        original_tags: ['PR', 'pr', 'private-before-migration'],
      };
      await pool.query(`
        INSERT INTO memories (
          id, scope_id, type, title, body, author_id, source, tags, metadata
        ) VALUES (
          '30000000-0000-4000-8000-000000000032',
          '20000000-0000-4000-8000-000000000030',
          'fact', 'Promoted canonical memory', 'Keep true migration provenance unchanged',
          '10000000-0000-4000-8000-000000000030', 'manual',
          ARRAY['pr', 'decision'], $1::jsonb
        )
      `, [JSON.stringify({
        keep: 'promotion',
        continuum_legacy_tags: ['private-before-migration'],
        continuum_tag_migration: migrationProvenance,
      })]);
      const promoted = await pool.query(
        `SELECT tags, metadata FROM memories
          WHERE id = '30000000-0000-4000-8000-000000000032'`,
      );
      expect(promoted.rows).toEqual([{
        tags: ['pr', 'decision'],
        metadata: {
          keep: 'promotion',
          continuum_legacy_tags: ['private-before-migration'],
          continuum_tag_migration: migrationProvenance,
        },
      }]);

      await pool.query(`
        UPDATE memories
           SET title = 'Legacy writer changed only the title'
         WHERE id = '30000000-0000-4000-8000-000000000030'
      `);
      const stable = await pool.query(
        `SELECT tags, metadata FROM memories
          WHERE id = '30000000-0000-4000-8000-000000000030'`,
      );
      expect(stable.rows).toEqual(stored.rows);

      const restore = await readFile(
        join(process.cwd(), 'scripts/restore-tag-strict-enforcement.sql'),
        'utf8',
      );
      await pool.query(restore);
      await expect(pool.query(`
        INSERT INTO memories (
          id, scope_id, type, title, body, author_id, source, tags
        ) VALUES (
          '30000000-0000-4000-8000-000000000033',
          '20000000-0000-4000-8000-000000000030',
          'fact', 'Forward deployment', 'Strict enforcement is restored',
          '10000000-0000-4000-8000-000000000030', 'manual', ARRAY['private-after-rollback']
        )
      `)).rejects.toMatchObject({ code: '23514' });
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
});
