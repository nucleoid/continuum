/** Source-checkout experiment only. The .test.ts suffix keeps all prototype code
 * out of tsc/package/container output. No serving relationship implementation. */
import { execFileSync } from 'node:child_process';
import { readFile, stat, writeFile, mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadCorpus, retrievalInput, checkDelivered, scoreRetrieval, compareRuns, relationshipGate,
  latencyPolicy, seededOrder, sha256, boundReport, PhaseBudget, withEvaluationFixture,
  graphShortcutDiagnostics, candidateUniverseHash, measureStorage, accountStorage,
  planRows, type Corpus, type FixtureCase, type Reference } from './test-helpers.js';
import { Budget, BudgetError, checkedProfile, starterProfile, type BudgetAdapter } from '../pipeline/budget.js';
import { runReranking } from '../reranking/runner.js';
import { configureReranking } from '../reranking/provider.js';
import { testReranking } from '../reranking/test-helpers.js';
import { StubEmbeddingProvider } from '../embeddings/stub.js';
import { recallCandidates } from '../storage/recall.js';
import { createMemory } from '../storage/memories.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';

const key = (ref: Reference) => `${ref.id}@${ref.version}`;
const reference = z.object({ id: z.string().regex(/^[a-z0-9-]{1,80}$/), version: z.string().regex(/^[1-9][0-9]*$/) }).strict();
const edgeSchema = z.object({ id: z.string().max(80), type: z.enum(['decision-supersession', 'evidence-dependency']),
  direction: z.literal('source-to-target'), source: reference, target: reference,
  scope: z.literal('project:synthetic'), policyVersion: z.literal('fixture-policy-v1'),
  sourceGeneration: z.literal(1), targetGeneration: z.literal(1), state: z.enum(['active', 'revoked', 'erased']),
  expiresAt: z.string().datetime().nullable(), provenance: z.object({
    kind: z.literal('synthetic-explicit-ledger'), version: z.literal('1'),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), targetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict() }).strict();
type Edge = z.infer<typeof edgeSchema>;
type Mode = 'seed-only' | 'typed-one-hop' | 'matched-extra-candidates';
const modes: Mode[] = ['seed-only', 'typed-one-hop', 'matched-extra-candidates'];
const limits = Object.freeze({ seeds: 10, edgesPerSeed: 5, additions: 50, total: 100, final: 10, baselinePool: 20 });
const profile = checkedProfile({ ...starterProfile, id: 'relationship-fixture-v1', overallMs: 1000, stageMs: 1000,
  limits: { ...starterProfile.limits, candidates: 100, hydratedBytes: 65_536, inputBytes: 65_536,
    contextTokens: 65_536, outputBytes: 65_536, outputTokens: 8192, completionTokens: 8192,
    calls: 2, retries: 0, storageBytes: 0, artifactBytes: 0 }, maxItemHydratedBytes: 16_384 });

type Header = { ref: Reference; family: string; scope: string; policyVersion: string; generation: number;
  current: boolean; active: boolean; expiresAt: number | null; readable: boolean; sourceReadable: boolean;
  localOnly: boolean; temporalMatch: boolean; bodyBytes: number };
type Body = { ref: Reference; title: string; body: string };
type FixturePort = {
  header(ref: Reference): Header | undefined;
  edges(seed: Reference): Promise<readonly Edge[]>;
  edgeCurrent(edge: Edge): boolean;
  hydrate(ref: Reference): Promise<Body>;
};
type StageResult = { status: 'used' | 'fallback' | 'cancelled'; refs: Reference[];
  diagnostic: 'used' | 'unavailable' | 'cancelled'; usage: ReturnType<Budget['snapshot']>['used'];
  work: { linkLookups: number; edgesInspected: number; additions: number; hydrationCount: number } };

function eligible(header: Header | undefined, now: number, hosted: boolean): header is Header {
  return !!header && header.current && header.active && header.readable && header.sourceReadable
    && header.policyVersion === 'fixture-policy-v1' && header.generation === 1 && header.temporalMatch
    && (header.expiresAt === null || (Number.isFinite(header.expiresAt) && header.expiresAt > now))
    && (!hosted || !header.localOnly);
}

/** Fixed seed rank, type order, target identity. No recursion, edge confidence,
 * advisory metadata, relevance judgments or relationship prose enters ranking. */
async function additionsFor(seeds: readonly Reference[], port: FixturePort, now: () => number,
  hosted: boolean, assertLive: () => void, work: StageResult['work']): Promise<Reference[]> {
  const seen = new Set(seeds.map(key)); const additions: Reference[] = [];
  for (const seed of seeds.slice(0, limits.seeds)) {
    assertLive();
    if (!eligible(port.header(seed), now(), hosted)) continue;
    work.linkLookups++;
    const raw = await port.edges(seed); assertLive();
    // The port must perform a bounded metadata lookup, never hand us an unbounded graph.
    if (raw.length > limits.edgesPerSeed) throw new Error('Unbounded link input');
    const edges = raw.map(value => edgeSchema.parse(value)).sort((a, b) => a.type.localeCompare(b.type)
      || key(a.target).localeCompare(key(b.target)) || a.id.localeCompare(b.id));
    for (const edge of edges) {
      assertLive(); work.edgesInspected++;
      if (key(edge.source) !== key(seed)) throw new Error('Wrong link direction');
      const source = port.header(edge.source), target = port.header(edge.target);
      if (!eligible(source, now(), hosted) || !eligible(target, now(), hosted) || !port.edgeCurrent(edge)
        || edge.state !== 'active' || edge.policyVersion !== source.policyVersion
        || edge.scope !== source.scope || edge.scope !== target.scope
        || edge.sourceGeneration !== source.generation || edge.targetGeneration !== target.generation
        || (edge.expiresAt !== null && Date.parse(edge.expiresAt) <= now())) continue;
      if (!seen.has(key(edge.target))) {
        seen.add(key(edge.target)); additions.push(edge.target);
        if (additions.length === limits.additions) return additions;
      }
    }
  }
  return additions;
}

async function prototype(input: { query: string; pool: Reference[]; baseline: Reference[]; mode: Mode;
  port: FixturePort; budget: Budget; now?: () => number; hosted?: boolean; signal?: AbortSignal;
  rerank: (bodies: Body[], authorize: () => Promise<boolean>) => Promise<Reference[] | null> }): Promise<StageResult> {
  const { port, budget, signal } = input; const now = input.now ?? Date.now; const hosted = input.hosted ?? false;
  const work = { linkLookups: 0, edgesInspected: 0, additions: 0, hydrationCount: 0 };
  const live = () => { signal?.throwIfAborted(); budget.assertLive(); };
  const current = (refs: readonly Reference[]) => refs.filter(ref => eligible(port.header(ref), now(), hosted));
  const result = (status: StageResult['status'], refs: Reference[]): StageResult => ({ status, refs,
    diagnostic: status === 'used' ? 'used' : status === 'cancelled' ? 'cancelled' : 'unavailable', usage: budget.snapshot().used, work });
  // Recheck the independent baseline on fallback. Failure establishing current
  // authority cannot revive the old baseline or expose a raw dependency error.
  const fallback = () => {
    if (signal?.aborted) return result('cancelled', []);
    try { return result('fallback', current(input.baseline).slice(0, limits.final)); }
    catch { return result('fallback', []); }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let closed = false;
  const assertLive = () => { if (closed) throw new Error('Closed stage'); live(); };
  const run = async () => {
    assertLive();
    if (input.pool.length > limits.total || new Set(input.pool.map(key)).size !== input.pool.length) throw new Error('Invalid pool');
    const pool = current(input.pool), base = pool.slice(0, limits.baselinePool);
    budget.consume({ candidates: pool.length });
    const additions = input.mode === 'seed-only' ? [] : await additionsFor(base.slice(0, limits.seeds), port, now, hosted, assertLive, work);
    const extra = input.mode === 'matched-extra-candidates'
      ? pool.slice(limits.baselinePool, limits.baselinePool + additions.filter(ref => !base.some(row => key(row) === key(ref))).length)
      : additions;
    const selected = [...new Map([...base, ...extra].map(ref => [key(ref), ref])).values()];
    if (input.mode === 'matched-extra-candidates' && selected.length !== base.length
      + additions.filter(ref => !base.some(row => key(row) === key(ref))).length) throw new Error('Unmatched control');
    if (selected.length > limits.total) throw new BudgetError();
    const outside = selected.filter(ref => !pool.some(row => key(row) === key(ref))).length;
    budget.consume({ candidates: outside }); work.additions = selected.length - base.length;
    const bodies: Body[] = [];
    for (const ref of selected) {
      assertLive(); const header = port.header(ref);
      if (!eligible(header, now(), hosted)) throw new Error('Authority changed');
      if (!Number.isSafeInteger(header.bodyBytes) || header.bodyBytes < 0 || header.bodyBytes > budget.profile.maxItemHydratedBytes) throw new BudgetError();
      budget.consume({ hydratedBytes: header.bodyBytes });
      const body = await port.hydrate(ref); assertLive();
      if (key(body.ref) !== key(ref) || !eligible(port.header(ref), now(), hosted)) throw new Error('Version changed');
      const bytes = Buffer.byteLength(JSON.stringify(body));
      if (bytes > header.bodyBytes) throw new BudgetError();
      work.hydrationCount++; bodies.push(body);
    }
    const authorize = async () => {
      assertLive();
      if (!selected.every(ref => eligible(port.header(ref), now(), hosted))) return false;
      if (input.mode === 'seed-only') return true;
      const fresh = await additionsFor(base.slice(0, limits.seeds), port, now, hosted, assertLive, work);
      return JSON.stringify(fresh) === JSON.stringify(additions);
    };
    if (!await authorize()) throw new Error('Authority changed');
    const ranked = await input.rerank(bodies, authorize); assertLive();
    if (!ranked || ranked.length !== selected.length || new Set(ranked.map(key)).size !== selected.length
      || ranked.some(ref => !selected.some(row => key(row) === key(ref))) || !await authorize()) throw new Error('Invalid ranking');
    const refs = ranked.slice(0, limits.final);
    budget.consume({ outputBytes: Buffer.byteLength(JSON.stringify(refs)) });
    return result('used', refs);
  };
  try {
    return await Promise.race([run(), new Promise<StageResult>(resolve => {
      timer = setTimeout(() => { closed = true; resolve(fallback()); }, budget.remainingMs());
      onAbort = () => { closed = true; resolve(result('cancelled', [])); };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    })]);
  } catch { return fallback(); }
  finally { closed = true; clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort); }
}

type Observation = { id: string; mode: Mode; repetition: number; refs: Reference[];
  failures: string[]; status: StageResult['status']; stageLatencyMs: number;
  usage: StageResult['usage']; work: StageResult['work']; vectorStatus?: string };
type RunFailure = { error: unknown };

async function persistReport(path: string, report: unknown, failure?: RunFailure): Promise<void> {
  // Exclusive creation preserves earlier evidence on an accidental replay.
  // Propagate the original failure only after preserving its bounded report.
  await writeFile(path, boundReport(report), { flag: 'wx' });
  if (failure) throw failure.error;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Connected query/source-family components are the uncertainty units. Repeats
 * and correlated questions contribute one cluster mean, never extra N. */
function pairedAnalysis(cases: FixtureCase[], observations: Observation[]) {
  const holdout = cases.filter(item => item.split === 'holdout');
  if (new Set(holdout.map(item => item.id)).size !== holdout.length) throw new Error('Duplicate paired query');
  const rows = holdout.flatMap(item => modes.map(mode => {
    const all = observations.filter(row => row.id === item.id && row.mode === mode);
    const samples = all.filter(row => row.repetition > 0);
    if (samples.length !== latencyPolicy.repetitions || new Set(samples.map(row => row.repetition)).size !== latencyPolicy.repetitions
      || samples.some(row => row.repetition > latencyPolicy.repetitions)
      || all.length !== latencyPolicy.repetitions + latencyPolicy.warmups || all.filter(row => row.repetition === 0).length !== 1) throw new Error('Incomplete paired samples');
    const metrics = samples.map(row => scoreRetrieval(row.refs, item.relevant));
    return { id: item.id, mode, ndcg: metrics.some(m => m.ndcg === null) ? null : mean(metrics.map(m => m.ndcg!)),
      evidenceCoverage: metrics.some(m => m.evidenceCoverage === null) ? null : mean(metrics.map(m => m.evidenceCoverage!)),
      abstentionErrors: metrics.reduce((n, m) => n + m.abstentionError, 0),
      duplicateResults: metrics.reduce((n, m) => n + m.duplicateResults, 0),
      stageMedianMs: median(samples.map(row => row.stageLatencyMs)),
      failures: samples.flatMap(row => row.failures), fallbacks: samples.filter(row => row.status !== 'used').length };
  }));
  if (observations.some(row => !holdout.some(item => item.id === row.id))) throw new Error('Unknown paired query');
  const groups = holdout.map(item => ({ ids: [item.id], families: new Set(item.relevant.map(ref => ref.family)) }));
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length;) {
    if ([...groups[j].families].some(family => groups[i].families.has(family))) {
      groups[i].ids.push(...groups[j].ids); for (const family of groups[j].families) groups[i].families.add(family);
      groups.splice(j, 1); i = -1; break;
    } else j++;
  }
  const pairs = (mode: Mode) => groups.flatMap(group => {
    const selected = rows.filter(row => row.mode === mode && group.ids.includes(row.id));
    return selected.some(row => row.ndcg === null) ? [] : [{ id: [...group.ids].sort().join('+'), value: mean(selected.map(row => row.ndcg!)) }];
  });
  const failures = observations.flatMap(row => row.failures);
  const unmatchedControls = observations.filter(row => row.mode === 'typed-one-hop').filter(row => {
    const control = observations.find(other => other.id === row.id && other.repetition === row.repetition && other.mode === 'matched-extra-candidates');
    return !control || control.status !== 'used' || row.status !== 'used' || control.work.additions !== row.work.additions;
  }).map(row => ({ id: row.id, repetition: row.repetition }));
  const coverageRegressions = rows.filter(row => row.mode === 'typed-one-hop').filter(row => {
    const baseline = rows.find(before => before.id === row.id && before.mode === 'seed-only')!;
    return row.evidenceCoverage !== null && baseline.evidenceCoverage !== null && row.evidenceCoverage < baseline.evidenceCoverage;
  }).map(row => row.id);
  // No resources passed: compareRuns can produce diagnostic uncertainty, never
  // acceptance from stage-only timing or whole-database growth.
  return { rows, independentUnits: groups.map(group => [...group.ids].sort()),
    typedVsSeed: compareRuns(pairs('seed-only'), pairs('typed-one-hop'), relationshipGate, failures),
    typedVsControl: compareRuns(pairs('matched-extra-candidates'), pairs('typed-one-hop'), relationshipGate, failures),
    criticalCoverageRegressions: coverageRegressions, unmatchedControls };
}

function decision(analysis: ReturnType<typeof pairedAnalysis> | null, hardFailures: string[] = []) {
  const failed = hardFailures.length > 0 || (!!analysis && (analysis.rows.some(row => row.failures.length) || analysis.criticalCoverageRegressions.length > 0));
  return { outcome: failed ? 'no-go' : 'inconclusive', graphRuntimeAuthorized: false,
    reasons: [...hardFailures, ...(failed ? ['critical-regression'] : []), ...(analysis ? [] : ['not-measured']),
      ...(analysis?.unmatchedControls.length ? ['unmatched-or-unavailable-control'] : []),
      'real-hybrid-reranker-unqualified', 'verified-end-to-end-pairing-unavailable', 'normalized-total-storage-unavailable'],
    arithmeticIsAcceptance: false };
}

function typedTopologyDiagnostics(corpus: Corpus, edges: Edge[]) {
  return ['development', 'holdout'].flatMap(split => ['decision-supersession', 'evidence-dependency'].flatMap(type =>
    ['source', 'target'].map(endpoint => {
      let positives = 0, negatives = 0;
      const scores: number[] = [];
      for (const item of corpus.cases.filter(row => row.collection === 'ranking' && row.split === split)) {
        const input = retrievalInput(corpus, item); const allowed = new Set(input.documents.map(key));
        const selected = new Set(edges.filter(edge => edge.type === type && allowed.has(key(edge.source)) && allowed.has(key(edge.target)))
          .map(edge => key(endpoint === 'source' ? edge.source : edge.target)));
        // Per-query incidence is descriptive only. A low split-wide precision
        // cannot rule out a query-conditioned authored-topology shortcut.
        for (const ref of selected) { if (item.relevant.some(row => key(row) === ref)) positives++; else negatives++; }
        const ranked = [...input.documents].sort((a, b) => Number(selected.has(key(b))) - Number(selected.has(key(a))) || key(a).localeCompare(key(b)));
        scores.push(scoreRetrieval(ranked, item.relevant).ndcg ?? 0);
      }
      return { split, type, endpoint, positives, negatives, precision: positives + negatives ? positives / (positives + negatives) : null,
        queryBlindMeanNdcg: mean(scores), sufficientForShortcutExclusion: false };
    })));
}

async function readJson(path: string, maximum: number) {
  if ((await stat(path)).size > maximum) throw new Error('Input bound');
  const bytes = await readFile(path); if (bytes.length > maximum) throw new Error('Input bound');
  return { bytes, value: JSON.parse(bytes.toString('utf8')) as unknown };
}

// These hashes freeze NEW experiment inputs before any measurements. The original
// #25 manifest, scorer, gate, corpus and assertions remain untouched.
const PREREGISTRATION_SHA256 = '857dbe68bb6620ae7c270cb140ea7f84a679ae419cab6845870ab95113b37ce2';
async function registration() {
  const input = await readJson('evals/relationship-preregistration-v1.json', 65_536);
  if (sha256(input.bytes) !== PREREGISTRATION_SHA256) throw new Error('Preregistration drift');
  const spec = input.value as { gate: typeof relationshipGate; latencyPolicy: typeof latencyPolicy;
    corpusManifest: string; ledgerSha256: string; profileSha256: string; holdout: string[]; development: string[];
    predecessorHeads: Record<string, string>; limits: typeof limits; maximumCalls: number };
  const corpus = await loadCorpus();
  const ledger = await readJson('evals/relationship-links-v1.json', 65_536);
  const parsed = z.object({ version: z.literal('relationship-links-v1'), synthetic: z.literal(true),
    semantics: z.literal('authored-fixture-ledger-only'), edges: z.array(edgeSchema).max(100) }).strict().parse(ledger.value);
  if (new Set(parsed.edges.map(edge => edge.id)).size !== parsed.edges.length) throw new Error('Duplicate edge');
  if (JSON.stringify(spec.gate) !== JSON.stringify(relationshipGate) || JSON.stringify(spec.latencyPolicy) !== JSON.stringify(latencyPolicy)
    || JSON.stringify(spec.limits) !== JSON.stringify(limits) || spec.corpusManifest !== corpus.manifestHash
    || spec.ledgerSha256 !== sha256(ledger.bytes) || spec.profileSha256 !== sha256(JSON.stringify(profile))) throw new Error('Frozen policy drift');
  for (const split of ['development', 'holdout'] as const) {
    const actual = corpus.cases.filter(item => item.collection === 'ranking' && item.split === split).map(item => item.id).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...spec[split]].sort())) throw new Error('Split drift');
  }
  return { corpus, edges: parsed.edges, spec, hash: sha256(input.bytes) };
}

