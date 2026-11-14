import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { Budget, BudgetError, runBudgetedStage, budgetedStageUnavailable } from '../pipeline/budget.js';
import { chunkSource } from '../extraction/chunking.js';
import { EXTRACTION_PROMPT, EXTRACTION_SCHEMA, validateAssertions, type ExtractionOutput } from '../extraction/model.js';
import { extractionDescriptor, ExtractionRegistry, type ExtractionProfile } from '../extraction/provider.js';
import { extractionOperation, extractionAttempt, type ExtractionClaim } from '../storage/extraction.js';
import { requireExtractionReady } from '../storage/provider-lifecycle.js';

/** A trusted adapter may classify a settled transient failure. Arbitrary error
 * strings are never retained, logged, or interpreted as retry authority. */
export class ExtractionTransientError extends Error {
  constructor() { super('Extraction dependency temporarily unavailable'); }
}
export interface ExtractionWorkOptions {
  signal?: AbortSignal; onWork?: (work: Promise<unknown>) => void;
}
/** One typed bounded run. The durable workflow is created once at first claim;
 * every chunk/retry shares its original deadline, spend and reservation ledger. */
export async function processExtraction(pool: pg.Pool, worker: string, profile: Readonly<ExtractionProfile>,
  options: ExtractionWorkOptions = {}): Promise<'idle' | 'unavailable' | 'processed'> {
  let claim: ExtractionClaim | undefined;
  let abort: (() => void) | undefined;
  let cancellation: Promise<void> | undefined;
  const stop = async (reason: string) => {
    if (claim) await extractionOperation(pool, 'SELECT continuum_extraction_stop($1,$2,$3,$4) AS result', [claim.id, worker, claim.generation, reason]);
  };
  try {
    options.signal?.throwIfAborted();
    if (budgetedStageUnavailable(profile.budget, profile.adapter)) return 'idle';
    // Local clock begins before claim/accounting/hydration, leaving ten seconds
    // of lease slack for final SQL. SQL independently checks database time.
    const budget = new Budget(profile.budget);
    const claimStarted = performance.now();
    const selected = await extractionOperation<ExtractionClaim | { outcome: 'unavailable' } | null>(pool,
      'SELECT continuum_extraction_claim($1,$2,$3) AS result', [profile.id, worker, extractionDescriptor(profile)]);
    if (!selected) return 'idle';
    if (selected.outcome !== 'claimed') return 'unavailable';
    claim = selected;
    // Use database remaining duration, not host wall-clock agreement. Charging
    // the complete claim round trip conservatively includes acquisition/SQL.
    const cutoff = claimStarted + claim.remainingMs;
    const assertLive = () => {
      options.signal?.throwIfAborted(); budget.assertLive();
      if (performance.now() >= cutoff) throw new BudgetError('deadline');
    };
    abort = () => {
      budget.cancel();
      cancellation ??= stop('cancelled').catch(() => undefined);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    assertLive();
    const payload = await extractionOperation<string>(pool, 'SELECT continuum_extraction_hydrate($1,$2,$3) AS result', [claim.id, worker, claim.generation]);
    budget.consume({ candidates: 1, hydratedBytes: Buffer.byteLength(payload) });
    let chunks: ReturnType<typeof chunkSource>;
    try { chunks = chunkSource(claim.sourceVersion, payload, profile.chunkBytes, profile.maxChunks); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      await stop('budget'); return 'unavailable';
    }
    const states = await extractionOperation<Array<{ index: number; state: string }>>(pool,
      'SELECT continuum_extraction_prepare($1,$2,$3,$4) AS result', [claim.id, worker, claim.generation,
        JSON.stringify(chunks.map(({ text: _text, sourceFamily: _family, ...metadata }) => metadata))]);
    for (const chunk of chunks) {
      assertLive();
      if (states[chunk.index]?.state !== 'pending') continue;
      let attempt = claim.attempts?.find(a => a.index === chunk.index && a.generation === claim!.generation && a.state === null)?.id;
      if (!attempt) {
        attempt = randomUUID();
        const attached = await extractionOperation<boolean | 'budget'>(pool, 'SELECT continuum_extraction_budget($1,$2,$3,$4,\'attach\',$5,0) AS result',
          [claim.id, worker, claim.generation, attempt, { index: chunk.index }]);
        if (attached !== true) { await stop(attached === 'budget' ? 'budget' : 'ambiguous'); return 'unavailable'; }
      }
      let transient = false;
      const adapter = { ...profile.adapter, serialize: profile.adapter.serialize.bind(profile.adapter),
        invoke: async (...args: Parameters<typeof profile.adapter.invoke>) => {
          try { return await profile.adapter.invoke(...args); }
          catch (error) { transient = error instanceof ExtractionTransientError; throw error; }
        } };
      const authorize = async () => {
        try {
          return await extractionOperation<boolean>(pool, 'SELECT continuum_extraction_budget($1,$2,$3,$4,\'authorize\',\'{}\',0) AS result',
            [claim!.id, worker, claim!.generation, attempt]);
        } catch { return false; }
      };
      // Includes durable settlement rejection. Retain original identities and
      // charges; never substitute a fresh workflow after an ambiguous failure.
      const outcome = await runBudgetedStage(budget, adapter, { schema: EXTRACTION_SCHEMA, prompt: EXTRACTION_PROMPT,
        referenceData: { trust: 'untrusted', sourceVersion: claim.sourceVersion, chunk } },
      { signal: options.signal, transportMs: Math.max(0, Math.floor(cutoff - performance.now())),
        authorize, durable: extractionAttempt(pool, claim, worker, attempt), onWork: options.onWork });
      let output: ExtractionOutput | null = null;
      let failure: string | null = null;
      if (outcome.status === 'complete') {
        try { output = validateAssertions(outcome.value, chunk); }
        catch { failure = 'invalid-output'; }
      } else {
        const reason = outcome.reason;
        const admissionUnavailable = outcome.retryableAdmission === true
          || reason === 'credentials_unavailable' || reason === 'capability_unavailable' || reason === 'pricing_unavailable';
        failure = admissionUnavailable ? 'transient' : reason === 'provider_failed' ? transient ? 'transient' : 'permanent'
          : reason === 'deadline' || reason === 'cancelled' ? reason
          : reason === 'policy_denied' ? 'policy' : reason === 'invalid_response' ? 'invalid-output' : 'budget';
        if (reason === 'deadline' || reason === 'cancelled' || reason === 'stale_attempt') {
          await stop(reason === 'stale_attempt' ? 'ambiguous' : reason); return 'unavailable';
        }
      }
      assertLive();
      try {
        await extractionOperation(pool, 'SELECT continuum_extraction_apply($1,$2,$3,$4,$5,$6,$7) AS result',
          [claim.id, worker, claim.generation, chunk.index, attempt, output, failure], assertLive);
      } catch (error) {
        if ((error as { code?: string }).code !== '54000') throw error;
        await extractionOperation(pool, 'SELECT continuum_extraction_apply($1,$2,$3,$4,$5,NULL,\'budget\') AS result',
          [claim.id, worker, claim.generation, chunk.index, attempt], assertLive);
      }
      if (failure === 'transient') return 'unavailable';
    }
    return 'processed';
  } catch {
    try { await stop(options.signal?.aborted ? 'cancelled' : 'ambiguous'); } catch { /* Stale ownership remains fenced in SQL. */ }
    return 'unavailable';
  } finally {
    if (abort) options.signal?.removeEventListener('abort', abort);
    await cancellation;
  }
}

/** Explicit custom runtime composition only. No generic executor, stock model,
 * hosted fallback or automatically installed profile. Polls one run per profile. */
export class ExtractionWorker {
  private readonly owner = randomUUID();
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private stopped = false;
  constructor(private readonly pool: pg.Pool, private readonly registry: ExtractionRegistry,
    private readonly options: { pollMs?: number; shutdownMs?: number } = {}) {
    for (const [value, min, max] of [[options.pollMs ?? 1000, 100, 30_000], [options.shutdownMs ?? 5000, 1, 10_000]]) {
      if (!Number.isInteger(value) || value < min || value > max) throw new TypeError('Invalid extraction worker bounds');
    }
  }
  private track = (work: Promise<unknown>) => {
    this.pending.add(work); void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
  };
  async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = (async () => {
      for (const id of this.registry.ids()) {
        if (this.stopped) break;
        await processExtraction(this.pool, this.owner, this.registry.get(id)!, { signal: this.controller.signal, onWork: this.track });
      }
    })();
    try { await this.polling; } finally { this.polling = undefined; }
  }
  async start(): Promise<void> {
    if (this.stopped || this.timer) return;
    await requireExtractionReady(this.pool);
    this.timer = setInterval(() => { void this.poll().catch(() => undefined); }, this.options.pollMs ?? 1000);
    this.timer.unref();
  }
  async stop(_reason = 'shutdown'): Promise<void> {
    this.stopped = true; if (this.timer) clearInterval(this.timer); this.controller.abort();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([Promise.allSettled([this.polling, ...this.pending]), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Extraction worker did not settle')), this.options.shutdownMs ?? 5000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
