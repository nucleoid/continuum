import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { extractionFixture, syntheticExtractor } from '../extraction/test-helpers.js';
import { processExtraction, ExtractionTransientError, ExtractionWorker } from './extraction.js';
import { createMemory } from '../storage/memories.js';
import { requireExtractionReady, requireEvidenceReady } from '../storage/provider-lifecycle.js';
import { extractionDescriptor } from '../extraction/provider.js';
import type pg from 'pg';

it('rolls back final assertion publication when the original local deadline expires during SQL admission', async () => {
  const profile = syntheticExtractor();
  profile.budget = { ...profile.budget, overallMs: 2000, stageMs: 500 };
  profile.adapter.timeoutMs = 500;
  await extractionFixture(async f => {
    await createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId,
      type: 'decision', title: 'Original cutoff', body: 'Keep original truth', source: 'manual' });
    let entered!: () => void, release!: () => void;
    const suspended = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const observed = new Proxy(f.worker, { get(target, key) {
      if (key !== 'connect') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; }
      return async () => {
        if (first) { first = false; await new Promise(resolve => setTimeout(resolve, 750)); }
        const client = await target.connect();
        return new Proxy(client, { get(connection, property) {
          if (property !== 'query') { const value = Reflect.get(connection, property); return typeof value === 'function' ? value.bind(connection) : value; }
          return async (...args: [string, unknown[]?]) => {
            if (args[0].includes('SELECT continuum_extraction_apply')) { entered(); await resume; }
            return connection.query(...args);
          };
        } });
      };
    } }) as pg.Pool;
    const start = performance.now();
    const work = processExtraction(observed, randomUUID(), f.profile);
    let outcome: Awaited<typeof work> | undefined;
    try {
      await Promise.race([suspended, work.then(() => { throw new Error('Worker stopped before apply'); })]);
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 2100 - (performance.now() - start))));
      expect((await f.owner.query('SELECT deadline_at>clock_timestamp() AS live FROM pipeline_budget_workflows')).rows[0].live).toBe(true);
    } finally { release(); outcome = await work; }
    expect(outcome).toBe('unavailable');
    expect((await f.owner.query("SELECT count(*)::int AS n FROM evidence_versions WHERE kind='extracted-assertion'")).rows[0].n).toBe(0);
    expect((await f.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE metadata->>'operation'='extraction_chunk_finished'")).rows[0].n).toBe(0);
    expect((await f.owner.query('SELECT body FROM memories WHERE scope_id=$1', [f.scopeId])).rows[0].body).toBe('Keep original truth');
  }, profile);
}, 120_000);

it('commits a cancellation fence while pre-hydration work is suspended', async () => {
  await extractionFixture(async f => {
    await createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId, type: 'decision', title: 'Cancel admission', body: 'Never disclose', source: 'manual' });
    const controller = new AbortController();
    let entered!: () => void, release!: () => void, fenced!: () => void;
    const suspended = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const committed = new Promise<void>(resolve => { fenced = resolve; });
    const observed = new Proxy(f.worker, { get(target, key) {
      if (key !== 'connect') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; }
      return async () => {
        const client = await target.connect(); let cancellation = false;
        return new Proxy(client, { get(connection, property) {
          if (property !== 'query') { const value = Reflect.get(connection, property); return typeof value === 'function' ? value.bind(connection) : value; }
          return async (...args: [string, unknown[]?]) => {
            if (args[0].includes('SELECT continuum_extraction_hydrate')) { entered(); await resume; }
            const result = await connection.query(...args);
            if (args[0].includes('SELECT continuum_extraction_stop')) cancellation = true;
            if (args[0] === 'COMMIT' && cancellation) fenced();
            return result;
          };
        } });
      };
    } }) as pg.Pool;
    const work = processExtraction(observed, randomUUID(), f.profile, { signal: controller.signal });
    let timer: NodeJS.Timeout | undefined;
    try {
      await suspended; controller.abort();
      await Promise.race([committed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Cancellation fence did not commit')), 1000); })]);
      expect((await f.owner.query('SELECT cancelled FROM pipeline_budget_workflows')).rows[0].cancelled).toBe(true);
    } finally { if (timer) clearTimeout(timer); release(); await work; }
    expect((await f.owner.query("SELECT count(*)::int AS n FROM evidence_versions WHERE kind='extracted-assertion'")).rows[0].n).toBe(0);
  });
}, 120_000);

