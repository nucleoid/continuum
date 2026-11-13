/** Source-checkout evaluation tooling. Deliberately excluded from the public package. */
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { z } from 'zod';
import { runMigrations } from '../storage/migrator.js';
import { dropIsolatedTestDatabase } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';
import { StubEmbeddingProvider } from '../embeddings/stub.js';
import { recallForPrincipal } from '../services/recall.js';
import { getMemoryForPrincipal } from '../services/memories.js';
import { prepareAgentsMdForPrincipal, renderAgentsMdForPrincipal } from '../services/agents-md.js';
import { escapeAgentsMdData } from '../agents-md/render.js';
import { EmbeddingRegistry, ScopeEmbeddingRouter } from '../embeddings/router.js';
import { supersedeForPrincipal } from '../services/supersede.js';
import { mapOwnedUserScope, offboardPrincipal } from '../services/offboarding.js';
import type { Principal, Memory, Scope } from '../types.js';

export const RUNNER_VERSION = 'memory-evaluation-v1';
const MANIFEST_SHA256 = '31577ca467b8e4c5f559e1f83f0950c773d6342b929920df5c6d8d570de58670';
export const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const version = z.string().regex(/^[1-9][0-9]{0,5}$/);
const date = z.string().datetime();
const reference = z.object({ id, version }).strict();
const relevantSchema = reference.extend({ grade: z.number().int().min(1).max(3), family: id, assertion: id.optional() }).strict();
const claimSchema = z.object({ id, label: z.enum(['implemented-fact', 'recorded-intent', 'inference']),
  evidence: z.array(reference).max(20), unknown: z.boolean(), contradiction: id.nullable() }).strict();
const documentSchema = z.object({ id, version, assertionVersion: version, family: id,
  sourceKind: z.enum(['code', 'non-code']), scope: z.enum(['project:synthetic', 'project:denied']),
  title: z.string().min(1).max(500), body: z.string().min(1).max(16_384),
  type: z.enum(['decision', 'fact', 'context', 'playbook', 'relationship']),
  tags: z.array(z.enum(['decision', 'github', 'deploy', 'terminal'])).max(4),
  state: z.enum(['live', 'stale', 'archived', 'quarantined']), allowed: z.boolean(), sourceAllowed: z.boolean(),
  residency: z.enum(['local-only', 'approved-hosted']), eventStart: date,
  eventEnd: date.nullable(), ingestedAt: date }).strict();
const operations = ['recall', 'fetch', 'agents-md', 'supersede', 'expiry', 'revoke', 'erase',
  'extraction', 'synthesis', 'temporal', 'connector', 'relationship-expansion', 'reranking', 'vector-only'] as const;
const caseSchema = z.object({ id, split: z.enum(['development', 'holdout']), operation: z.enum(operations),
  collection: z.literal('ranking').optional(),
  executionResidency: z.enum(['local', 'hosted']),
  query: z.string().min(1).max(500), documents: z.array(documentSchema).max(30),
  relevant: z.array(relevantSchema).max(30), prohibited: z.array(z.string().regex(/^[a-z0-9-]+@[1-9][0-9]*$/)).max(30),
  abstain: z.boolean(), claims: z.array(claimSchema).max(20), chunks: z.array(id).max(20),
  contradictionSets: z.array(z.object({ id, evidence: z.array(reference).min(2).max(10) }).strict()).max(10),
  timeline: z.array(z.object({ at: date, action: z.enum(['supersede', 'expiry', 'revoke', 'erase', 'quarantine']),
    evidence: z.string().max(90) }).strict()).max(10),
  relations: z.array(z.object({ type: z.enum(['supports', 'depends-on', 'contradicts']), source: reference, target: reference,
    basis: z.string().max(200).optional() }).strict()).max(30) }).strict();
export type FixtureCase = z.infer<typeof caseSchema>;
export type Reference = z.infer<typeof reference>;
export type Relevant = z.infer<typeof relevantSchema>;
export type Claim = z.infer<typeof claimSchema>;
export const latencyPolicy = Object.freeze({ version: 'service-latency-v1', repetitions: 5, warmups: 1,
  order: 'seeded-rotating-interleaved', summary: 'p95-of-per-query-medians', comparison: 'paired-interleaved-session' });
export const relationshipGate = Object.freeze({ version: 'relationship-v1', primaryMetric: 'ndcg@10',
  minimumRelativeGain: 0.05, confidence: 0.95, minPairs: 20, bootstrapSamples: 2000, seed: 25,
  maximumP95Ratio: 1.1, maximumStorageRatio: 2, criticalCoverageRegression: 0,
  securityRegressions: 0, budgetPolicy: 'identical' });
const gateSchema = z.object({ version: id, primaryMetric: z.literal('ndcg@10'),
  minimumRelativeGain: z.number().positive().max(1), confidence: z.literal(0.95),
  minPairs: z.number().int().min(20).max(1000), bootstrapSamples: z.number().int().min(1000).max(10_000),
  seed: z.number().int().nonnegative(), maximumP95Ratio: z.number().min(1).max(2),
  maximumStorageRatio: z.number().min(1).max(2), criticalCoverageRegression: z.literal(0),
  securityRegressions: z.literal(0), budgetPolicy: z.literal('identical') }).strict();
const budgetsSchema = z.object({ maxCases: z.number().int().min(1).max(100),
  maxStages: z.number().int().min(1).max(12), maxRows: z.number().int().min(1).max(512),
  maxSourceBytes: z.number().int().min(1).max(16_384), maxArtifactBytes: z.number().int().min(1).max(1_048_576),
  maxSetupMs: z.number().int().min(1).max(120_000), maxDurationMs: z.number().int().min(1).max(120_000), candidateLimit: z.number().int().min(1).max(50),
  hydrationLimit: z.number().int().min(1).max(10), contextBytes: z.number().int().min(1).max(65_536),
  outputBytes: z.number().int().min(1).max(65_536), calls: z.number().int().min(1).max(1024),
  retries: z.literal(0), reservedSpend: z.literal(0), actualSpend: z.literal(0),
  storageBytes: z.number().int().min(1).max(16_777_216) }).strict();
const fixtureFiles = ['retrieval.json', 'lifecycle-security.json', 'extraction-synthesis.json', 'temporal-connectors.json'] as const;
const manifestSchema = z.object({ schema: z.literal(1), version: z.literal('v1'), synthetic: z.literal(true),
  clock: date, seed: z.number().int(), files: z.object(Object.fromEntries(fixtureFiles.map(name =>
    [name, z.string().regex(/^[a-f0-9]{64}$/)])) as Record<typeof fixtureFiles[number], z.ZodString>).strict(),
  splitPolicy: z.string().max(200), rubricVersion: z.literal('relevance-v1'), latencyPolicy: z.object({
    version: z.literal('service-latency-v1'), repetitions: z.literal(5), warmups: z.literal(1),
    order: z.literal('seeded-rotating-interleaved'), summary: z.literal('p95-of-per-query-medians'), comparison: z.literal('paired-interleaved-session') }).strict(),
  relationshipGate: gateSchema, budgets: budgetsSchema }).strict();
export type Corpus = { manifest: z.infer<typeof manifestSchema>; manifestHash: string; cases: FixtureCase[] };
const loadedCorpora = new WeakSet<object>();
function freezeData<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

