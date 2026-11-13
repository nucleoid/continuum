import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadCorpus, scoreRetrieval, scoreClaims, compareRuns, relationshipGate,
  evaluateMechanism, seededOrder, boundReport, runBaseline, evaluateTaskPair, validateCases, compareExperiments, checkedGrantSql, experimentFromReport,
  retrievalInput, evaluateRetrieval, PhaseBudget, planRows, checkDelivered, graphShortcutDiagnostics,
  acceptanceEligible, accountStorage, measureStorage, withEvaluationFixture, assertPublishableReport, candidateUniverseHash, latencyPolicy } from './test-helpers.js';

describe('frozen domain evaluator', () => {
  it('uses the shared authorized universe and catches foreign-case policy leaks', async () => {
    const corpus = await loadCorpus();
    const item = corpus.cases.find(item => item.id === 'aster-refunds')!;
    const other = corpus.cases.find(item => item.id === 'ember-handover')!;
    const denied = other.documents.find(doc => !doc.allowed)!;
    const input = retrievalInput(corpus, item);
    expect(input.documents.some(doc => other.relevant.some(ref => ref.id === doc.id))).toBe(true);
    expect(input.documents.some(doc => doc.id === denied.id)).toBe(false);
    expect(checkDelivered(corpus, item, [denied])).toContain('prohibited-evidence');
    const permitted = other.documents.find(doc => doc.allowed && doc.sourceAllowed)!;
    expect(checkDelivered(corpus, item, [permitted])).toEqual([]);
    for (const policy of [{ state: 'quarantined' as const }, { state: 'stale' as const }, { sourceAllowed: false }, { scope: 'project:denied' as const }]) {
      const changed = structuredClone(corpus);
      Object.assign(changed.cases.find(row => row.id === other.id)!.documents.find(doc => doc.id === permitted.id)!, policy);
      expect(checkDelivered(changed, item, [permitted])).toContain('prohibited-evidence');
      expect(retrievalInput(changed, item).documents.some(doc => doc.id === permitted.id)).toBe(false);
    }
    const hosted = { ...item, executionResidency: 'hosted' as const };
    expect(checkDelivered(corpus, hosted, [permitted])).toContain('prohibited-evidence');
    const erased = structuredClone(corpus);
    erased.cases.find(row => row.id === other.id)!.timeline.push({ at: '2026-01-01T00:00:00Z', action: 'erase', evidence: `${permitted.id}@${permitted.version}` });
    expect(checkDelivered(erased, item, [permitted])).toContain('prohibited-evidence');
    expect(retrievalInput(erased, item).documents.some(doc => doc.id === permitted.id)).toBe(false);
    const development = corpus.cases.find(row => row.collection === 'ranking' && row.split === 'development')!;
    expect(retrievalInput(corpus, development).documents.some(doc => doc.id === permitted.id)).toBe(false);
    expect(await evaluateRetrieval(corpus, item, async () => [{ id: denied.id, version: denied.version }]))
      .toMatchObject({ status: 'failed', reason: 'PROHIBITED_EVIDENCE' });
  });

  it('canonicalizes adapter input independently of authored case, document and relation order', async () => {
    const corpus = await loadCorpus();
    const item = corpus.cases.find(row => row.id === 'aster-refunds')!;
    const reversed = structuredClone(corpus);
    reversed.cases.reverse();
    for (const row of reversed.cases) { row.documents.reverse(); row.relations.reverse(); }
    const reordered = reversed.cases.find(row => row.id === item.id)!;
    expect(JSON.stringify(retrievalInput(reversed, reordered)) === JSON.stringify(retrievalInput(corpus, item))).toBe(true);
    expect(candidateUniverseHash(reversed, reordered)).toBe(candidateUniverseHash(corpus, item));
  });

  it('rejects self relations before accepting a fixture', async () => {
    const corpus = await loadCorpus();
    const item = structuredClone(corpus.cases.find(row => row.collection === 'ranking')!);
    const source = { id: item.documents[0].id, version: item.documents[0].version };
    item.relations = [{ type: 'supports', source, target: source }];
    expect(() => validateCases({ schema: 1, cases: [item] })).toThrow(/self relation/i);
  });

  it('rejects graph topology answer shortcuts and records query-independent rankings diagnostically', async () => {
    const corpus = await loadCorpus();
    const diagnostics = graphShortcutDiagnostics(corpus.cases);
    expect(diagnostics.localFeatures.length).toBeGreaterThanOrEqual(8);
    expect(diagnostics.localFeatures.every(row => row.positives > 0 && row.negatives > 0 && row.precision <= 0.75)).toBe(true);
    expect(diagnostics.maximumQueryBlindNdcg).toBeGreaterThanOrEqual(0);
    const forged = structuredClone(corpus);
    for (const item of forged.cases.filter(item => item.collection === 'ranking')) {
      item.relations = item.relevant.map(ref => ({ type: 'supports', source: { id: ref.id, version: ref.version }, target: { id: ref.id, version: ref.version } }));
    }
    expect(() => graphShortcutDiagnostics(forged.cases)).toThrow(/shortcut/i);
  });

  it('keeps dirty and synthetic evidence ineligible while permitting committed merges', () => {
    const head = 'a'.repeat(40);
    const proof = { headStart: head, headEnd: head, treeStart: head, treeEnd: head,
      parents: ['b'.repeat(40), 'c'.repeat(40)], cleanStart: true, cleanEnd: true, sourceIdentity: 'explicit' as const, context: 'local' as const };
    expect(acceptanceEligible(head, head, proof)).toBe(true);
    expect(acceptanceEligible(head, 'b'.repeat(40), proof)).toBe(false);
    expect(acceptanceEligible(head, head, { ...proof, cleanStart: false })).toBe(false);
    expect(acceptanceEligible(head, head, { ...proof, sourceIdentity: 'checkout' })).toBe(false);
  });

  it('counts non-public tables, materialized views and large-object growth', async () => {
    await withEvaluationFixture(process.env.CONTINUUM_TEST_DATABASE_URL ?? 'postgres://continuum:continuum@localhost:5433/continuum', async ({ owner }) => {
      const empty = await measureStorage(owner);
      await owner.query('CREATE SCHEMA eval_storage_probe');
      await owner.query("CREATE TABLE eval_storage_probe.receipts AS SELECT n, md5(n::text) AS body FROM generate_series(1,2000) n");
      const table = await measureStorage(owner);
      await owner.query('CREATE MATERIALIZED VIEW eval_storage_probe.edges AS SELECT * FROM eval_storage_probe.receipts');
      const view = await measureStorage(owner);
      await owner.query("SELECT lo_from_bytea(0, decode(string_agg(md5(n::text),''),'hex')) FROM generate_series(1,10000) n");
      const lob = await measureStorage(owner);
      expect(table.applicationBytes).toBeGreaterThan(empty.applicationBytes);
      expect(view.applicationBytes).toBeGreaterThan(table.applicationBytes);
      expect(lob.applicationBytes).toBeGreaterThan(view.applicationBytes);
      expect(accountStorage(empty, lob).evidenceBytes).toBeGreaterThan(0);
    });
    expect(accountStorage({ applicationBytes: 100, databaseBytes: 10000 }, { applicationBytes: 200, databaseBytes: 10500 }))
      .toMatchObject({ evidenceBytes: 500, persistedBytes: 600 });
  }, 180_000);

  it('returns insufficient evidence for a zero storage growth denominator', () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ id: String(index), value: 0.5 }));
    expect(compareRuns(rows, rows.map(row => ({ ...row, value: 0.6 })), relationshipGate, [], {
      baselineP95: 10, candidateP95: 10, baselineBytes: 0, candidateBytes: 0, hardStorageBudget: 1000,
      identicalCaps: true, criticalCoverageRegressions: 0 }).status).toBe('insufficient_evidence');
  });
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
    const input = retrievalInput(corpus, item);
    expect(Object.keys(input).sort()).toEqual(['documents', 'query', 'relations']);
    expect(input.documents.every(doc => !item.prohibited.includes(`${doc.id}@${doc.version}`))).toBe(true);
    expect(input.documents.every(doc => Object.keys(doc).sort().join(',') === 'body,id,title,version')).toBe(true);
    expect(input.relations.every(edge => input.documents.some(doc => doc.id === edge.target.id))).toBe(true);
    expect(await evaluateRetrieval(corpus, item, undefined)).toEqual({ status: 'not_supported' });
    const denied = item.documents.find(doc => item.prohibited.includes(`${doc.id}@${doc.version}`))!;
    expect(await evaluateRetrieval(corpus, item, async () => [{ id: denied.id, version: denied.version }])).toMatchObject({ status: 'failed', reason: 'PROHIBITED_EVIDENCE' });
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

  it('rejects oversized complete adapter context before invoking the adapter', async () => {
    const corpus = await loadCorpus();
    const task = structuredClone(corpus.cases.find(item => item.id === 'aster-refunds')!);
    task.documents = Array.from({ length: 5 }, (_, index) => ({ ...task.documents[0], id: `large-${index}`, body: 'x'.repeat(16_384) }));
    let called = false;
    expect(await evaluateRetrieval({ ...corpus, cases: corpus.cases.map(item => item.id === task.id ? task : item) }, task, async () => { called = true; return []; })).toEqual({ status: 'failed', reason: 'CONTEXT_BOUND' });
    expect(called).toBe(false);
  });

  it('refuses an unverified corpus or fictitious checkout before provisioning', async () => {
    const corpus = await loadCorpus();
    await expect(runBaseline(corpus, 'postgres://127.0.0.1:1/invalid', 'a'.repeat(40))).rejects.toThrow(/checkout/i);
    await expect(runBaseline(structuredClone(corpus), 'postgres://127.0.0.1:1/invalid', 'a'.repeat(40))).rejects.toThrow(/loaded frozen corpus/i);
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
      provenance: { headStart: (value === 0.5 ? 'a' : 'b').repeat(40), headEnd: (value === 0.5 ? 'a' : 'b').repeat(40),
        treeStart: 'd'.repeat(40), treeEnd: 'd'.repeat(40), parents: [], cleanStart: true, cleanEnd: true, sourceIdentity: 'explicit', context: 'local' },
      latencyEvidence: { policy: latencyPolicy, pairedSession: 'synthetic-pair', environment: 'e'.repeat(64) },
      fixtureManifest: corpus.manifestHash, seed: 25, runner: 'memory-evaluation-v1', budgets: corpus.manifest.budgets,
      gates: { failures: [] }, usage: { persistedBytes: 1100, emptySchemaBytes: 1000, evidenceBytes: 100, rawApplicationBytes: 1100, rawDatabaseBytes: 10100, emptyDatabaseBytes: 10000, candidateCount: 240, actualSpend: 0, reservedSpend: 0, calls: 24, retries: 0 },
      rows: ids.map(id => ({ id, ablation, status: 'measured', metrics: { ndcg: value, evidenceCoverage: 1 }, latencyMs: p95, latencySamplesMs: Array(5).fill(p95), universeHash: candidateUniverseHash(corpus, corpus.cases.find(item => item.id === id)!), failures: [] })) });
    const features = { hybrid: true, reranking: true, 'relationship-expansion': false };
    const before = experimentFromReport(corpus, report('hybrid-reranking', 0.5, 10), 'hybrid-reranking', features, { hybrid: '1', reranking: '1' });
    const after = experimentFromReport(corpus, report('relationship-expansion', 0.6, 11), 'relationship-expansion',
      { ...features, 'relationship-expansion': true }, { hybrid: '1', reranking: '1' }, before.head);
    // Self-labelled pairing and work counters cannot establish a verified paired execution.
    expect(compareExperiments(before, after, corpus)).toMatchObject({ status: 'insufficient_evidence' });
    const emptyGrowth = report('hybrid-reranking', 0.5, 10);
    Object.assign(emptyGrowth.usage, { evidenceBytes: 0, persistedBytes: 1000, rawApplicationBytes: 1000, rawDatabaseBytes: 10000 });
    expect(compareExperiments(experimentFromReport(corpus, emptyGrowth, 'hybrid-reranking', features, before.adapters), after, corpus))
      .toEqual(expect.objectContaining({ status: 'insufficient_evidence' }));
    const wrongMedian = report('relationship-expansion', 0.6, 11);
    wrongMedian.rows[0].latencyMs = 100;
    expect(experimentFromReport(corpus, wrongMedian, 'relationship-expansion', after.features, after.adapters, before.head).status).toBe('failed');
    const differentUniverse = report('relationship-expansion', 0.6, 11);
    differentUniverse.rows[0].universeHash = 'f'.repeat(64);
    expect(experimentFromReport(corpus, differentUniverse, 'relationship-expansion', after.features, after.adapters, before.head).status).toBe('failed');
    const noSource = { ...report('hybrid-reranking', 0.5, 10), sourceHead: undefined };
    expect(() => experimentFromReport(corpus, noSource, 'hybrid-reranking', features, {})).toThrow();
    expect(() => experimentFromReport(corpus, { ...report('hybrid-reranking', 0.5, 10), seed: 26 }, 'hybrid-reranking', features, {})).toThrow(/drift/i);
    expect(() => experimentFromReport(corpus, { ...noSource, sourceHead: 'c'.repeat(40) }, 'hybrid-reranking', features, {})).toThrow(/provenance/i);
    const amplified = report('relationship-expansion', 0.6, 11);
    amplified.usage.persistedBytes = 1300; amplified.usage.evidenceBytes = 300; amplified.usage.rawApplicationBytes = 1300; amplified.usage.rawDatabaseBytes = 10300;
    const amplification = experimentFromReport(corpus, amplified, 'relationship-expansion', after.features, after.adapters, before.head);
    expect(compareExperiments(before, amplification, corpus)).toMatchObject({ status: 'insufficient_evidence' });
    expect(() => experimentFromReport(corpus, { ...amplified, usage: { ...amplified.usage, evidenceBytes: 1 } }, 'relationship-expansion', after.features, after.adapters)).toThrow(/storage/i);
    const noPair = experimentFromReport(corpus, { ...report('relationship-expansion', 0.6, 11), latencyEvidence: { ...report('relationship-expansion', 0.6, 11).latencyEvidence, pairedSession: null } }, 'relationship-expansion', after.features, after.adapters, before.head);
    expect(compareExperiments(before, noPair, corpus)).toEqual({ status: 'insufficient_evidence' });
    const dirty = report('hybrid-reranking', 0.5, 10); dirty.provenance.cleanStart = false; dirty.predecessorEligible = false;
    expect(() => assertPublishableReport(dirty)).toThrow(/clean/i);
    expect(experimentFromReport(corpus, dirty, 'hybrid-reranking', features, {}).predecessorEligible).toBe(false);
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
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
    const report = await runBaseline(await loadCorpus(), process.env.CONTINUUM_TEST_DATABASE_URL
      ?? 'postgres://continuum:continuum@localhost:5433/continuum', head);
    if (process.env.CONTINUUM_EVAL_REPORT) {
      assertPublishableReport(report);
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
    expect(report.rows.filter(row => row.status === 'measured').every(row => row.latencySamplesMs?.length === 5 && row.evaluatorMs! >= 0)).toBe(true);
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8', timeout: 5000 }).trim() !== '';
    expect(report.provenance.cleanStart).toBe(!dirty);
    if (dirty || !process.env.CONTINUUM_EVAL_SOURCE_SHA) expect(report.predecessorEligible).toBe(false);
    expect(report.experiments).toHaveLength(3);
    expect(report.sampleCounts.unsupported).toBeGreaterThan(0);
  }, 360_000);
});
