import { describe, expect, it } from 'vitest';
import type { CaptureInput } from '../types.js';
import { captureReceiptIdentity, initialEmbeddingStatus } from './embedding-jobs.js';
import { publicEmbeddingState } from '../storage/embedding-jobs-model.js';

const actor = 'aaaa1111-1111-4111-8111-111111111111', scope = 'bbbb2222-2222-4222-8222-222222222222';
const input: CaptureInput = { scope: { kind: 'project', name: 'test' }, type: 'fact', title: 'Exact title',
  body: 'Exact body', source: 'manual' };
const receipt = (extra: Partial<CaptureInput> = {}, key = 'retained-key') => captureReceiptIdentity(actor, scope, key, { ...input, ...extra });

describe('capture receipt normalization', () => {
  it('normalizes defaults, tag order/case and metadata keys across transports', () => {
    expect(receipt()).toEqual(receipt({ tags: [], metadata: {} }));
    expect(receipt({ tags: [' GitHub ', 'decision'], metadata: { z: [1, { b: 2, a: 1 }], a: true } }))
      .toEqual(receipt({ tags: ['decision', 'github'], metadata: { a: true, z: [1, { a: 1, b: 2 }] } }));
    expect(captureReceiptIdentity(actor.toUpperCase(), scope.toUpperCase(), 'retained-key', input)).toEqual(receipt());
  });
  it('binds body, event, source/ref and all stored semantic fields', () => {
    for (const changed of [{ body: 'Different body' }, { title: 'Different title' }, { type: 'decision' as const },
      { source: 'terminal-summary' }, { sourceRef: 'r' }, { metadata: { x: 1 } }, { tags: ['github'] },
      { eventAnnotation: { status: 'unknown' as const, original: 'uncertain' } }]) {
      expect(receipt(changed).payloadDigest).not.toBe(receipt().payloadDigest);
      expect(receipt(changed).keyHash).toBe(receipt().keyHash);
    }
    expect(receipt({ body: ' Exact body' }).payloadDigest).not.toBe(receipt().payloadDigest);
  });
  it('separates actor, resolved scope, operation and key without retaining source/key', () => {
    const a = receipt();
    expect(captureReceiptIdentity(scope, scope, 'retained-key', input).keyHash).not.toBe(a.keyHash);
    expect(captureReceiptIdentity(actor, actor, 'retained-key', input).keyHash).not.toBe(a.keyHash);
    expect(receipt({}, 'other-key').keyHash).not.toBe(a.keyHash);
    expect(receipt({}, 'other-key').payloadDigest).toBe(a.payloadDigest);
    expect(JSON.stringify(a)).not.toMatch(/retained-key|Exact body|Exact title/);
  });
  it.each(['', ' ', ' key', 'key ', 'key\n', 'é', 'x'.repeat(129)])('rejects invalid keys', key => {
    expect(() => receipt({}, key)).toThrow('visible ASCII');
  });
  it('rejects JSON collisions, accessors, cycles and duplicate normalized tags', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const metadata of [{ invalid: undefined }, { invalid: NaN }, { invalid: new Date() }, cycle,
      Object.defineProperty({}, 'getter', { enumerable: true, get: () => { throw new Error('must not execute'); } })]) {
      expect(() => receipt({ metadata })).toThrow();
    }
    expect(() => receipt({ tags: ['github', ' GitHub '] })).toThrow('unique');
    expect(() => receipt({ metadata: { related: [] } })).toThrow('reserved');
  });
});

describe('truthful asynchronous embedding states', () => {
  it('does not equate unavailable local-only with disabled configuration', () => {
    expect(initialEmbeddingStatus({ provider: null, alias: null, policy: 'disabled' })).toBe('not_configured');
    expect(initialEmbeddingStatus({ provider: null, alias: null, policy: 'local-only-unavailable' })).toBe('blocked_policy');
    expect(initialEmbeddingStatus({ provider: { id: 'x', dim: 768, embed: async () => [] }, alias: 'x', policy: 'provider' })).toBe('queued');
  });
  it('requires exact current vector evidence for ready and compatibility boolean', () => {
    expect(publicEmbeddingState('queued', false)).toEqual({ embeddingStatus: 'queued', embedded: false });
    expect(() => publicEmbeddingState('ready', false)).toThrow('matching');
    expect(publicEmbeddingState('ready', true).embedded).toBe(true);
  });
});
