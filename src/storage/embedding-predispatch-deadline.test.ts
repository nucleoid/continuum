// Actual fixture roles/profile/SQL; no paid provider, budget/job forging, clock mocks or threshold changes.
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { embeddingQueueFixture } from '../embeddings/test-helpers.js';
import { EmbeddingProviderError } from '../embeddings/provider.js';
import { starterProfile } from '../pipeline/budget.js';
import { captureMemory } from '../services/capture.js';
import { SqlEmbeddingJobStore } from './embedding-jobs.js';
import { processEmbeddingJobs } from '../workers/embedding-jobs.js';

const profile = { ...starterProfile, maxConcurrency: 1, overallMs: 10000, stageMs: 1000 };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { resolve, promise };
}

it('does not count a cooperative worker cancellation as a provider outage', async () => {
  await embeddingQueueFixture(async f => {
    await captureMemory(f.app, f.router, f.principal, { scope: { kind: f.scope.kind, name: f.scope.name },
      type: 'fact', title: 'Actual cooperative cancellation', body: 'Provider abort is not provider failure.', source: 'manual' });
    const entered = deferred(), controller = new AbortController(), tracked: Promise<unknown>[] = [];
    vi.mocked(f.adapter.invoke).mockImplementation((_wire, options) => new Promise<never>((_resolve, reject) => {
      const abort = () => reject(options.signal.reason ?? new Error('Embedding request aborted'));
      if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
      entered.resolve();
    }));
    const running = processEmbeddingJobs(new SqlEmbeddingJobStore(f.worker), f.target, f.policy, f.provider, f.profile,
      randomUUID(), { signal: controller.signal, onWork: work => tracked.push(work) });
    try {
      await entered.promise; controller.abort(); expect(await running).toBe('unavailable');
      expect((await f.owner.query('SELECT state,failure_code FROM embedding_jobs')).rows)
        .toEqual([{ state: 'retry_wait', failure_code: 'EMBEDDING_CANCELLED' }]);
      expect((await f.owner.query('SELECT state,failures FROM embedding_provider_control')).rows)
        .toEqual([{ state: 'closed', failures: '0' }]);
      expect(f.adapter.invoke).toHaveBeenCalledOnce();
    } finally { controller.abort(); await running; await Promise.allSettled(tracked); }
  }, { profile });
}, 60000);

it('does not mark a provider outage when the real SQL authorization wait outlives the pre-invocation stage deadline', async () => {
  const started = performance.now();
  const phase = (name: string) => console.log('embedding predispatch deadline phase', { name, elapsedMs: Math.round(performance.now() - started) });
  phase('fixture-start');
  await embeddingQueueFixture(async f => {
    phase('fixture-ready');
    await captureMemory(f.app, f.router, f.principal, { scope: { kind: f.scope.kind, name: f.scope.name },
      type: 'fact', title: 'Predispatch SQL wait', body: 'Synthetic deadline source.', source: 'manual' });
    phase('source-queued');
    const store = new SqlEmbeddingJobStore(f.worker), originalAttempt = store.attempt.bind(store);
    // Separate existing owner connection holds one actual row lock. No owner query
    // is issued through f.owner while its sole connection is held below.
    const blocker = await f.owner.connect();
    const locked = deferred();
    const tracked: Promise<unknown>[] = [];
    let open = false;
    vi.spyOn(store, 'attempt').mockImplementation(claim => {
      const actual = originalAttempt(claim);
      return { ...actual, reserve: async (amount, retained) => {
        const reserved = await actual.reserve(amount, retained); // Real SQL COMMIT before blocking authorize.
        phase('reserve-returned');
        if (reserved) {
          await blocker.query('BEGIN'); open = true;
          await blocker.query('SELECT provider FROM embedding_provider_control WHERE provider=$1 AND dim=768 FOR UPDATE', [f.provider.id]);
          phase('owner-lock-held'); locked.resolve();
        }
        return reserved;
      } };
    });
    const running = processEmbeddingJobs(store, f.target, f.policy, f.provider, f.profile, randomUUID(),
      { onWork: work => tracked.push(work) });
    try {
      // Setup failure is explicit if real reserve never succeeds; no fabricated claim/permit.
      await Promise.race([locked.promise, running.then(() => { throw new Error('Actual reserve did not establish the SQL wait'); })]);
      // Real stage timer expires while authorize is blocked. Original overall deadline
      // is still valid after this wait; it does not itself suppress the fail transition.
      await new Promise(resolve => setTimeout(resolve, profile.stageMs + 150));
    } finally {
      if (open) await blocker.query('ROLLBACK');
      blocker.release(); phase('owner-lock-released');
    }
    expect(await running).toBe('unavailable'); phase('run-finished');
    phase('tracked-drain-start');
    await Promise.allSettled(tracked); phase('tracked-drain-finished'); // Original zero-use settlement must finish before final metadata inspection.
    expect(f.adapter.invoke).not.toHaveBeenCalled();
    expect((await f.owner.query('SELECT state,failures FROM embedding_provider_control WHERE provider=$1', [f.provider.id])).rows)
      .toEqual([{ state: 'closed', failures: '0' }]);
    expect((await f.owner.query('SELECT 1 FROM memory_embeddings')).rows).toEqual([]);
    phase('assertions-finished');
  }, { profile });
  phase('fixture-disposed');
}, 60000);

it('still treats a real dispatched adapter timeout as a provider outage', async () => {
  await embeddingQueueFixture(async f => {
    await captureMemory(f.app, f.router, f.principal, { scope: { kind: f.scope.kind, name: f.scope.name },
      type: 'fact', title: 'Actual invoked timeout', body: 'Synthetic timeout source.', source: 'manual' });
    vi.mocked(f.adapter.invoke).mockImplementationOnce(async (_wire, options) => new Promise((_, reject) => {
      const timeout = () => reject(new EmbeddingProviderError('EMBEDDING_TIMEOUT', 'Synthetic dispatched timeout'));
      if (options.signal.aborted) timeout();
      else options.signal.addEventListener('abort', timeout, { once: true });
    }));
    const tracked: Promise<unknown>[] = [];
    expect(await processEmbeddingJobs(new SqlEmbeddingJobStore(f.worker), f.target, f.policy, f.provider, f.profile,
      randomUUID(), { onWork: work => tracked.push(work) })).toBe('unavailable');
    await Promise.allSettled(tracked);
    expect(f.adapter.invoke).toHaveBeenCalledOnce();
    expect((await f.owner.query('SELECT state,failures FROM embedding_provider_control WHERE provider=$1', [f.provider.id])).rows)
      .toEqual([{ state: 'open', failures: '1' }]);
  }, { profile });
}, 60000);
