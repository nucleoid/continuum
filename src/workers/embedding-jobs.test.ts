import { afterEach, describe, expect, it, vi } from 'vitest';
import { starterProfile, type BudgetAdapter, type BudgetProfile } from '../pipeline/budget.js';
import { EmbeddingItemError, type EmbeddingProvider } from '../embeddings/provider.js';
import { embeddingTarget, MEMORY_EMBEDDING_INPUT_TRANSFORM } from '../embeddings/target.js';
import type { EmbeddingJobClaim, EmbeddingJobStore } from '../storage/embedding-jobs-model.js';
import { checkedEmbeddingWorkerProfile, EmbeddingJobWorker, processEmbeddingJobs } from './embedding-jobs.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const vector = () => Array(768).fill(1);
function fixture(id = 'local:worker-test') {
  const target = embeddingTarget({ space: { provider: id, model: 'exact', profile: 'document-v1', dim: 768,
    inputTransform: MEMORY_EMBEDDING_INPUT_TRANSFORM }, endpoint: 'http://localhost:11434/api/embed', local: true });
  const events: string[] = [];
  const policy = { generation: '2', digest: 'a'.repeat(64) };
  const adapter: BudgetAdapter<string[], number[][]> = {
    id, model: 'exact', profile: 'document-v1', local: true, timeoutMs: 10_000, credentials: 'not-required',
    responseBodyBytes: 32_000, enforceableCaps: true, cancellation: 'cooperative',
    outputTokens: 0, reasoningTokens: 0, completionTokens: 0,
    tokens: { kind: 'conservative', model: 'exact', profile: 'document-v1', validationId: 'synthetic-only-v1', overheadTokens: 0, count: () => 100 },
    price: { id: 'local-zero-v1', currency: 'USD', unitTokens: 1, inputMicros: 0, outputMicros: 0, reasoningMicros: 0 },
    serialize: texts => ({ input: texts }),
    invoke: vi.fn(async () => { events.push('provider'); return { value: [vector()], response: [vector()] }; }),
  };
  const provider: EmbeddingProvider = { id, dim: 768, local: true, target, batchSize: 32, pipelineAdapter: adapter,
    embed: vi.fn(async () => { throw new Error('Use accounted dispatch only'); }) };
  const profile: BudgetProfile = { ...starterProfile, id: 'embedding-worker-test', maxConcurrency: 1 };
  const claim: EmbeddingJobClaim = { id: 'batch', owner: 'worker', generation: '4', target: target.fingerprint,
    policyGeneration: policy.generation, policyDigest: policy.digest, workflowId: 'original-workflow', attemptId: 'original-attempt', attemptOwner: 'original-owner',
    attemptGeneration: 1, retry: false, remainingMs: 30_000,
    jobs: [{ id: 'job', memoryId: 'memory', sourceGeneration: '7', leaseGeneration: '3' }] };
  const store: EmbeddingJobStore = {
    claim: vi.fn(async () => { events.push('claim'); return claim; }),
    hydrate: vi.fn(async () => { events.push('hydrate'); return { items: [{ id: 'job', title: 'title', body: 'body' }], oversized: [] }; }),
    renew: vi.fn(async () => true), authorize: vi.fn(async () => { events.push('authorize'); return true; }),
    attempt: vi.fn(() => ({ reserve: vi.fn(async () => { events.push('reserve'); return true; }),
      dispatch: vi.fn(async () => { events.push('dispatch'); return true; }),
      settle: vi.fn(async () => { events.push('settle'); return true; }) })),
    apply: vi.fn(async () => { events.push('apply'); return true; }), fail: vi.fn(async () => true), release: vi.fn(async () => true),
  };
  const run = (signal?: AbortSignal) => processEmbeddingJobs(store, target, policy, provider, profile, 'worker', { signal });
  return { target, policy, adapter, provider, profile, claim, store, events, run };
}

afterEach(() => { vi.useRealTimers(); });

