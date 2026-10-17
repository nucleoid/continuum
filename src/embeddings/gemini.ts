import {
  HostedEmbeddingProvider, invalidResponse, validateVectors, type HostedOptions,
} from './hosted.js';
import { STORAGE_EMBEDDING_DIM } from '../storage/schema.js';

/** Optional text-only Gemini adapter. Model choice is always explicit. */
export class GeminiEmbeddingProvider extends HostedEmbeddingProvider {
  readonly id: string;
  readonly httpProvider = 'gemini';

  constructor(options: HostedOptions) {
    if (!options.apiKey?.trim()) throw new Error('Gemini API key is required');
    if (!/^gemini-[A-Za-z0-9._-]{1,120}$/.test(options.model)) {
      throw new Error('Gemini embedding model must be an explicit gemini model ID');
    }
    if (options.dim !== STORAGE_EMBEDDING_DIM) {
      throw new Error(`Gemini embedding dimension must be ${STORAGE_EMBEDDING_DIM}`);
    }
    if (options.batchSize !== undefined && options.batchSize > 100) {
      throw new Error('Gemini embedding batchSize must be at most 100');
    }
    if (options.endpoint) {
      let endpoint: URL;
      try { endpoint = new URL(options.endpoint); }
      catch { throw new Error('Invalid Gemini embedding endpoint'); }
      if (endpoint.search || endpoint.hash) throw new Error('Gemini embedding endpoint must not contain query or fragment');
    }
    super(options, `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:batchEmbedContents`);
    this.id = `gemini:${options.model}`;
  }

  async embed(texts: string[], options: { signal?: AbortSignal } = {}): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      const chunk = texts.slice(offset, offset + this.batchSize);
      vectors.push(...await this.request(chunk, { 'x-goog-api-key': this.apiKey }, {
        requests: chunk.map(text => ({
          model: `models/${this.model}`,
          content: { parts: [{ text }] },
          outputDimensionality: this.dim,
        })),
      }, options.signal));
    }
    return vectors;
  }

  protected override responseVectors(json: Record<string, unknown>, count: number): number[][] {
    if (!Array.isArray(json.embeddings)) throw invalidResponse('Provider returned invalid embedding count');
    return validateVectors(json.embeddings.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw invalidResponse('Provider returned an invalid embedding item');
      }
      return { embedding: (item as { values?: unknown }).values };
    }), count, this.dim);
  }
}