function fixturePort(corpus: Corpus, item: FixtureCase, edges: Edge[]): FixturePort {
  const documents = corpus.cases.filter(row => row.collection === 'ranking' && row.split === item.split).flatMap(row => row.documents);
  const allowed = new Set(retrievalInput(corpus, item).documents.map(key));
  // Fixture setup supplies immutable metadata. Edge admission below uses only
  // these headers/digests, never reads a target body to establish permission.
  const digests = new Map(documents.map(doc => [key(doc), sha256(`${doc.title}\n\n${doc.body}`)]));
  const headers = new Map(documents.map(doc => [key(doc), { ref: { id: doc.id, version: doc.version }, family: doc.family,
    scope: doc.scope, policyVersion: 'fixture-policy-v1', generation: 1, current: true, active: doc.state === 'live',
    expiresAt: null, readable: allowed.has(key(doc)), sourceReadable: doc.sourceAllowed,
    localOnly: doc.residency === 'local-only', temporalMatch: true,
    bodyBytes: Buffer.byteLength(JSON.stringify({ ref: { id: doc.id, version: doc.version }, title: doc.title, body: doc.body })) } satisfies Header]));
  return { header: ref => headers.get(key(ref)),
    edges: async seed => edges.filter(edge => key(edge.source) === key(seed)).sort((a, b) => a.type.localeCompare(b.type)
      || key(a.target).localeCompare(key(b.target)) || a.id.localeCompare(b.id)).slice(0, limits.edgesPerSeed),
    edgeCurrent: edge => edge.provenance.sourceSha256 === digests.get(key(edge.source)) && edge.provenance.targetSha256 === digests.get(key(edge.target)),
    async hydrate(ref) {
      // Labels and relation basis never reach the reranker. This is fixture body
      // access, not a claim of locked SQL authorization or service read auditing.
      const doc = documents.find(row => key(row) === key(ref)); if (!doc) throw new Error('Missing version');
      return { ref: { id: doc.id, version: doc.version }, title: doc.title, body: doc.body };
    } };
}