describe('embedding worker preparation contract', () => {
  it('reports pending original accounting as an unsuccessful shutdown', async () => {
    const f = fixture('local:accounting-shutdown');
    f.store.unsettledAccounting=()=>true;
    const worker = new EmbeddingJobWorker(f.store, [{ target:f.target, policy:f.policy, provider:f.provider, profile:f.profile }], 'worker');
    expect(await worker.stop()).toEqual({ settled:false });
    expect(await worker.stop()).toEqual({ settled:false });
    expect(f.adapter.invoke).not.toHaveBeenCalled();
  });
  it('commits dispatch authority before provider work and settlement before atomic apply', async () => {
    const f = fixture();
    expect(await f.run()).toBe('processed');
    expect(f.events).toEqual(['claim', 'hydrate', 'reserve', 'authorize', 'dispatch', 'provider', 'authorize', 'settle', 'apply']);
    expect(f.provider.embed).not.toHaveBeenCalled();
    expect(f.store.apply).toHaveBeenCalledWith(f.claim, [{ id: 'job', vector: vector() }]);
    expect(f.store.attempt).toHaveBeenCalledWith(expect.objectContaining({ attemptId: 'original-attempt', workflowId: 'original-workflow' }));
  });
  it('withholds provider I/O when current dispatch policy or durable reservation denies', async () => {
    const f = fixture();
    vi.mocked(f.store.authorize).mockResolvedValue(false);
    expect(await f.run()).toBe('unavailable'); expect(f.adapter.invoke).not.toHaveBeenCalled();
    expect(f.store.fail).toHaveBeenCalledWith(f.claim, { code: 'EMBEDDING_POLICY', action: 'retry' });
    expect(f.store.apply).not.toHaveBeenCalled();
  });
  it('denies another policy generation before source hydration', async () => {
    const f = fixture();
    f.claim.policyGeneration = '1';
    expect(await f.run()).toBe('unavailable');
    expect(f.store.hydrate).not.toHaveBeenCalled(); expect(f.adapter.invoke).not.toHaveBeenCalled();
  });
  it('suppresses a settled result after source/policy revocation or stale apply', async () => {
    const f = fixture();
    vi.mocked(f.store.authorize).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await f.run()).toBe('unavailable'); expect(f.adapter.invoke).toHaveBeenCalledOnce();
    expect(f.store.apply).not.toHaveBeenCalled();
    const other = fixture('local:stale-apply');
    vi.mocked(other.store.apply).mockResolvedValue(false);
    expect(await other.run()).toBe('unavailable');
  });
  it('does not dispatch oversized inputs or malformed/duplicated hydration', async () => {
    const f = fixture();
    vi.mocked(f.store.hydrate).mockResolvedValue({ items: [], oversized: ['job'] });
    expect(await f.run()).toBe('processed'); expect(f.adapter.invoke).not.toHaveBeenCalled();
    vi.mocked(f.store.hydrate).mockResolvedValue({ items: [{ id: 'job', title: 'x', body: 'y' }, { id: 'job', title: 'x', body: 'y' }], oversized: [] });
    expect(await f.run()).toBe('unavailable'); expect(f.adapter.invoke).not.toHaveBeenCalled();
    vi.mocked(f.store.hydrate).mockResolvedValue({ items: [{ id: 'job', title: 'x', body: 'x'.repeat(4 * 1024 * 1024) }], oversized: [] });
    expect(await f.run()).toBe('unavailable'); expect(f.adapter.invoke).not.toHaveBeenCalled();
    vi.mocked(f.store.hydrate).mockResolvedValue({ items: [{ id: 'job', title: 'x', body: 'x'.repeat(2 * 1024 * 1024) }], oversized: [] });
    expect(await f.run()).toBe('unavailable'); expect(f.adapter.invoke).not.toHaveBeenCalled();
  });
  it('requires finite exact-dimension responses and never blanket-poisons explicit batch rejection', async () => {
    const f = fixture();
    vi.mocked(f.adapter.invoke).mockResolvedValue({ value: [[NaN]], response: {} });
    expect(await f.run()).toBe('unavailable'); expect(f.store.apply).not.toHaveBeenCalled();
    expect(f.store.fail).toHaveBeenCalledWith(f.claim, { code: 'EMBEDDING_INVALID_RESPONSE', action: 'retry' });
    vi.mocked(f.adapter.invoke).mockRejectedValue(new EmbeddingItemError('private input'));
    expect(await f.run()).toBe('unavailable');
    expect(f.store.fail).toHaveBeenLastCalledWith(f.claim, { code: 'EMBEDDING_ITEM_FAILED', action: 'isolate_item' });
  });
  it('retains conservative accounting on settlement rejection without raw errors', async () => {
    const f = fixture();
    vi.mocked(f.store.attempt).mockReturnValue({ reserve: async () => true, dispatch: async () => true,
      settle: async () => { throw new Error('private database secret'); } });
    expect(await f.run()).toBe('unavailable'); expect(f.store.apply).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(f.store.fail).mock.calls)).not.toContain('private');
  });
  it('clamps claim batches and rejects mismatched model/transform/concurrency before claims', async () => {
    const f = fixture(); Object.assign(f.provider, { batchSize: 2 });
    await f.run(); expect(f.store.claim).toHaveBeenCalledWith(f.target, f.policy, 'worker', 2, expect.anything());
    expect(() => checkedEmbeddingWorkerProfile(f.target, f.provider, { ...f.profile, maxConcurrency: 2 })).toThrow();
    const mismatched = { ...f.provider, pipelineAdapter: { ...f.adapter, model: 'wrong' } };
    expect(() => checkedEmbeddingWorkerProfile(f.target, mismatched, f.profile)).toThrow();
  });
  it('keeps abort-ignoring work fenced through timeout, replacement and bounded shutdown', async () => {
    vi.useFakeTimers();
    const f = fixture('local:retained-work');
    const started = deferred<void>(), result = deferred<Awaited<ReturnType<typeof f.adapter.invoke>>>();
    vi.mocked(f.adapter.invoke).mockImplementation(async () => { started.resolve(); return result.promise; });
    f.profile.stageMs = 20;
    const worker = new EmbeddingJobWorker(f.store, [{ target: f.target, policy: f.policy, provider: f.provider, profile: f.profile }], 'worker');
    const pass = worker.poll(); await started.promise;
    await vi.advanceTimersByTimeAsync(20); await pass;
    expect(await f.run()).toBe('idle');
    await worker.poll(); expect(f.store.claim).toHaveBeenCalledTimes(1);
    const stopped = worker.stop(); await vi.advanceTimersByTimeAsync(5000);
    expect(await stopped).toEqual({ settled: false });
    expect(worker.stop()).toBe(stopped);
    expect(f.store.apply).not.toHaveBeenCalled();
    result.resolve({ value: [vector()], response: [vector()] });
    await vi.advanceTimersByTimeAsync(1);
    expect(await worker.stop()).toEqual({ settled: true });
    expect(f.store.apply).not.toHaveBeenCalled();
  });
  it('renews a long dispatch lease and aborts on renewal loss', async () => {
    vi.useFakeTimers();
    const f = fixture('local:renewal-loss');
    f.profile.stageMs = 25_000; f.adapter.timeoutMs = 25_000;
    const started = deferred<void>(), result = deferred<Awaited<ReturnType<typeof f.adapter.invoke>>>();
    vi.mocked(f.adapter.invoke).mockImplementation(async () => { started.resolve(); return result.promise; });
    vi.mocked(f.store.renew).mockResolvedValue(false);
    const pass = f.run(); await started.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pass).toBe('unavailable');
    expect(f.store.renew).toHaveBeenCalledWith(f.claim); expect(f.store.apply).not.toHaveBeenCalled();
    result.resolve({ value: [vector()], response: [vector()] });
    await vi.advanceTimersByTimeAsync(1);
  });
});
