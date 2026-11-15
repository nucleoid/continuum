import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { embeddingQueueFixture } from '../embeddings/test-helpers.js';
import { EmbeddingRegistry, ScopeEmbeddingRouter } from '../embeddings/router.js';
import { EmbeddingItemError } from '../embeddings/provider.js';
import { captureMemory } from '../services/capture.js';
import { controlEmbeddingJobs } from '../services/embedding-jobs.js';
import { getPrincipal } from './principals.js';
import { addMembership } from './memberships.js';
import { SqlEmbeddingJobStore, readEmbeddingStatus } from './embedding-jobs.js';
import { processEmbeddingJobs } from '../workers/embedding-jobs.js';
import { amounts } from '../pipeline/budget.js';
import type { CaptureInput } from '../types.js';

type Fixture = Parameters<Parameters<typeof embeddingQueueFixture>[0]>[0];
const input = (f: Fixture, title: string): CaptureInput => ({ scope: { kind: f.scope.kind, name: f.scope.name },
  type: 'fact', title, body: 'Synthetic source with no external provider.', source: 'manual' });
const run = (f: Fixture) => processEmbeddingJobs(new SqlEmbeddingJobStore(f.worker), f.target,
  f.policy, f.provider, f.profile, randomUUID());

it('recovers an expired provably undispatched reservation without changing original maximum charges', async () => {
  await embeddingQueueFixture(async f => {
    await captureMemory(f.app, f.router, f.principal, input(f, 'Reserved, never dispatched'));
    const original = new SqlEmbeddingJobStore(f.worker);
    const first = (await original.claim(f.target, f.policy, randomUUID(), 1, f.profile))!;
    await original.hydrate(first, 4194304);
    const reservation = amounts({ calls: 1, inputBytes: 1000, contextTokens: 1000, outputBytes: 4096 });
    expect(await original.attempt(first).reserve(reservation, 5096)).toBe(true);
    expect((await f.owner.query('SELECT state FROM pipeline_budget_attempts WHERE workflow_id=$1', [first.workflowId])).rows)
      .toEqual([{ state: 'reserved' }]);
    const before = (await f.owner.query('SELECT * FROM embedding_dispatch_windows')).rows;
    const used = (await f.owner.query('SELECT used FROM pipeline_budget_workflows WHERE id=$1', [first.workflowId])).rows[0].used;
    // Owner-only lease-expiry fault fixture. It is NOT evidence that a
    // DISPATCHED attempt settled or that any process exited.
    await f.owner.query(`UPDATE embedding_cohorts SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, [first.id]);
    await f.owner.query(`UPDATE embedding_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE cohort_id=$1`, [first.id]);
    expect(await new SqlEmbeddingJobStore(f.worker).claim(f.target, f.policy, randomUUID(), 1, f.profile)).toBeNull();
    expect((await f.owner.query('SELECT state FROM pipeline_budget_attempts WHERE workflow_id=$1', [first.workflowId])).rows)
      .toEqual([{ state: 'settled' }]);
    expect((await f.owner.query('SELECT used,active,retained_bytes FROM pipeline_budget_workflows WHERE id=$1', [first.workflowId])).rows)
      .toEqual([{ used, active: 0, retained_bytes: '0' }]);
    expect((await f.owner.query('SELECT * FROM embedding_dispatch_windows')).rows).toEqual(before);
    expect(await original.attempt(first).dispatch()).toBe(false);
    expect(await original.attempt(first).settle({}, 'unknown')).toBe(false);
    expect(f.adapter.invoke).not.toHaveBeenCalled();
  }, { windowSeconds: 86400 });
}, 60000);

it('retains a successful diagnostic control across a later approved budget window', async () => {
  await embeddingQueueFixture(async f => {
    const phase = Number((await f.owner.query('SELECT mod(extract(epoch FROM clock_timestamp())*1000,5000) AS phase')).rows[0].phase);
    await new Promise(resolve => setTimeout(resolve, 5020 - phase));
    const healthy = await captureMemory(f.app, f.router, f.principal, input(f, 'Healthy diagnostic control'));
    const poison = await captureMemory(f.app, f.router, f.principal, input(f, 'Explicit diagnostic poison'));
    vi.mocked(f.adapter.invoke).mockImplementation(async serialized => {
      const texts = JSON.parse(serialized).input as string[];
      if (texts.some(text => text.includes('Explicit diagnostic poison'))) throw new EmbeddingItemError('Synthetic explicit rejection');
      const value = texts.map(() => Array(768).fill(0.125)); return { value, response: value };
    });
    expect(await run(f)).toBe('unavailable');
    // Isolate the healthy sibling first, under its original finite allowance.
    await f.owner.query(`UPDATE embedding_jobs SET available_at=CASE WHEN memory_id=$1 THEN clock_timestamp()-interval '1 second'
      ELSE clock_timestamp()+interval '1 minute' END WHERE state='retry_wait'`, [healthy.memory.id]);
    expect(await run(f)).toBe('processed');
    expect(await readEmbeddingStatus(f.app, f.actorId, healthy.memory.id)).toMatchObject({ embedded: true });
    const oldWindow = (await f.owner.query('SELECT * FROM embedding_dispatch_windows ORDER BY starts_at LIMIT 1')).rows[0];
    const remaining = Number((await f.owner.query(`SELECT greatest(0,extract(epoch FROM
      (ends_at-clock_timestamp()))*1000) AS milliseconds FROM embedding_dispatch_windows WHERE id=$1`, [oldWindow.id])).rows[0].milliseconds);
    await new Promise(resolve => setTimeout(resolve, remaining + 50));
    await f.owner.query(`UPDATE embedding_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE memory_id=$1`, [poison.memory.id]);
    expect(await run(f)).toBe('unavailable');
    expect(await readEmbeddingStatus(f.app, f.actorId, poison.memory.id)).toMatchObject({ embeddingStatus: 'permanent_failure', embedded: false });
    expect((await f.owner.query('SELECT * FROM embedding_dispatch_windows WHERE id=$1', [oldWindow.id])).rows[0]).toEqual(oldWindow);
    expect((await f.owner.query('SELECT count(DISTINCT workflow_id)::int AS n FROM embedding_cohorts')).rows[0].n).toBe(2);
  }, { windowSeconds: 5 });
}, 60000);

it('cancels a global bounded page of actual target-less blocked jobs without losing source or replay rights', async () => {
  await embeddingQueueFixture(async f => {
    const unavailable = new ScopeEmbeddingRouter(new EmbeddingRegistry([]), { default: 'local-only' });
    const captures = [input(f, 'Blocked A'), input(f, 'Blocked B')];
    const accepted = [];
    for (let i = 0; i < captures.length; i++) accepted.push(await captureMemory(f.app, unavailable, f.principal,
      captures[i], {}, { idempotencyKey: 'blocked-key-' + i }));
    expect(accepted.every(value => value.embeddingStatus === 'blocked_policy')).toBe(true);
    const admin = (await getPrincipal(f.owner, f.adminId))!;
    await expect(f.app.query('SELECT continuum_operator_embedding_control($1,$2,NULL,1)', [f.adminId, 'cancel']))
      .rejects.toMatchObject({ code: '42501' });
    await expect(f.worker.query('SELECT continuum_operator_embedding_control($1,$2,NULL,1)', [f.adminId, 'cancel']))
      .rejects.toMatchObject({ code: '42501' });
    expect((await f.owner.query('SELECT active FROM embedding_scope_admission WHERE scope_id=$1', [f.scopeId])).rows[0].active).toBe(2);
    expect(await controlEmbeddingJobs(f.operator, admin, 'cancel', null, 1)).toMatchObject({ processed: 1 });
    expect((await f.owner.query('SELECT active FROM embedding_scope_admission WHERE scope_id=$1', [f.scopeId])).rows[0].active).toBe(1);
    expect(await controlEmbeddingJobs(f.operator, admin, 'cancel', null, 1)).toMatchObject({ processed: 1 });
    expect(await controlEmbeddingJobs(f.operator, admin, 'cancel', null, 1)).toMatchObject({ processed: 0 });
    expect((await f.owner.query('SELECT active FROM embedding_scope_admission WHERE scope_id=$1', [f.scopeId])).rows[0].active).toBe(0);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM memories')).rows[0].n).toBe(2);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM embedding_capture_receipts')).rows[0].n).toBe(2);
    for (let i = 0; i < captures.length; i++) expect(await captureMemory(f.app, unavailable, f.principal,
      captures[i], {}, { idempotencyKey: 'blocked-key-' + i })).toMatchObject({ replayed: true, memory: { id: accepted[i].memory.id }, embeddingStatus: 'cancelled' });
    const org = (await f.owner.query("SELECT id FROM scopes WHERE kind='org' AND name=''")).rows[0].id;
    await addMembership(f.owner, f.actorId, org, 'admin');
    await f.owner.query(`UPDATE scope_memberships SET active=FALSE WHERE principal_id=$1 AND role='admin'`, [f.adminId]);
    await expect(controlEmbeddingJobs(f.operator, admin, 'cancel', null, 1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.adapter.invoke).not.toHaveBeenCalled();
  });
}, 60000);
