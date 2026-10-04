import type { EmbeddingProvider } from './provider.js';
import {
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  validateEmbeddingTimeout,
  withEmbeddingTimeout,
} from './timeout.js';

const DEFAULT_BATCH_SIZE = 32;
const MAX_BATCH_SIZE = 1_000;

export interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
  dim: number;
  timeoutMs?: number;
  batchSize?: number;
  fetchImpl?: typeof fetch;
}

interface OllamaEmbedResponse {
  embeddings?: unknown;
}

export class EmbeddingTimeoutError extends Error {
  readonly code = 'EMBEDDING_TIMEOUT';

  constructor(
    readonly providerId: string,
    readonly timeoutMs: number,
    options: { cause?: unknown } = {},
  ) {
    super(`Embedding request to ${providerId} exceeded ${timeoutMs} ms`, options);
    this.name = 'EmbeddingTimeoutError';
  }
}

function positiveInteger(value: number, name: string, maximum?: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (maximum !== undefined && value > maximum) {
    throw new Error(`${name} must be at most ${maximum}`);
  }
  return value;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  readonly local = true;
  readonly timeoutMs: number;
  readonly batchSize: number;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaProviderOptions) {
    this.id = `ollama:${opts.model}`;
    this.dim = opts.dim;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.model = opts.model;
    this.batchSize = positiveInteger(opts.batchSize ?? DEFAULT_BATCH_SIZE, 'Ollama batchSize', MAX_BATCH_SIZE);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = validateEmbeddingTimeout(opts.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS);
  }

  async embed(texts: string[], options: { signal?: AbortSignal } = {}): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      options.signal?.throwIfAborted();
      const chunk = texts.slice(offset, offset + this.batchSize);
      try {
        const vectors = await withEmbeddingTimeout(this.timeoutMs, options.signal, async (signal) => {
          const res = await this.fetchImpl(`${this.baseUrl}/api/embed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.model, input: chunk }),
          signal,
        });
        if (!res.ok) {
          throw new Error(`Ollama embed failed: ${res.status} ${res.statusText}`);
        }
        const json = (await res.json()) as OllamaEmbedResponse;
        if (!Array.isArray(json.embeddings) || json.embeddings.length !== chunk.length) {
          throw new Error(`Ollama returned unexpected embedding cardinality (expected ${chunk.length})`);
        }
        return json.embeddings.map((candidate, index) => {
          if (!Array.isArray(candidate) || candidate.length !== this.dim) {
            throw new Error(`Ollama returned unexpected embedding dimension at index ${index} (expected ${this.dim})`);
          }
          if (!candidate.every((value) => typeof value === 'number' && Number.isFinite(value))) {
            throw new Error(`Ollama returned an invalid embedding at index ${index}`);
          }
          return candidate as number[];
        });
        });
        out.push(...vectors);
      } catch (error) {
        if (error instanceof Error && /timed out/i.test(error.message)) {
          throw new EmbeddingTimeoutError(this.id, this.timeoutMs, { cause: error });
        }
        throw error;
      }
    }
    return out;
  }
}