function unique(values: string[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${name}`);
}
const key = (value: Reference): string => `${value.id}@${value.version}`;
export function validateCases(input: unknown): FixtureCase[] {
  const cases = z.object({ schema: z.literal(1), cases: z.array(caseSchema).max(100) }).strict().parse(input).cases;
  unique(cases.map(item => item.id), 'case IDs');
  for (const item of cases) {
    unique(item.documents.map(key), 'source versions');
    unique(item.relevant.map(key), 'relevance judgments');
    unique(item.claims.map(claim => claim.id), 'claim labels');
    unique(item.chunks, 'chunks');
    const known = new Set(item.documents.map(key));
    if (item.operation === 'supersede') known.add('successor@2');
    for (const ref of [...item.relevant.map(key), ...item.prohibited,
      ...item.claims.flatMap(claim => claim.evidence.map(key)), ...item.contradictionSets.flatMap(set => set.evidence.map(key)),
      ]) {
      if (!known.has(ref)) throw new Error('Judgment references an absent source version');
    }
    const edgeKnown = item.collection === 'ranking' ? new Set(cases.filter(row => row.collection === 'ranking' && row.split === item.split).flatMap(row => row.documents.map(key))) : known;
    for (const edge of item.relations) {
      if (key(edge.source) === key(edge.target)) throw new Error('Self relation is not permitted');
      if (!edgeKnown.has(key(edge.source)) || !edgeKnown.has(key(edge.target))) throw new Error('Relation references an absent split source');
    }
    if (item.relevant.some(ref => item.prohibited.includes(key(ref)))) throw new Error('Contradictory judgments');
    const forbidden = new Set(item.documents.filter(doc => !doc.allowed || !doc.sourceAllowed
      || (item.executionResidency === 'hosted' && doc.residency === 'local-only')).map(key));
    for (const claim of item.claims) {
      if (claim.evidence.some(ref => item.prohibited.includes(key(ref)) || forbidden.has(key(ref)))) throw new Error('Claim cites prohibited evidence');
      if (claim.contradiction && !item.contradictionSets.some(set => set.id === claim.contradiction)) throw new Error('Unknown contradiction set');
    }
    unique(item.contradictionSets.map(set => set.id), 'contradiction sets');
    if (item.abstain !== (item.relevant.length === 0)) throw new Error('Contradictory abstention label');
    if (item.documents.some(doc => Buffer.byteLength(doc.body) > 16_384)) throw new Error('Source byte bound exceeded');
    const copies = new Map<string, typeof item.documents[number]>();
    for (const doc of item.documents) {
      const body = doc.body.replace(/\s+/g, ' ').trim();
      const original = copies.get(body);
      if (original) {
        const first = item.relevant.find(ref => key(ref) === key(original));
        const second = item.relevant.find(ref => key(ref) === key(doc));
        if (original.family !== doc.family || (first && second && (!first.assertion || first.assertion !== second.assertion))) {
          throw new Error('Copied assertions must retain their family and relevance unit');
        }
      } else copies.set(body, doc);
    }
    scoreRetrieval([], item.relevant);
  }
  return cases;
}

export async function loadCorpus(directory = resolve('evals/fixtures/v1')): Promise<Corpus> {
  if ((await stat(resolve(directory, 'manifest.json'))).size > 16_384) throw new Error('Manifest bound exceeded');
  const bytes = await readFile(resolve(directory, 'manifest.json'));
  if (bytes.length > 16_384 || sha256(bytes) !== MANIFEST_SHA256) throw new Error('Frozen v1 manifest drift');
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  const cases: FixtureCase[] = [];
  for (const name of fixtureFiles) {
    if ((await stat(resolve(directory, name))).size > 1_048_576) throw new Error('Fixture bound exceeded');
    const content = await readFile(resolve(directory, name));
    if (content.length > 1_048_576 || sha256(content) !== manifest.files[name]) throw new Error('Frozen fixture drift');
    cases.push(...validateCases(JSON.parse(content.toString('utf8'))));
  }
  unique(cases.map(item => item.id), 'case IDs');
  if (cases.length > manifest.budgets.maxCases) throw new Error('Case bound exceeded');
  if (JSON.stringify(manifest.relationshipGate) !== JSON.stringify(relationshipGate)) throw new Error('Gate drift');
  graphShortcutDiagnostics(cases);
  const corpus = freezeData({ manifest, manifestHash: sha256(bytes), cases });
  loadedCorpora.add(corpus);
  return corpus;
}

export function seededOrder<T extends { id: string }>(items: T[], seed: number): T[] {
  return [...items].sort((a, b) => sha256(`${seed}:${a.id}`).localeCompare(sha256(`${seed}:${b.id}`)) || a.id.localeCompare(b.id));
}

/** Fixture-only adapter boundary. No relevance grades, answers, or denied bodies. */
function universe(corpus: Pick<Corpus, 'cases'>, item: FixtureCase) {
  return item.collection === 'ranking' ? corpus.cases.filter(row => row.collection === 'ranking' && row.split === item.split) : [item];
}
function forbidden(corpus: Pick<Corpus, 'cases' | 'manifest'>, item: FixtureCase) {
  const cases = universe(corpus, item);
  return new Set(cases.flatMap(row => [...row.prohibited,
    ...row.documents.filter(doc => !doc.allowed || !doc.sourceAllowed || doc.scope === 'project:denied' || doc.state !== 'live'
      || (item.executionResidency === 'hosted' && doc.residency === 'local-only')).map(key),
    ...row.timeline.filter(event => event.at <= corpus.manifest.clock).map(event => event.evidence)]));
}
export function checkDelivered(corpus: Corpus, item: FixtureCase, actual: (Reference | undefined)[], deniedScope = false): string[] {
  const denied = forbidden(corpus, item);
  const known = new Set(universe(corpus, item).flatMap(row => row.documents.map(key)));
  if (item.operation === 'supersede') known.add('successor@2');
  return deniedScope || actual.some(ref => !ref || denied.has(key(ref)) || !known.has(key(ref))) ? ['prohibited-evidence'] : [];
}
export function retrievalInput(corpus: Corpus, item: FixtureCase) {
  const cases = universe(corpus, item); const denied = forbidden(corpus, item);
  const documents = cases.flatMap(row => row.documents).filter(doc => !denied.has(key(doc)))
    .map(({ id, version, title, body }) => ({ id, version, title, body })).sort((a, b) => key(a).localeCompare(key(b)));
  unique(documents.map(key), 'shared source versions');
  const available = new Set(documents.map(key));
  return freezeData({ query: item.query, documents,
    relations: cases.flatMap(row => row.relations).filter(edge => available.has(key(edge.source)) && available.has(key(edge.target)))
      .map(({ type, source, target }) => ({ type, source, target })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
}
export function candidateUniverseHash(corpus: Corpus, item: FixtureCase): string {
  const input = retrievalInput(corpus, item);
  return sha256(JSON.stringify({ documents: [...input.documents].sort((a, b) => key(a).localeCompare(key(b))),
    relations: [...input.relations].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }));
}
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
export async function evaluateRetrieval(corpus: Corpus, item: FixtureCase,
  adapter?: (input: ReturnType<typeof retrievalInput>) => Promise<Reference[]>) {
  if (!adapter) return { status: 'not_supported' as const };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const input = retrievalInput(corpus, item);
    if (Buffer.byteLength(JSON.stringify(input)) > 65_536) return { status: 'failed' as const, reason: 'CONTEXT_BOUND' };
    const raw = await Promise.race([adapter(input), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Adapter deadline')), 1000);
    })]);
    if (Buffer.byteLength(JSON.stringify(raw)) > 65_536) throw new Error('Adapter byte bound');
    const actual = z.array(reference).max(10).parse(raw);
    const permitted = new Set(input.documents.map(key));
    if (actual.some(ref => !permitted.has(key(ref))) || checkDelivered(corpus, item, actual).length) {
      return { status: 'failed' as const, reason: 'PROHIBITED_EVIDENCE' };
    }
    return { status: 'measured' as const, metrics: scoreRetrieval(actual, item.relevant) };
  } catch { return { status: 'failed' as const, reason: 'ADAPTER_FAILED' }; }
  finally { clearTimeout(timer); }
}

/** Limited graph incidence checks and descriptive query-blind scores. Not feature acceptance. */
export function graphShortcutDiagnostics(cases: FixtureCase[]) {
  const corpus = { cases, manifest: { clock: '2026-02-01T00:00:00Z' } } as Corpus;
  const features = ['outgoing', 'incoming', ...['supports', 'depends-on', 'contradicts'].flatMap(type => [`${type}:source`, `${type}:target`])];
  const localFeatures = ['development', 'holdout'].flatMap(split => features.map(feature => {
    let positives = 0; let negatives = 0;
    for (const item of cases.filter(row => row.collection === 'ranking' && row.split === split)) {
      const available = new Set(retrievalInput(corpus, item).documents.map(key));
      const refs = new Set(item.relations.filter(edge => available.has(key(edge.source)) && available.has(key(edge.target)))
        .flatMap(edge => feature === 'outgoing' ? [key(edge.source)] : feature === 'incoming' ? [key(edge.target)]
        : feature === `${edge.type}:source` ? [key(edge.source)] : feature === `${edge.type}:target` ? [key(edge.target)] : []));
      for (const ref of refs) { if (item.relevant.some(row => key(row) === ref)) positives++; else negatives++; }
    }
    return { split, feature, positives, negatives, precision: ratio(positives, positives + negatives) ?? 0 };
  }));
  if (localFeatures.some(row => row.positives === 0 || row.negatives === 0 || row.precision > 0.75)) throw new Error(`Graph shortcut: ${JSON.stringify(localFeatures)}`);
  const holdout = cases.filter(item => item.collection === 'ranking' && item.split === 'holdout');
  const blindScores = features.map(feature => {
    const scores = holdout.map(item => {
      const input = retrievalInput(corpus, item);
      const selected = new Set(input.relations.flatMap(edge => feature === 'outgoing' ? [key(edge.source)] : feature === 'incoming' ? [key(edge.target)]
        : feature === `${edge.type}:source` ? [key(edge.source)] : feature === `${edge.type}:target` ? [key(edge.target)] : []));
      const ranked = [...input.documents].sort((a, b) => Number(selected.has(key(b))) - Number(selected.has(key(a))) || key(a).localeCompare(key(b)));
      return scoreRetrieval(ranked, item.relevant).ndcg ?? 0;
    });
    return scores.reduce((sum, value) => sum + value, 0) / scores.length;
  });
  const maximumQueryBlindNdcg = Math.max(...blindScores);
  return { localFeatures, maximumQueryBlindNdcg };
}

/** Provisioning and measured work have independent finite clocks. */
export class PhaseBudget {
  private readonly started: number;
  private measured?: number;
  constructor(private readonly setupLimit: number, private readonly measuredLimit: number,
    private readonly now: () => number = performance.now.bind(performance)) { this.started = now(); }
  check() {
    if (this.measured === undefined) {
      if (this.now() - this.started > this.setupLimit) throw new Error('Evaluation setup deadline exceeded');
    } else if (this.now() - this.measured > this.measuredLimit) throw new Error('Evaluation measured deadline exceeded');
  }
  beginMeasured() { this.check(); this.measured = this.now(); }
  timings() { return { setupMs: (this.measured ?? this.now()) - this.started,
    measuredMs: this.measured === undefined ? 0 : this.now() - this.measured }; }
}
export function planRows(supported: number, unsupported: number, modes: number, maximum: number) {
  if (![supported, unsupported, modes, maximum].every(Number.isSafeInteger) || supported < 0 || unsupported < 0
    || modes < 1 || modes > 12 || maximum < 1 || supported * modes + unsupported > maximum) throw new Error('Report row bound exceeded');
  return supported * modes + unsupported;
}
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
}
const ratio = (numerator: number, denominator: number): number | null => denominator === 0 ? null : numerator / denominator;
export function scoreRetrieval(actual: Reference[], expected: Relevant[], cutoff = 10) {
  if (!Number.isInteger(cutoff) || cutoff < 1 || cutoff > 100) throw new Error('Invalid cutoff');
  unique(expected.map(key), 'relevance judgments');
  const top = actual.slice(0, cutoff);
  const seen = new Set<string>();
  const judgments = new Map(expected.map(item => [key(item), item]));
  const units = new Map<string, Relevant>();
  const unitKey = (item: Relevant) => item.assertion ?? key(item);
  for (const judgment of expected) {
    const previous = units.get(unitKey(judgment));
    if (previous && (previous.family !== judgment.family || previous.grade !== judgment.grade)) throw new Error('Assertion family/grade drift');
    units.set(unitKey(judgment), judgment);
  }
  let hits = 0; let first = 0; let dcg = 0;
  const families = new Set<string>();
  top.forEach((item, index) => {
    const judgment = judgments.get(key(item));
    const identity = judgment ? unitKey(judgment) : key(item);
    if (judgment && !seen.has(identity)) {
      hits++; if (!first) first = 1 / (index + 1);
      dcg += (2 ** judgment.grade - 1) / Math.log2(index + 2);
      families.add(judgment.family);
    }
    seen.add(identity);
  });
  const ideal = [...units.values()].sort((a, b) => b.grade - a.grade).slice(0, cutoff)
    .reduce((sum, item, index) => sum + (2 ** item.grade - 1) / Math.log2(index + 2), 0);
  return { precision: ratio(hits, top.length), recall: ratio(hits, units.size),
    evidenceCoverage: ratio(families.size, new Set(expected.map(item => item.family)).size),
    mrr: expected.length === 0 ? null : first, ndcg: ratio(dcg, ideal),
    abstentionError: expected.length === 0 ? Number(actual.length !== 0) : Number(actual.length === 0),
    duplicateResults: top.length - seen.size, independentFamilies: families.size };
}

export function scoreClaims(actual: Claim[], expected: Claim[], chunks: string[] = [], completedChunks: string[] = []) {
  unique(expected.map(item => item.id), 'claim labels');
  unique(actual.map(item => item.id), 'output claims');
  const judgments = new Map(expected.map(item => [item.id, item]));
  let aligned = 0; let labels = 0; let unsupported = 0; let unknowns = 0; let conflicts = 0;
  for (const claim of actual) {
    const expectedClaim = judgments.get(claim.id);
    const correct = expectedClaim && claim.evidence.length > 0
      && new Set(claim.evidence.map(key)).size === claim.evidence.length
      && claim.evidence.length === expectedClaim.evidence.length
      && claim.evidence.every(ref => expectedClaim.evidence.some(expectedRef => key(ref) === key(expectedRef)));
    if (correct) aligned++; else unsupported++;
    if (expectedClaim?.label === claim.label) labels++;
    if (expectedClaim?.unknown && claim.unknown) unknowns++;
    if (expectedClaim?.contradiction && expectedClaim.contradiction === claim.contradiction) conflicts++;
  }
  return { alignment: ratio(aligned, actual.length), labelAccuracy: ratio(labels, expected.length),
    unsupportedAssertionRate: ratio(unsupported, actual.length), claimRecall: ratio(actual.filter(item => judgments.has(item.id)).length, expected.length),
    unknownPreservation: ratio(unknowns, expected.filter(item => item.unknown).length),
    contradictionPreservation: ratio(conflicts, expected.filter(item => item.contradiction !== null).length),
    chunkCoverage: ratio(new Set(completedChunks.filter(chunk => chunks.includes(chunk))).size, new Set(chunks).size) };
}

export async function evaluateMechanism(_name: string, adapter?: () => Promise<unknown>) {
  if (!adapter) return { status: 'not_supported' as const };
  try { return { status: 'measured' as const, output: await adapter() }; }
  catch { return { status: 'failed' as const, reason: 'ADAPTER_FAILED' }; }
}

const taskOutputSchema = z.object({ claims: z.array(claimSchema).max(20), delivered: z.array(reference).max(30),
  completedChunks: z.array(id).max(20), abstained: z.boolean() }).strict();
export type TaskOutput = z.infer<typeof taskOutputSchema>;
export type TaskAdapter = (evidence: Reference[]) => Promise<TaskOutput>;
/** Mechanism-only contract for future adapters. Oracle evidence does not bypass fixture policy. */
export async function evaluateTaskPair(task: FixtureCase, retrieved: Reference[], adapter?: TaskAdapter) {
  if (!adapter) return { status: 'not_supported' as const };
  const permitted = task.documents.filter(doc => doc.allowed && doc.sourceAllowed && doc.state === 'live'
    && (task.executionResidency === 'local' || doc.residency !== 'local-only')
    && !task.prohibited.includes(key(doc)) && (doc.eventEnd === null || doc.eventEnd >= doc.eventStart));
  const allowed = new Set(permitted.map(key));
  const oracleEvidence = task.relevant.filter(ref => allowed.has(key(ref))).map(({ id, version }) => ({ id, version }));
  try {
    const run = async (evidence: Reference[]) => {
      if (evidence.length > 30 || Buffer.byteLength(JSON.stringify(evidence)) > 65_536) throw new Error('Input bound');
      let timer: ReturnType<typeof setTimeout> | undefined;
      let raw: TaskOutput;
      try {
        raw = await Promise.race([adapter(structuredClone(evidence)), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Adapter deadline')), 1000);
        })]);
      } finally { clearTimeout(timer); }
      const output = taskOutputSchema.parse(raw);
      if (Buffer.byteLength(JSON.stringify(output)) > 65_536) throw new Error('Output bound');
      const prohibited = [...evidence, ...output.delivered, ...output.claims.flatMap(claim => claim.evidence)]
        .some(ref => !allowed.has(key(ref)));
      return { claims: scoreClaims(output.claims, task.claims, task.chunks, output.completedChunks),
        retrieval: scoreRetrieval(output.delivered, task.relevant),
        abstentionError: Number(output.abstained !== task.abstain), prohibited };
    };
    const retrievedRun = await run(retrieved); const oracleRun = await run(oracleEvidence);
    const critical = retrievedRun.prohibited || oracleRun.prohibited;
    const correct = (result: typeof oracleRun) => result.abstentionError === 0 && !result.prohibited
      && Object.entries(result.claims).every(([metric, value]) => metric === 'unsupportedAssertionRate'
        ? value === null || value === 0 : value === null || value === 1);
    return { status: 'measured' as const, gate: critical ? 'fail' : 'pass', retrieved: retrievedRun, oracle: oracleRun,
      diagnosis: !correct(oracleRun) ? 'reasoning_failure' : !correct(retrievedRun) ? 'retrieval_miss' : 'no_miss' };
  } catch { return { status: 'failed' as const, gate: 'fail', reason: 'ADAPTER_FAILED' }; }
}

export type Pair = { id: string; value: number };
export type ComparisonResources = { baselineP95: number; candidateP95: number; baselineBytes: number;
  candidateBytes: number; hardStorageBudget: number; identicalCaps: boolean; criticalCoverageRegressions: number };
export function compareRuns(baseline: Pair[], candidate: Pair[], gate: unknown, criticalFailures: string[] = [], resources?: ComparisonResources) {
  if (!gate) throw new Error('A declared gate is required');
  const policy = gateSchema.parse(gate);
  unique(baseline.map(item => item.id), 'paired IDs'); unique(candidate.map(item => item.id), 'paired IDs');
  const before = [...baseline].sort((a, b) => a.id.localeCompare(b.id));
  const after = [...candidate].sort((a, b) => a.id.localeCompare(b.id));
  if (before.length !== after.length || before.some((item, index) => item.id !== after[index].id)) throw new Error('Runs must be paired');
  if ([...before, ...after].some(item => !Number.isFinite(item.value) || item.value < 0 || item.value > 1)) throw new Error('Invalid metric');
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const differences = before.map((item, index) => after[index].value - item.value);
  const baselineMean = mean(before.map(item => item.value));
  const delta = mean(differences);
  const gain = baselineMean > 0 ? delta / baselineMean : null;
  const rng = random(policy.seed);
  const samples = Array.from({ length: policy.bootstrapSamples }, () => mean(differences.map(() => differences[Math.floor(rng() * differences.length)]))).sort((a, b) => a - b);
  const ci = differences.length ? [samples[Math.floor(samples.length * 0.025)], samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.975))]] : null;
  const invalidResources = resources && (Object.entries(resources).some(([name, value]) =>
    name !== 'identicalCaps' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))
    || resources.baselineP95 <= 0 || resources.hardStorageBudget <= 0);
  if (invalidResources) throw new Error('Invalid resource measurements');
  const failedResources = resources && (!resources.identicalCaps || resources.criticalCoverageRegressions > 0
    || resources.candidateP95 > resources.baselineP95 * policy.maximumP95Ratio
    || (resources.baselineBytes > 0 && resources.candidateBytes > resources.baselineBytes * policy.maximumStorageRatio)
    || resources.candidateBytes > resources.hardStorageBudget);
  const status = criticalFailures.length || failedResources ? 'fail'
    : before.length < policy.minPairs || gain === null || !resources || resources.baselineBytes === 0 ? 'insufficient_evidence'
      : gain >= policy.minimumRelativeGain && ci && ci[0] > 0 ? 'pass' : 'fail';
  return { status, pairs: before.length, relativeGain: gain, confidenceInterval: ci,
    criticalFailures: criticalFailures.length, resourceGate: !resources || resources.baselineBytes === 0 ? 'not_measured' : failedResources ? 'fail' : 'pass' };
}

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const provenanceSchema = z.object({ headStart: sha, headEnd: sha, treeStart: sha, treeEnd: sha,
  parents: z.array(sha).max(20), cleanStart: z.boolean(), cleanEnd: z.boolean(),
  sourceIdentity: z.enum(['explicit', 'checkout']), context: z.enum(['local', 'pull_request', 'push', 'workflow_dispatch', 'other']) }).strict();
type Provenance = z.infer<typeof provenanceSchema>;
export function acceptanceEligible(head: string, sourceHead: string, proof: Provenance): boolean {
  return proof.sourceIdentity === 'explicit' && proof.cleanStart && proof.cleanEnd
    && proof.headStart === head && proof.headEnd === head && head === sourceHead && proof.treeStart === proof.treeEnd;
}
export function assertPublishableReport(report: { head: string; provenance: Provenance }) {
  const p = report.provenance;
  if (!p.cleanStart || !p.cleanEnd || p.headStart !== report.head || p.headEnd !== report.head || p.treeStart !== p.treeEnd
    || p.sourceIdentity !== 'explicit') throw new Error('Publication requires proven clean stable checkout and explicit source identity');
}

const reportEvidenceSchema = z.object({ head: z.string().regex(/^[a-f0-9]{40}$/),
  sourceHead: z.string().regex(/^[a-f0-9]{40}$/), predecessorEligible: z.boolean(),
  provenance: provenanceSchema,
  latencyEvidence: z.object({ policy: manifestSchema.shape.latencyPolicy, pairedSession: id.nullable(), environment: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  sampling: z.object({ observations: z.number().int().nonnegative().max(3072), orderDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  fixtureManifest: z.string().regex(/^[a-f0-9]{64}$/), seed: z.number().int(), runner: z.literal(RUNNER_VERSION),
  budgets: budgetsSchema, gates: z.object({ failures: z.array(z.string().max(80)).max(100) }).passthrough(),
  usage: z.object({ persistedBytes: z.number().int().positive(), emptySchemaBytes: z.number().int().positive(),
    runGrowthBytes: z.number().int().nonnegative(), rawApplicationBytes: z.number().int().positive(), rawDatabaseBytes: z.number().int().positive(),
    emptyDatabaseBytes: z.number().int().positive(), candidateCount: z.number().int().nonnegative().nullable(),
    actualSpend: z.number().finite().nonnegative().nullable(), reservedSpend: z.number().finite().nonnegative().nullable(),
    calls: z.number().int().nonnegative().nullable(), setupCalls: z.number().int().nonnegative().optional(),
    retries: z.number().int().nonnegative().nullable() }).passthrough(),
  rows: z.array(z.object({ id, ablation: z.string().max(40), status: z.enum(['measured', 'not_supported', 'failed']),
    metrics: z.object({ ndcg: z.number().finite().min(0).max(1).nullable(), evidenceCoverage: z.number().finite().min(0).max(1).nullable().optional() }).passthrough().optional(),
    latencyMs: z.number().finite().nonnegative().optional(), latencySamplesMs: z.array(z.number().finite().nonnegative()).length(5).optional(),
    universeHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), failures: z.array(z.string().max(80)).max(20).optional() }).passthrough()).max(512) }).passthrough()
  .refine(report => report.predecessorEligible === acceptanceEligible(report.head, report.sourceHead, report.provenance), 'Source provenance mismatch')
  .refine(report => report.usage.persistedBytes >= report.usage.emptySchemaBytes
    && report.usage.runGrowthBytes === report.usage.persistedBytes - report.usage.emptySchemaBytes
    && report.usage.runGrowthBytes === Math.max(0, report.usage.rawApplicationBytes - report.usage.emptySchemaBytes,
      report.usage.rawDatabaseBytes - report.usage.emptyDatabaseBytes), 'Storage delta mismatch');
const experimentSchema = z.object({ head: z.string().regex(/^[a-f0-9]{40}$/),
  predecessorHead: z.string().regex(/^[a-f0-9]{40}$/), fixtureHash: z.string().regex(/^[a-f0-9]{64}$/),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/), budgetHash: z.string().regex(/^[a-f0-9]{64}$/),
  seed: z.number().int(), runner: z.literal(RUNNER_VERSION), gate: gateSchema,
  split: z.literal('holdout'), repetitionRule: z.literal('one-paired-mean-per-query'),
  features: z.record(z.boolean()).refine(value => Object.keys(value).length <= 12), adapters: z.record(z.string().max(100)).refine(value => Object.keys(value).length <= 12),
  samples: z.array(z.object({ id, value: z.number().finite().min(0).max(1) }).strict()).max(1000),
  criticalFailures: z.array(id).max(100), criticalCoverageRegressions: z.number().int().nonnegative(),
  p95: z.number().finite().nonnegative().nullable(), runGrowthBytes: z.number().int().nonnegative(),
  hardStorageBudget: z.number().int().positive(), supported: z.boolean(),
  status: z.enum(['measured', 'not_supported', 'failed']), ablation: z.string().max(40), predecessorEligible: z.boolean(), sourceReport: reportEvidenceSchema }).strict();

/** Derive, rather than hand-enter, scores, policy identity, security and resources. */
export function experimentFromReport(corpus: Corpus, input: unknown, ablation: string,
  features: Record<string, boolean>, adapters: Record<string, string>, predecessorHead?: string) {
  if (!loadedCorpora.has(corpus)) throw new Error('A loaded frozen corpus is required');
  const report = reportEvidenceSchema.parse(input);
  if (report.seed !== corpus.manifest.seed || report.fixtureManifest !== corpus.manifestHash || JSON.stringify(report.budgets) !== JSON.stringify(corpus.manifest.budgets)) throw new Error('Report fixture/budget drift');
  const sourceReport = { head: report.head, sourceHead: report.sourceHead, predecessorEligible: report.predecessorEligible, provenance: report.provenance,
    latencyEvidence: report.latencyEvidence, sampling: report.sampling,
    fixtureManifest: report.fixtureManifest, seed: report.seed, runner: report.runner,
    budgets: report.budgets, gates: { failures: report.gates.failures }, usage: {
      persistedBytes: report.usage.persistedBytes, emptySchemaBytes: report.usage.emptySchemaBytes, runGrowthBytes: report.usage.runGrowthBytes,
      rawApplicationBytes: report.usage.rawApplicationBytes, rawDatabaseBytes: report.usage.rawDatabaseBytes, emptyDatabaseBytes: report.usage.emptyDatabaseBytes,
      candidateCount: report.usage.candidateCount, actualSpend: report.usage.actualSpend,
      reservedSpend: report.usage.reservedSpend, calls: report.usage.calls, setupCalls: report.usage.setupCalls, retries: report.usage.retries },
    rows: report.rows.map(row => ({ id: row.id, ablation: row.ablation, status: row.status,
      metrics: row.metrics ? { ndcg: row.metrics.ndcg, evidenceCoverage: row.metrics.evidenceCoverage } : undefined,
      latencyMs: row.latencyMs, latencySamplesMs: row.latencySamplesMs, universeHash: row.universeHash, failures: row.failures })) };
  const holdout = corpus.cases.filter(item => item.split === 'holdout' && item.operation === 'recall').map(item => item.id).sort();
  const selected = sourceReport.rows.filter(row => row.ablation === ablation && holdout.includes(row.id));
  unique(selected.map(row => row.id), 'report holdout IDs');
  if (selected.length && JSON.stringify(selected.map(row => row.id).sort()) !== JSON.stringify(holdout)) throw new Error('Report holdout drift');
  const status = selected.length === 0 || selected.every(row => row.status === 'not_supported') ? 'not_supported'
    : selected.some(row => row.status !== 'measured' || row.metrics?.ndcg == null || row.metrics.evidenceCoverage == null || row.latencyMs === undefined
      || !row.latencySamplesMs || !row.universeHash || row.latencyMs !== median(row.latencySamplesMs)
      || row.universeHash !== candidateUniverseHash(corpus, corpus.cases.find(item => item.id === row.id)!)) ? 'failed' : 'measured';
  const criticalFailures = [...new Set([...report.gates.failures, ...report.rows.flatMap(row => row.failures ?? []),
    ...(status === 'failed' ? ['incomplete-samples'] : [])].map(value => value.toLowerCase().replaceAll('_', '-')))].sort();
  const latencies = selected.map(row => row.latencyMs ?? 0).sort((a, b) => a - b);
  return { head: report.head, predecessorHead: predecessorHead ?? report.head, fixtureHash: corpus.manifestHash,
    policyHash: sha256(JSON.stringify({ manifest: corpus.manifestHash, policy: 'fixture-authoritative-v1' })),
    budgetHash: sha256(JSON.stringify(corpus.manifest.budgets)), seed: report.seed, runner: RUNNER_VERSION,
    gate: corpus.manifest.relationshipGate, split: 'holdout' as const, repetitionRule: 'one-paired-mean-per-query' as const,
    features, adapters, samples: status === 'measured' ? selected.map(row => ({ id: row.id, value: row.metrics!.ndcg! })) : [],
    criticalFailures, criticalCoverageRegressions: 0,
    p95: latencies.length ? latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] : null,
    runGrowthBytes: report.usage.runGrowthBytes, hardStorageBudget: corpus.manifest.budgets.storageBytes,
    supported: status === 'measured', status, ablation, predecessorEligible: report.predecessorEligible, sourceReport };
}

export function compareExperiments(baselineInput: unknown, candidateInput: unknown, corpus?: Corpus) {
  if (!corpus || !loadedCorpora.has(corpus)) throw new Error('A loaded frozen corpus is required');
  const before = experimentSchema.parse(baselineInput); const after = experimentSchema.parse(candidateInput);
  for (const record of [before, after]) {
    if (record.features['relationship-expansion'] && record.ablation !== 'relationship-expansion') throw new Error('Feature/ablation drift');
    if (record.features.reranking && record.features.hybrid && !record.features['relationship-expansion']
      && record.ablation !== 'hybrid-reranking') throw new Error('Feature/ablation drift');
    if (record.fixtureHash !== corpus.manifestHash || corpus.manifestHash !== MANIFEST_SHA256) throw new Error('Fixture drift');
    const derived = experimentFromReport(corpus, record.sourceReport, record.ablation, record.features, record.adapters, record.predecessorHead);
    for (const field of ['head', 'fixtureHash', 'policyHash', 'budgetHash', 'seed', 'runner', 'samples', 'criticalFailures',
      'p95', 'runGrowthBytes', 'hardStorageBudget', 'supported', 'status', 'gate', 'predecessorEligible'] as const) {
      if (JSON.stringify(record[field]) !== JSON.stringify(derived[field])) throw new Error('Experiment differs from source report');
    }
  }
  if (!before.predecessorEligible || !after.predecessorEligible) throw new Error('Unproven, dirty or source-mismatched checkout is ineligible as an acceptance baseline');
  if (after.predecessorHead !== before.head) throw new Error('Capture the predecessor feature head first');
  for (const field of ['fixtureHash', 'policyHash', 'budgetHash', 'seed', 'runner', 'split', 'repetitionRule', 'hardStorageBudget'] as const) {
    if (before[field] !== after[field]) throw new Error('Comparison input drift');
  }
  if (JSON.stringify(before.gate) !== JSON.stringify(after.gate)) throw new Error('Gate drift');
  const featureNames = [...new Set([...Object.keys(before.features), ...Object.keys(after.features)])].sort();
  const changes = featureNames.filter(name => before.features[name] !== after.features[name]);
  if (changes.length !== 1) throw new Error('Change exactly one mechanism per ablation');
  if (before.gate.version === relationshipGate.version && changes[0] !== 'relationship-expansion') throw new Error('Declare a gate for this feature before acceptance');
  for (const name of new Set([...Object.keys(before.adapters), ...Object.keys(after.adapters)])) {
    if (name !== changes[0] && before.adapters[name] !== after.adapters[name]) throw new Error('Unchanged adapter drift');
  }
  if (before.criticalFailures.length || after.criticalFailures.length) return { status: 'fail' };
  // Self-reported pairing, environment and work counts are diagnostics, not verified execution.
  // Check known hard failures before fencing acceptance pending a real paired producer.
  for (const record of [before, after]) {
    const usage = record.sourceReport.usage;
    if (usage.persistedBytes > record.hardStorageBudget
      || (usage.actualSpend ?? 0) > corpus.manifest.budgets.actualSpend
      || (usage.reservedSpend ?? 0) > corpus.manifest.budgets.reservedSpend
      || (usage.calls ?? 0) + (usage.setupCalls ?? 0) > corpus.manifest.budgets.calls
      || (usage.retries ?? 0) > corpus.manifest.budgets.retries) return { status: 'fail' };
  }
  if (!before.supported || !after.supported) return { status: 'not_supported' };
  if (changes[0] === 'relationship-expansion' && (!before.features['hybrid'] || !before.features['reranking']
    || before.features['relationship-expansion'] !== false || after.features['relationship-expansion'] !== true
    || JSON.stringify(before.gate) !== JSON.stringify(relationshipGate))) throw new Error('Relationship gate requires hybrid plus reranking and frozen policy');
  const beforeCoverage = new Map(before.sourceReport.rows.filter(row => row.ablation === before.ablation).map(row => [row.id, row.metrics?.evidenceCoverage]));
  const coverageRegressions = after.sourceReport.rows.filter(row => row.ablation === after.ablation)
    .filter(row => beforeCoverage.get(row.id) != null && row.metrics?.evidenceCoverage != null && row.metrics.evidenceCoverage < beforeCoverage.get(row.id)!).length;
  if (coverageRegressions) return { status: 'fail' };
  // No paired cross-head runner or normalized evidence-storage producer ships in v1.
  // Arbitrary report labels must never turn diagnostic measurements into acceptance.
  return { status: 'insufficient_evidence' };
}

export function boundReport(report: unknown): string {
  if (report && typeof report === 'object' && 'rows' in report
    && Array.isArray(report.rows) && report.rows.length > 512) throw new Error('Report row bound exceeded');
  const bytes = JSON.stringify(report, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > 1_048_576) throw new Error('Report artifact bound exceeded');
  return bytes;
}

const quote = (value: string): string => '"' + value.replaceAll('"', '""') + '"';
function fixtureUuid(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const GRANT_HASHES: Record<string, string> = {
  'grant-application-role.sql': 'df1518282b189bfb23482e173adeac935ed5bab935912dacd2b2d5f018cfb884',
  'grant-operator-role.sql': '1520fb81154ce29ffe661c5ed6e81b39c7225a9292bceac4bd38720764305ff6',
  'grant-sync-role.sql': '35c77a918abbc297d5c1e1fd89902bc99e29ac086147edd5cc973b1879c538c3',
};
/** Reviewed standalone SQL emulation, not a general-purpose psql interpreter. */
export function checkedGrantSql(filename: string, source: string): string {
  const normalized = source.replaceAll('\r\n', '\n');
  if (!GRANT_HASHES[filename] || sha256(normalized) !== GRANT_HASHES[filename]) throw new Error('Grant script drift requires review');
  return normalized.split('\n').filter(line => !line.trimStart().startsWith('\\')).join('\n');
}
async function grant(owner: pg.Pool, filename: string, variables: Record<string, string>) {
  let sql = checkedGrantSql(filename, await readFile(resolve('scripts', filename), 'utf8'));
  for (const [name, value] of Object.entries({ continuum_schema: 'public', ...variables })) {
    sql = sql.replaceAll(`:"${name}"`, quote(value)).replaceAll(`:'${name}'`, "'" + value.replaceAll("'", "''") + "'");
  }
  await owner.query(sql);
}

/** Creates a fresh DB, never migrates or resets the caller's database. LOGINs are real sessions. */
export async function withEvaluationFixture<T>(url: string, run: (fixture: {
  owner: pg.Pool; app: pg.Pool; operator: pg.Pool; sync: pg.Pool; actor: Principal; emptyStorage: StorageSnapshot;
}) => Promise<T>): Promise<T> {
  const suffix = randomUUID().replaceAll('-', '');
  const database = `eval_${suffix}`;
  const maintenance = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=60000 -c lock_timeout=5000' });
  const pools: pg.Pool[] = [];
  const roles: string[] = [];
  let created = false;
  try {
    await maintenance.query(`CREATE DATABASE ${quote(database)}`); created = true;
    const ownerUrl = new URL(url); ownerUrl.pathname = '/' + database;
    const owner = new pg.Pool({ connectionString: ownerUrl.toString(), max: 1, connectionTimeoutMillis: 5000,
      options: '-c statement_timeout=60000 -c lock_timeout=5000' }); pools.push(owner);
    await runMigrations(owner);
    const emptyStorage = await measureStorage(owner);
    const actor = await createPrincipal(owner, { externalId: 'eval-admin', kind: 'user', displayName: 'Synthetic administrator' });
    const org = (await getScopeByRef(owner, { kind: 'org', name: '' }))!;
    await addMembership(owner, actor.id, org.id, 'admin');
    const syncActor = await createPrincipal(owner, { externalId: 'eval-sync', kind: 'service', displayName: 'Synthetic sync' });
    const sessions: pg.Pool[] = [];
    for (const kind of ['app', 'operator', 'sync']) {
      const role = `eval_${kind}_${suffix}`; const password = randomUUID();
      await owner.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}'`); roles.push(role);
      if (kind !== 'sync') await grant(owner, 'grant-application-role.sql', { continuum_app_role: role });
      if (kind === 'operator') await grant(owner, 'grant-operator-role.sql', { continuum_operator_role: role, continuum_principal_id: actor.id });
      if (kind === 'sync') await grant(owner, 'grant-sync-role.sql', { continuum_sync_role: role, continuum_principal_id: syncActor.id });
      const roleUrl = new URL(ownerUrl); roleUrl.username = role; roleUrl.password = password;
      const pool = new pg.Pool({ connectionString: roleUrl.toString(), max: 1, connectionTimeoutMillis: 5000,
        options: '-c search_path=public -c statement_timeout=5000 -c lock_timeout=1000' });
      pools.push(pool); sessions.push(pool);
      const session = (await pool.query('SELECT session_user AS name, rolsuper FROM pg_catalog.pg_roles WHERE rolname=session_user')).rows[0];
      if (session.name !== role || session.rolsuper) throw new Error('Runtime authority fixture invalid');
    }
    return await run({ owner, app: sessions[0], operator: sessions[1], sync: sessions[2], actor, emptyStorage });
  } finally {
    await Promise.all(pools.map(pool => pool.end()));
    const cleanupErrors: unknown[] = [];
    try {
      if (created) try { await dropIsolatedTestDatabase(maintenance, database); } catch (error) { cleanupErrors.push(error); }
      for (const role of roles.reverse()) {
        try { await maintenance.query(`ALTER ROLE ${quote(role)} NOLOGIN`); await maintenance.query(`DROP ROLE ${quote(role)}`); }
        catch (error) { cleanupErrors.push(error); }
      }
    } finally { await maintenance.end(); }
    if (cleanupErrors.length) throw new Error('Isolated fixture cleanup incomplete');
  }
}

