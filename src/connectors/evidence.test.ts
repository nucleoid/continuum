import { describe, expect, it } from 'vitest';
import { RepositoryEvidenceRegistry } from './registry.js';
import { validateRepositoryEvidence } from './evidence.js';

describe('source-neutral repository evidence boundary', () => {
  it('defaults empty and rejects duplicate or contributed connector identities', () => {
    const registry = new RepositoryEvidenceRegistry();
    expect(registry.ids()).toEqual([]);
    expect(registry.get('engram')).toBeUndefined();
    expect(() => registry.register({ id: '../content-selected' } as never)).toThrow();
  });
  it('rejects cross-repository spill, oversized output and guessed exact freshness', () => {
    const request = { repository: 'stable-repository', evidenceClass: 'source-code' as const,
      query: 'synthetic', commit: 'a'.repeat(40), maxResults: 2 };
    const item = { id: 'opaque-symbol', repository: request.repository, kind: 'vcs' as const,
      text: 'untrusted reference', locator: 'src/example.ts:1', commit: request.commit, indexWatermark: null };
    expect(validateRepositoryEvidence({ items: [item], truncated: false }, request)).toBe(true);
    expect(validateRepositoryEvidence({ items: [{ ...item, repository: 'unapproved' }], truncated: false }, request)).toBe(false);
    expect(validateRepositoryEvidence({ items: [{ ...item, commit: null }], truncated: false }, request)).toBe(false);
    expect(validateRepositoryEvidence({ items: [{ ...item, text: 'x'.repeat(65537) }], truncated: false }, request)).toBe(false);
    expect(validateRepositoryEvidence({ items: [item], truncated: false, credential: 'secret' }, request)).toBe(false);
  });
});
