import type { RecallResult } from '../types.js';
import { ExtensionRegistry } from './registry.js';

export const DEFAULT_ENRICHER_TIMEOUT_MS = 250;
export const DEFAULT_ENRICHMENT_MAX_BYTES = 16 * 1024;
export const MIN_ENRICHER_TIMEOUT_MS = 1;
export const MAX_ENRICHER_TIMEOUT_MS = 5_000;

export type Enrichment = Readonly<Record<string, unknown>>;
export type EnrichmentOutput = readonly (Enrichment | null)[];

export interface RetrievalEnricherContext {
  readonly principalId: string;
  readonly signal: AbortSignal;
}

export interface RetrievalEnricher {
  readonly id: string;
  enrich(
    results: readonly Readonly<RecallResult>[],
    context: RetrievalEnricherContext,
  ): Promise<EnrichmentOutput>;
}

export class RetrievalEnricherRegistry extends ExtensionRegistry<RetrievalEnricher> {}

export interface EnrichmentLogger {
  warn(event: {
    event: 'retrieval_enricher_failed';
    enricherId: string;
    reason: 'error' | 'timeout' | 'aborted' | 'invalid_output' | 'saturated' | 'oversized_input';
  }): void;
}

export interface EnrichmentOptions {
  timeoutMs: number;
  maxBytes: number;
  logger?: EnrichmentLogger;
  signal?: AbortSignal;
}

const defaultLogger: EnrichmentLogger = {
  warn: (event) => { console.warn(JSON.stringify(event)); },
};

export function enrichmentConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<EnrichmentOptions, 'timeoutMs' | 'maxBytes'> {
  const rawTimeout = env.CONTINUUM_ENRICHER_TIMEOUT_MS;
  const timeoutMs = rawTimeout === undefined
    ? DEFAULT_ENRICHER_TIMEOUT_MS
    : Number(rawTimeout);
  if (!/^\d+$/.test(rawTimeout ?? String(timeoutMs))
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < MIN_ENRICHER_TIMEOUT_MS
    || timeoutMs > MAX_ENRICHER_TIMEOUT_MS) {
    throw new Error(
      `CONTINUUM_ENRICHER_TIMEOUT_MS must be between ${MIN_ENRICHER_TIMEOUT_MS} and ${MAX_ENRICHER_TIMEOUT_MS}`,
    );
  }
  return { timeoutMs, maxBytes: DEFAULT_ENRICHMENT_MAX_BYTES };
}

const MAX_ENRICHER_CALLS = 16;
const MAX_HEALTHY_CALLS_PER_ID = 4;
const MAX_ENRICHER_INPUT_BYTES = 1024 * 1024;
const MAX_RETAINED_INPUT_BYTES = 8 * 1024 * 1024;
const inFlightEnrichers = new Map<string, number>();
const detachedEnrichers = new Map<string, number>();
let activeEnricherCalls = 0;
let retainedInputBytes = 0;

// Conservative UTF-16/key/object estimate, without serializing or cloning large
// input. Metadata depth/node fences also bound the traversal's own work.
function optionalInputBytes(value: unknown): number | null {
  let bytes = 0;
  let nodes = 0;
  const path = new Set<object>();
  const visit = (candidate: unknown, depth: number): boolean => {
    if (++nodes > 10_000 || depth > 32) return false;
    if (typeof candidate === 'string') bytes += 32 + candidate.length * 2;
    else if (candidate === null || candidate === undefined || typeof candidate === 'boolean' || typeof candidate === 'number') bytes += 16;
    else if (candidate instanceof Date) bytes += 128;
    else if (typeof candidate === 'object') {
      if (path.has(candidate)) return false;
      const prototype = Object.getPrototypeOf(candidate);
      if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null) return false;
      path.add(candidate); bytes += 64;
      for (const key in candidate) {
        if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
        bytes += 32 + key.length * 2;
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor || !('value' in descriptor) || bytes > MAX_ENRICHER_INPUT_BYTES || !visit(descriptor.value, depth + 1)) return false;
      }
      path.delete(candidate);
    } else return false;
    return bytes <= MAX_ENRICHER_INPUT_BYTES;
  };
  try { return visit(value, 0) ? bytes : null; } catch { return null; }
}