it('freezes the existing gate, all holdouts, repetitions, profile and explicit ledger before measurement', async () => {
  const { corpus, edges, spec } = await registration();
  expect(spec.holdout).toHaveLength(24); expect(spec.development).toHaveLength(5);
  expect(edges.length).toBeGreaterThan(0); expect(graphShortcutDiagnostics(corpus.cases).maximumQueryBlindNdcg).toBeGreaterThanOrEqual(0);
  expect(decision(null)).toMatchObject({ outcome: 'inconclusive', graphRuntimeAuthorized: false });
});

// Small adversarial fixtures are separate from quality holdouts. No test result
// below is substituted for measured model, database or lifecycle acceptance.
function unitWorld(count = 80) {
  const refs = Array.from({ length: count }, (_, i) => ({ id: `node-${String(i).padStart(3, '0')}`, version: '1' }));
  const headers = new Map(refs.map(ref => [key(ref), { ref, family: ref.id, scope: 'project:synthetic', policyVersion: 'fixture-policy-v1',
    generation: 1, current: true, active: true, expiresAt: null, readable: true, sourceReadable: true, localOnly: true, temporalMatch: true,
    bodyBytes: Buffer.byteLength(JSON.stringify({ ref, title: ref.id, body: 'reference data' })) } as Header]));
  const edges: Edge[] = [];
  const connect = (a: number, b: number, type: Edge['type'] = 'evidence-dependency') => {
    const edge: Edge = { id: `edge-${edges.length}`, source: refs[a], target: refs[b], type, direction: 'source-to-target', scope: 'project:synthetic',
      policyVersion: 'fixture-policy-v1', sourceGeneration: 1, targetGeneration: 1, state: 'active', expiresAt: null,
      provenance: { kind: 'synthetic-explicit-ledger', version: '1', sourceSha256: 'a'.repeat(64), targetSha256: 'b'.repeat(64) } };
    edges.push(edge); return edge;
  };
  const hydrate = vi.fn(async (ref: Reference) => ({ ref, title: ref.id, body: 'reference data' }));
  const port: FixturePort = { header: ref => headers.get(key(ref)), edges: async ref => edges.filter(edge => key(edge.source) === key(ref)),
    edgeCurrent: edge => edge.state === 'active', hydrate };
  const rerank = vi.fn(async (bodies: Body[]) => bodies.map(body => body.ref).reverse());
  const run = (extra: Partial<Parameters<typeof prototype>[0]> = {}) => prototype({ query: 'fixture', pool: refs.slice(0, 20),
    baseline: refs.slice(0, 10), mode: 'typed-one-hop', port, budget: new Budget(profile), rerank, ...extra });
  return { refs, headers, edges, connect, hydrate, port, rerank, run };
}

