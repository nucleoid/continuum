import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { embeddingQueueFixture } from '../embeddings/test-helpers.js';
import { embeddingTarget } from '../embeddings/target.js';
import { captureMemory } from '../services/capture.js';
import { getMemoryForPrincipal } from '../services/memories.js';
import { mapOwnedUserScope, offboardPrincipal } from '../services/offboarding.js';
import { getPrincipal } from './principals.js';
import { SqlEmbeddingJobStore, readEmbeddingStatus } from './embedding-jobs.js';
import { admitMemoryEmbedding, storeMemoryEmbeddingVector } from './embeddings.js';
import { processEmbeddingJobs } from '../workers/embedding-jobs.js';
import type { CaptureInput } from '../types.js';
import { amounts, starterProfile } from '../pipeline/budget.js';
import { EmbeddingItemError } from '../embeddings/provider.js';
import { computeExpiry } from './expiry.js';
import { requireEmbeddingQueueReady } from './provider-lifecycle.js';

type Fixture = Parameters<Parameters<typeof embeddingQueueFixture>[0]>[0];
const input = (f: Fixture, title = 'Deferred source'): CaptureInput => ({ scope: { kind: f.scope.kind, name: f.scope.name },
  type: 'fact', title, body: 'Source available before any provider response.', source: 'manual' });
