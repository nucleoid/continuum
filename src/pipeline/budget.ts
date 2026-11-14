import { randomUUID } from 'node:crypto';
import { BudgetReceipts, MAX_RECEIPT_BYTES, FAILURE_RECEIPT_BYTES, type BudgetReason, type UsageProvenance } from './receipts.js';

export const budgetDimensions = ['candidates', 'hydratedBytes', 'inputBytes', 'contextTokens',
  'outputBytes', 'outputTokens', 'reasoningTokens', 'completionTokens', 'calls', 'retries',
  'artifactBytes', 'storageBytes', 'spendMicros'] as const;
export type BudgetDimension = typeof budgetDimensions[number];
export type BudgetAmounts = Record<BudgetDimension, number>;
export interface BudgetProfile {
  version: 1;
  id: string;
  currency: string;
  rateSchedule: string;
  limits: Readonly<BudgetAmounts>;
  maxItemHydratedBytes: number;
  maxConcurrency: number;
  maxRetainedBytes: number;
  overallMs: number;
  stageMs: number;
}
export class BudgetError extends Error {
  constructor(readonly reason: BudgetReason = 'budget_exhausted') { super(`Pipeline stage unavailable: ${reason}`); }
}
const integer = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Budget values must be nonnegative safe integers');
  return value;
};
export function amounts(values: Partial<BudgetAmounts> = {}): BudgetAmounts {
  if (Object.keys(values).some((key) => !budgetDimensions.includes(key as BudgetDimension))) throw new TypeError('Unknown budget dimension');
  return Object.fromEntries(budgetDimensions.map((key) => [key, integer(values[key] ?? 0)])) as BudgetAmounts;
}
export function checkedProfile(input: BudgetProfile): Readonly<BudgetProfile> {
  const limits = amounts(input.limits);
  if (Object.keys(input.limits).length !== budgetDimensions.length || input.version !== 1
    || !/^[a-z][a-z0-9.-]{0,63}$/.test(input.id) || !/^[A-Z]{3}$/.test(input.currency)
    || !/^[a-z][a-z0-9.-]{0,63}$/.test(input.rateSchedule)) throw new TypeError('Invalid budget profile identity');
  for (const value of [input.maxItemHydratedBytes, input.maxConcurrency, input.maxRetainedBytes, input.overallMs, input.stageMs]) {
    if (integer(value) < 1) throw new TypeError('Budget bounds must be positive');
  }
  if (input.maxItemHydratedBytes > limits.hydratedBytes || input.stageMs > input.overallMs
    || input.overallMs > 86_400_000 || input.stageMs > 300_000 || input.maxConcurrency > 1024
    || limits.calls > 1024 || limits.candidates > 10_000 || limits.outputBytes < FAILURE_RECEIPT_BYTES
    || limits.reasoningTokens + limits.outputTokens > limits.completionTokens) throw new TypeError('Incompatible budget bounds');
  return Object.freeze({ version: 1, id: input.id, currency: input.currency, rateSchedule: input.rateSchedule,
    limits: Object.freeze(limits), maxItemHydratedBytes: input.maxItemHydratedBytes,
    maxConcurrency: input.maxConcurrency, maxRetainedBytes: input.maxRetainedBytes,
    overallMs: input.overallMs, stageMs: input.stageMs });
}
export const starterProfile = checkedProfile({
  version: 1, id: 'foreground-v1', currency: 'USD', rateSchedule: 'local-zero-v1',
  limits: { candidates: 200, hydratedBytes: 4 * 1024 * 1024, inputBytes: 1024 * 1024,
    contextTokens: 16_384, outputBytes: 1024 * 1024, outputTokens: 2048, reasoningTokens: 0,
    completionTokens: 2048, calls: 4, retries: 3, artifactBytes: 1024 * 1024, storageBytes: 1024 * 1024, spendMicros: 0 },
  maxItemHydratedBytes: 1024 * 1024, maxConcurrency: 2, maxRetainedBytes: 4 * 1024 * 1024,
  overallMs: 30_000, stageMs: 5_000,
});

/** Strict incremental JSON. Rejects executable shapes rather than invoking them.
 * Every temporary quoted string is at most 256 UTF-16 units. */