it('runs the installed local composition through an actual non-owner LOGIN and persists immutable unverified evidence', async () => {
  await extractionFixture(async f => {
    await requireExtractionReady(f.app); await requireEvidenceReady(f.app); await requireExtractionReady(f.worker);
    const memory = await createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId,
      type: 'decision', title: 'Truth', body: 'Authoritative source with explicit unknown release date.', source: 'manual' });
    expect(await processExtraction(f.worker, randomUUID(), f.profile)).toBe('processed');
    const result = (await f.app.query('SELECT continuum_extraction_status($1,$2,TRUE) AS result', [f.actorId, memory.id])).rows[0].result;
    expect(result.status).toBe('complete'); expect(result.assertions).toBe(1); expect(result.items[0].data.status).toBe('generated/unverified');
    expect(result.items[0].data.assertion.unknown).toBe(true);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM memories WHERE scope_id=$1', [f.scopeId])).rows[0].n).toBe(1);
    expect((await f.owner.query('SELECT body FROM memories WHERE id=$1', [memory.id])).rows[0].body).toBe(memory.body);
    expect(await processExtraction(f.worker, randomUUID(), f.profile)).toBe('idle');
    await expect(f.worker.query('SELECT body FROM memories')).rejects.toMatchObject({ code: '42501' });
    await expect(f.worker.query('SELECT continuum_evidence_source($1,$2)', [f.actorId, memory.id])).rejects.toMatchObject({ code: '42501' });
    await expect(f.app.query('SELECT continuum_extraction_claim($1,$2,$3)', [f.profile.id, randomUUID(), extractionDescriptor(f.profile)])).rejects.toMatchObject({ code: '42501' });
    const owner = await f.owner.connect();
    try {
      await owner.query(`SET ROLE "${f.workerRole}"`);
      await expect(owner.query('SELECT continuum_extraction_claim($1,$2,$3)', [f.profile.id, randomUUID(), extractionDescriptor(f.profile)])).rejects.toMatchObject({ code: '42501' });
    } finally { await owner.query('RESET ROLE'); owner.release(); }
  });
}, 120_000);

it('retains admission through an abort-ignoring call and suppresses its late assertion after bounded shutdown', async () => {
  let finish!: () => void; let invoked!: () => void;
  const started = new Promise<void>(resolve => { invoked = resolve; });
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const good = syntheticExtractor();
  const profile = syntheticExtractor(async (...args) => { invoked(); await blocked; return good.adapter.invoke(...args); });
  await extractionFixture(async f => {
    await createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId, type: 'decision', title: 'Blocked', body: 'Retained source', source: 'manual' });
    const worker = new ExtractionWorker(f.worker, f.registry, { shutdownMs: 500 });
    const poll = worker.poll();
    await started;
    await expect(worker.stop()).rejects.toThrow(/did not settle/);
    await poll;
    const before = (await f.owner.query('SELECT active,retained_bytes FROM pipeline_budget_workflows')).rows[0];
    expect(before.active).toBe(1); expect(Number(before.retained_bytes)).toBeGreaterThan(0);
    expect(await processExtraction(f.worker, randomUUID(), f.profile)).toBe('idle');
    finish();
    // Explicit actual promise settlement, rather than a timer or a lease, is
    // what releases retained resources. stop() remains idempotent afterwards.
    await worker.stop();
    expect((await f.owner.query('SELECT active,retained_bytes FROM pipeline_budget_workflows')).rows[0]).toMatchObject({ active: 0, retained_bytes: '0' });
    expect((await f.owner.query("SELECT count(*)::int AS n FROM evidence_versions WHERE kind='extracted-assertion'")).rows[0].n).toBe(0);
  }, profile);
}, 120_000);

