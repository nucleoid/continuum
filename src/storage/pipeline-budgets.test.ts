import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestPool } from './test-helpers.js';
import { Budget, amounts, checkedProfile, starterProfile, runBudgetedStage } from '../pipeline/budget.js';
import { createBudgetWorkflow, fenceBudgetWorkflow, pipelineAttempt, readBudgetWorkflow } from './pipeline-budgets.js';

describe('durable pipeline accounting', () => {
  let pool: pg.Pool;
  beforeAll(async () => { pool = await makeTestPool(); }, 30_000);
  afterAll(async () => { await pool?.end(); });
  const profile = checkedProfile({ ...starterProfile, rateSchedule: 'priced-v1', limits: { ...starterProfile.limits, calls: 3, spendMicros: 10 } });
  async function workflow(selected = profile) {
    const id = randomUUID(), owner = randomUUID();
    const state = await createBudgetWorkflow(pool, id, owner, selected);
    return { id, owner, generation: state.generation };
  }
  it('serializes replica reservations and rejects duplicate attempts without a dispatch permit', async () => {
    const w = await workflow();
    const first = pipelineAttempt(pool, { ...w, attemptId: randomUUID() });
    const second = pipelineAttempt(pool, { ...w, attemptId: randomUUID() });
    const admitted = await Promise.all([first.reserve(amounts({ calls: 1, spendMicros: 8 }), 100), second.reserve(amounts({ calls: 1, spendMicros: 8 }), 100)]);
    expect(admitted.filter(Boolean)).toHaveLength(1);
    const successful = admitted[0] ? first : second;
    expect(await successful.reserve(amounts({ calls: 1, spendMicros: 8 }), 100)).toBe(false);
    expect((await readBudgetWorkflow(pool, w.id)).used.spendMicros).toBe(8);
  });
  it('retains pre-dispatch and ambiguous dispatched reservations across restart and requeue', async () => {
    const w = await workflow();
    const pending = pipelineAttempt(pool, { ...w, attemptId: randomUUID() });
    expect(await pending.reserve(amounts({ calls: 1, spendMicros: 7 }), 300)).toBe(true);
    const dispatched = pipelineAttempt(pool, { ...w, attemptId: randomUUID() });
    expect(await dispatched.reserve(amounts({ calls: 1, spendMicros: 3 }), 200)).toBe(true);
    expect(await dispatched.dispatch()).toBe(true);
    expect(await dispatched.dispatch()).toBe(false);
    const newOwner = randomUUID();
    const next = await fenceBudgetWorkflow(pool, w.id, w.owner, w.generation, newOwner);
    expect(next.generation).toBe(w.generation + 1);
    expect(await pending.dispatch()).toBe(false);
    const replica = new pg.Pool((pool as unknown as { options: pg.PoolConfig }).options);
    try {
      expect(await pipelineAttempt(replica, { ...w, owner: newOwner, generation: next.generation, attemptId: randomUUID() }).reserve(amounts({ calls: 1, spendMicros: 1 }), 1)).toBe(false);
      expect((await readBudgetWorkflow(replica, w.id))).toMatchObject({ active: 2, retainedBytes: 500, used: { spendMicros: 10, calls: 2 } });
      expect(await dispatched.settle({})).toBe(false); // Old owner may settle, never publish.
      expect((await readBudgetWorkflow(replica, w.id))).toMatchObject({ active: 1, retainedBytes: 300, used: { spendMicros: 10 } });
    } finally { await replica.end(); }
  });
  it('settles exactly once, rejects conflicting usage and does not reset immutable workflow limits', async () => {
    const w = await workflow();
    const attempt = pipelineAttempt(pool, { ...w, attemptId: randomUUID() });
    expect(await attempt.reserve(amounts({ calls: 1, spendMicros: 10, outputTokens: 10 }), 300)).toBe(true);
    expect(await attempt.dispatch()).toBe(true);
    expect(await attempt.settle({ spendMicros: 6, outputTokens: 2 })).toBe(true);
    expect(await attempt.settle({ spendMicros: 6, outputTokens: 2 })).toBe(false); // No second publication permit.
    await expect(attempt.settle({ spendMicros: 5 })).rejects.toThrow(/conflict/);
    expect((await readBudgetWorkflow(pool, w.id))).toMatchObject({ active: 0, retainedBytes: 0, used: { spendMicros: 6, calls: 1, outputTokens: 2 } });
    await expect(createBudgetWorkflow(pool, w.id, w.owner, starterProfile)).rejects.toThrow();
  });
  it('uses fresh database deadlines after waiting for a workflow lock', async () => {
    const w = await workflow(checkedProfile({ ...profile, overallMs: 100, stageMs: 50 }));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM pipeline_budget_workflows WHERE id=$1 FOR UPDATE', [w.id]);
      const attempted = pipelineAttempt(pool, { ...w, attemptId: randomUUID() }).reserve(amounts({ calls: 1 }), 0);
      await client.query('SELECT pg_sleep(0.15)');
      await client.query('COMMIT');
      expect(await attempted).toBe(false);
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await readBudgetWorkflow(pool, w.id)).used.calls).toBe(0);
  });
  it('cancellation prevents late publication while actual settlement alone releases retained resources', async () => {
    const w = await workflow();
    const attempt = pipelineAttempt(pool, { ...w, attemptId: randomUUID() });
    await attempt.reserve(amounts({ calls: 1, spendMicros: 10 }), 100);
    await attempt.dispatch();
    await fenceBudgetWorkflow(pool, w.id, w.owner, w.generation, randomUUID(), true);
    expect((await readBudgetWorkflow(pool, w.id)).active).toBe(1);
    expect(await attempt.settle({})).toBe(false);
    expect((await readBudgetWorkflow(pool, w.id))).toMatchObject({ active: 0, used: { spendMicros: 10 } });
  });
  it('stores no provider payload or source text and cannot refund nonsettleable dimensions', async () => {
    const w = await workflow();
    const attempt = pipelineAttempt(pool, { ...w, attemptId: randomUUID() });
    await attempt.reserve(amounts({ calls: 1, spendMicros: 1 }), 1);
    await expect(attempt.settle({ calls: 0 })).rejects.toThrow();
    const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='pipeline_budget_attempts'")).rows.map((r) => r.column_name);
    expect(columns).not.toContain('payload');
    expect(columns).not.toContain('receipt');
    await expect(pool.query('SELECT continuum_pipeline_create($1,$2,$3)', [randomUUID(), randomUUID(), { ...profile, id: 'secret raw source' }])).rejects.toThrow();
  });
});