export function boundedJson(value: unknown, maxBytes: number): string {
  integer(maxBytes);
  const parts: string[] = []; let bytes = 0; let nodes = 0;
  const path = new Set<object>();
  const append = (part: string) => {
    bytes += Buffer.byteLength(part);
    if (bytes > maxBytes) throw new BudgetError();
    parts.push(part);
  };
  const quote = (s: string) => {
    append('"');
    for (let start = 0; start < s.length; start += 256) append(JSON.stringify(s.slice(start, start + 256)).slice(1, -1));
    append('"');
  };
  const invalid = () => { throw new TypeError('Unsupported pipeline serialization'); };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 10_000 || depth > 32) return invalid();
    if (item === null) { append('null'); return; }
    if (typeof item === 'string') { quote(item); return; }
    if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) { append(String(item)); return; }
    if (item instanceof Date) { quote(Date.prototype.toISOString.call(item)); return; }
    if (typeof item !== 'object' || path.has(item)) return invalid();
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return invalid();
    if (Object.getOwnPropertySymbols(item).length) return invalid();
    path.add(item);
    if (Array.isArray(item)) {
      if (item.length > 10_000) return invalid();
      append('[');
      for (let i = 0; i < item.length; i++) {
        if (i) append(',');
        const d = Object.getOwnPropertyDescriptor(item, String(i));
        if (!d || !('value' in d)) return invalid();
        visit(d.value, depth + 1);
      }
      append(']');
    } else {
      append('{'); let first = true;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (++nodes > 10_000) return invalid();
        const d = Object.getOwnPropertyDescriptor(item, key);
        if (!d || !('value' in d)) return invalid();
        if (!first) append(','); first = false;
        quote(key); append(':'); visit(d.value, depth + 1);
      }
      append('}');
    }
    path.delete(item);
  };
  visit(value, 0); return parts.join('');
}

interface Reservation { amount: BudgetAmounts; retained: number; settlement?: string; }
export class Budget {
  readonly profile: Readonly<BudgetProfile>;
  readonly receipts: BudgetReceipts;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly started: number;
  private readonly reservations = new Map<string, Reservation>();
  private readonly used = amounts();
  private active = 0;
  private retainedBytes = 0;
  constructor(profile: BudgetProfile, private readonly clock: () => number = () => performance.now()) {
    this.profile = checkedProfile(profile); this.started = clock(); this.signal = this.controller.signal;
    const receiptBytes = Math.min(MAX_RECEIPT_BYTES, this.profile.limits.outputBytes);
    this.receipts = new BudgetReceipts(receiptBytes);
    this.used.outputBytes = receiptBytes; // Includes one fixed safe failure receipt, never recursive.
  }
  child(): Budget { return this; }
  elapsedMs(): number { return Math.max(0, Math.floor(this.clock() - this.started)); }
  remainingMs(cap = this.profile.stageMs): number { return Math.max(0, Math.min(integer(cap), this.profile.overallMs - this.elapsedMs())); }
  assertLive(): void {
    if (this.signal.aborted) throw new BudgetError('cancelled');
    if (this.remainingMs(this.profile.overallMs) < 1) throw new BudgetError('deadline');
  }
  cancel(): void { this.controller.abort(); }
  snapshot(): { used: BudgetAmounts; active: number; retainedBytes: number } {
    return { used: { ...this.used }, active: this.active, retainedBytes: this.retainedBytes };
  }
  report() {
    return { profile: this.profile, usage: this.snapshot(), elapsedMs: this.elapsedMs(),
      remainingMs: this.remainingMs(this.profile.overallMs), cancelled: this.signal.aborted,
      receipts: this.receipts.snapshot() };
  }
  available(key: BudgetDimension): number { return this.profile.limits[key] - this.used[key]; }
  serializeOutput(value: unknown): string {
    this.assertLive();
    const serialized = boundedJson(value, this.available('outputBytes'));
    this.consume({ outputBytes: Buffer.byteLength(serialized) });
    return serialized;
  }
  consume(values: Partial<BudgetAmounts>): void {
    this.assertLive(); const delta = amounts(values);
    for (const key of budgetDimensions) if (delta[key] > this.available(key)) throw new BudgetError();
    for (const key of budgetDimensions) this.used[key] += delta[key];
  }
  reserve(values: Partial<BudgetAmounts>, retained: number): string {
    this.assertLive(); integer(retained);
    // Reservations always represent attempts; bound retained identity history too.
    if (values.calls !== 1 || this.active >= this.profile.maxConcurrency
      || retained > this.profile.maxRetainedBytes - this.retainedBytes) throw new BudgetError();
    const delta = amounts(values);
    if (delta.inputBytes > retained - delta.outputBytes) throw new BudgetError();
    this.consume(delta);
    const id = randomUUID(); this.reservations.set(id, { amount: delta, retained });
    this.active++; this.retainedBytes += retained;
    this.receipts.add({ event: 'reserved', elapsedMs: this.elapsedMs() });
    return id;
  }
  settle(id: string, actual: Partial<Pick<BudgetAmounts, 'spendMicros' | 'outputBytes' | 'outputTokens' | 'reasoningTokens' | 'completionTokens'>>,
    provenance: UsageProvenance = Object.keys(actual).length ? 'measured' : 'unknown'): void {
    const reservation = this.reservations.get(id);
    if (!reservation) throw new Error('Unknown pipeline reservation');
    const keys = Object.keys(actual) as Array<keyof typeof actual>;
    if (keys.some((key) => !['spendMicros', 'outputBytes', 'outputTokens', 'reasoningTokens', 'completionTokens'].includes(key))) throw new Error('Invalid pipeline settlement');
    if (!['measured', 'provider-reported', 'estimated', 'unknown'].includes(provenance)) throw new Error('Invalid usage provenance');
    const identity = boundedJson({ actual: Object.fromEntries(keys.sort().map((key) => [key, integer(actual[key]!)])), provenance }, 1024);
    if (reservation.settlement !== undefined) {
      if (reservation.settlement !== identity) throw new Error('Conflicting pipeline settlement');
      return;
    }
    for (const key of keys) if (actual[key]! > reservation.amount[key]) throw new Error('Pipeline usage exceeds reservation');
    for (const key of keys) this.used[key] -= reservation.amount[key] - actual[key]!;
    reservation.settlement = identity;
    this.active--; this.retainedBytes -= reservation.retained;
    this.receipts.add({ event: 'settled', elapsedMs: this.elapsedMs(), provenance });
  }
}

