import { classifyEmbeddingFailure, embeddingProbeAllowed } from '../embeddings/failure-policy.js';

export interface EmbeddingProbeResult {
  ready: Array<{ index: number; vector: number[] }>;
  permanent: number[];
  unresolved: number[];
  calls: number;
  outage: boolean;
  cancelled: boolean;
}

/** Bounded diagnostic work for an already failed batch. Each invocation MUST
 * obtain its own durable attempt from the original workflow/window before I/O.
 * The callback is the embedding-specific dispatch boundary, not a task executor.
 * Nothing here persists poison or advances a backfill cursor. */
export async function probeEmbeddingBatch(count: number,
  dispatch: (indexes: readonly number[]) => Promise<number[][]>, signal?: AbortSignal): Promise<EmbeddingProbeResult> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 32) throw new TypeError('Invalid embedding probe batch');
  const ready = new Map<number, number[]>(), poison = new Set<number>();
  const groups: number[][] = [];
  // The parent call already failed. A singleton cannot diagnose an outage.
  if (count > 1) {
    const middle = Math.ceil(count / 2);
    groups.push(Array.from({ length: middle }, (_, i) => i), Array.from({ length: count - middle }, (_, i) => middle + i));
  }
  let calls = 0, ambiguous = 0;
  while (groups.length && !signal?.aborted && embeddingProbeAllowed(calls, ambiguous)) {
    const indexes = groups.shift()!;
    calls++;
    try {
      const vectors = await dispatch(Object.freeze([...indexes]));
      if (!Array.isArray(vectors) || vectors.length !== indexes.length
        || vectors.some(vector => !Array.isArray(vector) || vector.length !== 768
          || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)))) {
        ambiguous++; continue;
      }
      indexes.forEach((index, i) => ready.set(index, vectors[i]));
    } catch (error) {
      const failure = classifyEmbeddingFailure(error);
      if (failure.action === 'park_provider' || ['EMBEDDING_RATE_LIMIT', 'EMBEDDING_NETWORK', 'EMBEDDING_TIMEOUT'].includes(failure.code)) break;
      if (failure.action !== 'isolate_item') ambiguous++;
      if (indexes.length === 1) {
        if (failure.action === 'isolate_item') poison.add(indexes[0]);
      } else {
        const middle = Math.ceil(indexes.length / 2);
        groups.push(indexes.slice(0, middle), indexes.slice(middle));
      }
    }
  }
  const cancelled = signal?.aborted === true;
  if (cancelled) { ready.clear(); poison.clear(); }
  const outage = !cancelled && ready.size === 0;
  // No successful control means even an all-failing diagnostic tree cannot
  // suppress every source as poison. Explicit successful isolation is required.
  if (outage) poison.clear();
  return { ready: [...ready].sort(([a], [b]) => a - b).map(([index, vector]) => ({ index, vector })),
    permanent: [...poison].sort((a, b) => a - b),
    unresolved: Array.from({ length: count }, (_, i) => i).filter(i => !ready.has(i) && !poison.has(i)), calls, outage, cancelled };
}
