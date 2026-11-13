import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadCorpus, scoreRetrieval, scoreClaims, compareRuns, relationshipGate,
  evaluateMechanism, seededOrder, boundReport, runBaseline, evaluateTaskPair, validateCases, compareExperiments, checkedGrantSql, experimentFromReport,
  retrievalInput, evaluateRetrieval, PhaseBudget, planRows } from './test-helpers.js';

describe('frozen domain evaluator', () => {
  it('loads content-addressed synthetic fixtures with reproducible seeded order', async () => {
    const corpus = await loadCorpus();
    expect(corpus.manifest.version).toBe('v1');
    expect(corpus.cases.length).toBeGreaterThanOrEqual(20);
    expect(seededOrder(corpus.cases, 25)).toEqual(seededOrder([...corpus.cases].reverse(), 25));
    expect(corpus.cases.some(item => item.id === 'source-document-denied')).toBe(true);
    const holdout = corpus.cases.filter(item => item.split === 'holdout' && item.operation === 'recall');
    expect(holdout.length).toBeGreaterThanOrEqual(20);
    expect(new Set(holdout.map(item => item.query)).size).toBe(holdout.length);
    expect(corpus.cases.some(item => item.split === 'development')).toBe(true);
    expect(new Set(holdout.map(item => item.relevant.map(ref => ref.grade).sort().join(','))).size).toBeGreaterThanOrEqual(6);
    expect(new Set(holdout.map(item => item.documents.length)).size).toBeGreaterThanOrEqual(4);
    expect(holdout.some(item => item.relations.length === 0)).toBe(true);
    expect(holdout.some(item => item.relations.some(edge => edge.type === 'contradicts'))).toBe(true);
    expect(holdout.some(item => item.relations.some(edge => item.prohibited.includes(`${edge.target.id}@${edge.target.version}`)))).toBe(true);
    expect(holdout.some(item => item.relations.length > 0 && item.relations.every(edge => !item.relevant.some(ref => ref.id === edge.target.id)))).toBe(true);
    const development = corpus.cases.filter(item => item.collection === 'ranking' && item.split === 'development');
    const bodies = new Set(development.flatMap(item => item.documents.map(doc => doc.body)));
    expect(holdout.every(item => item.documents.every(doc => !bodies.has(doc.body)))).toBe(true);
  });

  it('gives copied assertions no additional gain or independent-source credit', () => {
    const refs = [{ id: 'a', version: '1', grade: 3, family: 'source', assertion: 'same' },
      { id: 'b', version: '1', grade: 3, family: 'source', assertion: 'same' }];
    expect(scoreRetrieval(refs, refs)).toMatchObject({ recall: 1, precision: 0.5, independentFamilies: 1, ndcg: 1, duplicateResults: 1 });
    const forged = refs.map((ref, index) => ({ ...ref, family: `source-${index}` }));
    expect(() => scoreRetrieval(forged, forged)).toThrow(/family/i);
  });

  it('keeps judgments and denied payloads outside future retrieval adapters', async () => {
    const corpus = await loadCorpus();
    const item = corpus.cases.find(item => item.collection === 'ranking' && item.prohibited.length > 0)!;
    const input = retrievalInput(item);
    expect(Object.keys(input).sort()).toEqual(['documents', 'query', 'relations']);
    expect(input.documents.every(doc => !item.prohibited.includes(`${doc.id}@${doc.version}`))).toBe(true);
    expect(input.documents.every(doc => Object.keys(doc).sort().join(',') === 'body,id,title,version')).toBe(true);
    expect(input.relations.every(edge => input.documents.some(doc => doc.id === edge.target.id))).toBe(true);
    expect(await evaluateRetrieval(item, undefined)).toEqual({ status: 'not_supported' });
    const denied = item.documents.find(doc => item.prohibited.includes(`${doc.id}@${doc.version}`))!;
    expect(await evaluateRetrieval(item, async () => [{ id: denied.id, version: denied.version }])).toMatchObject({ status: 'failed', reason: 'PROHIBITED_EVIDENCE' });
  });

  it('separates setup time from measured work and preflights candidate report capacity', () => {
    let now = 0;
    const budget = new PhaseBudget(100, 20, () => now);
    now = 99; budget.check(); budget.beginMeasured();
    now = 118; budget.check();
    now = 120; expect(() => budget.check()).toThrow(/measured/i);
    const setup = new PhaseBudget(100, 20, () => now);
    now = 221; expect(() => setup.check()).toThrow(/setup/i);
    expect(planRows(47, 14, 4, 512)).toBe(202);
    expect(() => planRows(47, 14, 12, 512)).toThrow(/row/i);
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
    expect(() => boundReport({ rows: Array(513).fill({}) })).toThrow(/bound/i);
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

  it('accepts correct policy abstention and diagnoses wrong citations as reasoning failure', async () => {
    const corpus = await loadCorpus();
    const denied = corpus.cases.find(item => item.id === 'source-document-denied')!;
    const empty = async () => ({ claims: [], delivered: [], completedChunks: [], abstained: true });
    expect(await evaluateTaskPair(denied, [], empty)).toMatchObject({ gate: 'pass', diagnosis: 'no_miss' });
    const task = corpus.cases.find(item => item.id === 'oracle-vs-retrieved')!;
    expect(await evaluateTaskPair(task, [{ id: 'primary', version: '1' }], async () => ({
      claims: task.claims.map(claim => ({ ...claim, label: 'inference', evidence: [{ id: 'primary', version: '999' }] })),
      delivered: [], completedChunks: [], abstained: false,
    }))).toMatchObject({ gate: 'fail', diagnosis: 'reasoning_failure' });
    const contradictory = structuredClone(task);
    contradictory.claims[0].contradiction = 'missing';
    expect(() => validateCases({ schema: 1, cases: [contradictory] })).toThrow(/contradiction/i);
  });

  it('fails closed when the reviewed grant emulation changes', async () => {
    const sql = await readFile('scripts/grant-application-role.sql', 'utf8');
    expect(checkedGrantSql('grant-application-role.sql', sql)).toContain('BEGIN;');
    expect(() => checkedGrantSql('grant-application-role.sql', sql + '\n\\gexec\n')).toThrow(/drift/);
  });

  it('binds comparisons to all frozen holdout queries and reported security/resource evidence', async () => {
    const corpus = await loadCorpus();
    const ids = corpus.cases.filter(item => item.split === 'holdout' && item.operation === 'recall').map(item => item.id);
    const report = (ablation: string, value: number, p95: number) => ({ head: (value === 0.5 ? 'a' : 'b').repeat(40),
      sourceHead: (value === 0.5 ? 'a' : 'b').repeat(40), predecessorEligible: true,
      fixtureManifest: corpus.manifestHash, seed: 25, runner: 'memory-evaluation-v1', budgets: corpus.manifest.budgets,
      gates: { failures: [] }, usage: { persistedBytes: 1100, emptySchemaBytes: 1000, evidenceBytes: 100, candidateCount: 240, actualSpend: 0, reservedSpend: 0, calls: 24, retries: 0 },
      rows: ids.map(id => ({ id, ablation, status: 'measured', metrics: { ndcg: value, evidenceCoverage: 1 }, latencyMs: p95, failures: [] })) });
    const features = { hybrid: true, reranking: true, 'relationship-expansion': false };
    const before = experimentFromReport(corpus, report('hybrid-reranking', 0.5, 10), 'hybrid-reranking', features, { hybrid: '1', reranking: '1' });
    const after = experimentFromReport(corpus, report('relationship-expansion', 0.6, 11), 'relationship-expansion',
      { ...features, 'relationship-expansion': true }, { hybrid: '1', reranking: '1' }, before.head);
    expect(compareExperiments(before, after, corpus)).toMatchObject({ status: 'pass' });
    const noSource = { ...report('hybrid-reranking', 0.5, 10), sourceHead: undefined };
    expect(() => experimentFromReport(corpus, noSource, 'hybrid-reranking', features, {})).toThrow();
    expect(() => experimentFromReport(corpus, { ...noSource, sourceHead: 'c'.repeat(40) }, 'hybrid-reranking', features, {})).toThrow(/provenance/i);
    const amplified = report('relationship-expansion', 0.6, 11);
    amplified.usage.persistedBytes = 1300; amplified.usage.evidenceBytes = 300;
    const amplification = experimentFromReport(corpus, amplified, 'relationship-expansion', after.features, after.adapters, before.head);
    expect(compareExperiments(before, amplification, corpus)).toMatchObject({ status: 'fail' });
    expect(() => experimentFromReport(corpus, { ...amplified, usage: { ...amplified.usage, evidenceBytes: 1 } }, 'relationship-expansion', after.features, after.adapters)).toThrow(/storage/i);
    expect(() => compareExperiments(before, after)).toThrow(/corpus/i);
    expect(() => compareExperiments(before, { ...after, samples: after.samples.slice(1) }, corpus)).toThrow(/report|holdout/i);
    expect(() => compareExperiments(before, { ...after, fixtureHash: 'a'.repeat(64) }, corpus)).toThrow(/drift/i);
    const securityReport = report('relationship-expansion', 0.6, 11);
    (securityReport.gates.failures as string[]).push('unauthorized-disclosure');
    const unsafe = experimentFromReport(corpus, securityReport, 'relationship-expansion', after.features, after.adapters, before.head);
    expect(compareExperiments(before, unsafe, corpus)).toMatchObject({ status: 'fail' });
    expect(() => compareExperiments(before, { ...unsafe, criticalFailures: [] }, corpus)).toThrow(/report/i);
    const absent = experimentFromReport(corpus, { ...securityReport, gates: { failures: [] }, rows: [] }, 'relationship-expansion', after.features, after.adapters, before.head);
    expect(compareExperiments(before, absent, corpus)).toEqual({ status: 'not_supported' });
    expect(() => compareExperiments(before, after, structuredClone(corpus))).toThrow(/loaded frozen corpus/);
    expect(() => compareExperiments(before, { ...after, samples: after.samples.map(row => ({ ...row, value: 1 })) }, corpus)).toThrow(/source report/);
  });

  it('exercises current audited services on exact APP and bound OP/SYNC LOGIN profiles', async () => {
    const head = process.env.CONTINUUM_EVAL_REPORT
      ? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim() : 'a'.repeat(40);
    const report = await runBaseline(await loadCorpus(), process.env.CONTINUUM_TEST_DATABASE_URL
      ?? 'postgres://continuum:continuum@localhost:5433/continuum', head);
    if (process.env.CONTINUUM_EVAL_REPORT) {
      const output = process.env.CONTINUUM_EVAL_REPORT;
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, boundReport(report), { flag: 'wx' });
      await writeFile(output.replace(/\.json$/, '.md'), `# Offline synthetic memory baseline\n\nHead: ${head}\nFixture: ${report.fixtureManifest}\nMechanism: ${report.gates.mechanism}\nNo live-model quality claim.\n`, { flag: 'wx' });
    }
    expect(report.rows.filter(row => row.status === 'failed')).toEqual([]);
    expect(report.gates).toMatchObject({ mechanism: 'pass', relationshipExpansion: 'not_supported' });
    expect(report.rows.find(row => row.id === 'expired-evidence' && row.ablation === 'hybrid')?.metrics?.recall).toBeNull();
    expect(report.rows.find(row => row.id === 'explicit-supersession' && row.ablation === 'hybrid')?.metrics?.recall).toBe(1);
    expect(report.rows.find(row => row.id === 'deterministic-agents-md')?.metrics?.recall).toBe(1);
    expect(report.rows.find(row => row.id === 'local-only-no-egress' && row.ablation === 'hybrid')?.calls).toBe(0);
    expect(report.experiments).toHaveLength(3);
    expect(report.sampleCounts.unsupported).toBeGreaterThan(0);
  }, 360_000);
});
