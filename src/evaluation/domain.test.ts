import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadCorpus, scoreRetrieval, scoreClaims, compareRuns, relationshipGate,
  evaluateMechanism, seededOrder, boundReport, runBaseline, evaluateTaskPair, validateCases, compareExperiments, checkedGrantSql } from './test-helpers.js';

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
    expect(holdout.every(item => item.documents.length >= 3 && item.relevant.some(ref => ref.grade < 3))).toBe(true);
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

  it('rejects unpaired experiment inputs, cap drift, missing adapters, and critical regressions', () => {
    const before = { head: 'a'.repeat(40), predecessorHead: 'b'.repeat(40), fixtureHash: 'c'.repeat(64),
      policyHash: 'd'.repeat(64), budgetHash: 'e'.repeat(64), seed: 25, runner: 'memory-evaluation-v1', gate: relationshipGate,
      split: 'holdout', repetitionRule: 'one-paired-mean-per-query',
      features: { hybrid: true, reranking: true, 'relationship-expansion': false }, adapters: { hybrid: '1', reranking: '1' },
      samples: Array.from({ length: 20 }, (_, i) => ({ id: `query-${i}`, value: 0.5 })),
      criticalFailures: [], criticalCoverageRegressions: 0, p95: 10, persistedBytes: 100, hardStorageBudget: 1000, supported: true };
    const after = { ...before, head: 'f'.repeat(40), predecessorHead: before.head,
      features: { ...before.features, 'relationship-expansion': true }, samples: before.samples.map(row => ({ ...row, value: 0.6 })) };
    expect(compareExperiments(before, after)).toMatchObject({ status: 'pass' });
    expect(compareExperiments(before, { ...after, supported: false })).toEqual({ status: 'not_supported' });
    expect(() => compareExperiments(before, { ...after, budgetHash: 'a'.repeat(64) })).toThrow(/drift/);
    expect(compareExperiments(before, { ...after, p95: 11.01 })).toMatchObject({ status: 'fail' });
    expect(compareExperiments(before, { ...after, persistedBytes: 201 })).toMatchObject({ status: 'fail' });
    expect(compareExperiments(before, { ...after, criticalFailures: ['unauthorized-disclosure'] })).toMatchObject({ status: 'fail' });
    expect(compareExperiments(before, { ...after, criticalCoverageRegressions: 1 })).toMatchObject({ status: 'fail' });
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
    expect(report.rows.find(row => row.id === 'local-only-no-egress')?.calls).toBe(0);
    expect(report.sampleCounts.unsupported).toBeGreaterThan(0);
  }, 180_000);
});
