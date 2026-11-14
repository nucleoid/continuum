import { describe, expect, it } from 'vitest';
import { Budget, checkedProfile, starterProfile, boundedJson, runBudgetedStage, type BudgetAdapter } from './budget.js';

const profile = (limits = {}) => checkedProfile({ ...starterProfile, limits: { ...starterProfile.limits, ...limits } });
function adapter(overrides: Partial<BudgetAdapter<string, string>> = {}): BudgetAdapter<string, string> {
  return {
    id: 'fake', model: 'fake-v1', profile: 'fake-v1', local: true, timeoutMs: 100,
    responseBodyBytes: 128, outputTokens: 8, reasoningTokens: 0, completionTokens: 8,
    enforceableCaps: true, cancellation: 'cooperative',
    tokens: { kind: 'conservative', model: 'fake-v1', profile: 'fake-v1', validationId: 'byte-bound-v1', overheadTokens: 2, count: (s) => Buffer.byteLength(s) },
    price: { id: 'local-zero-v1', currency: 'USD', unitTokens: 1, inputMicros: 0, outputMicros: 0, reasoningMicros: 0 },
    serialize: (text, caps) => ({ model: 'fake-v1', prompt: text, tools: [{ name: 'test' }], ...caps }),
    invoke: async () => ({ value: 'ok', response: { text: 'ok' }, usage: { outputTokens: 2, reasoningTokens: 0, completionTokens: 2, provenance: 'measured' } }),
    ...overrides,
  };
}

describe('one shared pipeline envelope', () => {
  it('rejects malformed profiles and copies immutable limits', () => {
    for (const value of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => profile({ spendMicros: value })).toThrow();
    }
    const source = { ...starterProfile, limits: { ...starterProfile.limits } };
    const checked = checkedProfile(source);
    source.limits.calls = 100;
    expect(checked.limits.calls).toBe(4);
    expect(Object.isFrozen(checked.limits)).toBe(true);
    expect(() => checkedProfile({ ...source, stageMs: source.overallMs + 1 })).toThrow();
  });

  it('reserves atomically across children and never resets call/spend on retry', () => {
    const budget = new Budget(profile({ calls: 2, spendMicros: 10 }));
    const first = budget.reserve({ calls: 1, spendMicros: 8 }, 50);
    expect(() => budget.child().reserve({ calls: 1, spendMicros: 3 }, 1)).toThrow();
    expect(budget.snapshot().used.calls).toBe(1);
    budget.settle(first, { spendMicros: 6 });
    budget.settle(first, { spendMicros: 6 });
    expect(() => budget.settle(first, { spendMicros: 5 })).toThrow();
    const retry = budget.child().reserve({ calls: 1, retries: 1, spendMicros: 4 }, 1);
    budget.settle(retry, {}); // Unknown charge stays reserved.
    expect(budget.snapshot().used.spendMicros).toBe(10);
    expect(() => budget.reserve({ calls: 1 }, 0)).toThrow();
  });

  it('counts exact bounded JSON escaping without executing accessors or toJSON', () => {
    const input = { text: '\u0000"\\😀', metadata: { citation: 'source' } };
    const serialized = boundedJson(input, 1000);
    expect(JSON.parse(serialized)).toEqual(input);
    expect(() => boundedJson(input, Buffer.byteLength(serialized) - 1)).toThrow();
    expect(() => boundedJson({ get secret() { throw new Error('getter executed'); } }, 100)).toThrow(/serialization/);
    expect(() => boundedJson({ toJSON() { throw new Error('toJSON executed'); } }, 100)).toThrow(/serialization/);
    const cycle: unknown[] = []; cycle.push(cycle);
    expect(() => boundedJson(cycle, 100)).toThrow();
    expect(() => boundedJson({ large: 'x'.repeat(1_000_000) }, 100)).toThrow();
    let nested: unknown = null; for (let i = 0; i < 40; i++) nested = [nested];
    expect(() => boundedJson(nested, 1000)).toThrow();
  });

  it('charges wrappers and tokens before calling an adapter', async () => {
    let calls = 0;
    const result = await runBudgetedStage(new Budget(profile({ contextTokens: 10 })), adapter({ invoke: async () => { calls++; throw Error(); } }), 'x');
    expect(result).toMatchObject({ status: 'skipped', reason: 'budget_exhausted' });
    expect(calls).toBe(0);
    expect(await runBudgetedStage(new Budget(profile()), adapter({ tokens: undefined }), 'x')).toMatchObject({ status: 'skipped', reason: 'capability_unavailable' });
    expect(await runBudgetedStage(new Budget(profile()), adapter({ price: undefined }), 'x')).toMatchObject({ status: 'skipped', reason: 'pricing_unavailable' });
    expect(await runBudgetedStage(new Budget(profile()), adapter({ enforceableCaps: false }), 'x')).toMatchObject({ status: 'skipped', reason: 'capability_unavailable' });
  });

  it('keeps concurrency and bytes until an abort-ignoring call actually settles', async () => {
    let finish!: (value: Awaited<ReturnType<BudgetAdapter<string, string>['invoke']>>) => void;
    const budget = new Budget(checkedProfile({ ...profile(), maxConcurrency: 1, stageMs: 10 }));
    const stalled = runBudgetedStage(budget, adapter({ invoke: () => new Promise((r) => { finish = r; }) }), 'x');
    expect(await stalled).toMatchObject({ status: 'skipped', reason: 'deadline' });
    expect(budget.snapshot().active).toBe(1);
    expect(budget.snapshot().retainedBytes).toBeGreaterThan(0);
    expect(await runBudgetedStage(budget.child(), adapter(), 'retry')).toMatchObject({ status: 'skipped', reason: 'budget_exhausted' });
    finish({ value: 'late', response: 'late' });
    await new Promise((r) => setTimeout(r, 1));
    expect(budget.snapshot().active).toBe(0);
    expect(budget.snapshot().retainedBytes).toBe(0);
  });

  it('cancellation stops future dispatch and preserves ambiguous priced charges', async () => {
    const budget = new Budget(checkedProfile({ ...profile({ spendMicros: 1000 }), rateSchedule: 'priced-v1' }));
    const result = await runBudgetedStage(budget, adapter({ price: { id: 'priced-v1', currency: 'USD', unitTokens: 100, inputMicros: 1, outputMicros: 1, reasoningMicros: 1 }, invoke: async () => { throw Error('raw-secret'); } }), 'x');
    expect(result).toMatchObject({ status: 'skipped', reason: 'provider_failed' });
    expect(budget.snapshot().used.spendMicros).toBeGreaterThan(0);
    budget.cancel();
    expect(await runBudgetedStage(budget, adapter(), 'x')).toMatchObject({ status: 'skipped', reason: 'cancelled' });
    expect(JSON.stringify(budget.receipts.snapshot())).not.toContain('raw-secret');
  });
});