it('retries a settled classified transient within the same original workflow, retaining all attempt identities', async () => {
  let calls = 0;
  const good = syntheticExtractor();
  const profile = syntheticExtractor(async (...args) => {
    if (++calls === 1) throw new ExtractionTransientError();
    return good.adapter.invoke(...args);
  });
  await extractionFixture(async f => {
    const memory = await createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId,
      type: 'decision', title: 'Original', body: 'Retry source', source: 'manual' });
    const before = (await f.owner.query('SELECT workflow_id,budget_owner,budget_generation FROM extraction_runs WHERE memory_id=$1', [memory.id])).rows[0];
    expect(await processExtraction(f.worker, randomUUID(), f.profile)).toBe('unavailable');
    await f.app.query('SELECT continuum_extraction_retry($1,$2)', [f.actorId, memory.id]);
    expect(await processExtraction(f.worker, randomUUID(), f.profile)).toBe('processed');
    const after = (await f.owner.query('SELECT workflow_id,budget_owner,budget_generation,state FROM extraction_runs WHERE memory_id=$1', [memory.id])).rows[0];
    expect(after).toMatchObject({ ...before, state: 'complete' }); expect(calls).toBe(2);
    const w = (await f.owner.query('SELECT used,active,retained_bytes FROM pipeline_budget_workflows WHERE id=$1', [before.workflow_id])).rows[0];
    expect(w.used.calls).toBe(2); expect(w.used.retries).toBe(1); expect(w.active).toBe(0); expect(Number(w.retained_bytes)).toBe(0);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM extraction_attempts WHERE run_id=(SELECT id FROM extraction_runs WHERE memory_id=$1)', [memory.id])).rows[0].n).toBe(2);
  }, profile);
}, 120_000);

it('projects durable settlement rejection as unavailable and retains maxima until actual original-identity settlement', async () => {
  await extractionFixture(async f => {
    await createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId, type: 'decision', title: 'Settlement', body: 'Original source', source: 'manual' });
    await f.owner.query(`CREATE FUNCTION reject_extraction_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.state='settled' THEN RAISE EXCEPTION 'synthetic settlement rejection'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_extraction_settlement BEFORE UPDATE ON pipeline_budget_attempts FOR EACH ROW EXECUTE FUNCTION reject_extraction_settlement()`);
    expect(await processExtraction(f.worker, randomUUID(), f.profile)).toBe('unavailable');
    const row = (await f.owner.query(`SELECT r.id,r.generation,r.owner,r.workflow_id,a.attempt_id,w.active,w.used,w.retained_bytes
      FROM extraction_runs r JOIN extraction_attempts a ON a.run_id=r.id JOIN pipeline_budget_workflows w ON w.id=r.workflow_id`)).rows[0];
    expect(row.active).toBe(1); expect(row.used.calls).toBe(1); expect(Number(row.retained_bytes)).toBeGreaterThan(0);
    expect((await f.owner.query("SELECT count(*)::int AS n FROM evidence_versions WHERE kind='extracted-assertion'")).rows[0].n).toBe(0);
    await f.owner.query('DROP TRIGGER reject_extraction_settlement ON pipeline_budget_attempts');
    // The local call has actually settled. Use its persisted original identity,
    // retaining unknown maximum charges despite the cancelled generation.
    expect((await f.worker.query('SELECT continuum_extraction_budget($1,$2,$3,$4,\'settle\',$5,0) AS result',
      [row.id, randomUUID(), row.generation, row.attempt_id, { provenance: 'unknown' }])).rows[0].result).toBe(false);
    expect((await f.owner.query('SELECT active,used FROM pipeline_budget_workflows WHERE id=$1', [row.workflow_id])).rows[0]).toMatchObject({ active: 0, used: { calls: 1 } });
    expect(await processExtraction(f.worker, randomUUID(), f.profile)).toBe('idle');
  });
}, 120_000);
