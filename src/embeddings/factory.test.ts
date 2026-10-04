import { describe, expect, it } from 'vitest';
import { makeEmbeddingProviderFromEnv, makeEmbeddingRouterFromEnv } from './factory.js';

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

  it('builds a validated registry and routing table from JSON without inline secrets', () => {
    const router = makeEmbeddingRouterFromEnv({
      OPENAI_API_KEY: 'private-key',
      CONTINUUM_EMBEDDING_CONFIG: JSON.stringify({
        providers: [
          { alias: 'hosted', kind: 'openai', model: 'text-embedding-3-small', dim: 768,
            local: false },
          { alias: 'local', kind: 'ollama', model: 'nomic-embed-text', dim: 768,
            endpoint: 'http://localhost:11434', local: true },
        ],
        routing: {
          default: 'hosted',
          rules: [{ match: { kind: 'user' }, provider: 'local-only' }],
        },
      }),
    });

    expect(router.resolve({ kind: 'project', name: 'shop' }).provider?.id)
      .toBe('openai:text-embedding-3-small');
    expect(router.resolve({ kind: 'user', name: 'alice' }).provider?.id)
      .toBe('ollama:nomic-embed-text');
  });

  it('rejects hosted definitions without env credentials and inline keys', () => {
    const definition = {
      providers: [{ alias: 'hosted', kind: 'voyage', model: 'voyage-3', dim: 768,
        local: false }],
      routing: { default: 'hosted', rules: [] },
    };
    expect(() => makeEmbeddingRouterFromEnv({
      CONTINUUM_EMBEDDING_CONFIG: JSON.stringify(definition),
    })).toThrow(/VOYAGE_API_KEY/);
    expect(() => makeEmbeddingRouterFromEnv({
      VOYAGE_API_KEY: 'env-key',
      CONTINUUM_EMBEDDING_CONFIG: JSON.stringify({
        ...definition,
        providers: [{ ...definition.providers[0], apiKey: 'inline-secret' }],
      }),
    })).toThrow(/inline credentials/i);
  });
});
