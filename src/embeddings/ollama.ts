import type { EmbeddingProvider } from './provider.js';

export interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
  dim: number;
  fetchImpl?: typeof fetch;
}

interface OllamaEmbedResponse {
  embedding?: number[];
  embeddings?: number[][];
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  readonly local = true;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaProviderOptions) {
    this.id = `ollama:${opts.model}`;
    this.dim = opts.dim;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(texts: string[], options: { signal?: AbortSignal } = {}): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) {
      options.signal?.throwIfAborted();
      const res = await this.fetchImpl(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: options.signal,
      });
      if (!res.ok) {
        throw new Error(
          `Ollama embed failed: ${res.status} ${res.statusText}`,
        );
      }
      const json = (await res.json()) as OllamaEmbedResponse;
      const vec = json.embedding ?? json.embeddings?.[0];
      if (!vec || vec.length !== this.dim) {
        throw new Error(
          `Ollama returned unexpected embedding dim ${vec?.length} (expected ${this.dim})`,
        );
      }
      out.push(vec);
    }
    return out;
  }
}
