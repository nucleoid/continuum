import { EmbeddingProviderError, isEmbeddingItemError } from './provider.js';

export type EmbeddingFailureCode = 'EMBEDDING_ITEM_FAILED' | 'EMBEDDING_INPUT_TOO_LARGE'
  | 'EMBEDDING_TIMEOUT' | 'EMBEDDING_NETWORK' | 'EMBEDDING_AUTH' | 'EMBEDDING_RATE_LIMIT'
  | 'EMBEDDING_SERVER' | 'EMBEDDING_INVALID_RESPONSE' | 'EMBEDDING_FAILED'
  | 'EMBEDDING_STORAGE' | 'EMBEDDING_BUDGET' | 'EMBEDDING_POLICY' | 'EMBEDDING_CANCELLED';
export interface EmbeddingFailure {
  code: EmbeddingFailureCode;
  action: 'retry' | 'park_provider' | 'isolate_item';
  retryAfterMs?: number;
}
export const EMBEDDING_RETRY_MIN_MS = 1000;
export const EMBEDDING_RETRY_MAX_MS = 300_000;

/** Raw header exists only at the adapter boundary. Return a bounded number only.
 * Accept HTTP IMF-fixdate, not Date.parse's permissive numeric/date grammar. */
export function embeddingRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (value === null || value.length > 128 || !Number.isFinite(nowMs)) return undefined;
  const text = value.trim();
  let delay: number;
  if (/^\d+$/.test(text)) delay = Number(text) * 1000;
  else {
    if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return undefined;
    const at = Date.parse(text);
    if (!Number.isFinite(at) || new Date(at).toUTCString() !== text) return undefined;
    delay = at - nowMs;
  }
  if (Number.isNaN(delay)) return undefined;
  return Math.min(EMBEDDING_RETRY_MAX_MS, Math.max(EMBEDDING_RETRY_MIN_MS, delay));
}

/** No error text, status-only poison inference, duck-typed item flags or headers.
 * An item error on a multi-input call requests bounded isolation, not blanket
 * permanent failure. Existing adapters remain the explicit item authority. */
export function classifyEmbeddingFailure(error: unknown): EmbeddingFailure {
  if (isEmbeddingItemError(error)) return { code: 'EMBEDDING_ITEM_FAILED', action: 'isolate_item' };
  if (!(error instanceof EmbeddingProviderError)) return { code: 'EMBEDDING_FAILED', action: 'retry' };
  const failure: EmbeddingFailure = { code: error.code, action: error.code === 'EMBEDDING_AUTH' ? 'park_provider' : 'retry' };
  // provider.ts will expose this sanitized field in the integration phase.
  const retry = (error as EmbeddingProviderError & { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof retry === 'number' && Number.isSafeInteger(retry) && retry >= 0) {
    failure.retryAfterMs = Math.min(EMBEDDING_RETRY_MAX_MS, Math.max(EMBEDDING_RETRY_MIN_MS, retry));
  }
  return failure;
}

/** Equal jitter keeps every retry delayed, with a bounded exponent even after a
 * prolonged outage. Failures do not consume a lifetime job-attempt limit. */
export function embeddingBackoffMs(failures: number, random: number, retryAfterMs?: number): number {
  if (!Number.isSafeInteger(failures) || failures < 1 || !Number.isFinite(random) || random < 0 || random >= 1
    || (retryAfterMs !== undefined && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0))) {
    throw new TypeError('Invalid embedding retry bounds');
  }
  const ceiling = Math.min(EMBEDDING_RETRY_MAX_MS, EMBEDDING_RETRY_MIN_MS * 2 ** Math.min(failures - 1, 20));
  const jitter = Math.floor(ceiling / 2 + random * ceiling / 2);
  return Math.min(EMBEDDING_RETRY_MAX_MS, Math.max(EMBEDDING_RETRY_MIN_MS, jitter, retryAfterMs ?? 0));
}

export interface EmbeddingCircuit {
  state: 'closed' | 'open' | 'half_open' | 'parked';
  failures: number;
  nextProbeAtMs: number;
}
/** Planning primitive. Persist under a target lock and use database time. Only
 * the SQL half-open lease may grant a probe; a local calculation is no permit. */
export function embeddingCircuitFailure(previous: EmbeddingCircuit, failure: EmbeddingFailure, nowMs: number, random: number): EmbeddingCircuit {
  if (!Number.isSafeInteger(previous.failures) || previous.failures < 0 || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('Invalid embedding circuit state');
  }
  const failures = Math.min(Number.MAX_SAFE_INTEGER, previous.failures + 1);
  const delay = embeddingBackoffMs(failures, random, failure.retryAfterMs);
  if (!Number.isSafeInteger(nowMs + delay)) throw new TypeError('Invalid embedding circuit time');
  return { state: failure.action === 'park_provider' || previous.state === 'parked' ? 'parked' : 'open',
    failures, nextProbeAtMs: nowMs + delay };
}

/** One failed batch gets at most 64 diagnostic calls and eight ambiguous
 * failures. An all-failing ambiguous tree never establishes item poison. */
export function embeddingProbeAllowed(calls: number, ambiguousFailures: number): boolean {
  return Number.isSafeInteger(calls) && calls >= 0 && calls < 64
    && Number.isSafeInteger(ambiguousFailures) && ambiguousFailures >= 0 && ambiguousFailures < 8;
}
