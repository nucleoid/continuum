import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { embeddingQueueFixture } from '../embeddings/test-helpers.js';
import { staticEmbeddingRouter } from '../embeddings/router.js';
import { memoryEmbeddingText } from '../embeddings/text.js';
import { captureMemory } from '../services/capture.js';
import { processEmbeddingJobs } from '../workers/embedding-jobs.js';
import { SqlEmbeddingJobStore } from './embedding-jobs.js';
import { computeExpiry } from './expiry.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import type { CaptureInput } from '../types.js';

type Fixture = Parameters<Parameters<typeof embeddingQueueFixture>[0]>[0];
const input = (f: Fixture, title: string): CaptureInput => ({ scope: { kind: f.scope.kind, name: f.scope.name },
  type: 'fact', title, body: 'Synthetic bounded queue capacity source.', source: 'manual' });
const run = (f: Fixture) => processEmbeddingJobs(new SqlEmbeddingJobStore(f.worker), f.target,
  f.policy, f.provider, f.profile, randomUUID());

it('drains admitted work at the real scope cap when an edited completed source needs another job', async () => {
  await embeddingQueueFixture(async f => {
    const completed = await captureMemory(f.app, f.router, f.principal, input(f, 'Completed before saturation'));
    expect(await run(f)).toBe('processed');
    await f.app.query("UPDATE memories SET body=body||' Edited source.' WHERE id=$1", [completed.memory.id]);
    const prefix = 'full-progress-' + randomUUID();
    for (let offset = 0; offset < 10000; offset += 100) {
      const reference = prefix + '-' + offset;
      // Real APP source triggers and enqueue admission, no fabricated counters.
      await f.app.query(`INSERT INTO memories(id,scope_id,type,title,body,author_id,source,source_ref,expires_at)
        SELECT gen_random_uuid(),$1,'fact','Pending capacity source','Synthetic queued body',$2,'manual',$3,$4 FROM generate_series(1,100)`,
      [f.scopeId, f.actorId, reference, computeExpiry('fact', f.scope.kind)]);
      expect((await f.app.query(`SELECT count(continuum_embedding_enqueue($1,id,$2,$3,'queued'))::int AS n
        FROM memories WHERE source_ref=$4`, [f.actorId, f.target, f.policy, reference])).rows[0].n).toBe(100);
    }
    expect((await f.owner.query('SELECT active FROM embedding_scope_admission WHERE scope_id=$1', [f.scopeId])).rows[0].active).toBe(10000);
    await expect(captureMemory(f.app, f.router, f.principal, input(f, 'No cap exemption')))
      .rejects.toMatchObject({ code: 'EMBEDDING_QUEUE_QUOTA_EXCEEDED' });
    // Eight fixture vectors fit both the 131072-byte adapter response cap
    // and the pipeline serializer's 10000-node bound (6153 nodes).
    const boundedProvider = { ...f.provider, batchSize: 8 };
    const store = new SqlEmbeddingJobStore(f.worker);
    const claims = vi.spyOn(store, 'claim');
    const hydrations = vi.spyOn(store, 'hydrate');
    const completions = vi.spyOn(store, 'apply');
    const failures = vi.spyOn(store, 'fail');
    const outcome = await processEmbeddingJobs(store, f.target, f.policy, boundedProvider, f.profile, randomUUID());
    const claimResults = await Promise.allSettled(claims.mock.results.map(result => result.value));
    expect(outcome, JSON.stringify({
      claims: claimResults.map(result => result.status === 'rejected' ? { error: result.reason?.code, message: result.reason?.message }
        : { jobs: result.value?.jobs.length, remainingMs: result.value?.remainingMs }),
      hydrations: hydrations.mock.calls.length, completions: completions.mock.calls.length,
      failures: failures.mock.calls.map(call => call[1]), providerCalls: vi.mocked(f.adapter.invoke).mock.calls.length,
    })).toBe('processed');
    expect((await f.owner.query(`SELECT active,(SELECT count(*)::int FROM embedding_jobs j WHERE j.scope_id=$1
      AND j.state IN ('queued','processing','retry_wait','blocked_policy')) AS actual FROM embedding_scope_admission WHERE scope_id=$1`, [f.scopeId])).rows)
      .toEqual([{ active: 9992, actual: 9992 }]);
    expect((await f.owner.query('SELECT state FROM embedding_jobs WHERE memory_id=$1', [completed.memory.id])).rows)
      .toEqual([{ state: 'ready' }]);
    expect((await f.owner.query('SELECT status FROM embedding_sources WHERE memory_id=$1', [completed.memory.id])).rows[0].status).toBe('superseded');
    expect(f.adapter.invoke).toHaveBeenCalledTimes(2);
  });
}, 60000);

