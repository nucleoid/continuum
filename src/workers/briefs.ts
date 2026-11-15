import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { Budget, BudgetError, budgetedStageUnavailable, runBudgetedStage } from '../pipeline/budget.js';
import { BRIEF_PROMPT, BRIEF_SCHEMA, validateBriefOutput, type BriefInput, type BriefSource, type BriefSection } from '../briefs/model.js';
import { BriefRegistry, briefDescriptor, type BriefProfile } from '../briefs/provider.js';
import { briefAttempt, briefOperation, type BriefClaimLease } from '../storage/briefs.js';
import { requireBriefsReady } from '../storage/provider-lifecycle.js';

/** One domain run. Missing/ambiguous identities never start a replacement budget. */
export async function processBrief(pool: pg.Pool, worker: string, profile: Readonly<BriefProfile>,
  options: { signal?: AbortSignal; onWork?: (work: Promise<unknown>) => void } = {}): Promise<'idle' | 'progress' | 'processed' | 'unavailable'> {
  let lease: BriefClaimLease | undefined; let abort: (() => void) | undefined; let cancellation: Promise<unknown> | undefined;
  const stop = (reason: string) => lease ? briefOperation(pool, 'SELECT continuum_brief_stop($1,$2,$3,$4) AS result',
    [lease.id, worker, lease.generation, reason]) : Promise.resolve();
  try {
    options.signal?.throwIfAborted();
    if (budgetedStageUnavailable(profile.budget, profile.adapter)) return 'idle';
    const budget = new Budget(profile.budget), started = performance.now();
    const selected = await briefOperation<BriefClaimLease | { outcome: 'unavailable' | 'progress' } | null>(pool,
      'SELECT continuum_brief_claim($1,$2,$3) AS result', [profile.id, worker, briefDescriptor(profile)]);
    if (!selected) return 'idle';
    if (selected.outcome === 'progress') return 'progress';
    if (selected.outcome !== 'claimed') return 'unavailable';
    lease = selected;
    const cutoff = started + lease.remainingMs;
    const live = () => { options.signal?.throwIfAborted(); budget.assertLive(); if (performance.now() >= cutoff) throw new BudgetError('deadline'); };
    abort = () => { budget.cancel(); cancellation ??= stop('cancelled').catch(() => undefined); };
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
    budget.consume({ candidates: lease.candidates, hydratedBytes: lease.hydratedBytes, storageBytes: lease.storageBytes, outputBytes: 262144 });
    live();
    const sources = lease.sections.length ? await briefOperation<BriefSource[]>(pool,
      'SELECT continuum_brief_hydrate($1,$2,$3) AS result', [lease.id, worker, lease.generation]) : [];
    let output = { claims: [] } as ReturnType<typeof validateBriefOutput>;
    // These are real independent provider calls. A section can retain its old
    // bytes only because unrelated inputs never reached the call producing it.
    const groups: readonly (readonly BriefSection[])[] = profile.isolation === 'independent-section-requests-v1'
      ? [['purpose'], ['decisions'], ['implementation', 'unknowns', 'coverage']] : [lease.sections];
    for (const group of groups) {
      const sections = lease.sections.filter(section => (group as readonly string[]).includes(section));
      const admitted = sources.filter(source => source.sections?.some(section => sections.includes(section)));
      if (!sections.length || !admitted.length) continue;
      const input: BriefInput = { schema: BRIEF_SCHEMA, prompt: BRIEF_PROMPT, sections,
        referenceData: { trust: 'untrusted', sources: admitted } };
      const attempt = await briefAttempt(pool, lease, worker, sections);
      const authorize = async () => {
        try { return await briefOperation<boolean>(pool, "SELECT continuum_brief_budget($1,$2,$3,'authorize',$4,0) AS result",
          [lease!.id, worker, lease!.generation, { attemptId: attempt.id, descriptor: briefDescriptor(profile) }]); }
        catch { return false; }
      };
      // Settlement I/O rejection is caught by this domain boundary. It retains
      // original durable maxima and cannot expose database/provider error text.
      const result = await runBudgetedStage(budget, profile.adapter, input, { signal: options.signal,
        authorize, retry: lease.retry, transportMs: Math.max(0, Math.floor(cutoff-performance.now())),
        durable: attempt.durable, onWork: options.onWork });
      if (result.status !== 'complete') {
        await stop(result.reason === 'cancelled' ? 'cancelled' : result.reason === 'deadline' ? 'deadline'
          : result.reason === 'policy_denied' ? 'policy' : result.reason === 'provider_failed' ? 'provider' : 'budget');
        return 'unavailable';
      }
      try { output.claims.push(...validateBriefOutput(result.value, input).claims); }
      catch { await stop('invalid-output'); return 'unavailable'; }
    }
    live();
    await briefOperation(pool, 'SELECT continuum_brief_apply($1,$2,$3,$4) AS result', [lease.id, worker, lease.generation, output], live);
    return 'processed';
  } catch {
    try { await stop(options.signal?.aborted ? 'cancelled' : 'ambiguous'); } catch { /* SQL fences remain authoritative. */ }
    return 'unavailable';
  } finally { if (abort) options.signal?.removeEventListener('abort', abort); await cancellation; }
}

/** Explicit custom composition only; stock runtimes install no synthesis worker. */
export class BriefWorker {
  private readonly owner = randomUUID();
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private stopped = false;
  constructor(private readonly pool: pg.Pool, private readonly registry: BriefRegistry,
    private readonly options: { pollMs?: number; shutdownMs?: number } = {}) {
    for (const [value,min,max] of [[options.pollMs ?? 1000,100,30000],[options.shutdownMs ?? 5000,1,10000]])
      if (!Number.isInteger(value) || value<min || value>max) throw new TypeError('Invalid brief worker bounds');
  }
  private track = (work: Promise<unknown>) => { this.pending.add(work); void work.then(() => this.pending.delete(work), () => this.pending.delete(work)); };
  async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = (async () => { for (const id of this.registry.ids()) {
      if (this.stopped) break;
      await processBrief(this.pool,this.owner,this.registry.get(id)!,{ signal: this.controller.signal,onWork: this.track });
    } })();
    try { await this.polling; } finally { this.polling=undefined; }
  }
  async start(): Promise<void> {
    if (this.stopped || this.timer) return;
    await requireBriefsReady(this.pool);
    this.timer=setInterval(() => { void this.poll().catch(() => undefined); },this.options.pollMs ?? 1000); this.timer.unref();
  }
  async stop(_reason = 'shutdown'): Promise<void> {
    this.stopped=true; if (this.timer) clearInterval(this.timer); this.controller.abort();
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([Promise.allSettled([this.polling,...this.pending]),new Promise<never>((_,reject) => {
      timer=setTimeout(() => reject(new Error('Brief worker did not settle')),this.options.shutdownMs ?? 5000);
    })]); } finally { if (timer) clearTimeout(timer); }
  }
}