it('limits seed rank/fanout/additions, traverses exactly one hop and deduplicates cycles', async () => {
  const world = unitWorld();
  for (let seed = 0; seed < 11; seed++) for (let target = 0; target < 5; target++) world.connect(seed, 20 + seed * 5 + target);
  world.connect(70, 79); // Not a seed: never followed.
  const result = await world.run();
  expect(result.status).toBe('used'); expect(result.work.additions).toBe(50);
  expect(world.hydrate).toHaveBeenCalledTimes(70); expect(world.hydrate.mock.calls.some(([ref]) => key(ref) === key(world.refs[79]))).toBe(false);
  const cycle = unitWorld(); cycle.connect(0, 20); cycle.connect(1, 20); cycle.connect(20, 21); cycle.connect(0, 0);
  expect((await cycle.run()).work.additions).toBe(1);
  expect(cycle.hydrate.mock.calls.map(([ref]) => key(ref))).not.toContain(key(cycle.refs[21]));
  const oversized = unitWorld(); for (let i = 20; i < 26; i++) oversized.connect(0, i);
  expect((await oversized.run()).status).toBe('fallback'); expect(oversized.hydrate).not.toHaveBeenCalled();
});

it('orders by seed, type, target without topology scoring or confidence credit', async () => {
  const world = unitWorld(); world.connect(0, 23); world.connect(0, 21, 'decision-supersession'); world.connect(0, 22);
  world.connect(1, 20); world.edges.reverse();
  await world.run(); expect(world.hydrate.mock.calls.slice(20).map(([ref]) => ref.id)).toEqual(['node-021', 'node-022', 'node-023', 'node-020']);
  const bad = unitWorld(); Object.assign(bad.connect(0, 20), { confidence: 1, related: ['node-021'] });
  expect((await bad.run()).status).toBe('fallback'); expect(bad.hydrate).not.toHaveBeenCalled();
});