function cloneAndFreeze<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate !== 'object') return candidate;
    if (candidate instanceof Date) {
      Object.freeze(candidate);
      return new Proxy(candidate, {
        get(target, key) {
          const member: unknown = Reflect.get(target, key, target);
          if (typeof member !== 'function') return member;
          if (typeof key === 'string' && key.startsWith('set')) {
            return () => { throw new TypeError('Enricher input dates are read-only'); };
          }
          return member.bind(target);
        },
      });
    }
    for (const [key, child] of Object.entries(candidate)) {
      (candidate as Record<string, unknown>)[key] = freeze(child);
    }
    return Object.freeze(candidate);
  };
  freeze(clone);
  return clone;
}

function jsonSafe(value: unknown, seen: Set<object>, depth: number, budget: { nodes: number }): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 32 || --budget.nodes < 0) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((item) => jsonSafe(item, seen, depth + 1, budget));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.values(descriptors).every((descriptor) =>
      'value' in descriptor
      && jsonSafe(descriptor.value, seen, depth + 1, budget));
  } finally {
    seen.delete(value);
  }
}

function validateAndCloneOutput(
  output: unknown,
  resultCount: number,
  maxBytes: number,
): EnrichmentOutput | null {
  if (!Array.isArray(output) || output.length !== resultCount) return null;
  if (!jsonSafe(output, new Set(), 0, { nodes: 10_000 })) return null;
  for (const item of output) {
    if (item !== null && (Array.isArray(item) || typeof item !== 'object')) return null;
  }
  const json = JSON.stringify(output);
  if (Buffer.byteLength(json, 'utf8') > maxBytes) return null;
  return cloneAndFreeze(JSON.parse(json) as EnrichmentOutput);
}

