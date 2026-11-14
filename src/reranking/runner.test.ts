import { expect, it, vi } from 'vitest';
import { Budget, starterProfile } from '../pipeline/budget.js';
import { runReranking } from './runner.js';
import { configureReranking, type RerankingAdapter } from './provider.js';

const candidates = Object.freeze([
  Object.freeze({ id: 'c0', title: 'First', excerpt: 'Reference data' }),
  Object.freeze({ id: 'c1', title: 'Second', excerpt: 'Other reference data' }),
]);
function adapter(value: unknown = { version: 'test-v1', scores: [{ id: 'c0', score: 0 }, { id: 'c1', score: 1 }] }): RerankingAdapter {
  return {
    id: 'test-reranker', version: 'test-v1', model: 'deterministic-v1', profile: 'test-v1', local: true,
    timeoutMs: 100, responseBodyBytes: 4096, enforceableCaps: true, cancellation: 'cooperative',
    outputTokens: 100, reasoningTokens: 0, completionTokens: 100,
    tokens: { model: 'deterministic-v1', profile: 'test-v1', kind: 'exact', validationId: 'test-bytes-v1', overheadTokens: 0, count: s => Buffer.byteLength(s) },
    price: { id: 'local-zero-v1', currency: 'USD', unitTokens: 1, inputMicros: 0, outputMicros: 0, reasoningMicros: 0 },
    serialize: (input, caps) => ({ protocol: 'test-v1', input, caps }),
    invoke: vi.fn(async () => ({ value, response: value })),
  };
}
const configured = (a: RerankingAdapter) => configureReranking(a, starterProfile, {
  candidateLimit: 20, evidence: { kind: 'local-contract', adapterId: a.id, version: a.version, model: a.model, profile: a.profile },
});
it('scores the whole pool, counts the complete wire request, and preserves opaque IDs', async () => {
  const a = adapter(); const budget = new Budget(starterProfile);
  const result = await runReranking(configured(a), budget, { query: 'reference', candidates }, async () => true, 20_000);
  expect(result).toEqual({ status: 'used', scores: new Map([['c0', 0], ['c1', 1]]) });
  expect(budget.snapshot().used.calls).toBe(1);
  expect(budget.snapshot().used.inputBytes).toBe(Buffer.byteLength(vi.mocked(a.invoke).mock.calls[0][0]));
  expect(budget.snapshot().active).toBe(0);
});
it.each([
  { version: 'wrong', scores: [] },
  { version: 'test-v1', scores: [{ id: 'c0', score: 1 }] },
  { version: 'test-v1', scores: [{ id: 'c0', score: 1 }, { id: 'c0', score: 2 }] },
  { version: 'test-v1', scores: [{ id: 'c0', score: 1 }, { id: 'secret', score: 2 }] },
  { version: 'test-v1', scores: [{ id: 'c0', score: NaN }, { id: 'c1', score: 2 }] },
  { version: 'test-v1', scores: [{ id: 'c0', score: Infinity }, { id: 'c1', score: 2 }] },
  { get version() { throw new Error('private text'); } },
])('rejects malformed scores without a partial prefix', async value => {
  const result = await runReranking(configured(adapter(value)), new Budget(starterProfile), { query: 'q', candidates }, async () => true, 20_000);
  expect(result).toEqual({ status: 'fallback', reason: 'invalid_response' });
});
it('denies disclosure, preserves final-output allowance, and sanitizes adapter failures', async () => {
  const a = adapter(); const config = configured(a);
  expect(await runReranking(config, new Budget(starterProfile), { query: 'q', candidates }, async () => false, 20_000))
    .toEqual({ status: 'fallback', reason: 'policy_denied' });
  expect(a.invoke).not.toHaveBeenCalled();
  const budget = new Budget(starterProfile); budget.consume({ outputBytes: budget.available('outputBytes') - 20_000 });
  expect(await runReranking(config, budget, { query: 'q', candidates }, async () => true, 20_000))
    .toEqual({ status: 'fallback', reason: 'budget_exhausted' });
  expect(a.invoke).not.toHaveBeenCalled();
  vi.mocked(a.invoke).mockRejectedValue(new Error('private adapter response'));
  expect(await runReranking(config, new Budget(starterProfile), { query: 'q', candidates }, async () => true, 20_000))
    .toEqual({ status: 'fallback', reason: 'provider_failed' });
});
it('retains detached admission until actual settlement and rejects late scores', async () => {
  const a = adapter(); a.timeoutMs = 10;
  let finish!: (value: Awaited<ReturnType<RerankingAdapter['invoke']>>) => void;
  vi.mocked(a.invoke).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const config = configured(a); const budget = new Budget(starterProfile);
  expect(await runReranking(config, budget, { query: 'q', candidates }, async () => true, 20_000))
    .toEqual({ status: 'fallback', reason: 'deadline' });
  expect(budget.snapshot().active).toBe(1);
  expect(await runReranking(config, new Budget(starterProfile), { query: 'q', candidates }, async () => true, 20_000))
    .toEqual({ status: 'fallback', reason: 'budget_exhausted' });
  finish({ value: { version: 'test-v1', scores: [{ id: 'c0', score: 0 }, { id: 'c1', score: 1 }] }, response: {} });
  await vi.waitFor(() => expect(budget.snapshot().active).toBe(0));
});
