import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { embeddingQueueFixture } from '../embeddings/test-helpers.js';
import { staticEmbeddingRouter } from '../embeddings/router.js';
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
    expect(await run(f)).toBe('processed');
    expect((await f.owner.query(`SELECT active,(SELECT count(*)::int FROM embedding_jobs j WHERE j.scope_id=$1
      AND j.state IN ('queued','processing','retry_wait','blocked_policy')) AS actual FROM embedding_scope_admission WHERE scope_id=$1`, [f.scopeId])).rows)
      .toEqual([{ active: 9968, actual: 9968 }]);
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
