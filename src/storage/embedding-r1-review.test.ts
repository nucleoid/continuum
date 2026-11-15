import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { embeddingQueueFixture } from '../embeddings/test-helpers.js';
import { captureMemory } from '../services/capture.js';
import { processEmbeddingJobs } from '../workers/embedding-jobs.js';
import { SqlEmbeddingJobStore, readEmbeddingStatus } from './embedding-jobs.js';
import { verifyMemoryWithAudit } from './promote.js';
import type { CaptureInput } from '../types.js';
import type { EmbeddingAttemptFailure } from './embedding-jobs-model.js';

type Fixture = Parameters<Parameters<typeof embeddingQueueFixture>[0]>[0];
const input = (f: Fixture, title: string): CaptureInput => ({
  scope: { kind: f.scope.kind, name: f.scope.name }, type: 'fact', title,
  body: 'Synthetic source; no hosted provider or live data.', source: 'manual',
});

it('claims healthy work behind a full prefix whose external proof expired without a source update', async () => {
  await embeddingQueueFixture(async f => {
    const blocked: string[] = [];
    for (let index = 0; index < 32; index++) {
      const accepted = await captureMemory(f.app, f.router, f.principal, input(f, `Lapsed proof ${index}`));
      blocked.push(accepted.memory.id);
      await f.owner.query('SELECT continuum_evidence_source($1,$2)', [f.actorId, accepted.memory.id]);
    }
    // Actual durable evidence transition invalidates old jobs. Install a future
    // proof, reconcile through real OP authority, then let database time expire it.
    await f.owner.query(`UPDATE evidence_roots SET external_state='allow',checked_at=clock_timestamp(),
      valid_until=clock_timestamp()+interval '5 seconds' WHERE source_memory_id=ANY($1::uuid[])`, [blocked]);
    expect((await f.operator.query('SELECT continuum_operator_embedding_control($1,$2,$3,1000) AS result',
      [f.adminId, 'reconcile', f.target.fingerprint])).rows[0].result.processed).toBe(32);
    await f.owner.query(`UPDATE embedding_jobs SET available_at=clock_timestamp()-interval '1 hour'
      WHERE memory_id=ANY($1::uuid[]) AND state='queued'`, [blocked]);
    const healthy = await captureMemory(f.app, f.router, f.principal, input(f, 'Healthy trailing source'));
    const remaining = Number((await f.owner.query(`SELECT greatest(0,extract(epoch FROM
      (max(valid_until)-clock_timestamp()))*1000) AS milliseconds FROM evidence_roots
      WHERE source_memory_id=ANY($1::uuid[])`, [blocked])).rows[0].milliseconds);
    expect(remaining).toBeGreaterThan(0);
    await new Promise(resolve => setTimeout(resolve, remaining + 50));
    expect((await f.owner.query(`SELECT bool_and(valid_until<=clock_timestamp()) AS expired
      FROM evidence_roots WHERE source_memory_id=ANY($1::uuid[])`, [blocked])).rows[0].expired).toBe(true);
    const claimed = await new SqlEmbeddingJobStore(f.worker).claim(f.target, f.policy, randomUUID(), 32, f.profile);
    expect(claimed?.jobs.map(job => job.memoryId)).toEqual([healthy.memory.id]);
    expect(f.adapter.invoke).not.toHaveBeenCalled();
  }, { windowSeconds: 86400 });
}, 60000);

it('keeps an exact current vector through successful verification with unchanged title and body', async () => {
  await embeddingQueueFixture(async f => {
    const accepted = await captureMemory(f.app, f.router, f.principal, input(f, 'Already embedded fact'));
    expect(await processEmbeddingJobs(new SqlEmbeddingJobStore(f.worker), f.target, f.policy,
      f.provider, f.profile, randomUUID())).toBe('processed');
    const before = (await f.owner.query(`SELECT embedding::text AS vector,space_fingerprint
      FROM memory_embeddings WHERE memory_id=$1`, [accepted.memory.id])).rows[0];
    expect(before).toBeDefined();
    const calls = vi.mocked(f.adapter.invoke).mock.calls.length;
    const verified = await verifyMemoryWithAudit(f.app, f.actorId, accepted.memory.id, true);
    expect(verified.title).toBe(accepted.memory.title);
    expect(verified.body).toBe(accepted.memory.body);
    expect((await f.owner.query(`SELECT embedding::text AS vector,space_fingerprint
      FROM memory_embeddings WHERE memory_id=$1`, [accepted.memory.id])).rows).toEqual([before]);
    expect(await readEmbeddingStatus(f.app, f.actorId, accepted.memory.id)).toMatchObject({ embedded: true, embeddingStatus: 'ready' });
    expect(vi.mocked(f.adapter.invoke).mock.calls.length).toBe(calls);
  });
}, 60000);