it('filters a disabled binding principal before the prefix while another approved scope on the same LOGIN progresses', async () => {
  await embeddingQueueFixture(async f => {
    const other = await createScope(f.owner, { kind: 'project', name: 'healthy-binding-' + randomUUID() });
    const service = await createPrincipal(f.owner, { externalId: randomUUID(), kind: 'service', displayName: 'Healthy embedding worker' });
    await addMembership(f.owner, f.actorId, other.id, 'writer');
    await addMembership(f.owner, f.adminId, other.id, 'writer');
    await f.operator.query('SELECT continuum_operator_bind_embedding_worker($1,$2,$3,$4,$5,TRUE)',
      [f.adminId, f.workerRole, service.id, other.id, f.target.fingerprint]);
    const routing = (await f.owner.query('SELECT routing FROM embedding_policy WHERE singleton')).rows[0].routing;
    routing.scopes[other.id] = { target: f.target.fingerprint, localOnly: false };
    const policy = (await f.operator.query('SELECT continuum_operator_embedding_policy($1,$2,$3) AS policy',
      [f.adminId, routing, createHash('sha256').update(JSON.stringify(routing)).digest('hex')])).rows[0].policy;
    const router = Object.assign(staticEmbeddingRouter(f.provider), { queuePolicy: policy });
    const unavailable = await captureMemory(f.app, router, f.principal, input(f, 'Disabled bound worker source'));
    const healthy = await captureMemory(f.app, router, f.principal,
      { ...input(f, 'Healthy bound worker source'), scope: { kind: other.kind, name: other.name } });
    await f.owner.query('UPDATE principals SET disabled_at=clock_timestamp() WHERE id=$1', [f.producerId]);
    await f.owner.query("UPDATE embedding_jobs SET available_at=clock_timestamp()-interval '1 hour' WHERE memory_id=$1", [unavailable.memory.id]);
    const claim = await new SqlEmbeddingJobStore(f.worker).claim(f.target, policy, randomUUID(), 1, f.profile);
    expect(claim?.jobs.map(job => job.memoryId)).toEqual([healthy.memory.id]);
    expect(f.adapter.invoke).not.toHaveBeenCalled();
  });
}, 60000);

it('stops before hydration when a real finite synthetic-priced window has retained its complete cost allowance', async () => {
  await embeddingQueueFixture(async f => {
    const firstInput = input(f, 'Priced source one');
    const cost = Buffer.byteLength(JSON.stringify({ input: [memoryEmbeddingText(firstInput)] }));
    const profile = { ...f.profile, rateSchedule: 'fixture-priced-v1', limits: { ...f.profile.limits, spendMicros: 1000000 } };
    const provider = { ...f.provider, pipelineAdapter: { ...f.adapter,
      price: { id: profile.rateSchedule, currency: 'USD', unitTokens: 1, inputMicros: 1, outputMicros: 0, reasoningMicros: 0 } } };
    // Explicit OP-approved finite local synthetic pricing, never a paid probe.
    await f.operator.query('SELECT continuum_operator_embedding_target($1,$2,$3,$4,TRUE)', [f.adminId, f.target, profile,
      { seconds: 86400, dispatches: 64, inputBytes: 16777216, tokens: 16777216, spendMicros: cost, rateSchedule: profile.rateSchedule }]);
    const policy = (await f.owner.query('SELECT generation::text AS generation,digest FROM embedding_policy WHERE singleton')).rows[0];
    const router = Object.assign(staticEmbeddingRouter(provider), { queuePolicy: policy });
    const store = new SqlEmbeddingJobStore(f.worker);
    const hydrate = vi.spyOn(store, 'hydrate');
    await captureMemory(f.app, router, f.principal, firstInput);
    expect(f.adapter.invoke).not.toHaveBeenCalled();
    expect(await processEmbeddingJobs(store, f.target, policy, provider, profile, randomUUID())).toBe('processed');
    const window = (await f.owner.query('SELECT * FROM embedding_dispatch_windows')).rows[0];
    expect(Number(window.cost_micros)).toBe(cost);
    expect(Number(window.max_cost_micros)).toBe(cost);
    const original = (await f.owner.query('SELECT id,used FROM pipeline_budget_workflows')).rows;
    const cohorts = (await f.owner.query('SELECT count(*)::int AS n FROM embedding_cohorts')).rows[0].n;
    hydrate.mockClear();
    await captureMemory(f.app, router, f.principal, input(f, 'Priced source two'));
    expect(await processEmbeddingJobs(store, f.target, policy, provider, profile, randomUUID())).toBe('idle');
    expect(hydrate).not.toHaveBeenCalled();
    expect(f.adapter.invoke).toHaveBeenCalledTimes(1);
    expect((await f.owner.query('SELECT id,used FROM pipeline_budget_workflows')).rows).toEqual(original);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM embedding_cohorts')).rows[0].n).toBe(cohorts);
    expect((await f.owner.query('SELECT * FROM embedding_dispatch_windows')).rows).toEqual([window]);
    expect((await f.owner.query('SELECT state,failures FROM embedding_provider_control')).rows)
      .toEqual([{ state: 'closed', failures: '0' }]);
  }, { windowSeconds: 86400 });
}, 60000);