it.each(['readable', 'sourceReadable', 'active', 'current', 'temporalMatch'] as const)('denies %s before target hydration', async field => {
  const world = unitWorld(); world.connect(0, 20); world.headers.get(key(world.refs[20]))![field] = false;
  const result = await world.run(); expect(result.status).toBe('used'); expect(result.work.additions).toBe(0);
  expect(world.hydrate.mock.calls.map(([ref]) => key(ref))).not.toContain(key(world.refs[20]));
});

it('denies expired, generation-mismatched, quarantined/archived and hosted-local-only targets', async () => {
  for (const change of [{ expiresAt: 1 }, { generation: 2 }, { active: false }]) {
    const world = unitWorld(); world.connect(0, 20); Object.assign(world.headers.get(key(world.refs[20]))!, change);
    expect((await world.run({ now: () => 2 })).work.additions).toBe(0);
  }
  const hosted = unitWorld(); hosted.connect(0, 20);
  expect((await hosted.run({ hosted: true })).refs).toEqual([]); expect(hosted.hydrate).not.toHaveBeenCalled();
});

it('uses a matched extra-candidate count and preserves whole-stage current fallback on malformed or unavailable work', async () => {
  const world = unitWorld(); world.connect(0, 40); world.connect(0, 41);
  const control = await world.run({ pool: world.refs.slice(0, 30), mode: 'matched-extra-candidates' });
  expect(control.work.additions).toBe(2); expect(world.hydrate.mock.calls.slice(20).map(([ref]) => ref.id)).toEqual(['node-020', 'node-021']);
  const unavailable = unitWorld(); unavailable.connect(0, 20);
  unavailable.port.edges = async () => { throw new Error('PRIVATE error node-999'); };
  unavailable.headers.get(key(unavailable.refs[0]))!.readable = false;
  const result = await unavailable.run(); expect(result.status).toBe('fallback'); expect(result.refs).toEqual(unavailable.refs.slice(1, 10));
  expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(unavailable.hydrate).not.toHaveBeenCalled();
  const budget = unitWorld(); budget.connect(0, 20);
  expect((await budget.run({ budget: new Budget({ ...profile, limits: { ...profile.limits, hydratedBytes: 1 }, maxItemHydratedBytes: 1 }) })).status).toBe('fallback');
});

