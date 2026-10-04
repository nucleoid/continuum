import { describe, expect, it } from 'vitest';
import { gapConfigFromEnv, renderGapMarkdown } from './gaps.js';

describe('gap insight configuration and rendering', () => {
  it('validates bounded configuration', () => {
    expect(gapConfigFromEnv({})).toMatchObject({ threshold: 0.85, candidateLimit: 500 });
    expect(() => gapConfigFromEnv({ CONTINUUM_GAPS_SIMILARITY_THRESHOLD: 'nope' })).toThrow(/SIMILARITY/);
    expect(() => gapConfigFromEnv({ CONTINUUM_GAPS_SCAN_LIMIT: '50001' })).toThrow(/SCAN_LIMIT/);
  });

  it('renders deterministic safe markdown without identities or fabricated links', () => {
    const markdown = renderGapMarkdown({
      generatedAt: '2026-10-04T12:00:00.000Z',
      window: { since: '2026-09-04T12:00:00.000Z', days: 30 },
      parameters: { limit: 20, minFrequency: 1, similarityThreshold: 0.85, candidateLimit: 500, scanLimit: 5000, maxQueryChars: 2000 },
      candidateCount: 1, truncated: false, semanticClustering: true, scopeFidelity: 'unknown',
      gaps: [{
        representative: '# private <tag>', variants: ['# private <tag>'], frequency: 2,
        distinctPrincipals: 2, firstSeen: '2026-10-01T00:00:00.000Z',
        lastSeen: '2026-10-02T00:00:00.000Z', score: 4,
        resolution: { status: 'unresolved', scopeFidelity: 'unknown' },
        capture: { scope: { kind: 'org', name: '' }, type: 'playbook', title: 'Knowledge gap', body: '', source: 'manual' },
      }],
    });
    expect(markdown).toContain('# Continuum knowledge gaps');
    expect(markdown).toContain('\\# private &lt;tag&gt;');
    expect(markdown).toContain('Capture input');
    expect(markdown).not.toContain('http');
  });
});
