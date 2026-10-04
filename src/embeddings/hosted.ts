import type { EmbeddingProvider } from './provider.js';

interface HostedOptions {
  apiKey: string;
  model: string;
  dim: number;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface EmbeddingItem { index?: number; embedding?: unknown }

function validateVectors(items: EmbeddingItem[], count: number, dim: number): number[][] {
  if (!Array.isArray(items) || items.length !== count) throw new Error('Provider returned invalid embedding count');
  const indexed = items.map((item, position) => ({ ...item, index: item.index ?? position }));
  indexed.sort((a, b) => a.index! - b.index!);
  if (indexed.some((item, index) => item.index !== index)) throw new Error('Provider returned invalid embedding indexes');
  return indexed.map((item) => {
    if (!Array.isArray(item.embedding)
      || item.embedding.length !== dim
      || item.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('Provider returned invalid embedding vector');
    }
    return item.embedding as number[];
  });
}

async function withTimeout<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const forward = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forward, { once: true });
  if (signal?.aborted) forward();
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error('Embedding request timed out');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), deadline]); } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forward);
  }
}

abstract class HostedEmbeddingProvider implements EmbeddingProvider {
  abstract readonly id: string;
  abstract embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
  readonly local = false;
  readonly dim: number;
  protected readonly apiKey: string;
  protected readonly model: string;
  protected readonly endpoint: string;
  protected readonly timeoutMs: number;
  protected readonly fetchImpl: typeof fetch;

  constructor(options: HostedOptions, defaultEndpoint: string) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.dim = options.dim;
    this.endpoint = options.endpoint ?? defaultEndpoint;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  protected async request(
    texts: string[], headers: Record<string, string>, body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    return withTimeout(this.timeoutMs, signal, async (requestSignal) => {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body), signal: requestSignal,
      });
      if (!response.ok) throw new Error(`Embedding provider request failed with status ${response.status}`);
      const json = await response.json() as { data?: EmbeddingItem[] };
      return validateVectors(json.data ?? [], texts.length, this.dim);
    });
  }
}

export class OpenAIEmbeddingProvider extends HostedEmbeddingProvider {
  readonly id: string;
  constructor(options: HostedOptions) {
    super(options, 'https://api.openai.com/v1/embeddings');
    this.id = `openai:${options.model}`;
  }
  embed(texts: string[], options: { signal?: AbortSignal } = {}): Promise<number[][]> {
    return this.request(texts, { authorization: `Bearer ${this.apiKey}` }, {
      model: this.model, input: texts, dimensions: this.dim,
    }, options.signal);
  }
}

export class VoyageEmbeddingProvider extends HostedEmbeddingProvider {
  readonly id: string;
  constructor(options: HostedOptions) {
    super(options, 'https://api.voyageai.com/v1/embeddings');
    this.id = `voyage:${options.model}`;
  }
  embed(texts: string[], options: { signal?: AbortSignal } = {}): Promise<number[][]> {
    return this.request(texts, { authorization: `Bearer ${this.apiKey}` }, {
      model: this.model, input: texts,
    }, options.signal);
  }
}
