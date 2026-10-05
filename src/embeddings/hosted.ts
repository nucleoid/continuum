import {
  EmbeddingItemError,
  EmbeddingProviderError,
  embeddingProviderHttpError,
  type EmbeddingProvider,
} from './provider.js';
import {
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  validateEmbeddingTimeout,
  withEmbeddingTimeout,
} from './timeout.js';

interface HostedOptions {
  apiKey: string;
  model: string;
  dim: number;
  endpoint?: string;
  timeoutMs?: number;
  batchSize?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BATCH_SIZE = 32;
const MAX_BATCH_SIZE = 1_000;
const SUCCESS_BODY_BASE_BYTES = 16 * 1024;
const SUCCESS_VECTOR_VALUE_BYTES = 32;
const MAX_SUCCESS_BODY_BYTES = 64 * 1024 * 1024;

interface EmbeddingItem { index?: number; embedding?: unknown }

function invalidResponse(message: string, cause?: unknown): EmbeddingProviderError {
  return new EmbeddingProviderError(
    'EMBEDDING_INVALID_RESPONSE', message, { cause, diagnostic: true },
  );
}

function successBodyLimit(count: number, dim: number): number {
  return Math.min(
    MAX_SUCCESS_BODY_BYTES,
    SUCCESS_BODY_BASE_BYTES + count * dim * SUCCESS_VECTOR_VALUE_BYTES,
  );
}

async function boundedSuccessJson(response: Response, count: number, dim: number): Promise<unknown> {
  // Test doubles may expose json() without a web stream. Real fetch responses
  // always take the bounded stream path.
  if (!response.body) return response.json() as Promise<unknown>;
  const maximum = successBodyLimit(count, dim);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    await response.body.cancel().catch(() => undefined);
    throw invalidResponse('Embedding provider returned an oversized response');
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
      throw invalidResponse('Embedding provider returned an oversized response');
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
  catch (error) { throw invalidResponse('Embedding provider returned invalid JSON', error); }
}

function validateHostedEndpoint(endpoint: string): string {
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch {
    throw new Error('Hosted embedding endpoint must be a valid URL');
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase());
  if (parsed.username || parsed.password || (parsed.protocol !== 'https:'
    && !(parsed.protocol === 'http:' && loopback))) {
    throw new Error('Hosted embedding endpoint must use HTTPS (HTTP is allowed only for loopback)');
  }
  return endpoint;
}

function validateVectors(items: unknown, count: number, dim: number): number[][] {
  if (!Array.isArray(items) || items.length !== count) throw invalidResponse('Provider returned invalid embedding count');
  if (items.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))) {
    throw invalidResponse('Provider returned an invalid embedding item');
  }
  const indexed = (items as EmbeddingItem[])
    .map((item, position) => ({ ...item, index: item.index ?? position }));
  indexed.sort((a, b) => a.index! - b.index!);
  if (indexed.some((item, index) => item.index !== index)) throw invalidResponse('Provider returned invalid embedding indexes');
  return indexed.map((item) => {
    if (!Array.isArray(item.embedding)
      || item.embedding.length !== dim
      || item.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw invalidResponse('Provider returned invalid embedding vector');
    }
    return item.embedding as number[];
  });
}

abstract class HostedEmbeddingProvider implements EmbeddingProvider {
  abstract readonly id: string;
  abstract readonly httpProvider: 'openai' | 'voyage';
  abstract embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
  readonly local = false;
  readonly dim: number;
  protected readonly apiKey: string;
  protected readonly model: string;
  protected readonly endpoint: string;
  protected readonly timeoutMs: number;
  readonly batchSize: number;
  protected readonly fetchImpl: typeof fetch;

  constructor(options: HostedOptions, defaultEndpoint: string) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.dim = options.dim;
    this.endpoint = validateHostedEndpoint(options.endpoint ?? defaultEndpoint);
    this.timeoutMs = validateEmbeddingTimeout(options.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS);
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > MAX_BATCH_SIZE) {
      throw new Error(`Hosted embedding batchSize must be a positive integer at most ${MAX_BATCH_SIZE}`);
    }
    this.batchSize = batchSize;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  protected async request(
    texts: string[], headers: Record<string, string>, body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    try {
      return await withEmbeddingTimeout(this.timeoutMs, signal, async (requestSignal) => {
        let response: Response;
        try {
          response = await this.fetchImpl(this.endpoint, {
            method: 'POST', headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body), signal: requestSignal,
          });
        } catch (error) {
          if (requestSignal.aborted) throw requestSignal.reason ?? error;
          throw new EmbeddingProviderError(
            'EMBEDDING_NETWORK', 'Embedding provider network request failed', { cause: error },
          );
        }
        if (!response.ok) throw await embeddingProviderHttpError(response, this.httpProvider);
        let json: unknown;
        try { json = await boundedSuccessJson(response, texts.length, this.dim); }
        catch (error) {
          if (error instanceof EmbeddingProviderError) throw error;
          throw invalidResponse('Embedding provider returned invalid JSON', error);
        }
        if (json === null || typeof json !== 'object' || Array.isArray(json)) {
          throw invalidResponse('Embedding provider returned an invalid response');
        }
        return validateVectors(
          (json as { data?: unknown }).data ?? [], texts.length, this.dim,
        );
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof EmbeddingProviderError || error instanceof EmbeddingItemError) throw error;
      if (error instanceof Error && /timed out/i.test(error.message)) {
        throw new EmbeddingProviderError(
          'EMBEDDING_TIMEOUT', 'Embedding provider request timed out', { cause: error },
        );
      }
      throw new EmbeddingProviderError(
        'EMBEDDING_NETWORK', 'Embedding provider network request failed', { cause: error },
      );
    }
  }
}

export class OpenAIEmbeddingProvider extends HostedEmbeddingProvider {
  readonly id: string;
  readonly httpProvider = 'openai';
  constructor(options: HostedOptions) {
    super(options, 'https://api.openai.com/v1/embeddings');
    this.id = `openai:${options.model}`;
  }
  async embed(texts: string[], options: { signal?: AbortSignal } = {}): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      const chunk = texts.slice(offset, offset + this.batchSize);
      vectors.push(...await this.request(chunk, { authorization: `Bearer ${this.apiKey}` }, {
        model: this.model, input: chunk, dimensions: this.dim,
      }, options.signal));
    }
    return vectors;
  }
}

export class VoyageEmbeddingProvider extends HostedEmbeddingProvider {
  readonly id: string;
  readonly httpProvider = 'voyage';
  constructor(options: HostedOptions) {
    super(options, 'https://api.voyageai.com/v1/embeddings');
    this.id = `voyage:${options.model}`;
  }
  async embed(texts: string[], options: { signal?: AbortSignal } = {}): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      const chunk = texts.slice(offset, offset + this.batchSize);
      vectors.push(...await this.request(chunk, { authorization: `Bearer ${this.apiKey}` }, {
        model: this.model, input: chunk,
      }, options.signal));
    }
    return vectors;
  }
}