export interface PriceSchedule {
  id: string; currency: string; unitTokens: number; inputMicros: number; outputMicros: number; reasoningMicros: number;
}
export interface TokenAccounting {
  kind: 'exact' | 'conservative'; model: string; profile: string; validationId: string;
  overheadTokens: number; count(serialized: string): number;
}
export interface AdapterCaps { outputTokens: number; reasoningTokens: number; completionTokens: number; }
export interface AdapterUsage extends AdapterCaps { provenance: UsageProvenance; }
export interface BudgetAdapter<Input, Output> extends AdapterCaps {
  id: string; model: string; profile: string; local: boolean; timeoutMs: number;
  credentials?: 'available' | 'not-required' | 'missing';
  responseBodyBytes: number; enforceableCaps: boolean; cancellation: 'cooperative' | 'unsupported';
  tokens?: TokenAccounting; price?: PriceSchedule;
  /** Must include all prompts, metadata, citations, tools and model/protocol wrappers. No credentials. */
  serialize(input: Input, caps: Readonly<AdapterCaps>): unknown;
  /** Send these exact serialized bytes, enforcing caps and response-body bounds at the adapter. */
  invoke(serialized: string, context: Readonly<AdapterCaps> & { signal: AbortSignal; timeoutMs: number; responseBodyBytes: number }): Promise<{ value: Output; response: unknown; usage?: AdapterUsage }>;
}
export function priceMicros(price: PriceSchedule, input: number, output: number, reasoning: number): number {
  const unit = BigInt(integer(price.unitTokens)); if (unit < 1n) throw new TypeError('Invalid price unit');
  const rounded = (tokens: number, rate: number) => (BigInt(integer(tokens)) * BigInt(integer(rate)) + unit - 1n) / unit;
  const total = rounded(input, price.inputMicros) + rounded(output, price.outputMicros) + rounded(reasoning, price.reasoningMicros);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new BudgetError();
  return Number(total);
}
export type StageOutcome<T> = { status: 'complete'; value: T; provenance: UsageProvenance } | { status: 'skipped'; reason: BudgetReason };
/** Optional durable hooks must commit before invocation and recheck publication at settlement.
 * A duplicate/ambiguous attempt must never return a dispatch permit. */