export async function applyRetrievalEnrichers(
  results: RecallResult[],
  principalId: string,
  registry: RetrievalEnricherRegistry,
  options: EnrichmentOptions,
): Promise<RecallResult[]> {
  const enrichers = registry.all();
  if (enrichers.length === 0 || results.length === 0) return results;
  if (!Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs < MIN_ENRICHER_TIMEOUT_MS
    || options.timeoutMs > MAX_ENRICHER_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be between ${MIN_ENRICHER_TIMEOUT_MS} and ${MAX_ENRICHER_TIMEOUT_MS}`);
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error('maxBytes must be a positive integer');
  }

  const logger = options.logger ?? defaultLogger;
  const warn = (event: Parameters<EnrichmentLogger['warn']>[0]) => {
    try {
      logger.warn(event);
    } catch {
      // Operational logging must never turn optional enrichment into a request failure.
    }
  };
  if (options.signal?.aborted) {
    for (const enricher of enrichers) warn({ event: 'retrieval_enricher_failed', enricherId: enricher.id, reason: 'aborted' });
    return results;
  }
  const bytes = optionalInputBytes(results);
  if (bytes === null) {
    for (const enricher of enrichers) warn({ event: 'retrieval_enricher_failed', enricherId: enricher.id, reason: 'oversized_input' });
    return results;
  }
  const admitted: RetrievalEnricher[] = [];
  const reported = new Set<string>();
  for (const enricher of enrichers) {
    if ((detachedEnrichers.get(enricher.id) ?? 0) > 0
        || (inFlightEnrichers.get(enricher.id) ?? 0) >= MAX_HEALTHY_CALLS_PER_ID
        || activeEnricherCalls + admitted.length >= MAX_ENRICHER_CALLS
        || retainedInputBytes + bytes > MAX_RETAINED_INPUT_BYTES) {
      warn({ event: 'retrieval_enricher_failed', enricherId: enricher.id, reason: 'saturated' });
      reported.add(enricher.id);
    } else admitted.push(enricher);
  }
  if (admitted.length === 0) return results;
  retainedInputBytes += bytes;
  activeEnricherCalls += admitted.length;
  for (const enricher of admitted) inFlightEnrichers.set(enricher.id, (inFlightEnrichers.get(enricher.id) ?? 0) + 1);
  const unsettledIds = new Set(admitted.map((enricher) => enricher.id));
  const detachedIds = new Set<string>();
  let unsettled = admitted.length;
  const release = (enricher: RetrievalEnricher) => {
    const active = (inFlightEnrichers.get(enricher.id) ?? 1) - 1;
    if (active === 0) inFlightEnrichers.delete(enricher.id); else inFlightEnrichers.set(enricher.id, active);
    unsettledIds.delete(enricher.id);
    if (detachedIds.delete(enricher.id)) {
      const detached = (detachedEnrichers.get(enricher.id) ?? 1) - 1;
      if (detached === 0) detachedEnrichers.delete(enricher.id); else detachedEnrichers.set(enricher.id, detached);
    }
    activeEnricherCalls -= 1;
    if (--unsettled === 0) retainedInputBytes -= bytes;
  };
  let input: readonly Readonly<RecallResult>[];
  try { input = cloneAndFreeze(results); }
  catch {
    for (const enricher of admitted) { release(enricher); warn({ event: 'retrieval_enricher_failed', enricherId: enricher.id, reason: 'error' }); }
    return results;
  }
  const resultCount = results.length;
  const controller = new AbortController();
  controller.signal.addEventListener('abort', () => {
    // Healthy overlap is bounded but allowed. Only unsettled detached calls
    // close admission for an ID until the actual provider promise settles.
    for (const id of unsettledIds) {
      detachedIds.add(id); detachedEnrichers.set(id, (detachedEnrichers.get(id) ?? 0) + 1);
    }
  }, { once: true });
  const abortForShutdown = () => controller.abort();
  options.signal?.addEventListener('abort', abortForShutdown, { once: true });
  if (options.signal?.aborted) controller.abort();
  const completed = new Map<string, EnrichmentOutput>();
  const tasks = admitted.map(async (enricher) => {
    try {
      if (controller.signal.aborted) return;
      const raw = await enricher.enrich(input, {
        principalId,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const output = validateAndCloneOutput(raw, resultCount, options.maxBytes);
      if (!output) {
        warn({
          event: 'retrieval_enricher_failed',
          enricherId: enricher.id,
          reason: 'invalid_output',
        });
        reported.add(enricher.id);
        return;
      }
      completed.set(enricher.id, output);
    } catch {
      if (!controller.signal.aborted) {
        warn({
          event: 'retrieval_enricher_failed',
          enricherId: enricher.id,
          reason: 'error',
        });
        reported.add(enricher.id);
      }
    } finally {
      // A response deadline is not settlement of an abort-ignoring invocation.
      release(enricher);
    }
  });

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), options.timeoutMs);
  });
  const aborted = new Promise<'aborted'>((resolve) => {
    if (controller.signal.aborted) {
      resolve('aborted');
      return;
    }
    controller.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
  const outcome = await Promise.race([
    Promise.all(tasks).then(() => 'complete' as const),
    deadline,
    aborted,
  ]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') {
    controller.abort();
  }
  if (outcome !== 'complete') {
    const unfinished = enrichers.filter((enricher) =>
      !completed.has(enricher.id) && !reported.has(enricher.id));
    for (const enricher of unfinished) {
      warn({
        event: 'retrieval_enricher_failed',
        enricherId: enricher.id,
        reason: outcome === 'timeout' ? 'timeout' : 'aborted',
      });
    }
  }
  options.signal?.removeEventListener('abort', abortForShutdown);

  const accepted = new Map<string, EnrichmentOutput>();
  for (const enricher of enrichers) {
    const output = completed.get(enricher.id);
    if (!output) continue;
    const candidate = new Map(accepted);
    candidate.set(enricher.id, output);
    const serialized = results.map((_result, index) => {
      const namespaces: Record<string, Enrichment> = {};
      for (const extension of enrichers) {
        const value = candidate.get(extension.id)?.[index];
        if (value !== null && value !== undefined) namespaces[extension.id] = value;
      }
      return namespaces;
    });
    const bytes = Buffer.byteLength(JSON.stringify(serialized), 'utf8');
    if (bytes > options.maxBytes) {
      warn({
        event: 'retrieval_enricher_failed',
        enricherId: enricher.id,
        reason: 'invalid_output',
      });
      continue;
    }
    accepted.set(enricher.id, output);
  }
  if (accepted.size === 0) return results;
  return results.map((result, index) => {
    const enrichments: Record<string, Enrichment> = {};
    for (const enricher of enrichers) {
      const value = accepted.get(enricher.id)?.[index];
      if (value !== null && value !== undefined) enrichments[enricher.id] = value;
    }
    return Object.keys(enrichments).length === 0
      ? result
      : { ...result, enrichments: Object.freeze(enrichments) };
  });
}