export type StorageSnapshot = { applicationBytes: number; databaseBytes: number };
export async function measureStorage(pool: pg.Pool): Promise<StorageSnapshot> {
  const row = (await pool.query(`SELECT pg_database_size(current_database())::text AS database_bytes,
    (SELECT coalesce(sum(pg_total_relation_size(c.oid)),0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE (n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)'
        AND c.relkind IN ('r','m','p','S'))
        OR c.oid IN ('pg_catalog.pg_largeobject'::regclass,'pg_catalog.pg_largeobject_metadata'::regclass))::text AS application_bytes`)).rows[0];
  return { applicationBytes: Number(row.application_bytes), databaseBytes: Number(row.database_bytes) };
}
export function accountStorage(empty: StorageSnapshot, final: StorageSnapshot) {
  const runGrowthBytes = Math.max(0, final.applicationBytes - empty.applicationBytes, final.databaseBytes - empty.databaseBytes);
  return { persistedBytes: empty.applicationBytes + runGrowthBytes, runGrowthBytes, emptySchemaBytes: empty.applicationBytes,
    rawApplicationBytes: final.applicationBytes, rawDatabaseBytes: final.databaseBytes, emptyDatabaseBytes: empty.databaseBytes };
}

export type Ablation = 'lexical' | 'hybrid' | 'fallback' | 'vector-only' | 'reranking' | 'extraction' | 'synthesis' | 'temporal' | 'connector' | 'relationship-expansion';
export const ablations: Ablation[] = ['lexical', 'hybrid', 'fallback', 'vector-only', 'reranking', 'extraction', 'synthesis', 'temporal', 'connector', 'relationship-expansion'];
export type EvaluationRow = { id: string; ablation: Ablation; status: 'measured' | 'not_supported' | 'failed';
  metrics?: ReturnType<typeof scoreRetrieval>; latencyMs?: number; failures?: string[];
  latencySamplesMs?: number[]; evaluatorMs?: number; universeHash?: string; warmup?: boolean;
  diagnostics?: string; contextBytes?: number; outputBytes?: number; contextBytesTotal?: number; outputBytesTotal?: number; hydrated?: number; calls?: number };
