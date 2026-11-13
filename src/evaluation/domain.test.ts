import { describe, expect, it } from 'vitest';
import { loadCorpus, scoreRetrieval, scoreClaims, compareRuns, relationshipGate,
  evaluateMechanism, seededOrder, boundReport } from './test-helpers.js';

describe('frozen domain evaluator', () => {
  it('loads content-addressed synthetic fixtures with reproducible seeded order', async () => {
    const corpus = await loadCorpus();
    expect(corpus.manifest.version).toBe('v1');
    expect(corpus.cases.length).toBeGreaterThanOrEqual(20);
    expect(seededOrder(corpus.cases, 25)).toEqual(seededOrder([...corpus.cases].reverse(), 25));
    expect(corpus.cases.some(item => item.id === 'source-document-denied')).toBe(true);
  });

  it('scores ranks once per exact version, penalizes copies, and distinguishes undefined denominators', () => {
    const expected = [{ id: 'a', version: '1', grade: 3, family: 'original' },
      { id: 'b', version: '2', grade: 1, family: 'independent' }];
    const score = scoreRetrieval([{ id: 'b', version: '2' }, { id: 'a', version: '1' }, { id: 'a', version: '1' }], expected, 10);
    expect(score.precision).toBeCloseTo(2 / 3);
    expect(score.recall).toBe(1);
    expect(score.mrr).toBe(1);
    expect(score.ndcg).toBeCloseTo((1 + 7 / Math.log2(3)) / (7 + 1 / Math.log2(3)));
    expect(scoreRetrieval([], [], 10)).toMatchObject({ precision: null, recall: null, ndcg: null, mrr: null });
    expect(scoreRetrieval([{ id: 'a', version: 'old' }], expected, 10).recall).toBe(0);
  });

  it('scores unknowns, contradictions, exact citations, labels and partial chunks separately', () => {
    const expected = [{ id: 'c', label: 'recorded-intent' as const, evidence: [{ id: 'a', version: '2' }],
      unknown: true, contradiction: 'conflict' }];
    expect(scoreClaims([{ id: 'c', label: 'implemented-fact', evidence: [{ id: 'a', version: '1' }],
      unknown: false, contradiction: null }], expected, ['one', 'two'], ['one']))
      .toMatchObject({ alignment: 0, labelAccuracy: 0, unknownPreservation: 0, contradictionPreservation: 0,
        chunkCoverage: 0.5, unsupportedAssertionRate: 1 });
  });

  it('cannot turn missing future adapters into successful empty outputs', async () => {
    expect(await evaluateMechanism('relationship-expansion', undefined)).toEqual({ status: 'not_supported' });
    expect(await evaluateMechanism('synthesis', async () => { throw new Error('private provider payload'); }))
      .toEqual({ status: 'failed', reason: 'ADAPTER_FAILED' });
  });

  it('requires declared gates and paired evidence, with critical failures overriding quality', () => {
    expect(() => compareRuns([], [], undefined)).toThrow(/gate/i);
    const baseline = Array.from({ length: 20 }, (_, index) => ({ id: String(index), value: 0.5 }));
    const candidate = baseline.map(row => ({ ...row, value: 0.6 }));
    expect(compareRuns(baseline, candidate, relationshipGate).status).toBe('pass');
    expect(compareRuns(baseline, candidate, relationshipGate, ['unauthorized-disclosure']).status).toBe('fail');
    expect(compareRuns(baseline.slice(0, 1), candidate.slice(0, 1), relationshipGate).status).toBe('insufficient_evidence');
    expect(() => compareRuns(baseline, candidate.slice(1), relationshipGate)).toThrow(/paired/i);
  });

  it('bounds artifacts without silently truncating security evidence', () => {
    expect(() => boundReport({ rows: Array(201).fill({}) })).toThrow(/bound/i);
    expect(() => boundReport({ text: 'x'.repeat(1_048_577) })).toThrow(/bound/i);
  });
});
