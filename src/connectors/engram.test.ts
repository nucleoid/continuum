import { describe, expect, it } from 'vitest';
import { createEngramEvidenceConnector, engramCapabilityReport } from './engram.js';
describe('Engram capability gate', () => {
  it('cannot instantiate a live adapter from tool names or shared credentials', () => {
    expect(engramCapabilityReport.enabled).toBe(false);
    expect(engramCapabilityReport.missing).toContain('delegated-principal-repository-proof-and-revalidation');
    expect(() => createEngramEvidenceConnector()).toThrow(/unverified/);
  });
  it('distinguishes indexed metadata, on-demand source and retained history truthfully', () => {
    expect(engramCapabilityReport.inspected.get_symbol).toMatch(/does not pin/);
    expect(engramCapabilityReport.inspected.get_file_context).toMatch(/not historical source reconstruction/);
    expect(engramCapabilityReport.missing).toContain('frozen-real-response-fixtures');
  });
});