function checkoutState(head: string) {
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8', timeout: 5000 }).trim();
  if (actual !== head) throw new Error('Checkout identity must match the tested head');
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8', timeout: 5000 }).trim();
  // Read the commit headers, including parents hidden by a shallow CI boundary.
  const headers = execFileSync('git', ['cat-file', 'commit', 'HEAD'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1_048_576 }).split('\n\n', 1)[0];
  const parents = [...headers.matchAll(/^parent ([a-f0-9]{40})$/gm)].map(match => match[1]);
  return { head: actual, tree, parents, clean: dirty === '' };
}

export async function runBaseline(corpus: Corpus, databaseUrl: string, head: string, seed = corpus.manifest.seed, signal?: AbortSignal) {
  if (!loadedCorpora.has(corpus)) throw new Error('A loaded frozen corpus is required');
  if (!/^[a-f0-9]{40}$/.test(head) || seed !== corpus.manifest.seed) throw new Error('Invalid run identity');
  const checkoutStart = checkoutState(head);
  const started = performance.now();
  const rows: EvaluationRow[] = [];
  const limits = corpus.manifest.budgets;
  const budget = new PhaseBudget(limits.maxSetupMs, limits.maxDurationMs);
  let storage = { persistedBytes: 0, runGrowthBytes: 0, emptySchemaBytes: 0, rawApplicationBytes: 0, rawDatabaseBytes: 0, emptyDatabaseBytes: 0 };
  let workEnded = started;
  let timings = { setupMs: 0, measuredMs: 0 };
  let setupCalls = 0;
  const supported = new Set(['recall', 'fetch', 'agents-md', 'supersede', 'expiry', 'revoke', 'erase']);
  planRows(corpus.cases.filter(item => supported.has(item.operation)).length,
    corpus.cases.filter(item => !supported.has(item.operation)).length, 3, limits.maxRows);
  const observations: EvaluationRow[] = [];
  let environment = '';
  await withEvaluationFixture(databaseUrl, async ({ owner, app, operator, sync, actor, emptyStorage }) => {
    const platform = (await owner.query("SELECT current_setting('server_version_num') AS version, current_setting('jit') AS jit, current_setting('fsync') AS fsync")).rows[0];
    environment = sha256(JSON.stringify({ host: hostname(), node: process.version, platform: process.platform, arch: process.arch, postgres: platform }));
    budget.check(); signal?.throwIfAborted();
    // Exact grant scripts run before runtime work; SYNC must have no memory payload access.
    const syncAllowed = (await sync.query("SELECT has_table_privilege(session_user,'memories','SELECT') AS allowed")).rows[0].allowed;
    if (syncAllowed) throw new Error('SYNC fixture may not read memory payloads');
    const stub = new StubEmbeddingProvider();
    type Seeded = { reader: Principal; scoped: Scope; denied: Scope; memories: Map<string, Memory>; references: Map<string, Reference> };
    const shared = new Map<string, Seeded>();
    const prepared = new Map<string, Seeded>();
    const seedDocument = async (item: FixtureCase, doc: FixtureCase['documents'][number], fixture: Seeded, denied: Scope) => {
      budget.check(); signal?.throwIfAborted();
      // No production quarantine state exists. Its negative adapter fixture is
      // withheld from admission, never represented as a measured serving feature.
      if (doc.state === 'quarantined') return;
      const memory = await createMemory(owner, { id: fixtureUuid(`${seed}:${item.id}:${key(doc)}`),
        scopeId: doc.allowed && doc.sourceAllowed && doc.scope !== 'project:denied' ? fixture.scoped.id : denied.id,
        scopeKind: doc.allowed && item.operation === 'erase' ? 'user' : 'project', type: doc.type,
        title: doc.title, body: doc.body, tags: doc.tags, authorId: fixture.reader.id, source: 'manual',
        sourceRef: key(doc), metadata: {} });
      fixture.memories.set(doc.id, memory); fixture.references.set(memory.id, { id: doc.id, version: doc.version });
      await owner.query('UPDATE memories SET state=$1, created_at=$2, updated_at=$2 WHERE id=$3', [doc.state, corpus.manifest.clock, memory.id]);
      if (doc.state === 'live') {
        setupCalls++;
        await storeMemoryEmbeddingVector(owner, memory.id, (await stub.embed([`${doc.title}\n\n${doc.body}`]))[0], stub);
      }
    };
    for (const split of ['development', 'holdout']) {
      const reader = await createPrincipal(owner, { externalId: `eval-shared-${split}`, kind: 'user', displayName: 'Synthetic ranking reader' });
      const scoped = await createScope(owner, { kind: 'project', name: `eval-shared-${split}` });
      await addMembership(owner, reader.id, scoped.id, 'writer');
      const denied = await createScope(owner, { kind: 'project', name: `eval-shared-denied-${split}` });
      const fixture = { reader, scoped, denied, memories: new Map<string, Memory>(), references: new Map<string, Reference>() };
      shared.set(split, fixture);
      for (const item of seededOrder(corpus.cases.filter(item => item.split === split && item.collection === 'ranking'), seed)) {
        for (const doc of seededOrder(item.documents, seed)) await seedDocument(item, doc, fixture, denied);
      }
    }
    for (const item of seededOrder(corpus.cases, seed)) {
      signal?.throwIfAborted();
      budget.check();
      if (!supported.has(item.operation)) {
        rows.push({ id: item.id, ablation: item.operation as Ablation, status: 'not_supported' }); continue;
      }
      const group = item.collection === 'ranking' ? shared.get(item.split) : undefined;
      const reader = group?.reader ?? await createPrincipal(owner, { externalId: `eval-${item.id}`, kind: 'user', displayName: 'Synthetic reader' });
      const scoped = group?.scoped ?? await createScope(owner, { kind: item.operation === 'erase' ? 'user' : 'project', name: `eval-${item.id}` });
      const denied = group?.denied ?? await createScope(owner, { kind: 'project', name: `denied-${item.id}` });
      await addMembership(owner, reader.id, scoped.id, 'writer');
      const memories = group?.memories ?? new Map<string, Memory>();
      const references = group?.references ?? new Map<string, Reference>();
      const fixture = { reader, scoped, denied, memories, references };
      prepared.set(item.id, fixture);
      if (!group) for (const doc of seededOrder(item.documents, seed)) await seedDocument(item, doc, fixture, denied);
      if (item.operation === 'expiry') await owner.query('UPDATE memories SET expires_at=clock_timestamp() WHERE scope_id=$1', [scoped.id]);
      if (item.operation === 'revoke') await owner.query('UPDATE scope_memberships SET active=FALSE WHERE principal_id=$1 AND scope_id=$2', [reader.id, scoped.id]);
      if (item.operation === 'supersede') {
        setupCalls++;
        const result = await supersedeForPrincipal(app, stub, reader, { supersededId: memories.get('primary')!.id,
          title: 'Quartz deployment successor', body: 'Quartz deployment now uses the green queue.', tags: ['decision'] });
        references.set(result.successor.id, { id: 'successor', version: '2' });
      }
      if (item.operation === 'erase') {
        await mapOwnedUserScope(operator, actor, reader.id, scoped.id);
        let result = await offboardPrincipal(operator, actor, reader.id, { confirmationScopeId: scoped.id });
        for (let attempt = 0; !result.complete && attempt < 10; attempt++) result = await offboardPrincipal(operator, actor, reader.id, { confirmationScopeId: scoped.id });
        if (!result.complete) throw new Error('Erasure fixture incomplete');
        const residual = (await owner.query(`SELECT count(*)::int AS count FROM memories m
          WHERE scope_id=$1 AND (body <> '[erased]' OR title <> '[erased]' OR EXISTS
          (SELECT 1 FROM memory_embeddings e WHERE e.memory_id=m.id))`, [scoped.id])).rows[0].count;
        if (residual) throw new Error('Erased payload survived');
        const lateVectors = (await owner.query('SELECT 1 FROM memory_embeddings WHERE memory_id=ANY($1::uuid[])', [[...memories.values()].map(memory => memory.id)])).rowCount;
        if (lateVectors) throw new Error('Erased vectors survived');
      }
    }
    budget.beginMeasured();
    for (const item of seededOrder(corpus.cases.filter(item => supported.has(item.operation)), seed)) {
      const { reader, scoped, denied, memories, references } = prepared.get(item.id)!;
      const universeHash = candidateUniverseHash(corpus, item);
      const modes = ['lexical', 'hybrid', 'fallback'] as const;
      for (let repetition = 0; repetition <= latencyPolicy.repetitions; repetition++) {
      const offset = (repetition + parseInt(sha256(item.id).slice(0, 4), 16)) % modes.length;
      for (const ablation of [...modes.slice(offset), ...modes.slice(0, offset)]) {
        budget.check(); signal?.throwIfAborted();
        const start = performance.now(); const failures: string[] = []; let actual: Reference[] = [];
        let serviceMs = 0; let deniedScope = false;
        const service = async <T>(run: () => Promise<T>): Promise<T> => {
          const began = performance.now(); try { return await run(); } finally { serviceMs += performance.now() - began; }
        };
        let context: unknown = []; let diagnostics = 'not_applicable'; let calls = 0;
        const auditFence = (await owner.query('SELECT coalesce(max(id),0)::text AS id FROM audit_log')).rows[0].id;
        const readAudits = async () => (await owner.query(`SELECT memory_id FROM audit_log WHERE id > $1::bigint
          AND action='read' AND principal_id=$2 AND memory_id IS NOT NULL`, [auditFence, reader.id])).rows.map(row => row.memory_id as string);
        let deliveredAudits: string[] | undefined;
        try {
          if (item.operation === 'fetch') {
            try { const result = await service(() => getMemoryForPrincipal(app, reader, memories.values().next().value!.id));
              actual = [references.get(result.memory.id)!]; context = result.memory; deniedScope = result.memory.scopeId === denied.id;
            } catch (error) { if ((error as { code?: string }).code !== 'MEMORY_NOT_FOUND') throw error; }
          } else if (item.operation === 'agents-md') {
            const input = { project: scoped.name };
            const markdown = await service(() => renderAgentsMdForPrincipal(app, reader, input));
            deliveredAudits = await readAudits();
            const bundle = await prepareAgentsMdForPrincipal(app, reader, input);
            const repeated = await renderAgentsMdForPrincipal(app, reader, input);
            if (markdown !== repeated || markdown !== bundle.markdown || sha256(markdown) !== bundle.hash) failures.push('nondeterministic-agents-md');
            for (const memory of bundle.memories) {
              const body = escapeAgentsMdData(memory.body, { preserveNewlines: true });
              const data = body.split('\n').map(line => line === '' ? '> DATA:' : `> DATA: ${line}`).join('\n');
              if (!bundle.markdown.includes(`> [BEGIN CONTINUUM MEMORY DATA]\n${data}\n> [END CONTINUUM MEMORY DATA]`)) failures.push('instruction-authority');
            }
            actual = bundle.memories.map(memory => references.get(memory.id)!);
            deniedScope = bundle.memories.some(memory => memory.scopeId === denied.id);
            context = bundle.markdown;
          } else if (item.operation === 'erase') {
            // This row measures direct memory/all-vector residual proof only.
            // Canonical OP completion separately checks the wider lifecycle state.
            context = { tombstones: memories.size, residualVectors: 0 };
            diagnostics = 'physical_memory_vector_erasure';
          } else {
            const provider = ablation === 'lexical' ? null : { id: stub.id, dim: 768, local: true,
              embed: async (texts: string[]) => { calls++; if (ablation === 'fallback' || item.id === 'unavailable-vector-provider') throw new Error('synthetic unavailable'); return stub.embed(texts); } };
            const hostedSpy = { id: 'stub:hosted-spy', dim: 768, local: false,
              embed: async () => { calls++; failures.push('local-only-egress'); throw new Error('Hosted calls forbidden'); } };
            const routing = item.id === 'local-only-no-egress' && ablation === 'hybrid' ? new ScopeEmbeddingRouter(new EmbeddingRegistry([['hosted', hostedSpy]]),
              { default: 'hosted', rules: [{ match: { kind: 'project' }, provider: 'local-only' }] }) : provider;
            const result = await service(() => recallForPrincipal(app, routing, reader,
              { query: item.query, scopes: [`project:${scoped.name}`, `project:${denied.name}`], limit: limits.hydrationLimit }));
            deniedScope = result.results.some(row => row.memory.scopeId === denied.id);
            actual = result.results.map(result => references.get(result.memory.id)!);
            context = result.results;
            diagnostics = result.diagnostics.vector;
            if (item.collection === 'ranking' && ((ablation === 'hybrid' && diagnostics !== 'used')
              || (ablation === 'fallback' && diagnostics !== 'failed') || (ablation === 'lexical' && diagnostics !== 'disabled'))) failures.push('ablation-not-exercised');
          }
          failures.push(...checkDelivered(corpus, item, actual, deniedScope));
          // Preserve security classification before audit lookup or scoring can reject an unknown reference.
          if (actual.some(ref => !ref)) throw new Error('Unmapped delivered reference');
          const serializedBytes = Buffer.byteLength(JSON.stringify(context));
          if (serializedBytes > limits.contextBytes || serializedBytes > limits.outputBytes) failures.push('hard-byte-budget');
          deliveredAudits ??= await readAudits();
          if (actual.length && deliveredAudits.length === 0) failures.push('unaudited-delivery');
          for (const ref of actual) {
            const memoryId = [...references].find(([, value]) => key(value) === key(ref))?.[0];
            if (!memoryId || !deliveredAudits.includes(memoryId)) failures.push('missing-delivered-memory-audit');
          }
          observations.push({ id: item.id, ablation, status: 'measured', metrics: scoreRetrieval(actual, item.relevant),
            latencyMs: serviceMs, evaluatorMs: performance.now() - start - serviceMs, universeHash, warmup: repetition === 0, failures, diagnostics,
            contextBytes: serializedBytes, outputBytes: serializedBytes, hydrated: actual.length, calls });
        } catch (error) {
          const code = (error as { code?: string }).code;
          observations.push({ id: item.id, ablation, status: 'failed', latencyMs: serviceMs, evaluatorMs: performance.now() - start - serviceMs, universeHash, warmup: repetition === 0, calls,
            failures: [...new Set([...failures, 'SERVICE_FAILED'])], diagnostics: code && ['FORBIDDEN', 'UNAUTHORIZED', 'PRINCIPAL_DISABLED', 'INVALID_SCOPE', 'INTERNAL'].includes(code) ? code : 'SERVICE_ERROR' });
        }
        if (observations.length > limits.maxRows * (latencyPolicy.repetitions + latencyPolicy.warmups)) throw new Error('Observation bound exceeded');
        budget.check(); signal?.throwIfAborted();
      }
    }
    }
    storage = accountStorage(emptyStorage, await measureStorage(owner));
    budget.check(); timings = budget.timings(); workEnded = performance.now();
  });
  const checkoutEnd = checkoutState(head);
  const sourceHead = process.env.CONTINUUM_EVAL_SOURCE_SHA ?? head;
  const event = process.env.GITHUB_EVENT_NAME;
  const provenance: Provenance = { headStart: checkoutStart.head, headEnd: checkoutEnd.head, treeStart: checkoutStart.tree, treeEnd: checkoutEnd.tree,
    parents: checkoutStart.parents, cleanStart: checkoutStart.clean, cleanEnd: checkoutEnd.clean,
    sourceIdentity: process.env.CONTINUUM_EVAL_SOURCE_SHA ? 'explicit' : 'checkout',
    context: event === 'pull_request' || event === 'push' || event === 'workflow_dispatch' ? event : event ? 'other' : 'local' };
  const grouped = new Map<string, EvaluationRow[]>();
  for (const row of observations) { const name = row.id + ':' + row.ablation; const group = grouped.get(name) ?? []; group.push(row); grouped.set(name, group); }
  for (const group of grouped.values()) {
    const measuredGroup = group.filter(row => !row.warmup); const first = measuredGroup[0];
    const latencySamplesMs = measuredGroup.map(row => row.latencyMs!);
    const metrics = first.metrics && Object.fromEntries(Object.keys(first.metrics).map(name => {
      const values = measuredGroup.map(row => row.metrics?.[name as keyof NonNullable<typeof row.metrics>]);
      return [name, values.every(value => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0) / values.length];
    })) as EvaluationRow['metrics'];
    rows.push({ ...first, warmup: undefined, status: group.some(row => row.status !== 'measured') ? 'failed' : 'measured',
      metrics, latencyMs: median(latencySamplesMs), latencySamplesMs, evaluatorMs: group.reduce((sum, row) => sum + (row.evaluatorMs ?? 0), 0),
      failures: [...new Set(group.flatMap(row => row.failures ?? []))], calls: group.reduce((sum, row) => sum + (row.calls ?? 0), 0),
      hydrated: group.reduce((sum, row) => sum + (row.hydrated ?? 0), 0), contextBytes: Math.max(...group.map(row => row.contextBytes ?? 0)),
      outputBytes: Math.max(...group.map(row => row.outputBytes ?? 0)), contextBytesTotal: group.reduce((sum, row) => sum + (row.contextBytes ?? 0), 0),
      outputBytesTotal: group.reduce((sum, row) => sum + (row.outputBytes ?? 0), 0) });
  }
  const measured = rows.filter(row => row.status === 'measured');
  const latencies = measured.map(row => row.latencyMs!).sort((a, b) => a - b);
  const percentile = (p: number) => latencies.length ? latencies[Math.max(0, Math.ceil(p * latencies.length) - 1)] : null;
  const failures = [...new Set(rows.flatMap(row => row.failures ?? []))];
  if (storage.persistedBytes > limits.storageBytes) failures.push('hard-storage-budget');
  const allCalls = observations.reduce((sum, row) => sum + (row.calls ?? 0), 0);
  if (setupCalls + allCalls > limits.calls) failures.push('hard-call-budget');
  if (!/^[a-f0-9]{40}$/.test(sourceHead)) throw new Error('Invalid source provenance');
  const holdoutIds = new Set(corpus.cases.filter(item => item.collection === 'ranking' && item.split === 'holdout').map(item => item.id));
  const rankingDiagnostics = ['lexical', 'hybrid', 'fallback'].map(ablation => {
    const scores = measured.filter(row => holdoutIds.has(row.id) && row.ablation === ablation)
      .map(row => row.metrics?.ndcg).filter((score): score is number => score != null);
    const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    const variance = scores.length ? scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / scores.length : null;
    return { ablation, pairs: scores.length, distinctScores: new Set(scores).size, mean: scores.length ? mean : null,
      variance, diagnostic: variance === null ? 'no_evidence' : variance < 1e-12 ? 'degenerate_scores_review_corpus' : 'varied_scores' };
  });
  const report = { schema: 1, runner: RUNNER_VERSION, head, sourceHead, provenance, predecessorEligible: acceptanceEligible(head, sourceHead, provenance),
    latencyEvidence: { policy: latencyPolicy, pairedSession: null, environment },
    sampling: { observations: observations.length, orderDigest: sha256(JSON.stringify(observations.map(row => [row.id, row.ablation, row.warmup]))) },
    corpusDiagnostics: graphShortcutDiagnostics(corpus.cases),
    fixtureManifest: corpus.manifestHash,
    fixtureFiles: corpus.manifest.files, fixtureVersion: corpus.manifest.version, seed,
    clock: corpus.manifest.clock, rankingDiagnostics, provider: { id: 'stub:sha256', dim: 768, local: true, liveQuality: false },
    promptSchemaHash: sha256(JSON.stringify({ caseSchema: 'v1', prompt: null })),
    featureFlags: { productionChanges: false, hosted: false }, budgets: limits,
    fixtureStateAdapters: { quarantined: 'not_supported' },
    sampleCounts: { total: rows.length, measured: measured.length, unsupported: rows.filter(row => row.status === 'not_supported').length,
      failed: rows.filter(row => row.status === 'failed').length },
    latencyMs: { p50: percentile(0.5), p95: percentile(0.95) },
    timing: { ...timings, cleanupMs: performance.now() - workEnded, totalMs: performance.now() - started },
    usage: { candidateCount: null, candidateCeilingPerBranch: limits.candidateLimit, candidateUnionCeiling: limits.candidateLimit * 2,
      hydrationCount: measured.reduce((sum, row) => sum + (row.hydrated ?? 0), 0),
      completeSerializedContextBytes: rows.reduce((sum, row) => sum + (row.contextBytesTotal ?? 0), 0),
      outputBytes: rows.reduce((sum, row) => sum + (row.outputBytesTotal ?? 0), 0),
      contextTokens: null, outputTokens: null, tokenizer: 'not_supported',
      calls: allCalls, setupCalls, retries: 0, reservedSpend: 0, actualSpend: 0,
      ...storage, storageAmplification: null },
    gates: { mechanism: failures.length ? 'fail' : 'pass', qualityAcceptance: 'not_evaluated',
      relationshipExpansion: 'not_supported', failures }, rows };
  const experiments = ['lexical', 'hybrid', 'fallback'].map(ablation => experimentFromReport(corpus, report, ablation,
    { lexical: true, hybrid: ablation === 'hybrid', reranking: false, 'relationship-expansion': false, 'vector-fallback': ablation === 'fallback' },
    { lexical: 'shared-service-v1', hybrid: 'stub:sha256-v1', reranking: 'not_supported', 'relationship-expansion': 'not_supported', 'vector-fallback': 'synthetic-unavailable-v1' }));
  return { ...report, measuredFields: ['**.latencyMs', '**.p95', '**.persistedBytes', '**.emptySchemaBytes', '**.runGrowthBytes', '**.latencySamplesMs', '**.evaluatorMs', '**.rawApplicationBytes', '**.rawDatabaseBytes', '**.emptyDatabaseBytes', 'timing'], experiments };
}
