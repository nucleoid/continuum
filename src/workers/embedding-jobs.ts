import { MAX_PIPELINE_JSON_NODES, Budget, budgetedStageUnavailable, checkedProfile, runBudgetedStage, type BudgetAdapter, type BudgetProfile } from '../pipeline/budget.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { classifyEmbeddingFailure } from '../embeddings/failure-policy.js';
import { MEMORY_EMBEDDING_INPUT_TRANSFORM, type EmbeddingTarget } from '../embeddings/target.js';
import { memoryEmbeddingText } from '../embeddings/text.js';
import { EMBEDDING_WORKER_DEFAULTS, embeddingBatchSize, type EmbeddingAttemptFailure, type EmbeddingJobClaim, type EmbeddingJobHydration, type EmbeddingJobStore, type EmbeddingPolicyIdentity } from '../storage/embedding-jobs-model.js';

export type EmbeddingPollOutcome = 'idle' | 'unavailable' | 'processed';
export interface EmbeddingWorkerTarget { target: EmbeddingTarget; policy: EmbeddingPolicyIdentity; provider: EmbeddingProvider; profile: BudgetProfile; }
/** Retained until actual provider/accounting settlement, including after timeout.
 * Replacement workers/configs in this process cannot bypass a hung provider. */
const activeProviders = new Set<string>();

// One array root plus one nested array and 768 numeric nodes per vector.
// Adapters with extra envelopes or tighter byte caps must configure less.
function workerBatchSize(provider: EmbeddingProvider): number {
  return Math.min(embeddingBatchSize(provider.batchSize),
    Math.floor((MAX_PIPELINE_JSON_NODES - 1) / (provider.dim + 1)));
}

export function checkedEmbeddingWorkerProfile(target: EmbeddingTarget, provider: EmbeddingProvider,
  input: BudgetProfile): Readonly<BudgetProfile> {
  const profile = checkedProfile(input), adapter = provider.pipelineAdapter;
  if (provider.id !== target.space.provider || provider.dim !== target.space.dim || provider.local !== target.local
    || provider.target?.fingerprint !== target.fingerprint || provider.target.spaceFingerprint !== target.spaceFingerprint
    || target.space.inputTransform !== MEMORY_EMBEDDING_INPUT_TRANSFORM || !adapter
    || adapter.id !== provider.id || adapter.model !== target.space.model || adapter.profile !== target.space.profile
    || adapter.local !== target.local || profile.maxConcurrency !== 1
    || profile.limits.hydratedBytes > EMBEDDING_WORKER_DEFAULTS.hydrationBytes) {
    throw new TypeError('Embedding worker profile does not match the approved target');
  }
  workerBatchSize(provider);
  return profile;
}

