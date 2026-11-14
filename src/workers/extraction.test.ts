import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { extractionFixture, syntheticExtractor } from '../extraction/test-helpers.js';
import { processExtraction, ExtractionTransientError, ExtractionWorker } from './extraction.js';
import { createMemory } from '../storage/memories.js';
import { requireExtractionReady, requireEvidenceReady } from '../storage/provider-lifecycle.js';
import { extractionDescriptor } from '../extraction/provider.js';

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
