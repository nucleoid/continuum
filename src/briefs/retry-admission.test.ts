import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { refreshBrief } from '../services/briefs.js';
import { processBrief } from '../workers/briefs.js';
import type { BriefInput } from './model.js';
import { briefFixture, syntheticBrief } from './test-helpers.js';

type Fixture = Parameters<Parameters<typeof briefFixture>[0]>[0];
const enqueue = async (f: Fixture, key: string) => refreshBrief(f.app,
  (await getPrincipal(f.app, f.actorId))!, {
    project: f.projectName, mode: 'full', dryRun: false, idempotencyKey: key,
  });
const inputs = async (f: Fixture) => {
  for (const type of ['fact', 'decision'] as const) await createMemory(f.app, {
    scopeId: f.projectId, scopeKind: 'project', authorId: f.actorId, type,
    title: `Actual ${type} input`, body: `Retain ${type} evidence.`, source: 'manual',
  });
};
const state = async (f: Fixture, run: string) => (await f.owner.query(`
  SELECT j.state,j.reason,j.failures,j.generation,j.workflow_id,j.attempt_id,
    j.budget_owner,j.budget_generation,j.deadline_at,j.next_attempt_at,
    clock_timestamp() AS at,w.used,w.active,w.cancelled,w.generation AS workflow_generation
  FROM brief_runs j JOIN pipeline_budget_workflows w ON w.id=j.workflow_id WHERE j.id=$1`, [run])).rows[0];
const identity = (row: Awaited<ReturnType<typeof state>>) => ({
  workflow: row.workflow_id, attempt: row.attempt_id, owner: row.budget_owner,
  generation: row.budget_generation, deadline: row.deadline_at,
});
const backoff = async (row: Awaited<ReturnType<typeof state>>) => {
  const ms = new Date(row.next_attempt_at).getTime() - new Date(row.at).getTime();
  expect(ms).toBeGreaterThan(0); expect(ms).toBeLessThanOrEqual(1000);
  await new Promise(resolve => setTimeout(resolve, ms + 25));
};
const priced = (invoke: Parameters<typeof syntheticBrief>[0]) => {
  const profile = syntheticBrief(invoke);
  profile.qualification = { kind: 'operator-qualified', reportSha256: 'a'.repeat(64) };
  profile.adapter.price = { id: 'priced-local-test-v1', currency: 'USD', unitTokens: 1,
    inputMicros: 1, outputMicros: 1, reasoningMicros: 0 };
  profile.budget = { ...profile.budget, rateSchedule: 'priced-local-test-v1', limits: {
    ...profile.budget.limits, spendMicros: 1_000_000, outputTokens: 131072, completionTokens: 131072,
  } };
  return profile;
};

