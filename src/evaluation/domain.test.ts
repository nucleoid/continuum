import { describe, expect, it } from 'vitest';
import { loadCorpus, scoreRetrieval, scoreClaims, compareRuns, relationshipGate,
  evaluateMechanism, seededOrder, boundReport, runBaseline, evaluateTaskPair, validateCases } from './test-helpers.js';

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
    const resources = { baselineP95: 10, candidateP95: 11, baselineBytes: 100, candidateBytes: 200,
      hardStorageBudget: 1000, identicalCaps: true, criticalCoverageRegressions: 0 };
    expect(compareRuns(baseline, candidate, relationshipGate, [], resources).status).toBe('pass');
    expect(compareRuns(baseline, candidate, relationshipGate).status).toBe('insufficient_evidence');
    expect(compareRuns(baseline, candidate, relationshipGate, ['unauthorized-disclosure']).status).toBe('fail');
    expect(compareRuns(baseline.slice(0, 1), candidate.slice(0, 1), relationshipGate).status).toBe('insufficient_evidence');
    expect(() => compareRuns(baseline, candidate.slice(1), relationshipGate)).toThrow(/paired/i);
  });

  it('bounds artifacts without silently truncating security evidence', () => {
    expect(() => boundReport({ rows: Array(201).fill({}) })).toThrow(/bound/i);
    expect(() => boundReport({ text: 'x'.repeat(1_048_577) })).toThrow(/bound/i);
  });

  it('separates oracle reasoning failure from retrieval miss and fails unauthorized answers', async () => {
    const corpus = await loadCorpus();
    const task = corpus.cases.find(item => item.id === 'oracle-vs-retrieved')!;
    const adapter = async (evidence: { id: string; version: string }[]) => ({ claims: evidence.length ? task.claims : [],
      delivered: evidence, completedChunks: task.chunks, abstained: evidence.length === 0 });
    const result = await evaluateTaskPair(task, [], adapter);
    expect(result).toMatchObject({ status: 'measured', retrieved: { claims: { claimRecall: 0 } },
      oracle: { claims: { claimRecall: 1 } }, diagnosis: 'retrieval_miss' });
    const denied = corpus.cases.find(item => item.id === 'source-document-denied')!;
    expect(await evaluateTaskPair(denied, [{ id: 'primary', version: '1' }], adapter))
      .toMatchObject({ gate: 'fail' });
    expect(await evaluateTaskPair(task, [], undefined)).toEqual({ status: 'not_supported' });
  });

  it('rejects absent versions, contradictory labels, and oversized UTF-8 sources', async () => {
    const corpus = await loadCorpus();
    const item = structuredClone(corpus.cases[0]);
    delete (item.documents[0] as Partial<typeof item.documents[0]>).version;
    expect(() => validateCases({ schema: 1, cases: [item] })).toThrow();
    const other = structuredClone(corpus.cases[0]);
    other.prohibited = other.relevant.map(ref => `${ref.id}@${ref.version}`);
    expect(() => validateCases({ schema: 1, cases: [other] })).toThrow(/Contradictory/);
    other.prohibited = []; other.documents[0].body = '界'.repeat(6000);
    expect(() => validateCases({ schema: 1, cases: [other] })).toThrow(/byte bound/);
  });

  it('exercises current audited services on exact APP and bound OP/SYNC LOGIN profiles', async () => {
    const report = await runBaseline(await loadCorpus(), process.env.CONTINUUM_TEST_DATABASE_URL
      ?? 'postgres://continuum:continuum@localhost:5433/continuum', 'a'.repeat(40));
    expect(report.sampleCounts.failed).toBe(0);
    expect(report.gates).toMatchObject({ mechanism: 'pass', relationshipExpansion: 'not_supported' });
    expect(report.rows.find(row => row.id === 'expired-evidence' && row.ablation === 'hybrid')?.metrics?.recall).toBeNull();
    expect(report.rows.find(row => row.id === 'explicit-supersession' && row.ablation === 'hybrid')?.metrics?.recall).toBe(1);
    expect(report.sampleCounts.unsupported).toBeGreaterThan(0);
  }, 180_000);
});
