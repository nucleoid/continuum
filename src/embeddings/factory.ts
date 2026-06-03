import type { EmbeddingProvider } from './provider.js';
import { OllamaEmbeddingProvider } from './ollama.js';

export function makeEmbeddingProviderFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider | null {
  const kind = env.CONTINUUM_EMBEDDING_PROVIDER?.toLowerCase();
  if (!kind || kind === 'none' || kind === 'noop') return null;
  if (kind === 'ollama') {
    const baseUrl = env.CONTINUUM_OLLAMA_URL ?? 'http://localhost:11434';
    const model = env.CONTINUUM_EMBEDDING_MODEL ?? 'nomic-embed-text';
    const dim = Number(env.CONTINUUM_EMBEDDING_DIM ?? 768);
    return new OllamaEmbeddingProvider({ baseUrl, model, dim });
  }
  throw new Error(`Unknown CONTINUUM_EMBEDDING_PROVIDER: ${kind}`);
}
