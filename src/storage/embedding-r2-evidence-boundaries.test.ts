import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { embeddingQueueFixture } from '../embeddings/test-helpers.js';
import { captureMemory } from '../services/capture.js';
import { runMigrations } from './migrator.js';
import { createMemory } from './memories.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';

const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';

it('fails closed without a root/memory wait cycle while actual evidence erasure owns the root', async () => {
  await embeddingQueueFixture(async f => {
    const captured = await captureMemory(f.app, f.router, f.principal, {
      scope: { kind: f.scope.kind, name: f.scope.name }, type: 'fact',
      title: 'Actual evidence lock order', body: 'Synthetic erasure concurrency source.', source: 'manual',
    });
    const version = (await f.app.query('SELECT continuum_evidence_source($1,$2) AS id',
      [f.actorId, captured.memory.id])).rows[0].id;
    const schema = (await f.owner.query('SELECT current_schema() AS name')).rows[0].name;
    // Success must retain real root locks, not replace current-policy fences with plain reads.
    const control = await f.app.connect();
    try {
      await control.query('BEGIN');
      expect((await control.query('SELECT continuum_embedding_admit_vector($1,$2) AS result',
        [captured.memory.id, f.target])).rows[0].result).not.toBeNull();
      await expect(f.owner.query('SELECT id FROM evidence_roots WHERE source_memory_id=$1 FOR UPDATE NOWAIT',
        [captured.memory.id])).rejects.toMatchObject({ code: '55P03' });
    } finally { await control.query('ROLLBACK'); control.release(); }
    const app = await f.app.connect();
    // The owner invokes the actual private erasure helper. This is explicitly
    // its low-level SQL boundary, not an assertion that owner is a bound OP LOGIN.
    const eraser = new pg.Client({ connectionString: f.connectionString,
      options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=1000` });
    let erase: Promise<{ error?: unknown }> | undefined;
    try {
      await eraser.connect(); await app.query('BEGIN');
      const appPid = (await app.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const erasePid = (await eraser.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await app.query('SELECT id FROM memories WHERE id=$1 FOR UPDATE', [captured.memory.id]);
      await eraser.query('BEGIN');
      erase = eraser.query('SELECT continuum_evidence_erase_version($1)', [version]).then(async () => {
        await eraser.query('COMMIT'); return {};
      }, async (error: unknown) => { await eraser.query('ROLLBACK'); return { error }; });
      let blocked = false;
      const observeBy = Date.now() + 750;
      while (Date.now() < observeBy) {
        blocked = (await f.owner.query('SELECT $2::int=ANY(pg_blocking_pids($1)) AS blocked', [erasePid, appPid])).rows[0].blocked;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!blocked) throw new Error('Actual evidence erasure did not establish the source-row wait');
      let admission: unknown, admissionError: unknown;
      try { admission = (await app.query('SELECT continuum_embedding_admit_vector($1,$2) AS result',
        [captured.memory.id, f.target])).rows[0].result; }
      catch (error) { admissionError = error; }
      await app.query(admissionError ? 'ROLLBACK' : 'COMMIT');
      const erased = await erase;
      console.log('actual evidence lock outcomes', { admissionDenied: admission === null,
        admissionError: (admissionError as { code?: string } | undefined)?.code,
        erasureError: (erased.error as { code?: string } | undefined)?.code });
      expect(admissionError).toBeUndefined(); expect(admission).toBeNull(); expect(erased.error).toBeUndefined();
      expect((await f.owner.query('SELECT 1 FROM evidence_payloads WHERE version_id=$1', [version])).rowCount).toBe(0);
      expect((await f.owner.query('SELECT state FROM evidence_state WHERE version_id=$1', [version])).rows).toEqual([{ state: 'erased' }]);
      expect((await f.owner.query('SELECT 1 FROM memory_embeddings WHERE memory_id=$1', [captured.memory.id])).rowCount).toBe(0);
      expect(f.adapter.invoke).not.toHaveBeenCalled();
    } finally {
      await app.query('ROLLBACK'); app.release(); await erase; await eraser.end();
    }
  });
}, 60000);

it('does not reject physical erasure of legitimate pre-0098 scope history beyond the new admission bound', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16), schema = `embedding_lineage_${suffix}`;
  const url = process.env.CONTINUUM_TEST_DATABASE_URL ?? 'postgres://continuum:continuum@localhost:5433/continuum';
  const maintenance = new pg.Pool({ connectionString: url, max: 1 });
  const owner = new pg.Pool({ connectionString: url, max: 1,
    options: `-c search_path=${schema} -c statement_timeout=60000 -c lock_timeout=5000` });
  const directory = await mkdtemp(join(tmpdir(), 'continuum-embedding-lineage-'));
  const migrations = new URL('../../migrations/', import.meta.url);
  let created = false;
  try {
    await maintenance.query(`CREATE SCHEMA ${quote(schema)}`); created = true;
    for (const file of (await readdir(migrations)).sort()) if (/^\d{4}_.+\.sql$/.test(file) && Number(file.slice(0, 4)) <= 97) {
      await copyFile(new URL(file, migrations), join(directory, file));
    }
    expect((await runMigrations(owner, directory)).at(-1)?.name).toBe('0097_project_briefs.sql');
    const actor = await createPrincipal(owner, { externalId: `legacy-history-${suffix}`, kind: 'user', displayName: 'Historical source owner' });
    const original = await createScope(owner, { kind: 'project', name: `legacy-original-${suffix}` });
    await addMembership(owner, actor.id, original.id, 'writer');
    const memory = await createMemory(owner, { scopeId: original.id, scopeKind: 'project', authorId: actor.id,
      type: 'fact', title: 'Legacy history source', body: 'LEGITIMATE HISTORICAL SOURCE', source: 'manual' });
    await owner.query('SELECT continuum_evidence_source($1,$2)', [actor.id, memory.id]);
    // Every immutable version is produced by the actual published memory fence
    // and source snapshot. No direct version/dependency insert or guard bypass.
    await owner.query(`INSERT INTO scopes(id,kind,name) SELECT gen_random_uuid(),'project','legacy-${suffix}-'||n FROM generate_series(1,256) n`);
    await owner.query(`DO $$ DECLARE item RECORD; BEGIN
      FOR item IN SELECT id FROM scopes WHERE name LIKE 'legacy-${suffix}-%' ORDER BY id LOOP
        UPDATE memories SET scope_id=item.id WHERE id='${memory.id}'::uuid;
      END LOOP;
      UPDATE memories SET scope_id='${original.id}'::uuid WHERE id='${memory.id}'::uuid;
    END $$`);
    expect((await owner.query(`SELECT count(DISTINCT scope_id)::int AS scopes,max(root_count) AS roots,max(depth) AS depth
      FROM evidence_versions WHERE root_id=$1`, [memory.id])).rows).toEqual([{ scopes: 257, roots: 1, depth: 0 }]);
    await copyFile(new URL('0098_async_embedding_jobs.sql', migrations), join(directory, '0098_async_embedding_jobs.sql'));
    expect((await runMigrations(owner, directory)).at(-1)?.name).toBe('0098_async_embedding_jobs.sql');
    expect((await owner.query('SELECT count(*)::int AS n FROM embedding_sources')).rows[0].n).toBe(0);
    // An actual legacy source writer's physical archive must remain possible.
    await owner.query(`UPDATE memories SET state='archived',title='[erased]',body='[erased]',metadata='{}'::jsonb WHERE id=$1`, [memory.id]);
    expect((await owner.query('SELECT revoked FROM evidence_roots WHERE id=$1', [memory.id])).rows).toEqual([{ revoked: true }]);
    await owner.query('SELECT continuum_evidence_erase_version(id) FROM evidence_versions WHERE root_id=$1 ORDER BY id', [memory.id]);
    expect((await owner.query('SELECT 1 FROM evidence_payloads p JOIN evidence_versions v ON v.id=p.version_id WHERE v.root_id=$1', [memory.id])).rowCount).toBe(0);
    expect((await owner.query('SELECT 1 FROM memory_embeddings WHERE memory_id=$1', [memory.id])).rowCount).toBe(0);
  } finally {
    await owner.end();
    if (created) { await maintenance.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
      expect((await maintenance.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount).toBe(0); }
    await maintenance.end(); await rm(directory, { recursive: true, force: true });
  }
}, 180000);
