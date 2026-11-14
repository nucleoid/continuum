import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { loadCorpus, withEvaluationFixture, retrievalInput, seededOrder, scoreRetrieval, checkDelivered,
  candidateUniverseHash, latencyPolicy, compareRuns, relationshipGate, sha256, type Reference } from './test-helpers.js';
import { Budget, type BudgetAdapter, type BudgetProfile } from '../pipeline/budget.js';
import { testReranking } from '../reranking/test-helpers.js';
import { configureReranking, type RerankingInput } from '../reranking/provider.js';
import { StubEmbeddingProvider } from '../embeddings/stub.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';
import { recallForPrincipal } from '../services/recall.js';

it('records interleaved local enabled/disabled/fallback ablations without claiming model qualification', async () => {
  const fixtureBytes = await readFile('evals/reranking-v1.json'); const spec = JSON.parse(fixtureBytes.toString());
  const corpus = await loadCorpus(); const cases = corpus.cases.filter(c => c.collection === 'ranking');
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', timeout: 5000 }).trim();
  const head = git('rev-parse', 'HEAD'); const tree = git('rev-parse', 'HEAD^{tree}');
  const cleanStart = !git('status', '--porcelain'); const sourceHead = process.env.CONTINUUM_EVAL_SOURCE_SHA ?? head;
  const observations: Array<Record<string, any>> = []; let setupCalls = 0; let calls = 0;
  let effectiveProfile: Readonly<BudgetProfile> | undefined;
  let setupMs = 0; let workMs = 0;
  const setupStarted = performance.now();
  await withEvaluationFixture(process.env.CONTINUUM_TEST_DATABASE_URL ?? 'postgres://continuum:continuum@localhost:5433/continuum', async ({ owner, app, actor }) => {
    const stub = new StubEmbeddingProvider();
    const shared = new Map<string, { scope: string; refs: Map<string, Reference> }>();
    for (const split of ['development', 'holdout']) {
      const item = cases.find(c => c.split === split)!;
      const scope = await createScope(owner, { kind: 'project', name: `reranking-${split}` });
      await addMembership(owner, actor.id, scope.id, 'writer');
      const refs = new Map<string, Reference>();
      // The exact same complete authorized split inventory competes in all modes.
      // Grades, relations and policy labels never enter either adapter.
      for (const doc of retrievalInput(corpus, item).documents) {
        const memory = await createMemory(app, { scopeId: scope.id, scopeKind: 'project', authorId: actor.id,
          title: doc.title, body: doc.body, sourceRef: `${doc.id}@${doc.version}`, type: 'decision', source: 'manual' });
        refs.set(memory.id, { id: doc.id, version: doc.version });
        await storeMemoryEmbeddingVector(app, memory.id, (await stub.embed([`${doc.title}\n\n${doc.body}`]))[0], stub); setupCalls++;
      }
      shared.set(split, { scope: scope.name, refs });
    }
    expect(performance.now() - setupStarted).toBeLessThan(spec.setupDeadlineMs);
    setupMs = performance.now() - setupStarted;
    const workStarted = performance.now();
    for (const item of seededOrder(cases, spec.seed)) {
      const { scope, refs } = shared.get(item.split)!;
      for (let repetition = 0; repetition <= latencyPolicy.repetitions; repetition++) {
        const modes = spec.modes as string[];
        const offset = (repetition + parseInt(sha256(item.id).slice(0, 4), 16)) % modes.length;
        for (const mode of [...modes.slice(offset), ...modes.slice(0, offset)]) {
          expect(performance.now() - workStarted).toBeLessThan(spec.workDeadlineMs);
          const actualResources = { inputBytes: 0, responseBytes: 0, inputTokenUnits: 0, outputTokenUnits: 0, spendMicros: 0 };
          const terms = item.query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
          const t = testReranking(c => terms.filter(term => `${c.title} ${c.excerpt}`.toLowerCase().includes(term)).length);
          t.adapter.version = spec.adapterVersion;
          // The real response and projection carry the exact immutable revision.
          t.adapter.invoke = async wire => {
            calls++; const { input } = JSON.parse(wire) as { input: RerankingInput };
            actualResources.inputBytes += Buffer.byteLength(wire); actualResources.inputTokenUnits += Buffer.byteLength(wire);
            const value = { version: spec.adapterVersion, scores: mode === 'fallback' ? [] : input.candidates.map(c => ({ id: c.id,
              score: terms.filter(term => `${c.title} ${c.excerpt}`.toLowerCase().includes(term)).length })) };
            const count = Buffer.byteLength(JSON.stringify(value));
            actualResources.responseBytes += count; actualResources.outputTokenUnits += count;
            return { value, response: value, usage: { provenance: 'measured', outputTokens: count, reasoningTokens: 0, completionTokens: count } };
          };
          const profile = t.config().profile;
          effectiveProfile = profile;
          const reranking = configureReranking(t.adapter, profile, { candidateLimit: spec.candidateLimit,
            evidence: { kind: 'local-contract', adapterId: t.adapter.id, version: t.adapter.version, model: t.adapter.model, profile: t.adapter.profile } });
          const embedding: BudgetAdapter<string[], number[][]> = { ...t.adapter, id: stub.id, outputTokens: 0, completionTokens: 0, responseBodyBytes: 65_536,
            serialize: (texts, caps) => ({ protocol: 'sha256-byte-protocol-v1', texts, caps }),
            async invoke(wire) { calls++; actualResources.inputBytes += Buffer.byteLength(wire); actualResources.inputTokenUnits += Buffer.byteLength(wire);
              const value = await stub.embed(JSON.parse(wire).texts); actualResources.responseBytes += Buffer.byteLength(JSON.stringify(value)); return { value, response: value,
              usage: { provenance: 'measured', outputTokens: 0, reasoningTokens: 0, completionTokens: 0 } }; } };
          const provider = { id: stub.id, dim: 768, local: true, pipelineAdapter: embedding, embed: stub.embed.bind(stub) };
          const budget = new Budget(profile); const beforeCalls = calls;
          const began = performance.now();
          const result = await recallForPrincipal(app, mode === 'lexical' ? null : provider, actor,
            { query: item.query, scopes: [`project:${scope}`], limit: spec.finalLimit }, {}, undefined, undefined, budget,
            mode === 'reranking' || mode === 'fallback' ? reranking : undefined);
          const latencyMs = performance.now() - began;
          const actual = result.results.map(r => refs.get(r.memory.id)!);
          const failures = checkDelivered(corpus, item, actual);
          const usage = budget.snapshot().used;
          const hardBudgetFailure = Object.entries(usage).some(([key, value]) => value > profile.limits[key as keyof typeof usage]);
          observations.push({ id: item.id, split: item.split, mode, repetition, warmup: repetition === 0, latencyMs,
            universeHash: candidateUniverseHash(corpus, item), metrics: scoreRetrieval(actual, item.relevant),
            failures, hardBudgetFailure, usage, actualResources, calls: calls - beforeCalls,
            reservedSpendMicros: usage.spendMicros, actualSpendMicros: 0, diagnostics: result.diagnostics });
          expect(failures).toEqual([]); expect(hardBudgetFailure).toBe(false);
          if (mode === 'reranking') expect(result.diagnostics.reranking).toEqual({ status: 'used' });
          if (mode === 'fallback') expect(result.diagnostics.reranking).toEqual({ status: 'fallback', reason: 'invalid_response' });
          expect(calls + setupCalls).toBeLessThanOrEqual(spec.maximumCalls);
        }
      }
    }
    workMs = performance.now() - workStarted;
    expect(workMs).toBeLessThan(spec.workDeadlineMs);
  });
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const rows = cases.flatMap(item => spec.modes.map((mode: string) => {
    const samples = observations.filter(o => o.id === item.id && o.mode === mode && !o.warmup);
    expect(samples).toHaveLength(latencyPolicy.repetitions);
    expect(new Set(samples.map(o => JSON.stringify(o.metrics))).size).toBe(1);
    return { id: item.id, split: item.split, mode, metrics: samples[0].metrics, latencyMs: median(samples.map(o => o.latencyMs)) };
  }));
  const summaries = spec.modes.map((mode: string) => {
    const selected = rows.filter(r => r.mode === mode); const times = selected.map(r => r.latencyMs).sort((a, b) => a - b);
    return { mode, queries: selected.length, p50Ms: median(times), p95Ms: times[Math.ceil(times.length * .95) - 1],
      meanNdcg: selected.reduce((n, r) => n + (r.metrics.ndcg ?? 0), 0) / selected.length,
      meanEvidenceCoverage: selected.reduce((n, r) => n + (r.metrics.evidenceCoverage ?? 0), 0) / selected.length,
      abstentionErrors: selected.reduce((n, r) => n + r.metrics.abstentionError, 0) };
  });
  const paired = (mode: string) => rows.filter(r => r.mode === mode && r.split === 'holdout' && r.metrics.ndcg !== null)
    .map(r => ({ id: r.id, value: r.metrics.ndcg! }));
  const report = { version: spec.version, head, sourceHead, tree, headEnd: git('rev-parse', 'HEAD'), cleanStart, cleanEnd: !git('status', '--porcelain'),
    predecessorSource: spec.predecessorSource, fixtureSha256: sha256(fixtureBytes), corpusManifest: corpus.manifestHash,
    seed: spec.seed, adapterVersion: spec.adapterVersion, adapterProfile: 'local-test-v1', profile: effectiveProfile, mode: 'local-deterministic-contract',
    qualityAcceptance: 'not_evaluated', realAdapterEnablement: 'unqualified', uncertainty: compareRuns(paired('hybrid'), paired('reranking'), relationshipGate),
    limitations: ['Synthetic query-overlap and SHA vectors do not measure model quality.', 'Byte-protocol token units do not qualify a real tokenizer or invoice.',
      'No cross-head feature acceptance or normalized storage evidence.'], latencyPolicy, setupCalls, calls, actualSpendMicros: 0,
    executionOrderSha256: sha256(JSON.stringify(observations.map(o => [o.id, o.mode, o.repetition]))),
    securityFailures: observations.filter(o => o.failures.length).length, hardBudgetFailures: observations.filter(o => o.hardBudgetFailure).length,
    reservedSpendMicros: observations.reduce((n, o) => n + o.reservedSpendMicros, 0),
    setupMs, workMs, summaries, rows, observations };
  await mkdir('.fire-off', { recursive: true });
  const serialized = JSON.stringify(report) + '\n';
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(corpus.manifest.budgets.maxArtifactBytes);
  await writeFile('.fire-off/reranking-eval.json', serialized);
  expect(report.headEnd).toBe(head); expect(report.securityFailures).toBe(spec.securityFailures); expect(report.hardBudgetFailures).toBe(spec.hardBudgetFailures);
}, 300_000);
