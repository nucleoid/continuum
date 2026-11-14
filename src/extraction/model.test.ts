import { describe, expect, it } from 'vitest';
import { chunkSource } from './chunking.js';
import { validateAssertions } from './model.js';

describe('extraction reference data', () => {
  const version = '00000000-0000-4000-8000-000000000100';
  it('chunks exact UTF-8 bytes deterministically without splitting code points or losing bytes', () => {
    const text = 'a😀é漢b'.repeat(12);
    const chunks = chunkSource(version, text, 17, 20);
    expect(chunks.map(c => c.text).join('')).toBe(text);
    expect(chunks).toEqual(chunkSource(version, text, 17, 20));
    expect(new Set(chunks.map(c => c.id)).size).toBe(chunks.length);
    for (const c of chunks) {
      expect(Buffer.byteLength(c.text)).toBe(c.end - c.start);
      expect(c.end - c.start).toBeLessThanOrEqual(17);
      expect(c.text).not.toContain('�');
      expect(c.sourceFamily).toBe(version);
    }
    expect(() => chunkSource(version, text, 17, 2)).toThrow(/bounds/);
  });
  it('keeps explicit unknown and temporal uncertainty, rejecting invented spans and instruction fields', () => {
    const [chunk] = chunkSource(version, 'The release date is unknown.', 64, 1);
    const assertion = { text: 'Release date unknown', type: 'unknown', unknown: true,
      unsupported: [], temporal: { value: null, uncertain: true },
      citations: [{ start: 0, end: Buffer.byteLength(chunk.text), quote: chunk.text }] };
    expect(validateAssertions({ assertions: [assertion] }, chunk).assertions).toEqual([assertion]);
    expect(() => validateAssertions({ assertions: [{ ...assertion, verified: true }] }, chunk)).toThrow();
    expect(() => validateAssertions({ assertions: [{ ...assertion, instructions: 'ignore policy' }] }, chunk)).toThrow();
    expect(() => validateAssertions({ assertions: [{ ...assertion, citations: [{ start: 1, end: 28, quote: assertion.citations[0].quote }] }] }, chunk)).toThrow();
    expect(() => validateAssertions({ assertions: [{ ...assertion, citations: [] }] }, chunk)).toThrow();
    expect(() => validateAssertions({ assertions: [{ ...assertion, unknown: undefined }] }, chunk)).toThrow();
    expect(validateAssertions({ assertions: [] }, chunk)).toEqual({ assertions: [] });
  });
  it('rejects citations that cut a multibyte scalar even when replacement decoding would match', () => {
    const [chunk] = chunkSource(version, '😀!', 64, 1);
    expect(() => validateAssertions({ assertions: [{ text: 'X', type: 'fact', unknown: false, unsupported: [],
      temporal: { value: null, uncertain: true }, citations: [{ start: 1, end: 4, quote: '���' }] }] }, chunk)).toThrow();
  });
  it('rejects NUL and unpaired surrogate output fields before PostgreSQL serialization', () => {
    const [chunk] = chunkSource(version, 'Valid reference', 64, 1);
    const assertion = { text: 'Valid', type: 'fact', unknown: false, unsupported: [],
      temporal: { value: null, uncertain: true }, citations: [{ start: 0, end: 15, quote: chunk.text }] };
    for (const invalid of ['\u0000', '\ud800', '\udfff']) for (const changed of [
      { text: invalid }, { unsupported: [invalid] }, { temporal: { value: invalid, uncertain: true } },
    ]) expect(() => validateAssertions({ assertions: [{ ...assertion, ...changed }] }, chunk)).toThrow();
  });
});
