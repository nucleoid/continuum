import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { embeddingQueueFixture } from '../embeddings/test-helpers.js';
import { EmbeddingItemError, EmbeddingProviderError } from '../embeddings/provider.js';
import { staticEmbeddingRouter } from '../embeddings/router.js';
import { captureOne, captureMemory } from '../services/capture.js';
import { processEmbeddingJobs } from '../workers/embedding-jobs.js';
import { SqlEmbeddingJobStore, readEmbeddingStatus } from './embedding-jobs.js';
import type { CaptureInput } from '../types.js';

type Fixture = Parameters<Parameters<typeof embeddingQueueFixture>[0]>[0];
const input = (f: Fixture, title: string): CaptureInput => ({ scope: { kind: f.scope.kind, name: f.scope.name },
  type: 'fact', title, body: 'Synthetic diagnostic boundary source.', source: 'manual' });
const run = (f: Fixture, store = new SqlEmbeddingJobStore(f.worker)) => processEmbeddingJobs(store, f.target,
  f.policy, f.provider, f.profile, randomUUID());

it('tries an untested healthy diagnostic sibling before declaring a failed singleton provider-wide outage', async () => {
  await embeddingQueueFixture(async f => {
    const bad = await captureMemory(f.app, f.router, f.principal, input(f, 'Bad first diagnostic'));
    const healthy = await captureMemory(f.app, f.router, f.principal, input(f, 'Healthy second diagnostic'));
    vi.mocked(f.adapter.invoke).mockImplementation(async wire => {
      const texts = JSON.parse(wire).input as string[];
      if (texts.some(text => text.includes('Bad first diagnostic'))) throw new EmbeddingItemError('Synthetic explicit rejection');
      const value = texts.map(() => Array(768).fill(0.125)); return { value, response: value };
    });
    expect(await run(f)).toBe('unavailable');
    await f.owner.query(`UPDATE embedding_jobs SET available_at=CASE WHEN memory_id=$1 THEN clock_timestamp()-interval '1 second'
      ELSE clock_timestamp()+interval '1 minute' END WHERE state='retry_wait'`, [bad.memory.id]);
    expect(await run(f)).toBe('unavailable');
    expect((await f.owner.query('SELECT state,failures FROM embedding_provider_control')).rows)
      .toEqual([{ state: 'closed', failures: '0' }]);
    // Advance only job availability. No owner reset of provider circuit state,
    // next_probe_at, original workflow or any retained allowance.
    await f.owner.query(`UPDATE embedding_jobs SET available_at=CASE WHEN memory_id=$1 THEN clock_timestamp()-interval '1 second'
      ELSE clock_timestamp()+interval '1 minute' END WHERE state='retry_wait'`, [healthy.memory.id]);
    expect(await run(f)).toBe('processed');
    expect(await readEmbeddingStatus(f.app, f.actorId, healthy.memory.id)).toMatchObject({ embedded: true });
    await f.owner.query("UPDATE embedding_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE memory_id=$1", [bad.memory.id]);
    expect(await run(f)).toBe('unavailable');
    expect(await readEmbeddingStatus(f.app, f.actorId, bad.memory.id)).toMatchObject({ embeddingStatus: 'permanent_failure' });
    expect(f.adapter.invoke).toHaveBeenCalledTimes(4);
    expect((await f.owner.query('SELECT count(DISTINCT workflow_id)::int AS n FROM embedding_cohorts')).rows[0].n).toBe(1);
  }, { windowSeconds: 86400 });
}, 60000);

it('does not allocate provider budget-window history for empty idle polls', async () => {
  await embeddingQueueFixture(async f => {
    for (let i = 0; i < 3; i++) expect(await run(f)).toBe('idle');
    expect((await f.owner.query('SELECT count(*)::int AS n FROM embedding_dispatch_windows')).rows[0].n).toBe(0);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM pipeline_budget_workflows')).rows[0].n).toBe(0);
    expect(f.adapter.invoke).not.toHaveBeenCalled();
  });
}, 60000);