export interface DurableAttempt {
  reserve(amount: BudgetAmounts, retainedBytes: number): Promise<boolean>;
  dispatch(): Promise<boolean>;
  settle(actual: Partial<BudgetAmounts>, provenance?: UsageProvenance): Promise<boolean>;
}
// Replacement budgets/registries cannot clear unsettled provider fences. These
// finite process limits tighten every caller profile and are not per-ID quotas.
const processCalls = new Map<string, { active: number; detached: number }>();
let processActive = 0;
let processRetained = 0;
export async function runBudgetedStage<I, O>(budget: Budget, adapter: BudgetAdapter<I, O>, input: I,
  options: { signal?: AbortSignal; retry?: boolean; authorize?: () => Promise<boolean>; durable?: DurableAttempt; transportMs?: number;
    onWork?: (settlement: Promise<unknown>) => void } = {},
): Promise<StageOutcome<O>> {
  const skip = (reason: BudgetReason): StageOutcome<O> => {
    budget.receipts.add({ event: 'skipped', reason, elapsedMs: budget.elapsedMs() });
    return { status: 'skipped', reason };
  };
  let id: string;
  let serialized: string;
  let inputTokens: number;
  let caps: AdapterCaps;
  let reserve: BudgetAmounts;
  let timeoutMs: number;
  let processKey: string;
  let retained: number;
  let processState: { active: number; detached: number };
  const enteredAt = performance.now();
  // Snapshot pricing before awaits. Mutating adapter configuration cannot refund
  // a request priced under a different schedule.
  let price: Readonly<PriceSchedule>;
  try {
    budget.assertLive();
    if (options.signal?.aborted) return skip('cancelled');
    if (adapter.credentials === 'missing') return skip('credentials_unavailable');
    if (typeof adapter.local !== 'boolean' || !adapter.model || !adapter.profile || !adapter.enforceableCaps
      || !adapter.tokens || adapter.tokens.model !== adapter.model || adapter.tokens.profile !== adapter.profile
      || !adapter.tokens.validationId || !['exact', 'conservative'].includes(adapter.tokens.kind)) return skip('capability_unavailable');
    if (!adapter.price || adapter.price.id !== budget.profile.rateSchedule || adapter.price.currency !== budget.profile.currency) return skip('pricing_unavailable');
    price = Object.freeze({ ...adapter.price });
    timeoutMs = Math.floor(budget.remainingMs(Math.min(budget.profile.stageMs, integer(adapter.timeoutMs),
      integer(options.transportMs ?? budget.profile.stageMs))));
    if (timeoutMs < 1) return skip('deadline');
    caps = { outputTokens: integer(adapter.outputTokens), reasoningTokens: integer(adapter.reasoningTokens), completionTokens: integer(adapter.completionTokens) };
    if (caps.outputTokens + caps.reasoningTokens > caps.completionTokens) return skip('capability_unavailable');
    const outputBytes = integer(adapter.responseBodyBytes);
    if (outputBytes < 1) return skip('capability_unavailable');
    serialized = boundedJson(adapter.serialize(input, Object.freeze(caps)), budget.available('inputBytes'));
    inputTokens = integer(adapter.tokens.count(serialized)) + integer(adapter.tokens.overheadTokens);
    integer(inputTokens);
    reserve = amounts({ inputBytes: Buffer.byteLength(serialized), contextTokens: inputTokens,
      ...caps, outputBytes, calls: 1, retries: options.retry ? 1 : 0,
      spendMicros: priceMicros(price, inputTokens, caps.outputTokens, caps.reasoningTokens) });
    timeoutMs = Math.floor(Math.min(timeoutMs - (performance.now() - enteredAt), budget.remainingMs(timeoutMs)));
    if (timeoutMs < 1) return skip('deadline');
    if (typeof adapter.id !== 'string' || adapter.id.length > 200 || adapter.model.length > 200 || adapter.profile.length > 200) return skip('capability_unavailable');
    processKey = `${adapter.id}\u0000${adapter.model}\u0000${adapter.profile}`;
    processState = processCalls.get(processKey) ?? { active: 0, detached: 0 };
    retained = reserve.inputBytes + outputBytes;
    if (processState.detached || processState.active >= 4 || processActive >= 128 || retained > 64 * 1024 * 1024 - processRetained) return skip('budget_exhausted');
    id = budget.reserve(reserve, retained);
    processState.active++; processActive++; processRetained += retained;
    processCalls.set(processKey, processState);
  } catch (error) { return skip(error instanceof BudgetError ? error.reason : 'capability_unavailable'); }
  const stopAt = performance.now() + timeoutMs;
  const invoke = adapter.invoke.bind(adapter);
  const controller = new AbortController();
  let detached = false;
  let settled = false;
  controller.signal.addEventListener('abort', () => {
    if (!settled && !detached) { detached = true; processState.detached++; }
  }, { once: true });
  const abort = () => controller.abort();
  const stageLive = () => {
    if (performance.now() >= stopAt) controller.abort();
    return !controller.signal.aborted;
  };
  budget.signal.addEventListener('abort', abort, { once: true });
  options.signal?.addEventListener('abort', abort, { once: true });
  if (budget.signal.aborted || options.signal?.aborted) controller.abort();
  let timer: NodeJS.Timeout | undefined;
  const stopped = new Promise<StageOutcome<O>>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(skip(budget.signal.aborted || options.signal?.aborted ? 'cancelled' : 'deadline')), { once: true });
    timer = setTimeout(abort, timeoutMs);
    if (controller.signal.aborted) resolve(skip('cancelled'));
  });
  const work = (async (): Promise<StageOutcome<O>> => {
    let durableReserved = false;
    let invoked = false;
    let actual: Partial<BudgetAmounts> = {};
    let provenance: UsageProvenance = 'unknown';
    try {
      if (options.durable) {
        durableReserved = await options.durable.reserve(reserve, reserve.inputBytes + reserve.outputBytes);
        if (!durableReserved) return skip('stale_attempt');
      }
      if (!stageLive()) return skip('deadline');
      if (options.authorize && !await options.authorize()) return skip('policy_denied');
      if (!stageLive()) return skip('deadline');
      budget.assertLive();
      if (options.durable && !await options.durable.dispatch()) return skip('stale_attempt');
      if (!stageLive()) return skip('deadline');
      invoked = true;
      const result = await invoke(serialized, { ...caps, signal: controller.signal,
        timeoutMs: Math.max(1, Math.floor(Math.min(stopAt - performance.now(), budget.remainingMs(timeoutMs)))), responseBodyBytes: reserve.outputBytes });
      const output = boundedJson(result.response, reserve.outputBytes);
      actual.outputBytes = Buffer.byteLength(output);
      const usage = result.usage;
      if (usage) {
        if (!['measured', 'provider-reported', 'estimated', 'unknown'].includes(usage.provenance)) return skip('invalid_response');
        for (const key of ['outputTokens', 'reasoningTokens', 'completionTokens'] as const) {
          if (integer(usage[key]) > caps[key]) return skip('invalid_response');
        }
        if (usage.outputTokens + usage.reasoningTokens > usage.completionTokens) return skip('invalid_response');
        provenance = usage.provenance;
        // Estimates/unknown do not establish that a maximum charge can be refunded.
        if (usage.provenance === 'measured' || usage.provenance === 'provider-reported') {
          actual = { ...actual, outputTokens: usage.outputTokens, reasoningTokens: usage.reasoningTokens,
            completionTokens: usage.completionTokens, spendMicros: priceMicros(price, inputTokens, usage.outputTokens, usage.reasoningTokens) };
        }
      }
      if (!stageLive()) return skip('deadline');
      budget.assertLive();
      if (options.authorize && !await options.authorize()) return skip('policy_denied');
      if (!stageLive()) return skip('deadline');
      const publish = !options.durable || await options.durable.settle(actual, provenance);
      durableReserved = false;
      if (!publish || !stageLive()) return skip('stale_attempt');
      return { status: 'complete', value: result.value, provenance: usage?.provenance ?? 'unknown' };
    } catch (error) { return skip(error instanceof BudgetError ? error.reason : 'provider_failed'); }
    finally {
      if (!invoked) actual = { spendMicros: 0, outputBytes: 0, outputTokens: 0, reasoningTokens: 0, completionTokens: 0 };
      try { if (durableReserved) await options.durable!.settle(actual, provenance); }
      finally {
        budget.settle(id, actual, provenance);
        settled = true; processState.active--; processActive--; processRetained -= retained;
        if (detached) processState.detached--;
        if (!processState.active) processCalls.delete(processKey);
      }
    }
  })();
  options.onWork?.(work);
  try { return await Promise.race([work, stopped]); }
  finally {
    if (timer) clearTimeout(timer);
    budget.signal.removeEventListener('abort', abort);
    options.signal?.removeEventListener('abort', abort);
    // work retains its reservation and signal until the underlying promise settles.
    void work.catch(() => undefined);
  }
}
