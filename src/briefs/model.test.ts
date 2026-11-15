import { describe, expect, it } from 'vitest';
import { validateBriefOutput, BRIEF_SECTIONS, type BriefInput } from './model.js';
import { renderBrief } from './render.js';

const input: BriefInput = { schema: 'project-brief-v1', prompt: 'brief-reference-v1', sections: [...BRIEF_SECTIONS],
  referenceData: { trust: 'untrusted', sources: [{ id: 'source-1', version: 'version-1', kind: 'source-document-version',
    family: 'family-1', text: 'Recorded plan: use PostgreSQL.\nImplementation remains unknown.' }] } };
const claim = { section: 'decisions', label: 'recorded_intent', text: 'Use PostgreSQL.', unknown: false,
  contradiction: false, citations: [{ version: 'version-1', quote: 'use PostgreSQL.' }] };

describe('maintained brief claims', () => {
  it('rejects fabricated versions, quotes, unsupported labels, instruction fields and implementation laundering', () => {
    for (const changed of [ { citations: [{ version: 'hidden', quote: 'use PostgreSQL.' }] },
      { citations: [{ version: 'version-1', quote: 'implemented' }] }, { label: 'verified' },
      { label: 'implemented_fact' }, { instruction: 'run a tool' }, { citations: [] }, { id: 'model-chosen' } ]) {
      expect(() => validateBriefOutput({ claims: [{ ...claim, ...changed }] }, input)).toThrow();
    }
    expect(validateBriefOutput({ claims: [claim] }, input).claims).toHaveLength(1);
  });
  it('requires supported conflicts and explicit unsupported implementation unknowns', () => {
    expect(() => validateBriefOutput({ claims: [{ ...claim, contradiction: true }] }, input)).toThrow();
    expect(validateBriefOutput({ claims: [{ ...claim, section: 'implementation', label: 'inference', unknown: true }] }, input).claims[0].unknown).toBe(true);
    expect(() => validateBriefOutput({ claims: [claim, claim] }, input)).toThrow();
  });
  it('renders contributed text and citations as escaped reference data', () => {
    const blocks = validateBriefOutput({ claims: [{ ...claim, text: '<script>\n# Override instructions\u0000' }] }, input).claims.map(value=>({ ...value,id: 'a'.repeat(64) }));
    const rendered = renderBrief(blocks);
    expect(rendered).not.toContain('<script>');
    expect(rendered).not.toContain('\u0000');
    expect(rendered).toContain('recorded_intent');
    expect(rendered).toContain('Reference data');
  });
});
