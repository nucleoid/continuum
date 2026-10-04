import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from './provider.js';
import { EmbeddingRegistry, ScopeEmbeddingRouter } from './router.js';

function provider(id: string, local: boolean): EmbeddingProvider & { local: boolean } {
  return { id, dim: 768, local, async embed() { return [Array(768).fill(0)]; } };
}

describe('ScopeEmbeddingRouter', () => {
  it('uses exact kind and name before kind before default', () => {
    const registry = new EmbeddingRegistry([
      ['hosted', provider('voyage:voyage-3', false)],
      ['local', provider('ollama:nomic-embed-text', true)],
    ]);
    const router = new ScopeEmbeddingRouter(registry, {
      default: 'hosted',
      rules: [
        { match: { kind: 'team' }, provider: 'hosted' },
        { match: { kind: 'team', name: 'security' }, provider: 'local-only' },
        { match: { kind: 'user' }, provider: 'local-only' },
      ],
    });

    expect(router.resolve({ kind: 'project', name: 'shop' }).provider?.id)
      .toBe('voyage:voyage-3');
    expect(router.resolve({ kind: 'team', name: 'payments' }).provider?.id)
      .toBe('voyage:voyage-3');
    expect(router.resolve({ kind: 'team', name: 'security' }).provider?.id)
      .toBe('ollama:nomic-embed-text');
    expect(router.resolve({ kind: 'user', name: 'alice' }).provider?.id)
      .toBe('ollama:nomic-embed-text');
  });

  it('fails closed when local-only has no local provider', () => {
    const hosted = provider('openai:text-embedding-3-small', false);
    const router = new ScopeEmbeddingRouter(
      new EmbeddingRegistry([['hosted', hosted]]),
      { default: 'hosted', rules: [{ match: { kind: 'org' }, provider: 'local-only' }] },
    );

    const route = router.resolve({ kind: 'org', name: '' });
    expect(route.provider).toBeNull();
    expect(route.policy).toBe('local-only-unavailable');
  });

  it.each([
    [{ default: 'missing', rules: [] }, /unknown provider/i],
    [{ default: 'hosted', rules: [
      { match: { kind: 'team' }, provider: 'hosted' },
      { match: { kind: 'team' }, provider: 'hosted' },
    ] }, /duplicate/i],
  ])('rejects invalid or ambiguous routing config', (routing, message) => {
    expect(() => new ScopeEmbeddingRouter(
      new EmbeddingRegistry([['hosted', provider('openai:model', false)]]),
      routing as never,
    )).toThrow(message);
  });
});