it('permits at most 64 actual diagnostic attempts in a later approved window without counting a nonexistent new initial batch', async () => {
  await embeddingQueueFixture(async f => {
    const profile = { ...f.profile, overallMs: 300000,
      limits: { ...f.profile.limits, calls: 128, retries: 128, outputBytes: 16 * 1024 * 1024 } };
    await f.operator.query('SELECT continuum_operator_embedding_target($1,$2,$3,$4,TRUE)', [f.adminId, f.target, profile,
      { seconds: 60, dispatches: 128, inputBytes: 16777216, tokens: 16777216, spendMicros: 0, rateSchedule: profile.rateSchedule }]);
    f.profile = profile;
    f.policy = (await f.owner.query('SELECT generation::text AS generation,digest FROM embedding_policy WHERE singleton')).rows[0];
    f.router = Object.assign(staticEmbeddingRouter(f.provider), { queuePolicy: f.policy });
    const primary = await captureMemory(f.app, f.router, f.principal, input(f, 'Primary diagnostic window'));
    await captureMemory(f.app, f.router, f.principal, input(f, 'Other untested diagnostic'));
    vi.mocked(f.adapter.invoke).mockRejectedValue(new EmbeddingProviderError('EMBEDDING_NETWORK', 'Synthetic local network failure'))
      .mockRejectedValueOnce(new EmbeddingItemError('Synthetic explicit initial split'));
    expect(await run(f)).toBe('unavailable');
    const oldWindow = (await f.owner.query('SELECT * FROM embedding_dispatch_windows')).rows[0];
    const wait = Number((await f.owner.query('SELECT greatest(0,extract(epoch FROM (ends_at-clock_timestamp()))*1000) AS ms FROM embedding_dispatch_windows WHERE id=$1', [oldWindow.id])).rows[0].ms);
    await new Promise(resolve => setTimeout(resolve, wait + 30));
    const store = new SqlEmbeddingJobStore(f.worker);
    const hydrate = vi.spyOn(store, 'hydrate');
    const schedule = async () => {
      // Scheduler-time fixtures only; all durable original charges, attempts,
      // workflow deadlines and current approved policy remain untouched.
      await f.owner.query(`UPDATE embedding_jobs SET available_at=CASE WHEN memory_id=$1 THEN clock_timestamp()-interval '1 second'
        ELSE clock_timestamp()+interval '1 hour' END WHERE state='retry_wait'`, [primary.memory.id]);
      await f.owner.query("UPDATE embedding_provider_control SET next_probe_at=clock_timestamp()-interval '1 second'");
    };
    for (let i = 0; i < 64; i++) { await schedule(); expect(await run(f, store)).toBe('unavailable'); }
    expect(f.adapter.invoke).toHaveBeenCalledTimes(65);
    const budgets = (await f.owner.query('SELECT id,used FROM pipeline_budget_workflows ORDER BY created_at')).rows;
    expect(budgets).toHaveLength(2); // Failure here is an honest window/fixture boundary, never a cap waiver.
    expect(budgets[1].used).toMatchObject({ calls: 64, retries: 63 });
    expect((await f.owner.query('SELECT * FROM embedding_dispatch_windows WHERE id=$1', [oldWindow.id])).rows[0]).toEqual(oldWindow);
    hydrate.mockClear(); await schedule();
    expect(await run(f, store)).toBe('idle');
    expect(hydrate).not.toHaveBeenCalled(); expect(f.adapter.invoke).toHaveBeenCalledTimes(65);
    expect((await f.owner.query('SELECT id,used FROM pipeline_budget_workflows ORDER BY created_at')).rows).toEqual(budgets);
  }, { windowSeconds: 60 });
}, 120000);


it('orders a real target rotation behind policy admission so the held APP transaction can finish another capture', async () => {
  await embeddingQueueFixture(async f => {
    const window = (await f.owner.query('SELECT window_policy FROM embedding_targets WHERE fingerprint=$1', [f.target.fingerprint])).rows[0].window_policy;
    const app = await f.app.connect(), operator = await f.operator.connect();
    let rotation: Promise<{ error?: unknown }> | undefined;
    try {
      const appPid = (await app.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const operatorPid = (await operator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await app.query('BEGIN');
      await app.query("SET LOCAL statement_timeout='5s'"); await app.query("SET LOCAL lock_timeout='1s'");
      // The real no-provider enqueue takes policy SHARE without target SHARE.
      expect(await captureOne(app, null, f.principal, input(f, 'Policy-only admitted source'))).toMatchObject({ embeddingStatus: 'not_configured' });
      rotation = operator.query('SELECT continuum_operator_embedding_target($1,$2,$3,$4,FALSE)',
        [f.adminId, f.target, f.profile, window]).then(() => ({}), error => ({ error }));
      let blocked = false; const deadline = Date.now() + 800;
      while (Date.now() < deadline) {
        blocked = (await f.owner.query('SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked', [appPid, operatorPid])).rows[0].blocked;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked, 'actual OP target rotation must be waiting behind the APP policy admission').toBe(true);
      const accepted = await captureOne(app, f.router, f.principal, input(f, 'Capture finishes while rotation waits'));
      expect(accepted).toMatchObject({ embedded: false, embeddingStatus: 'queued' });
      await app.query('COMMIT');
      const settled = await rotation; if (settled.error) throw settled.error;
      expect(await readEmbeddingStatus(f.app, f.actorId, accepted.memory.id)).toMatchObject({ embedded: false, embeddingStatus: 'blocked_policy' });
      expect(await captureMemory(f.app, f.router, f.principal, input(f, 'Valid ACK after approved disable')))
        .toMatchObject({ embedded: false, embeddingStatus: 'blocked_policy' });
      expect(f.adapter.invoke).not.toHaveBeenCalled(); expect(f.provider.embed).not.toHaveBeenCalled();
    } finally {
      await app.query('ROLLBACK');
      await rotation;
      app.release(); operator.release();
    }
  });
}, 60000);