it('fences edge/source revocation during inference and suppresses late/cancelled work', async () => {
  const world = unitWorld(); const edge = world.connect(0, 20);
  expect((await world.run({ rerank: async bodies => { edge.state = 'revoked'; return bodies.map(body => body.ref); } })).status).toBe('fallback');
  const changed = unitWorld(); changed.connect(0, 20);
  const result = await changed.run({ rerank: async bodies => { changed.headers.get(key(changed.refs[0]))!.current = false; return bodies.map(body => body.ref); } });
  expect(result.status).toBe('fallback'); expect(result.refs.some(ref => key(ref) === key(changed.refs[0]))).toBe(false);
  vi.useFakeTimers();
  try {
    const late = unitWorld(); let release!: (edges: Edge[]) => void;
    late.port.edges = () => new Promise(resolve => { release = resolve; });
    const pending = late.run(); await vi.advanceTimersByTimeAsync(1001);
    expect((await pending).status).toBe('fallback'); release([]); await vi.advanceTimersByTimeAsync(0);
    expect(late.hydrate).not.toHaveBeenCalled();
    const aborted = unitWorld(); const controller = new AbortController(); controller.abort();
    expect((await aborted.run({ signal: controller.signal })).status).toBe('cancelled'); expect(aborted.hydrate).not.toHaveBeenCalled();
    const disconnected = unitWorld(); const disconnect = new AbortController();
    let settle!: (edges: Edge[]) => void;
    disconnected.port.edges = () => new Promise(resolve => { settle = resolve; });
    const active = disconnected.run({ signal: disconnect.signal }); disconnect.abort();
    expect((await active).refs).toEqual([]); settle([]); await vi.advanceTimersByTimeAsync(0);
    expect(disconnected.hydrate).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it('keeps frozen quality/resource/security thresholds authoritative over synthetic gains', () => {
  const before = Array.from({ length: 20 }, (_, i) => ({ id: `independent-${i}`, value: 0.5 }));
  const after = before.map(row => ({ ...row, value: 0.75 }));
  const resources = { baselineP95: 100, candidateP95: 110, baselineBytes: 1000, candidateBytes: 2000,
    hardStorageBudget: 16_777_216, identicalCaps: true, criticalCoverageRegressions: 0 };
  expect(compareRuns(before, after, relationshipGate, [], resources).status).toBe('pass'); // Arithmetic only.
  for (const failure of ['security', 'authorization', 'deletion', 'quarantine', 'residency', 'supersession']) {
    expect(compareRuns(before, after, relationshipGate, [failure], resources).status).toBe('fail');
  }
  for (const change of [{ candidateP95: 110.01 }, { candidateBytes: 2001 }, { identicalCaps: false },
    { criticalCoverageRegressions: 1 }, { candidateBytes: 16_777_217 }]) {
    expect(compareRuns(before, after, relationshipGate, [], { ...resources, ...change }).status).toBe('fail');
  }
  expect(compareRuns(before.slice(1), after.slice(1), relationshipGate, [], resources).status).toBe('insufficient_evidence');
  expect(compareRuns(before, after, relationshipGate, [], { ...resources, baselineBytes: 0 }).status).toBe('insufficient_evidence');
  expect(compareRuns(before, before, relationshipGate, [], resources).status).toBe('fail');
});

it('clusters duplicate source families, rejects missing pairs and makes hard failures override quality', async () => {
  const corpus = await loadCorpus(); const first = structuredClone(corpus.cases.find(item => item.collection === 'ranking' && item.split === 'holdout')!);
  const second = { ...structuredClone(first), id: 'duplicate-query' };
  const observations = [first, second].flatMap(item => modes.flatMap(mode => Array.from({ length: 6 }, (_, repetition): Observation => ({
    id: item.id, mode, repetition, refs: item.relevant, failures: [], status: 'used', stageLatencyMs: 1,
    usage: new Budget(profile).snapshot().used, work: { linkLookups: 0, edgesInspected: 0, additions: 0, hydrationCount: 0 } }))));
  const analysis = pairedAnalysis([first, second], observations);
  expect(analysis.independentUnits).toHaveLength(1); expect(analysis.typedVsSeed.pairs).toBe(1);
  expect(analysis.typedVsSeed.status).toBe('insufficient_evidence'); expect(decision(analysis).graphRuntimeAuthorized).toBe(false);
  expect(() => pairedAnalysis([first, second], observations.slice(1))).toThrow('Incomplete');
  observations[1].failures.push('prohibited-evidence'); expect(decision(pairedAnalysis([first, second], observations)).outcome).toBe('no-go');
  expect(decision(analysis, ['hard-storage-ceiling']).outcome).toBe('no-go');
});

it('retains failed observations before propagating failure and refuses to overwrite earlier evidence', async () => {
  await mkdir('.fire-off', { recursive: true });
  const directory = await mkdtemp(resolve('.fire-off', 'relationship-report-test-'));
  const path = resolve(directory, 'report.json');
  const failure = new Error('delivery assertion failed');
  const report = { rows: [], observations: [{ id: 'denied-target', failures: ['prohibited-evidence'],
    usage: { candidates: 21 }, work: { hydrationCount: 21 } }], complete: false,
    decision: decision(null, ['prohibited-evidence', 'execution-incomplete']) };
  try {
    await expect(persistReport(path, report, { error: failure })).rejects.toBe(failure);
    const saved = await readFile(path, 'utf8');
    expect(JSON.parse(saved)).toEqual(report);
    expect(JSON.parse(saved).decision).toMatchObject({ outcome: 'no-go', graphRuntimeAuthorized: false });
    await expect(persistReport(path, { rows: [], observations: [], complete: true })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path, 'utf8')).toBe(saved);
  } finally {
    await rm(path, { force: true });
    await rmdir(directory);
  }
});

it('records paired typed-link/control diagnostics using the actual frozen #25 fixture and candidate implementation', async () => {
  const { corpus, edges, spec, hash } = await registration();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 }).trim();
  const head = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}'), cleanStart = !git('status', '--porcelain');
  for (const predecessor of Object.values(spec.predecessorHeads)) git('merge-base', '--is-ancestor', predecessor, head);
  const phase = new PhaseBudget(120_000, 120_000); const observations: Observation[] = [];
  const cases = corpus.cases.filter(item => spec.holdout.includes(item.id)); let calls = 0, setupCalls = 0;
  const documents = retrievalInput(corpus, cases[0]).documents;
  planRows(cases.length, 0, modes.length, corpus.manifest.budgets.maxRows);
  expect(documents.length + cases.length * modes.length * (latencyPolicy.repetitions + latencyPolicy.warmups) * profile.limits.calls)
    .toBeLessThanOrEqual(spec.maximumCalls);
  let storage: ReturnType<typeof accountStorage> | null = null;
  let failure: RunFailure | undefined;
  let unrecordedAttempt: { id: string; mode: Mode; repetition: number; budget: Budget } | undefined;
  try {
    storage = await withEvaluationFixture(process.env.CONTINUUM_TEST_DATABASE_URL ?? 'postgres://continuum:continuum@localhost:5433/continuum', async ({ owner, app, actor, emptyStorage }) => {
      const scope = await createScope(owner, { kind: 'project', name: 'relationship-holdout' });
      await addMembership(owner, actor.id, scope.id, 'writer');
      const stub = new StubEmbeddingProvider(); const references = new Map<string, Reference>();
      for (const doc of documents) {
        phase.check(); const memory = await createMemory(app, { scopeId: scope.id, scopeKind: 'project', authorId: actor.id,
          title: doc.title, body: doc.body, type: 'decision', source: 'manual', sourceRef: key(doc) });
        references.set(memory.id, { id: doc.id, version: doc.version });
        await storeMemoryEmbeddingVector(app, memory.id, (await stub.embed([`${doc.title}\n\n${doc.body}`]))[0], stub); setupCalls++;
      }
      phase.beginMeasured();
      for (const item of seededOrder(cases, relationshipGate.seed)) {
        const port = fixturePort(corpus, item, edges);
        for (let repetition = 0; repetition <= latencyPolicy.repetitions; repetition++) {
          const offset = (repetition + parseInt(sha256(item.id).slice(0, 4), 16)) % modes.length;
          for (const mode of [...modes.slice(offset), ...modes.slice(0, offset)]) {
            phase.check(); const budget = new Budget(profile);
            unrecordedAttempt = { id: item.id, mode, repetition, budget };
            const began = performance.now();
            // Same actual RRF candidate selector and complete split inventory in all
            // arms. The deterministic SHA provider and overlap reranker are NOT a
            // qualified semantic baseline. SQL/current-version races remain unmeasured.
            const terms = item.query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
            const ranking = testReranking(candidate => terms.filter(term => `${candidate.title} ${candidate.excerpt}`.toLowerCase().includes(term)).length);
            const config = configureReranking(ranking.adapter, profile, { candidateLimit: limits.total,
              evidence: { kind: 'local-contract', adapterId: ranking.adapter.id, version: ranking.adapter.version,
                model: ranking.adapter.model, profile: ranking.adapter.profile } });
            const embedding: BudgetAdapter<string[], number[][]> = { ...ranking.adapter, id: stub.id,
              outputTokens: 0, completionTokens: 0, responseBodyBytes: 32_768,
              serialize: (texts, caps) => ({ protocol: 'sha256-byte-protocol-v1', texts, caps }),
              async invoke(serialized) {
                calls++; const value = await stub.embed(JSON.parse(serialized).texts);
                return { value, response: value, usage: { provenance: 'measured', outputTokens: 0, reasoningTokens: 0, completionTokens: 0 } };
              } };
            const candidates = await recallCandidates(app, { query: item.query, scopeIds: [scope.id], actor: actor.id, limit: 10, budget,
              embeddingProvider: { id: stub.id, dim: 768, local: true, pipelineAdapter: embedding, embed: stub.embed.bind(stub) } }, 100, true);
            const pool = candidates.candidates.map(row => references.get(row.id)!);
            const base = pool.slice(0, limits.baselinePool);
            // Original independently authorized hybrid order is the optional-stage
            // fallback. Computing extra rerank scores here would read bodies before
            // admission or spend another call outside the identical envelope.
            const baseline = base.slice(0, 10);
            const stage = await prototype({ query: item.query, pool, baseline, mode, port, budget,
              now: () => Date.parse(corpus.manifest.clock), rerank: async (bodies, authorize) => {
                const aliases = bodies.map((body, i) => ({ id: `c${i}`, title: body.title, excerpt: body.body }));
                const result = await runReranking(config, budget, { query: item.query, candidates: aliases }, authorize, 4096);
                if (result.status !== 'used') return null;
                return bodies.map((body, i) => ({ ref: body.ref, score: result.scores.get(`c${i}`)!, i }))
                  .sort((a, b) => b.score - a.score || a.i - b.i).map(row => row.ref);
              } });
            calls += vi.mocked(ranking.adapter.invoke).mock.calls.length;
            observations.push({ id: item.id, mode, repetition, refs: stage.refs, status: stage.status,
              stageLatencyMs: performance.now() - began, failures: checkDelivered(corpus, item, stage.refs), usage: stage.usage, work: stage.work,
              vectorStatus: candidates.diagnostics.vector });
            unrecordedAttempt = undefined;
            expect(calls + setupCalls).toBeLessThanOrEqual(spec.maximumCalls);
            expect(observations.at(-1)!.failures).toEqual([]); phase.check();
          }
        }
      }
      return accountStorage(emptyStorage, await measureStorage(owner));
    });
  } catch (error) { failure = { error }; }
  let analysis: ReturnType<typeof pairedAnalysis> | null = null;
  if (!failure) {
    try { analysis = pairedAnalysis(cases, observations); }
    catch (error) { failure = { error }; }
  }
  const hardFailures = [...new Set([...observations.flatMap(row => row.failures),
    ...(failure ? ['execution-incomplete'] : []),
    ...(storage && storage.persistedBytes > corpus.manifest.budgets.storageBytes ? ['hard-storage-ceiling'] : [])])];
  const report = { version: 'relationship-experiment-v1', preregistrationSha256: hash,
    head, tree, headEnd: git('rev-parse', 'HEAD'), treeEnd: git('rev-parse', 'HEAD^{tree}'),
    sourceHead: process.env.CONTINUUM_EVAL_SOURCE_SHA ?? null, cleanStart, cleanEnd: !git('status', '--porcelain'),
    predecessorHeads: spec.predecessorHeads, corpusManifest: corpus.manifestHash,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    baseline: { kind: 'hybrid-sha-plus-overlap', stockReranking: 'disabled', realAdapterQualification: 'unqualified',
      reranker: { id: 'local-test', version: 'deterministic-v1', model: 'byte-protocol-v1', profile: 'local-test-v1' } },
    policy: 'fixture-only-current-version-v1', gate: relationshipGate, profile, latencyPolicy,
    stageLatencyKind: 'candidate-query-plus-fixture-prototype-no-final-service-audit',
    verifiedEndToEndP95: null, normalizedTotalEvidenceIndexReceiptBytes: null,
    storageDiagnostic: storage, phaseTimings: phase.timings(), setupCalls, calls, actualSpendMicros: 0,
    reservedSpendMicros: observations.reduce((sum, row) => sum + row.usage.spendMicros, 0),
    executionOrderSha256: sha256(JSON.stringify(observations.map(row => [row.id, row.mode, row.repetition]))),
    universeHashes: cases.map(item => ({ id: item.id, hash: candidateUniverseHash(corpus, item) })),
    topologyDiagnostics: { original: graphShortcutDiagnostics(corpus.cases), typed: typedTopologyDiagnostics(corpus, edges) },
    complete: !failure && analysis !== null, expectedObservations: cases.length * modes.length * (latencyPolicy.repetitions + latencyPolicy.warmups),
    unrecordedAttempt: unrecordedAttempt ? { id: unrecordedAttempt.id, mode: unrecordedAttempt.mode,
      repetition: unrecordedAttempt.repetition, usage: unrecordedAttempt.budget.snapshot() } : null,
    rows: analysis?.rows ?? [], analysis, decision: decision(analysis, hardFailures), hardFailures, observations,
    limitations: ['Synthetic authored links are not persisted canonical database relationships.',
      'Fixture checks do not establish SQL revocation, deletion, quarantine, residency or event-filter concurrency correctness.',
      'No qualified model, independent paired service producer, normalized storage collector or production graph is enabled.',
      'Whole-run storage includes setup/index allocation; it cannot establish the 2x gate.'] };
  await mkdir('.fire-off', { recursive: true });
  await persistReport('.fire-off/relationship-eval.json', report, failure);
  expect(report.complete).toBe(true); expect(hardFailures).toEqual([]);
  expect(report.decision.graphRuntimeAuthorized).toBe(false); expect(report.headEnd).toBe(head);
}, 300_000);
