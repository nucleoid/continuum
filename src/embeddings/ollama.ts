import {
  EmbeddingProviderError,
  embeddingProviderHttpError,
  type EmbeddingProvider,
} from './provider.js';
import {
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  validateEmbeddingTimeout,
  withEmbeddingTimeout,
} from './timeout.js';

const DEFAULT_BATCH_SIZE = 32;
const MAX_BATCH_SIZE = 1_000;
const SUCCESS_BODY_BASE_BYTES = 16 * 1024;
const SUCCESS_VECTOR_VALUE_BYTES = 32;
const MAX_SUCCESS_BODY_BYTES = 64 * 1024 * 1024;

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

function invalidResponse(message: string, cause?: unknown): EmbeddingProviderError {
  return new EmbeddingProviderError(
    'EMBEDDING_INVALID_RESPONSE', message, { cause, diagnostic: true },
  );
}

async function boundedSuccessJson(response: Response, count: number, dim: number): Promise<unknown> {
  if (!response.body) return response.json() as Promise<unknown>;
  const maximum = Math.min(
    MAX_SUCCESS_BODY_BYTES,
    SUCCESS_BODY_BASE_BYTES + count * dim * SUCCESS_VECTOR_VALUE_BYTES,
  );
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    await response.body.cancel().catch(() => undefined);
    throw invalidResponse('Ollama returned an oversized response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maximum) {
      await reader.cancel().catch(() => undefined);
      throw invalidResponse('Ollama returned an oversized response');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch (error) { throw invalidResponse('Ollama returned invalid JSON', error); }
}

export class EmbeddingTimeoutError extends EmbeddingProviderError {
  constructor(
    readonly providerId: string,
    readonly timeoutMs: number,
    options: { cause?: unknown } = {},
  ) {
    super('EMBEDDING_TIMEOUT', `Embedding request to ${providerId} timed out after ${timeoutMs} ms`, options);
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
          let res: Response;
          try {
            res = await this.fetchImpl(`${this.baseUrl}/api/embed`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model: this.model, input: chunk }),
              signal,
            });
          } catch (error) {
            if (signal.aborted) throw signal.reason ?? error;
            throw new EmbeddingProviderError(
              'EMBEDDING_NETWORK', 'Embedding provider network request failed', { cause: error },
            );
          }
          if (!res.ok) throw await embeddingProviderHttpError(res, 'ollama');
          let json: OllamaEmbedResponse;
          try {
            const decoded = await boundedSuccessJson(res, chunk.length, this.dim);
            if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
              throw invalidResponse('Ollama returned an invalid response object');
            }
            json = decoded as OllamaEmbedResponse;
          } catch (error) {
            if (error instanceof EmbeddingProviderError) throw error;
            throw new EmbeddingProviderError(
              'EMBEDDING_INVALID_RESPONSE',
              'Ollama returned invalid JSON',
              { cause: error },
            );
          }
          if (!Array.isArray(json.embeddings) || json.embeddings.length !== chunk.length) {
            throw new EmbeddingProviderError(
              'EMBEDDING_INVALID_RESPONSE',
              `Ollama returned unexpected embedding cardinality (expected ${chunk.length})`,
            );
          }
          return json.embeddings.map((candidate, index) => {
            if (!Array.isArray(candidate) || candidate.length !== this.dim) {
              throw new EmbeddingProviderError(
                'EMBEDDING_INVALID_RESPONSE',
                `Ollama returned unexpected embedding dimension at index ${index} (expected ${this.dim})`,
              );
            }
            if (!candidate.every((value) => typeof value === 'number' && Number.isFinite(value))) {
              throw new EmbeddingProviderError(
                'EMBEDDING_INVALID_RESPONSE', `Ollama returned an invalid embedding at index ${index}`,
              );
            }
            return candidate as number[];
          });
        });
        out.push(...vectors);
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        if (error instanceof EmbeddingProviderError) throw error;
        if (error instanceof Error && /timed out/i.test(error.message)) {
          throw new EmbeddingTimeoutError(this.id, this.timeoutMs, { cause: error });
        }
        throw error;
      }
    }
    return out;
  }
}