it.each(['EMBEDDING_STORAGE', 'EMBEDDING_BUDGET', 'EMBEDDING_POLICY', 'EMBEDDING_CANCELLED'] as const)(
  'does not classify %s as provider outage', async code => {
    await embeddingQueueFixture(async f => {
      await captureMemory(f.app, f.router, f.principal, input(f, 'Non-provider retry'));
      const store = new SqlEmbeddingJobStore(f.worker);
      const claim = (await store.claim(f.target, f.policy, randomUUID(), 1, f.profile))!;
      expect(claim).not.toBeNull();
      const failure: EmbeddingAttemptFailure = { code, action: 'retry' };
      expect(await store.fail(claim, failure)).toBe(true);
      expect((await f.owner.query('SELECT state,failures FROM embedding_provider_control')).rows)
        .toEqual([{ state: 'closed', failures: '0' }]);
      expect((await f.owner.query('SELECT state FROM embedding_jobs')).rows).toEqual([{ state: 'retry_wait' }]);
      expect(f.adapter.invoke).not.toHaveBeenCalled();
    });
  }, 60000,
);

it('still opens provider-wide backoff on an actual classified network failure', async () => {
  await embeddingQueueFixture(async f => {
    await captureMemory(f.app, f.router, f.principal, input(f, 'Provider outage control'));
    const store = new SqlEmbeddingJobStore(f.worker);
    const claim = (await store.claim(f.target, f.policy, randomUUID(), 1, f.profile))!;
    expect(await store.fail(claim, { code: 'EMBEDDING_NETWORK', action: 'retry' })).toBe(true);
    expect((await f.owner.query('SELECT state,failures FROM embedding_provider_control')).rows)
      .toEqual([{ state: 'open', failures: '1' }]);
  });
}, 60000);

it('does not increment admission counters when an actual APP repeats the same enqueue identity', async () => {
  await embeddingQueueFixture(async f => {
    const accepted = await captureMemory(f.app, f.router, f.principal, input(f, 'One original job'));
    const counts = async () => (await f.owner.query(`SELECT
      (SELECT count(*)::int FROM embedding_jobs) AS jobs,
      (SELECT active FROM embedding_admission WHERE singleton) AS installation,
      (SELECT active FROM embedding_scope_admission WHERE scope_id=$1) AS scope`, [f.scopeId])).rows[0];
    expect(await counts()).toEqual({ jobs: 1, installation: 1, scope: 1 });
    for (let repeat = 0; repeat < 2; repeat++) {
      expect((await f.app.query('SELECT continuum_embedding_enqueue($1,$2,$3,$4,$5) AS status',
        [f.actorId, accepted.memory.id, f.target, f.policy, 'queued'])).rows[0].status).toBe('queued');
    }
    expect(await counts()).toEqual({ jobs: 1, installation: 1, scope: 1 });
    expect((await f.app.query('SELECT continuum_embedding_is_ready() AS ready')).rows[0].ready).toBe(true);
    expect(f.adapter.invoke).not.toHaveBeenCalled();
  });
}, 60000);

it('does not change source freshness or erase newer server-owned related metadata on worker completion', async () => {
  await embeddingQueueFixture(async f => {
    const accepted = await captureMemory(f.app, f.router, f.principal, input(f, 'Original source freshness'));
    const candidate = await captureMemory(f.app, f.router, f.principal, input(f, 'Server relation candidate'));
    const related = [{ memoryId: candidate.memory.id, relation: 'similar', score: 0.7 }];
    await f.owner.query(`UPDATE memories SET updated_at=clock_timestamp()-interval '1 hour',
      metadata=jsonb_set(metadata,ARRAY['related'],$2::jsonb) WHERE id=$1`, [accepted.memory.id, JSON.stringify(related)]);
    const before = (await f.owner.query('SELECT updated_at,metadata FROM memories WHERE id=$1', [accepted.memory.id])).rows[0];
    expect(await processEmbeddingJobs(new SqlEmbeddingJobStore(f.worker), f.target, f.policy,
      f.provider, f.profile, randomUUID())).toBe('processed');
    expect((await f.owner.query('SELECT updated_at,metadata FROM memories WHERE id=$1', [accepted.memory.id])).rows)
      .toEqual([before]);
    expect(await readEmbeddingStatus(f.app, f.actorId, accepted.memory.id)).toMatchObject({ embedded: true, embeddingStatus: 'ready' });
  });
}, 60000);
