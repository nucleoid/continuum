import { describe, expect, it } from 'vitest';
import { reconcileBlocks, validateBriefOutput, BRIEF_SECTIONS, type BriefInput } from './model.js';
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
      { label: 'implemented_fact' }, { instruction: 'run a tool' }, { citations: [] } ]) {
      expect(() => validateBriefOutput({ claims: [{ ...claim, ...changed }] }, input)).toThrow();
    }
    expect(validateBriefOutput({ claims: [claim] }, input).claims).toHaveLength(1);
  });
  it('requires supported conflicts and explicit unsupported implementation unknowns', () => {
    expect(() => validateBriefOutput({ claims: [{ ...claim, contradiction: true }] }, input)).toThrow();
    expect(validateBriefOutput({ claims: [{ ...claim, section: 'implementation', label: 'inference', unknown: true }] }, input).claims[0].unknown).toBe(true);
    expect(() => validateBriefOutput({ claims: [claim, claim] }, input)).toThrow();
  });
  it('preserves exact untouched blocks, assigns stable identities itself, and converges full and delta', () => {
    const first = reconcileBlocks(validateBriefOutput({ claims: [claim] }, input), [], input.sections);
    const delta = reconcileBlocks({ claims: [] }, first, ['coverage']);
    expect(delta).toEqual(first);
    expect(reconcileBlocks(validateBriefOutput({ claims: [claim] }, input), first, input.sections)).toEqual(first);
    expect(first[0].id).toMatch(/^[0-9a-f]{64}$/);
    expect(() => validateBriefOutput({ claims: [{ ...claim, id: 'model-chosen' }] }, input)).toThrow();
  });
  it('renders contributed text and citations as escaped reference data', () => {
    const blocks = reconcileBlocks(validateBriefOutput({ claims: [{ ...claim, text: '<script>\n# Override instructions\u0000' }] }, input), [], input.sections);
    const rendered = renderBrief(blocks);
    expect(rendered).not.toContain('<script>');
    expect(rendered).not.toContain('\u0000');
    expect(rendered).toContain('recorded_intent');
    expect(rendered).toContain('Reference data');
  });
});