it.each([
  { calls: 4, retries: 3, admitted: false },
  { calls: 6, retries: 1, admitted: false },
  { calls: 6, retries: 3, admitted: true },
])('admits all three actual retry groups atomically: %j', async limits => {
  const good = syntheticBrief(); const seen: string[][] = [];
  const profile = priced(async (wire, caps) => {
    seen.push((JSON.parse(wire).input as BriefInput).sections);
    if (seen.length === 3) throw new Error('Settled synthetic failure on combined group');
    return good.adapter.invoke(wire, caps);
  });
  profile.budget = { ...profile.budget, limits: { ...profile.budget.limits,
    calls: limits.calls, retries: limits.retries } };
  await briefFixture(async f => {
    await inputs(f); const key = randomUUID(); const request = await enqueue(f, key);
    expect(await processBrief(f.worker, randomUUID(), f.profile)).toBe('unavailable');
    expect(seen).toEqual([['purpose'], ['decisions'], ['implementation', 'unknowns', 'coverage']]);
    const first = await state(f, request.runId);
    expect(first).toMatchObject({ state: limits.admitted ? 'queued' : 'unavailable', reason: 'provider',
      active: 0, cancelled: !limits.admitted, used: { calls: 3, retries: 0 } });
    expect(first.used.spendMicros).toBeGreaterThan(0);
    if (limits.admitted) {
      await backoff(first);
      expect(await processBrief(f.worker, randomUUID(), f.profile)).toBe('processed');
      expect(seen).toHaveLength(6);
      const done = await state(f, request.runId);
      expect(identity(done)).toEqual(identity(first));
      expect(done).toMatchObject({ state: 'complete', active: 0, cancelled: false,
        used: { calls: 6, retries: 3 } });
    } else {
      // No new request key, head, input mutation, or workflow can hide the waste.
      expect((await enqueue(f, key)).runId).toBe(request.runId);
      expect(await processBrief(f.worker, randomUUID(), f.profile)).toBe('idle');
      const parked = await state(f, request.runId);
      expect(identity(parked)).toEqual(identity(first)); expect(parked.used).toEqual(first.used);
      expect(seen).toHaveLength(3);
    }
    // Owner pool max=1: all inspection queries are sequential; no checked-out
    // owner client is held while querying that pool or performing application I/O.
    const attempts = (await f.owner.query(`SELECT p.state,p.reserved,p.settlement
      FROM brief_run_attempts a JOIN pipeline_budget_attempts p
        ON p.workflow_id=$2 AND p.attempt_id=a.attempt_id WHERE a.run_id=$1 ORDER BY a.ordinal`,
      [request.runId, first.workflow_id])).rows;
    const final = await state(f, request.runId);
    expect(attempts).toHaveLength(limits.admitted ? 6 : 3);
    expect(attempts.every(a => a.state === 'settled')).toBe(true);
    expect(attempts[2].settlement).toEqual({ provenance: 'unknown' });
    expect(final.used.spendMicros).toBe(attempts.reduce((n, a) => n + a.reserved.spendMicros, 0));
    expect((await f.owner.query('SELECT count(*)::int AS n FROM pipeline_budget_workflows')).rows[0].n).toBe(1);
  }, profile);
}, 120000);

it('durably fences a retry-claim allowance failure without refunding the original paid-shaped work', async () => {
  let calls = 0; const good = syntheticBrief();
  const profile = priced(async (...args) => {
    if (++calls === 1) throw new Error('Actually settled synthetic outage');
    return good.adapter.invoke(...args);
  });
  // First claim + one failed response cap fits. A second 262144-byte generation
  // allowance does not. This is a real profile, not forged job/accounting state.
  profile.budget = { ...profile.budget, limits: { ...profile.budget.limits, outputBytes: 500000 } };
  await briefFixture(async f => {
    await inputs(f); const key = randomUUID(); const request = await enqueue(f, key);
    expect(await processBrief(f.worker, randomUUID(), f.profile)).toBe('unavailable');
    const queued = await state(f, request.runId);
    expect(queued).toMatchObject({ state: 'queued', failures: 1, active: 0, cancelled: false,
      used: { calls: 1, retries: 0 } });
    expect(queued.used.spendMicros).toBeGreaterThan(0);
    await backoff(queued);
    expect(await processBrief(f.worker, randomUUID(), f.profile)).toBe('unavailable');
    const parked = await state(f, request.runId);
    expect(parked).toMatchObject({ state: 'unavailable', reason: 'budget', active: 0, cancelled: true });
    expect(Number(parked.workflow_generation)).toBe(Number(queued.workflow_generation) + 1);
    expect(Number(parked.generation)).toBeGreaterThan(Number(queued.generation));
    expect(identity(parked)).toEqual(identity(queued)); expect(parked.used).toEqual(queued.used);
    expect(calls).toBe(1); expect((await enqueue(f, key)).runId).toBe(request.runId);
    expect(await processBrief(f.worker, randomUUID(), f.profile)).toBe('idle');
    expect((await f.owner.query('SELECT count(*)::int AS n FROM pipeline_budget_workflows')).rows[0].n).toBe(1);
  }, profile);
}, 120000);
