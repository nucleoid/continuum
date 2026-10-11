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
    reason: 'error' | 'timeout' | 'aborted' | 'invalid_output';
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

function cloneAndFreeze<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object' || Object.isFrozen(candidate)) return;
    for (const child of Object.values(candidate)) freeze(child);
    Object.freeze(candidate);
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
  const input = cloneAndFreeze(results) as readonly Readonly<RecallResult>[];
  const controller = new AbortController();
  const abortForShutdown = () => controller.abort();
  options.signal?.addEventListener('abort', abortForShutdown, { once: true });
  if (options.signal?.aborted) controller.abort();
  const completed = new Map<string, EnrichmentOutput>();
  const reported = new Set<string>();
  const tasks = enrichers.map(async (enricher) => {
    try {
      const raw = await enricher.enrich(input, {
        principalId,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const output = validateAndCloneOutput(raw, results.length, options.maxBytes);
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
