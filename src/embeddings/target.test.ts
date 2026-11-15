import { describe, expect, it } from 'vitest';
import { assertSameEmbeddingSpace, embeddingTarget, MEMORY_EMBEDDING_INPUT_TRANSFORM, type EmbeddingVectorSpace } from './target.js';

const space: EmbeddingVectorSpace = { provider: 'local:exact-v1', model: 'exact', profile: 'document-v1',
  dim: 768, inputTransform: MEMORY_EMBEDDING_INPUT_TRANSFORM };
const target = (extra = {}) => embeddingTarget({ space, endpoint: 'http://localhost:11434/api/embed', local: true, ...extra });

describe('embedding target identity', () => {
  it('canonicalizes field order and freezes the credential-free descriptor', () => {
    const a = target(), b = target({ space: { inputTransform: space.inputTransform, dim: 768, profile: space.profile, model: space.model, provider: space.provider } });
    expect(a).toEqual(b);
    expect(Object.isFrozen(a)).toBe(true); expect(Object.isFrozen(a.space)).toBe(true);
    expect(JSON.stringify(a)).not.toContain('localhost');
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
  it.each(['model', 'profile', 'inputTransform', 'provider'] as const)('binds exact %s semantics despite equal dimensions', field => {
    const a = target(), b = target({ space: { ...space, [field]: 'changed' } });
    expect(a.spaceFingerprint).not.toBe(b.spaceFingerprint);
    expect(() => assertSameEmbeddingSpace(a.space, b.space)).toThrow('conflicts');
  });
  it('keeps reviewed vector space distinct from transport and locality', () => {
    const a = target(), b = target({ endpoint: 'https://example.invalid/v1/embed', local: false });
    expect(a.spaceFingerprint).toBe(b.spaceFingerprint);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(() => assertSameEmbeddingSpace(a.space, b.space)).not.toThrow();
    expect(target({ endpoint: 'https://example.invalid', local: true }).local).toBe(true);
  });
  it.each(['https://key@example.invalid', 'https://example.invalid/?key=secret', 'https://example.invalid/#secret', 'file:///secret'])('rejects unsafe endpoint %s', endpoint => {
    expect(() => target({ endpoint })).toThrow();
  });
  it('rejects provider/config objects and unsupported dimensions instead of hashing secrets', () => {
    expect(() => target({ apiKey: 'private' })).toThrow('Unexpected');
    expect(() => target({ space: { ...space, credentials: 'private' } })).toThrow('Unexpected');
    expect(() => target({ space: { ...space, dim: 1024 } })).toThrow('768');
  });
});