function validHydration(claim: EmbeddingJobClaim, data: EmbeddingJobHydration, maxBytes: number, maxItemBytes: number): boolean {
  const expected = new Set(claim.jobs.map(job => job.id));
  const seen = new Set<string>();
  let bytes = 0;
  if (expected.size !== claim.jobs.length || data.items.length + data.oversized.length !== expected.size) return false;
  for (const item of data.items) {
    if (!expected.has(item.id) || seen.has(item.id) || typeof item.title !== 'string' || typeof item.body !== 'string') return false;
    seen.add(item.id);
    const itemBytes = Buffer.byteLength(memoryEmbeddingText(item));
    if (itemBytes > maxItemBytes) return false;
    bytes += itemBytes;
    if (bytes > maxBytes) return false;
  }
  for (const id of data.oversized) {
    if (!expected.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/** One bounded target pass, using an explicitly composed accounting adapter.
 * SQL owns authority, admission, circuit/window state and commit identities.
 * SQL grants only the approved actual worker LOGIN these capabilities. */
export async function processEmbeddingJobs(store: EmbeddingJobStore, target: EmbeddingTarget, policy: EmbeddingPolicyIdentity, provider: EmbeddingProvider,
  input: BudgetProfile, owner: string, options: { signal?: AbortSignal; onWork?: (work: Promise<unknown>) => void } = {}): Promise<EmbeddingPollOutcome> {
  const profile = checkedEmbeddingWorkerProfile(target, provider, input);
  if (!/^[1-9][0-9]{0,18}$/.test(policy.generation) || BigInt(policy.generation) > 9223372036854775807n
    || !/^[0-9a-f]{64}$/.test(policy.digest)) throw new TypeError('Invalid durable embedding policy identity');
  policy = Object.freeze({ ...policy });
  const adapter = provider.pipelineAdapter!;
  if (options.signal?.aborted || activeProviders.has(provider.id) || budgetedStageUnavailable(profile, adapter)) return 'idle';
  activeProviders.add(provider.id);
  const pending = new Set<Promise<unknown>>();
  let finished = false;
  const release = () => { if (finished && !pending.size) activeProviders.delete(provider.id); };
  const track = (work: Promise<unknown>) => {
    pending.add(work);
    void work.then(() => { pending.delete(work); release(); }, () => { pending.delete(work); release(); });
    options.onWork?.(work);
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let claim: EmbeddingJobClaim | null = null;
  let timer: NodeJS.Timeout | undefined;
  let renewal: Promise<void> | undefined;
  let stopping = false;
  const heartbeat = () => {
    timer = setTimeout(() => {
      renewal = (async () => {
        try { if (!await store.renew(claim!)) controller.abort(); } catch { controller.abort(); }
        if (!stopping && !controller.signal.aborted) heartbeat();
      })();
    }, EMBEDDING_WORKER_DEFAULTS.renewMs);
    timer.unref();
  };
  const fail = async (failure: EmbeddingAttemptFailure) => {
    if (claim) await store.fail(claim, failure);
  };
  try {
    const started = performance.now();
    claim = await store.claim(target, policy, owner, workerBatchSize(provider), profile);
    if (!claim) return 'idle';
    if (claim.owner !== owner || claim.target !== target.fingerprint || claim.policyGeneration !== policy.generation
      || claim.policyDigest !== policy.digest || !Number.isFinite(claim.remainingMs)
      || claim.remainingMs <= 0 || claim.jobs.length < 1 || claim.jobs.length > workerBatchSize(provider)) {
      throw new TypeError('Invalid embedding claim');
    }
    const cutoff = started + claim.remainingMs;
    const live = () => !controller.signal.aborted && performance.now() + 1000 < cutoff;
    if (!live()) { await store.release(claim); return 'unavailable'; }
    heartbeat();
    const maxBytes = Math.min(profile.limits.hydratedBytes, EMBEDDING_WORKER_DEFAULTS.hydrationBytes);
    const data = await store.hydrate(claim, maxBytes);
    if (!validHydration(claim, data, maxBytes, profile.maxItemHydratedBytes)) throw new TypeError('Invalid bounded embedding hydration');
    // Oversize items were disposed by metadata-only SQL; no provider call needed.
    if (!data.items.length) return 'processed';
    if (!live()) { await store.release(claim); return 'unavailable'; }
    const budget = new Budget(profile);
    budget.consume({ candidates: data.items.length,
      hydratedBytes: data.items.reduce((sum, item) => sum + Buffer.byteLength(memoryEmbeddingText(item)), 0) });
    let providerFailure: EmbeddingAttemptFailure | undefined;
    const wrapped: BudgetAdapter<string[], number[][]> = { ...adapter,
      serialize: adapter.serialize.bind(adapter),
      invoke: async (...args) => {
        try { return await adapter.invoke(...args); }
        catch (error) { providerFailure = classifyEmbeddingFailure(error); throw error; }
      } };
    const outcome = await runBudgetedStage(budget, wrapped, data.items.map(memoryEmbeddingText), {
      signal: controller.signal, durable: store.attempt(claim), retry: claim.retry,
      transportMs: Math.max(1, Math.floor(cutoff - performance.now() - 1000)), onWork: track,
      authorize: async () => live() && await store.authorize(claim!) && live(),
    });
    if (outcome.status !== 'complete') {
      const failure: EmbeddingAttemptFailure = providerFailure ?? {
        code: outcome.reason === 'policy_denied' ? 'EMBEDDING_POLICY'
          : outcome.reason === 'cancelled' ? 'EMBEDDING_CANCELLED'
          : outcome.reason === 'deadline' ? 'EMBEDDING_TIMEOUT'
          : outcome.reason === 'invalid_response' ? 'EMBEDDING_INVALID_RESPONSE'
          : outcome.reason === 'provider_failed' || outcome.reason === 'stale_attempt' ? 'EMBEDDING_STORAGE'
          : outcome.reason === 'budget_exhausted' ? 'EMBEDDING_BUDGET' : 'EMBEDDING_POLICY', action: 'retry' };
      // isolate_item instructs SQL to schedule durable half groups sharing
      // the original window/workflow. It never poisons every member of a batch.
      await fail(failure);
      return 'unavailable';
    }
    if (!Array.isArray(outcome.value) || outcome.value.length !== data.items.length
      || outcome.value.some(vector => !Array.isArray(vector) || vector.length !== 768
        || vector.some(n => typeof n !== 'number' || !Number.isFinite(n)))) {
      await fail({ code: 'EMBEDDING_INVALID_RESPONSE', action: 'retry' }); return 'unavailable';
    }
    if (!live()) { await store.release(claim); return 'unavailable'; }
    return await store.apply(claim, data.items.map((item, i) => ({ id: item.id, vector: outcome.value[i] }))) ? 'processed' : 'unavailable';
  } catch {
    // Includes durable settlement rejection. Conservative original accounting
    // remains; a storage failure grants no new budget or completion identity.
    try { await fail({ code: 'EMBEDDING_STORAGE', action: 'retry' }); } catch { /* Expired ownership is recovered by SQL. */ }
    return 'unavailable';
  } finally {
    stopping = true;
    if (timer) clearTimeout(timer);
    await renewal;
    options.signal?.removeEventListener('abort', abort);
    finished = true; release();
  }
}

/** Explicit runtime composition only. One unsettled dispatch per worker.
 * Independent workers may serve other providers while this worker drains. */
export class EmbeddingJobWorker {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private polling?: Promise<void>;
  private stopped = false;
  private stopPromise?: Promise<{ settled: boolean }>;
  private next = 0;
  constructor(private readonly store: EmbeddingJobStore,
    private readonly targets: ReadonlyArray<EmbeddingWorkerTarget>,
    private readonly owner: string) {
    const ids = new Set<string>();
    for (const entry of targets) {
      checkedEmbeddingWorkerProfile(entry.target, entry.provider, entry.profile);
      if (ids.has(entry.provider.id)) throw new TypeError('Duplicate embedding worker provider');
      ids.add(entry.provider.id);
    }
  }
  poll(): Promise<void> {
    if (this.stopped || this.pending.size) return Promise.resolve();
    if (this.polling) return this.polling;
    this.polling = (async () => {
      for (let i = 0; i < this.targets.length && !this.stopped; i++) {
        const entry = this.targets[(this.next + i) % this.targets.length];
        await processEmbeddingJobs(this.store, entry.target, entry.policy, entry.provider, entry.profile, this.owner, {
          signal: this.controller.signal, onWork: work => {
            this.pending.add(work);
            void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
          },
        });
        if (this.pending.size) break;
      }
      if (this.targets.length) this.next = (this.next + 1) % this.targets.length;
    })().finally(() => { this.polling = undefined; });
    return this.polling;
  }
  stop(): Promise<{ settled: boolean }> {
    // Preserve the original bounded shutdown promise while work remains. Once
    // actual callbacks/accounting settle, a later observation can report that
    // fact without starting another shutdown wait or admitting more work.
    if (this.stopped && !this.polling && !this.pending.size && !this.store.unsettledAccounting?.()) {
      return Promise.resolve({ settled: true });
    }
    return this.stopPromise ??= this.stopWork();
  }
  private async stopWork(): Promise<{ settled: boolean }> {
    this.stopped = true; this.controller.abort();
    let timer: NodeJS.Timeout | undefined;
    try {
      const settled = (async () => { await this.polling; await Promise.allSettled([...this.pending]);
        return { settled: !this.store.unsettledAccounting?.() }; })();
      return await Promise.race([settled, new Promise<{ settled: boolean }>(resolve => {
        timer = setTimeout(() => resolve({ settled: false }), EMBEDDING_WORKER_DEFAULTS.shutdownMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