const runWorker = (f: Fixture) => processEmbeddingJobs(new SqlEmbeddingJobStore(f.worker), f.target, f.policy, f.provider, f.profile, randomUUID());
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('durable embedding SQL, capture and worker integration', () => {
  it('acknowledges once without provider I/O, replays concurrently and survives creator writer loss', async () => {
    await embeddingQueueFixture(async f => {
      expect((await f.worker.query('SELECT continuum_embedding_worker_config($1,$2,$3) AS ready', [f.target, f.policy, f.profile])).rows[0].ready).toBe(true);
      const concurrent = new pg.Pool({ connectionString: f.app.options.connectionString, options: f.app.options.options,
        max: 2, connectionTimeoutMillis: 5000 });
      try {
        const results = await Promise.all(Array.from({ length: 4 }, () => captureMemory(concurrent, f.router, f.principal,
          input(f), {}, { idempotencyKey: 'retained-capture-key' })));
        expect(new Set(results.map(result => result.memory.id)).size).toBe(1);
        expect(results.filter(result => !result.replayed)).toHaveLength(1);
        expect(results.every(result => !result.embedded && result.embeddingStatus === 'queued' && result.related.length === 0)).toBe(true);
        expect(f.provider.embed).not.toHaveBeenCalled();
        expect(f.adapter.invoke).not.toHaveBeenCalled();
        const memory = results[0].memory;
        expect((await getMemoryForPrincipal(f.app, f.principal, memory.id)).memory.body).toBe(input(f).body);
        expect((await f.owner.query('SELECT count(*)::int AS n FROM embedding_jobs WHERE memory_id=$1', [memory.id])).rows[0].n).toBe(1);
        expect((await f.owner.query('SELECT count(*)::int AS n FROM embedding_capture_receipts WHERE memory_id=$1', [memory.id])).rows[0].n).toBe(1);
        expect((await f.owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE memory_id=$1 AND action='write' AND metadata ? 'embedding_status'`, [memory.id])).rows[0].n).toBe(1);
        const receipt = (await f.owner.query('SELECT key_hash,payload_digest,accepted_at,retain_until FROM embedding_capture_receipts WHERE memory_id=$1', [memory.id])).rows[0];
        expect(JSON.stringify(receipt)).not.toContain('retained-capture-key');
        expect(new Date(receipt.retain_until).valueOf() - new Date(receipt.accepted_at).valueOf()).toBeGreaterThanOrEqual(86400000);
        await expect(captureMemory(concurrent, f.router, f.principal, { ...input(f), body: 'Conflicting body' }, {},
          { idempotencyKey: 'retained-capture-key' })).rejects.toMatchObject({ code: 'CONFLICT' });
        await f.owner.query(`UPDATE scope_memberships SET role='reader' WHERE principal_id=$1 AND scope_id=$2`, [f.actorId, f.scopeId]);
        expect(await runWorker(f)).toBe('processed');
        expect(f.adapter.invoke).toHaveBeenCalledOnce();
        expect(f.provider.embed).not.toHaveBeenCalled();
        expect(await readEmbeddingStatus(f.app, f.actorId, memory.id)).toMatchObject({ embeddingStatus: 'ready', embedded: true, attempts: 1 });
        const replay = await captureMemory(concurrent, f.router, f.principal, input(f), {}, { idempotencyKey: 'retained-capture-key' });
        expect(replay).toMatchObject({ replayed: true, embedded: true, embeddingStatus: 'ready' });
        expect(replay.extraction).toEqual({ status: 'not-configured' });
        expect((await f.owner.query('SELECT count(*)::int AS n FROM extraction_runs')).rows[0].n).toBe(0);
        await expect(captureMemory(concurrent, f.router, f.principal, input(f, 'No writer'), {}, { idempotencyKey: 'new-key' }))
          .rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect((await f.owner.query('SELECT count(*)::int AS n FROM embedding_completions')).rows[0].n).toBe(1);
        expect((await f.owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE memory_id=$1 AND metadata->>'operation'='embedding_completed'`, [memory.id])).rows[0].n).toBe(1);
        await f.owner.query(`UPDATE memories SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [memory.id]);
        await expect(captureMemory(concurrent, f.router, f.principal, input(f), {}, { idempotencyKey: 'retained-capture-key' }))
          .rejects.toMatchObject({ code: 'FORBIDDEN' });
      } finally { await concurrent.end(); }
    });
  }, 60000);

  it('requires the actual bound LOGIN and immutable descriptor, and fences original generations and late responses', async () => {
    await embeddingQueueFixture(async f => {
      await expect(requireEmbeddingQueueReady(f.app)).resolves.toBeUndefined();
      await f.owner.query('ALTER TABLE memory_embeddings DISABLE TRIGGER embedding_vector_guard');
      try {
        expect((await f.app.query('SELECT continuum_embedding_is_ready() AS ready')).rows[0].ready).toBe(false);
        await expect(requireEmbeddingQueueReady(f.app)).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
      } finally { await f.owner.query('ALTER TABLE memory_embeddings ENABLE TRIGGER embedding_vector_guard'); }
      await expect(requireEmbeddingQueueReady(f.app)).resolves.toBeUndefined();
      const first = await captureMemory(f.app, f.router, f.principal, input(f));
      const store = new SqlEmbeddingJobStore(f.worker);
      await expect(f.app.query('SELECT continuum_embedding_claim($1,$2,$3,1,$4)', [f.target, f.policy, randomUUID(), f.profile]))
        .rejects.toMatchObject({ code: '42501' });
      await f.worker.query(`SELECT set_config('continuum.worker_principal',$1,FALSE)`, [f.producerId]);
      await expect(f.worker.query('SELECT body FROM memories')).rejects.toMatchObject({ code: '42501' });
      await expect(f.worker.query('SELECT continuum_operator_embedding_control($1,$2,$3,1)', [f.adminId, 'pause', f.target.fingerprint]))
        .rejects.toMatchObject({ code: '42501' });
      const appRole = (await f.app.query('SELECT session_user AS name')).rows[0].name as string;
      const quote = (name: string) => '"' + name.replaceAll('"','""') + '"';
      await f.owner.query(`GRANT ${quote(f.workerRole)} TO ${quote(appRole)}`);
      try {
        await f.app.query(`SET ROLE ${quote(f.workerRole)}`);
        await expect(f.app.query('SELECT continuum_embedding_claim($1,$2,$3,1,$4)', [f.target, f.policy, randomUUID(), f.profile]))
          .rejects.toMatchObject({ code: '42501' });
      } finally {
        await f.app.query('RESET ROLE');
        await f.owner.query(`REVOKE ${quote(f.workerRole)} FROM ${quote(appRole)}`);
      }
      const conflict = embeddingTarget({ space: { ...f.target.space, profile: 'different-vector-space' }, endpoint: 'http://fixture.invalid/embedding', local: true });
      await expect(f.operator.query('SELECT continuum_operator_embedding_target($1,$2,$3,$4,TRUE)', [f.adminId, conflict, f.profile,
        { seconds: 60, dispatches: 64, inputBytes: 16777216, tokens: 16777216, spendMicros: 0, rateSchedule: f.profile.rateSchedule }]))
        .rejects.toMatchObject({ code: '23514' });
      const original = await admitMemoryEmbedding(f.app, first.memory.id, f.provider);
      expect(original).not.toBeNull();
      await f.owner.query(`UPDATE memories SET body='New generation' WHERE id=$1`, [first.memory.id]);
      expect(await storeMemoryEmbeddingVector(f.app, first.memory.id, Array(768).fill(0.125), f.provider, original!)).toBe(false);
      await expect(f.app.query(`INSERT INTO memory_embeddings(memory_id,provider,dim,embedding) VALUES($1,$2,768,$3)`,
        [first.memory.id, f.provider.id, '[' + Array(768).fill(0.125).join(',') + ']'])).rejects.toMatchObject({ code: '23514' });
      const incoming = await captureMemory(f.app, f.router, f.principal, input(f, 'Expires during provider work'));
      const entered = deferred<void>(), release = deferred<void>();
      vi.mocked(f.adapter.invoke).mockImplementationOnce(async serialized => {
        entered.resolve(); await release.promise;
        const value = (JSON.parse(serialized).input as string[]).map(() => Array(768).fill(0.125));
        return { value, response: value };
      });
      const running = runWorker(f);
      await entered.promise;
      try { await f.owner.query(`UPDATE memories SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [incoming.memory.id]); }
      finally { release.resolve(); }
      expect(await running).toBe('unavailable');
      expect((await f.owner.query('SELECT count(*)::int AS n FROM memory_embeddings WHERE memory_id=$1', [incoming.memory.id])).rows[0].n).toBe(0);
      expect(await readEmbeddingStatus(f.app, f.actorId, incoming.memory.id)).toMatchObject({ embedded: false, embeddingStatus: 'cancelled' });
      expect(await store.release({ id: randomUUID(), owner: randomUUID(), generation: '1' } as never)).toBe(false);
    });
  }, 60000);

  it('rolls back derived vector/audit/completion together, then retries with retained original charges', async () => {
    await embeddingQueueFixture(async f => {
      const accepted = await captureMemory(f.app, f.router, f.principal, input(f), {}, { idempotencyKey: 'atomic-source-key' });
      await f.owner.query(`CREATE FUNCTION queue_test_reject_embedding_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Synthetic required audit failure'; END $$;
        REVOKE ALL ON FUNCTION queue_test_reject_embedding_audit() FROM PUBLIC;
        CREATE TRIGGER queue_test_reject_embedding_audit BEFORE INSERT ON audit_log FOR EACH ROW
          WHEN (NEW.metadata->>'operation'='embedding_completed') EXECUTE FUNCTION queue_test_reject_embedding_audit()`);
      try {
        expect(await runWorker(f)).toBe('unavailable');
        expect((await f.owner.query('SELECT count(*)::int AS n FROM memory_embeddings WHERE memory_id=$1', [accepted.memory.id])).rows[0].n).toBe(0);
        expect((await f.owner.query('SELECT count(*)::int AS n FROM embedding_completions')).rows[0].n).toBe(0);
        expect(await readEmbeddingStatus(f.app, f.actorId, accepted.memory.id)).toMatchObject({ embeddingStatus: 'retry_wait', embedded: false });
        expect((await f.owner.query('SELECT count(*)::int AS n FROM embedding_capture_receipts WHERE memory_id=$1', [accepted.memory.id])).rows[0].n).toBe(1);
        expect((await f.owner.query(`SELECT dispatches FROM embedding_dispatch_windows`)).rows[0].dispatches).toBe('1');
      } finally {
        await f.owner.query('DROP TRIGGER queue_test_reject_embedding_audit ON audit_log; DROP FUNCTION queue_test_reject_embedding_audit()');
      }
      await f.owner.query(`UPDATE embedding_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE memory_id=$1`, [accepted.memory.id]);
      await f.owner.query(`UPDATE embedding_provider_control SET next_probe_at=clock_timestamp()-interval '1 second'`);
      expect(await runWorker(f)).toBe('processed');
      expect((await f.owner.query('SELECT count(*)::int AS n FROM embedding_completions')).rows[0].n).toBe(1);
      expect((await f.owner.query('SELECT count(*)::int AS n FROM pipeline_budget_attempts')).rows[0].n).toBe(2);
      const original = (await f.owner.query(`SELECT count(DISTINCT workflow_id)::int AS workflows,
        count(DISTINCT deadline_at)::int AS deadlines,count(DISTINCT attempt_owner)::int AS owners FROM embedding_cohorts`)).rows[0];
      expect(original).toEqual({ workflows: 1, deadlines: 1, owners: 1 });
      const used = (await f.owner.query('SELECT used FROM pipeline_budget_workflows')).rows[0].used;
      expect(used.calls).toBe(2);
      expect(used.retries).toBe(1);
      expect(used.candidates).toBe(2);
      expect(used.hydratedBytes).toBe(2 * Buffer.byteLength(accepted.memory.title + '\n\n' + accepted.memory.body));
      expect((await f.owner.query('SELECT sum(dispatches)::text AS n FROM embedding_dispatch_windows')).rows[0].n).toBe('2');
      expect((await f.owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE memory_id=$1 AND metadata->>'operation'='embedding_completed'`, [accepted.memory.id])).rows[0].n).toBe(1);
    }, { windowSeconds: 86400 });
  }, 60000);

  it('does not renew an original in-window deadline after release or a worker restart', async () => {
    await embeddingQueueFixture(async f => {
      const accepted = await captureMemory(f.app, f.router, f.principal, input(f));
      const originalStore = new SqlEmbeddingJobStore(f.worker);
      const claim = (await originalStore.claim(f.target, f.policy, randomUUID(), 1, f.profile))!;
      expect(claim).not.toBeNull();
      await originalStore.hydrate(claim, 4194304);
      expect(await originalStore.release(claim)).toBe(true);
      const before = (await f.owner.query('SELECT deadline_at,used FROM pipeline_budget_workflows WHERE id=$1', [claim.workflowId])).rows[0];
      await new Promise(resolve => setTimeout(resolve, 1100));
      await f.owner.query(`UPDATE embedding_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE memory_id=$1`, [accepted.memory.id]);
      const replacementStore = new SqlEmbeddingJobStore(f.worker);
      expect(await replacementStore.claim(f.target, f.policy, randomUUID(), 1, f.profile)).toBeNull();
      expect((await f.owner.query('SELECT count(*)::int AS n FROM embedding_cohorts')).rows[0].n).toBe(1);
      expect((await f.owner.query('SELECT deadline_at,used FROM pipeline_budget_workflows WHERE id=$1', [claim.workflowId])).rows[0]).toEqual(before);
      expect(await readEmbeddingStatus(f.app, f.actorId, accepted.memory.id)).toMatchObject({ embeddingStatus: 'retry_wait', embedded: false });
    }, { windowSeconds: 86400, profile: { ...starterProfile, maxConcurrency: 1, overallMs: 1000, stageMs: 500 } });
  }, 60000);

  it('audits real operator controls atomically and makes same-policy reconciliation a budget-preserving no-op', async () => {
    await embeddingQueueFixture(async f => {
      const accepted = await captureMemory(f.app, f.router, f.principal, input(f));
      const control = async (operation: string) => (await f.operator.query(
        'SELECT continuum_operator_embedding_control($1,$2,$3,10) AS result', [f.adminId, operation, f.target.fingerprint])).rows[0].result;
      await f.owner.query(`CREATE FUNCTION queue_test_reject_control_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Synthetic required operator audit failure'; END $$;
        REVOKE ALL ON FUNCTION queue_test_reject_control_audit() FROM PUBLIC;
        CREATE TRIGGER queue_test_reject_control_audit BEFORE INSERT ON audit_log FOR EACH ROW
          WHEN (NEW.metadata->>'operation'='embedding_pause') EXECUTE FUNCTION queue_test_reject_control_audit()`);
      try {
        await expect(control('pause')).rejects.toThrow('Synthetic required operator audit failure');
        expect((await f.owner.query('SELECT state FROM embedding_provider_control')).rows[0].state).toBe('open');
      } finally {
        await f.owner.query('DROP TRIGGER queue_test_reject_control_audit ON audit_log; DROP FUNCTION queue_test_reject_control_audit()');
      }
      const store = new SqlEmbeddingJobStore(f.worker);
      await control('pause');
      expect(await store.claim(f.target, f.policy, randomUUID(), 1, f.profile)).toBeNull();
      await control('resume');
      const claim = (await store.claim(f.target, f.policy, randomUUID(), 1, f.profile))!;
      expect(claim).not.toBeNull();
      await store.hydrate(claim, 4194304);
      expect(await store.attempt(claim).reserve(amounts({ calls: 1, inputBytes: 1000, contextTokens: 1000, outputBytes: 4096 }), 5096)).toBe(true);
      expect(await store.attempt(claim).dispatch()).toBe(true);
      const leases = (await f.operator.query('SELECT continuum_operator_embedding_leases($1,$2,10) AS result', [f.adminId, f.target.fingerprint])).rows[0].result;
      expect(JSON.stringify(leases)).toContain(claim.id);
      await store.attempt(claim).settle({}, 'unknown');
      expect(await store.fail(claim, { code: 'EMBEDDING_STORAGE', action: 'retry' })).toBe(true);
      const snapshot = async () => ({
        source: (await f.owner.query('SELECT * FROM embedding_sources WHERE memory_id=$1', [accepted.memory.id])).rows,
        jobs: (await f.owner.query('SELECT * FROM embedding_jobs WHERE memory_id=$1 ORDER BY id', [accepted.memory.id])).rows,
        workflows: (await f.owner.query('SELECT * FROM pipeline_budget_workflows ORDER BY id')).rows,
        windows: (await f.owner.query('SELECT * FROM embedding_dispatch_windows ORDER BY id')).rows,
        attempts: (await f.owner.query('SELECT * FROM pipeline_budget_attempts ORDER BY attempt_id')).rows,
      });
      const original = await snapshot();
      expect(original.workflows[0].used.calls).toBe(1);
      for (let repeat = 0; repeat < 3; repeat++) expect(await control('reconcile')).toMatchObject({ processed: 0 });
      expect(await snapshot()).toEqual(original);
      expect((await f.operator.query('SELECT continuum_operator_embedding_metrics($1) AS result', [f.adminId])).rows[0].result)
        .toEqual(expect.arrayContaining([expect.objectContaining({ status: 'retry_wait', count: 1, attempts: 1 })]));
      // A genuinely changed, explicitly approved profile policy may reconcile
      // accepted work, while immutable old attempts/charges remain intact.
      await f.operator.query('SELECT continuum_operator_embedding_target($1,$2,$3,$4,TRUE)', [f.adminId, f.target, f.profile,
        { seconds: 86400, dispatches: 63, inputBytes: 16777216, tokens: 16777216, spendMicros: 0, rateSchedule: f.profile.rateSchedule }]);
      expect(await control('reconcile')).toMatchObject({ processed: 1 });
      const changed = await snapshot();
      expect(changed.jobs).toHaveLength(2);
      expect(changed.jobs.find(job => job.id === original.jobs[0].id)).toMatchObject({ state: 'superseded', workflow_id: claim.workflowId });
      expect(changed.source[0].generation).toBe(String(Number(original.source[0].generation) + 1));
      expect(changed.workflows[0]).toMatchObject({ cancelled: true, used: original.workflows[0].used });
      expect(changed.windows).toEqual(original.windows);
      expect(changed.attempts).toEqual(original.attempts);
      expect(await control('reconcile')).toMatchObject({ processed: 0 });
      expect(f.adapter.invoke).not.toHaveBeenCalled();
    }, { windowSeconds: 86400 });
  }, 60000);

  it('retains unknown original charges across rollover and admits later capacity only after original settlement', async () => {
    await embeddingQueueFixture(async f => {
      const phase = Number((await f.owner.query(`SELECT mod(extract(epoch FROM clock_timestamp())*1000,2000) AS phase`)).rows[0].phase);
      await new Promise(resolve => setTimeout(resolve, 2020 - phase));
      const accepted = await captureMemory(f.app, f.router, f.principal, input(f));
      const store = new SqlEmbeddingJobStore(f.worker);
      const first = (await store.claim(f.target, f.policy, randomUUID(), 1, f.profile))!;
      await store.hydrate(first, 4194304);
      const reserved = amounts({ calls: 1, inputBytes: 1000, contextTokens: 1000, outputBytes: 4096 });
      expect(await store.attempt(first).reserve(reserved, 5096)).toBe(true);
      expect(await store.attempt(first).dispatch()).toBe(true);
      expect(await store.fail(first, { code: 'EMBEDDING_NETWORK', action: 'retry' })).toBe(true);
      const oldWindow = (await f.owner.query('SELECT * FROM embedding_dispatch_windows')).rows[0];
      // Owner-only crash-fixture lease expiry is not evidence of provider settlement.
      await f.owner.query(`UPDATE embedding_cohorts SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, [first.id]);
      await f.owner.query(`UPDATE embedding_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE cohort_id=$1`, [first.id]);
      await new Promise(resolve => setTimeout(resolve, 2100));
      await f.owner.query(`UPDATE embedding_provider_control SET next_probe_at=clock_timestamp()-interval '1 second'`);
      expect(await new SqlEmbeddingJobStore(f.worker).claim(f.target, f.policy, randomUUID(), 1, f.profile)).toBeNull();
      expect((await f.owner.query('SELECT count(*)::int AS n FROM embedding_dispatch_windows')).rows[0].n).toBe(1);
      await store.attempt(first).settle({}, 'unknown');
      expect(await store.apply(first, [{ id: first.jobs[0].id, vector: Array(768).fill(0.125) }])).toBe(false);
      // First poll only requeues settled expired ownership with its backoff intact.
      expect(await store.claim(f.target, f.policy, randomUUID(), 1, f.profile)).toBeNull();
      await f.owner.query(`UPDATE embedding_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE memory_id=$1`, [accepted.memory.id]);
      const next = (await store.claim(f.target, f.policy, randomUUID(), 1, f.profile))!;
      expect(next.workflowId).not.toBe(first.workflowId);
      expect(next.attemptId).not.toBe(first.attemptId);
      expect(next.retry).toBe(false);
      expect((await f.owner.query('SELECT * FROM embedding_dispatch_windows WHERE id=$1', [oldWindow.id])).rows[0]).toEqual(oldWindow);
      const original = (await f.owner.query('SELECT used FROM pipeline_budget_workflows WHERE id=$1', [first.workflowId])).rows[0].used;
      expect(original).toMatchObject({ calls: 1, contextTokens: 1000, inputBytes: 1000 });
      expect((await f.owner.query('SELECT state,settlement FROM pipeline_budget_attempts WHERE workflow_id=$1', [first.workflowId])).rows[0])
        .toEqual({ state: 'settled', settlement: { provenance: 'unknown' } });
      await store.hydrate(next, 4194304);
      expect(await store.attempt(next).reserve(reserved, 5096)).toBe(true);
      expect(await store.attempt(next).dispatch()).toBe(true);
      await store.attempt(next).settle({}, 'unknown');
      expect(await store.apply(next, [{ id: next.jobs[0].id, vector: Array(768).fill(0.125) }])).toBe(true);
      expect(await readEmbeddingStatus(f.app, f.actorId, accepted.memory.id)).toMatchObject({ embeddingStatus: 'ready', embedded: true });
      expect((await f.owner.query('SELECT count(*)::int AS n FROM pipeline_budget_workflows')).rows[0].n).toBe(2);
    }, { windowSeconds: 2, profile: { ...starterProfile, maxConcurrency: 1,
      limits: { ...starterProfile.limits, calls: 1, retries: 0 } } });
  }, 60000);

  it('bisects explicit failed batches under one original allowance and requires a healthy diagnostic control', async () => {
    await embeddingQueueFixture(async f => {
      const healthy = await captureMemory(f.app, f.router, f.principal, input(f, 'Healthy control'));
      const poison = await captureMemory(f.app, f.router, f.principal, input(f, 'Explicit poison'));
      vi.mocked(f.adapter.invoke).mockImplementation(async serialized => {
        const texts = (JSON.parse(serialized).input as string[]);
        if (texts.some(text => text.includes('Explicit poison'))) throw new EmbeddingItemError('Synthetic explicit fixture rejection');
        const value = texts.map(() => Array(768).fill(0.125));
        return { value, response: value };
      });
      for (let iteration = 0; iteration < 4; iteration++) {
        await runWorker(f);
        await f.owner.query(`UPDATE embedding_jobs SET available_at=available_at-interval '5 minutes' WHERE state='retry_wait'`);
        await f.owner.query(`UPDATE embedding_provider_control SET next_probe_at=clock_timestamp()-interval '1 second'`);
      }
      expect(await readEmbeddingStatus(f.app, f.actorId, healthy.memory.id)).toMatchObject({ embeddingStatus: 'ready', embedded: true });
      expect(await readEmbeddingStatus(f.app, f.actorId, poison.memory.id)).toMatchObject({ embeddingStatus: 'permanent_failure', embedded: false });
      expect((await f.owner.query('SELECT count(DISTINCT workflow_id)::int AS n FROM embedding_cohorts')).rows[0].n).toBe(1);
      const calls = vi.mocked(f.adapter.invoke).mock.calls;
      expect(calls.length).toBeLessThanOrEqual(4);
      expect((JSON.parse(calls[0][0]).input as string[])).toHaveLength(2);
      for (const call of calls.slice(1)) expect((JSON.parse(call[0]).input as string[])).toHaveLength(1);
    }, { windowSeconds: 86400 });
  }, 60000);

  it('keeps an all-failing explicit diagnostic tree retryable without renewing its original call allowance', async () => {
    await embeddingQueueFixture(async f => {
      await captureMemory(f.app, f.router, f.principal, input(f, 'Ambiguous poison A'));
      await captureMemory(f.app, f.router, f.principal, input(f, 'Ambiguous poison B'));
      vi.mocked(f.adapter.invoke).mockRejectedValue(new EmbeddingItemError('No successful control'));
      for (let iteration = 0; iteration < 6; iteration++) {
        await runWorker(f);
        await f.owner.query(`UPDATE embedding_jobs SET available_at=available_at-interval '5 minutes' WHERE state='retry_wait'`);
        await f.owner.query(`UPDATE embedding_provider_control SET next_probe_at=clock_timestamp()-interval '1 second'`);
      }
      expect(f.adapter.invoke).toHaveBeenCalledTimes(4);
      expect((await f.owner.query(`SELECT count(*)::int AS n FROM embedding_jobs WHERE state='permanent_failure'`)).rows[0].n).toBe(0);
      expect((await f.owner.query(`SELECT count(*)::int AS n FROM embedding_jobs WHERE state='retry_wait'`)).rows[0].n).toBe(2);
      expect((await f.owner.query('SELECT used FROM pipeline_budget_workflows')).rows[0].used).toMatchObject({ calls: 4, retries: 3 });
      expect((await f.owner.query('SELECT state,failures FROM embedding_provider_control')).rows[0]).toMatchObject({ state: 'open' });
      expect(await runWorker(f)).toBe('idle');
    }, { windowSeconds: 86400 });
  }, 60000);

  it('includes queue hashes, receipts, routes and vectors in real approved offboarding proof', async () => {
    await embeddingQueueFixture(async f => {
      const accepted = await captureMemory(f.app, f.router, f.principal, input(f), {}, { idempotencyKey: 'erase-this-key' });
      expect(await runWorker(f)).toBe('processed');
      const admin = (await getPrincipal(f.operator, f.adminId))!;
      await mapOwnedUserScope(f.operator, admin, f.actorId, f.scopeId, true);
      let result = await offboardPrincipal(f.operator, admin, f.actorId, { confirmationScopeId: f.scopeId, batchSize: 100 });
      for (let iteration = 0; !result.complete && iteration < 10; iteration++) {
        result = await offboardPrincipal(f.operator, admin, f.actorId, { confirmationScopeId: f.scopeId, batchSize: 100 });
      }
      expect(result.complete).toBe(true);
      expect((await f.owner.query('SELECT continuum_embedding_scope_is_erased($1) AS clean', [f.scopeId])).rows[0].clean).toBe(true);
      expect((await f.owner.query('SELECT count(*)::int AS n FROM memory_embeddings WHERE memory_id=$1', [accepted.memory.id])).rows[0].n).toBe(0);
      expect((await f.owner.query(`SELECT count(*)::int AS n FROM embedding_capture_receipts WHERE key_hash IS NOT NULL OR payload_digest IS NOT NULL`)).rows[0].n).toBe(0);
      expect((await f.owner.query(`SELECT count(*)::int AS n FROM embedding_sources WHERE input_hash IS NOT NULL OR current_target IS NOT NULL`)).rows[0].n).toBe(0);
      expect(await readEmbeddingStatus(f.app, f.actorId, accepted.memory.id)).toBeNull();
      await expect(captureMemory(f.app, f.router, f.principal, input(f), {}, { idempotencyKey: 'erase-this-key' })).rejects.toMatchObject({ code: 'SCOPE_NOT_FOUND' });
      expect(await runWorker(f)).toBe('idle');
    });
  }, 60000);

  it('preserves existing replay and rolls back new source/audit/job writes at real receipt and active-scope capacity', async () => {
    await embeddingQueueFixture(async f => {
      const accepted = await captureMemory(f.app, f.router, f.principal, input(f), {}, { idempotencyKey: 'capacity-original' });
      // Owner-only metadata fixture fills the real retained-receipt table; no
      // quota/counter/constraint is altered and no private source copies exist.
      await f.owner.query(`INSERT INTO embedding_capture_receipts(principal_id,scope_id,key_hash,payload_digest,memory_id)
        SELECT $1,$2,encode(sha256(convert_to('receipt-capacity-'||n,'UTF8')),'hex'),repeat('a',64),$3
          FROM generate_series(1,9999) n`, [f.actorId, f.scopeId, accepted.memory.id]);
      const counts = async () => (await f.owner.query(`SELECT (SELECT count(*)::int FROM memories) memories,
        (SELECT count(*)::int FROM embedding_jobs) jobs,(SELECT count(*)::int FROM embedding_capture_receipts) receipts,
        (SELECT count(*)::int FROM audit_log WHERE action='write' AND memory_id IS NOT NULL) writes`)).rows[0];
      const beforeReceipts = await counts();
      expect(beforeReceipts.receipts).toBe(10000);
      await expect(captureMemory(f.app, f.router, f.principal, input(f, 'Receipt capacity refusal'), {}, { idempotencyKey: 'capacity-next' }))
        .rejects.toMatchObject({ code: 'EMBEDDING_RECEIPT_QUOTA_EXCEEDED' });
      expect(await counts()).toEqual(beforeReceipts);
      expect(await captureMemory(f.app, f.router, f.principal, input(f), {}, { idempotencyKey: 'capacity-original' }))
        .toMatchObject({ replayed: true, embedded: false, embeddingStatus: 'queued' });
      // Seed actual current sources and enqueue using the real APP capability,
      // in bounded batches below the unchanged five-second SQL ceiling.
      const prefix = 'scope-capacity-' + randomUUID();
      for (let offset = 0; offset < 9998; offset += 100) {
        const batch = Math.min(100, 9998-offset), reference = prefix + '-' + offset;
        await f.app.query(`INSERT INTO memories(id,scope_id,type,title,body,author_id,source,source_ref,expires_at)
          SELECT gen_random_uuid(),$1,'fact','Capacity fixture','Bounded synthetic source',$2,'manual',$3,$5 FROM generate_series(1,$4::int)`,
          [f.scopeId, f.actorId, reference, batch, computeExpiry('fact', f.scope.kind)]);
        expect((await f.app.query(`SELECT count(continuum_embedding_enqueue($1,id,$2,$3,'queued'))::int AS n
          FROM memories WHERE source_ref=$4`, [f.actorId, f.target, f.policy, reference])).rows[0].n).toBe(batch);
      }
      const concurrent = new pg.Pool({ connectionString: f.app.options.connectionString, options: f.app.options.options,
        max: 2, connectionTimeoutMillis: 5000 });
      try {
        const race = await Promise.allSettled(['A','B'].map(label => captureMemory(concurrent, f.router, f.principal, input(f, 'Last capacity slot '+label))));
        expect(race.filter(result => result.status==='fulfilled')).toHaveLength(1);
        expect(race.filter(result => result.status==='rejected')).toMatchObject([{ reason: { code: 'EMBEDDING_QUEUE_QUOTA_EXCEEDED' } }]);
      } finally { await concurrent.end(); }
      const beforeQueue = await counts();
      expect(beforeQueue.jobs).toBe(10000);
      expect((await f.owner.query('SELECT active FROM embedding_scope_admission WHERE scope_id=$1', [f.scopeId])).rows[0].active).toBe(10000);
      await expect(captureMemory(f.app, f.router, f.principal, input(f, 'Scope capacity refusal')))
        .rejects.toMatchObject({ code: 'EMBEDDING_QUEUE_QUOTA_EXCEEDED' });
      expect(await counts()).toEqual(beforeQueue);
      expect(f.provider.embed).not.toHaveBeenCalled();
      expect(f.adapter.invoke).not.toHaveBeenCalled();
    });
  }, 60000);
});
