import { describe, expect, it } from 'vitest';
import { makeEmbeddingProviderFromEnv } from './factory.js';

describe('makeEmbeddingProviderFromEnv', () => {
  it('accepts the fixed v0 storage dimension', () => {
    const provider = makeEmbeddingProviderFromEnv({
      CONTINUUM_EMBEDDING_PROVIDER: 'ollama',
      CONTINUUM_EMBEDDING_MODEL: 'nomic-embed-text-v2',
      CONTINUUM_EMBEDDING_DIM: '768',
    });

    expect(provider?.dim).toBe(768);
    expect(provider?.id).toBe('ollama:nomic-embed-text-v2');
  });

  it.each(['1024', 'NaN', '768.5', '0', '-1'])(
    'rejects unsupported dimension %s before creating the provider',
    (dimension) => {
      expect(() => makeEmbeddingProviderFromEnv({
        CONTINUUM_EMBEDDING_PROVIDER: 'ollama',
        CONTINUUM_EMBEDDING_DIM: dimension,
      })).toThrow(/CONTINUUM_EMBEDDING_DIM.*768.*database/i);
    },
  );

  it('does not echo an invalid dimension value in the configuration error', () => {
    const invalidValue = '768-secret-like-suffix';

    expect(() => makeEmbeddingProviderFromEnv({
      CONTINUUM_EMBEDDING_PROVIDER: 'ollama',
      CONTINUUM_EMBEDDING_DIM: invalidValue,
    })).toThrowError(expect.not.objectContaining({ message: expect.stringContaining(invalidValue) }));
  });
});
