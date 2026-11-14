import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestPool } from './test-helpers.js';
import { Budget, amounts, checkedProfile, starterProfile, runBudgetedStage } from '../pipeline/budget.js';
import { createBudgetWorkflow, fenceBudgetWorkflow, pipelineAttempt, readBudgetWorkflow, requirePipelineBudgetsReady } from './pipeline-budgets.js';
import { createPrincipal } from './principals.js';
import { getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

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

  it('exposes only reviewed capabilities to actual APP/OP LOGIN sessions and none to SYNC', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const app = `pipeline_app_${suffix}`, op = `pipeline_op_${suffix}`, sync = `pipeline_sync_${suffix}`;
    const dbUrl = process.env.CONTINUUM_TEST_DATABASE_URL!;
    const admin = await createPrincipal(pool, { externalId: `pipeline-admin-${suffix}`, kind: 'user', displayName: 'Pipeline admin' });
    const service = await createPrincipal(pool, { externalId: `pipeline-sync-${suffix}`, kind: 'service', displayName: 'Pipeline sync' });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, admin.id, org.id, 'admin');
    const sessions: pg.Pool[] = [];
    const grant = (file: string, variables: Record<string, string>) => execFileSync('psql', [dbUrl, '-X', '-v', 'ON_ERROR_STOP=1',
      ...Object.entries(variables).flatMap(([key, value]) => ['-v', `${key}=${value}`]), '-f', join(process.cwd(), 'scripts', file)], { timeout: 30_000, stdio: 'pipe' });
    try {
      for (const role of [app, op, sync]) await pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'synthetic-pipeline-only'`);
      grant('grant-application-role.sql', { continuum_app_role: app });
      grant('grant-application-role.sql', { continuum_app_role: op });
      grant('grant-operator-role.sql', { continuum_operator_role: op, continuum_principal_id: admin.id });
      grant('grant-sync-role.sql', { continuum_sync_role: sync, continuum_principal_id: service.id });
      for (const [role, allowed] of [[app, true], [op, true], [sync, false]] as const) {
        const url = new URL(dbUrl); url.username = role; url.password = 'synthetic-pipeline-only';
        const session = new pg.Pool({ connectionString: url.toString(), max: 1, options: '-c search_path=public' }); sessions.push(session);
        expect((await session.query('SELECT session_user AS actual')).rows[0].actual).toBe(role);
        expect((await pool.query(`SELECT has_function_privilege($1,'continuum_pipeline_reserve(uuid,uuid,uuid,bigint,jsonb,bigint)','EXECUTE') AS execute,
          has_table_privilege($1,'pipeline_budget_attempts','SELECT,INSERT,UPDATE,DELETE') AS raw`, [role])).rows[0]).toEqual({ execute: allowed, raw: false });
        if (allowed) {
          await requirePipelineBudgetsReady(session, { expectedSchema: 'public' });
          const w = await createBudgetWorkflow(session, randomUUID(), randomUUID(), profile);
          const attempt = pipelineAttempt(session, { id: w.id, owner: w.owner, generation: w.generation, attemptId: randomUUID() });
          expect(await attempt.reserve(amounts({ calls: 1, spendMicros: 5 }), 1)).toBe(true);
          expect(await attempt.dispatch()).toBe(true);
          expect(await attempt.settle({ spendMicros: 1 })).toBe(true);
          await expect(session.query('UPDATE pipeline_budget_workflows SET used=$1', [{}])).rejects.toMatchObject({ code: '42501' });
        } else await expect(createBudgetWorkflow(session, randomUUID(), randomUUID(), profile)).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await Promise.all(sessions.map((p) => p.end()));
      for (const role of [sync, op, app]) {
        await pool.query(`DROP OWNED BY "${role}"`); await pool.query(`DROP ROLE "${role}"`);
      }
    }
  }, 60_000);

  it('retains durable concurrency after a local deadline until actual provider settlement', async () => {
    const selected = checkedProfile({ ...profile, stageMs: 10 });
    const w = await workflow(selected);
    const budget = new Budget(selected);
    let finish!: (r: { value: string; response: unknown }) => void;
    const adapter = {
      id: 'durable-local', model: 'fake', profile: 'fake', local: true, timeoutMs: 100, responseBodyBytes: 100,
      outputTokens: 0, reasoningTokens: 0, completionTokens: 0, enforceableCaps: true, cancellation: 'unsupported' as const,
      tokens: { kind: 'conservative' as const, model: 'fake', profile: 'fake', validationId: 'bytes-v1', overheadTokens: 0, count: () => 1 },
      price: { id: 'priced-v1', currency: 'USD', unitTokens: 1, inputMicros: 1, outputMicros: 0, reasoningMicros: 0 },
      serialize: () => ({ prompt: 'bounded fake' }), invoke: () => new Promise<{ value: string; response: unknown }>((r) => { finish = r; }),
    };
    expect(await runBudgetedStage(budget, adapter, 'x', { durable: pipelineAttempt(pool, { ...w, attemptId: randomUUID() }) })).toMatchObject({ reason: 'deadline' });
    expect((await readBudgetWorkflow(pool, w.id)).active).toBe(1);
    finish({ value: 'late', response: 'late' });
    // Join actual settlement, not a deadline receipt.
    const until = Date.now() + 1000;
    while ((await readBudgetWorkflow(pool, w.id)).active && Date.now() < until) await new Promise((r) => setTimeout(r, 1));
    expect((await readBudgetWorkflow(pool, w.id))).toMatchObject({ active: 0, used: { spendMicros: 1 } });
  });
});
