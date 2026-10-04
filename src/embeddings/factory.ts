import type { EmbeddingProvider } from './provider.js';
import { OllamaEmbeddingProvider } from './ollama.js';
import { STORAGE_EMBEDDING_DIM } from '../storage/schema.js';

function embeddingDimension(env: NodeJS.ProcessEnv): number {
  const configured = env.CONTINUUM_EMBEDDING_DIM ?? String(STORAGE_EMBEDDING_DIM);
  const dim = Number(configured);
  if (!Number.isInteger(dim) || dim <= 0 || dim !== STORAGE_EMBEDDING_DIM) {
    throw new Error(
      `CONTINUUM_EMBEDDING_DIM must be ${STORAGE_EMBEDDING_DIM} to match database vector(${STORAGE_EMBEDDING_DIM})`,
    );
  }
  return dim;
}

export function makeEmbeddingProviderFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider | null {
  const kind = env.CONTINUUM_EMBEDDING_PROVIDER?.toLowerCase();
  if (!kind || kind === 'none' || kind === 'noop') return null;
  if (kind === 'ollama') {
    const baseUrl = env.CONTINUUM_OLLAMA_URL ?? 'http://localhost:11434';
    const model = env.CONTINUUM_EMBEDDING_MODEL ?? 'nomic-embed-text';
    const dim = embeddingDimension(env);
    return new OllamaEmbeddingProvider({ baseUrl, model, dim });
  }
  throw new Error(`Unknown CONTINUUM_EMBEDDING_PROVIDER: ${kind}`);
}
