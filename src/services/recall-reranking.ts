import type pg from 'pg';
import { BudgetError, boundedJson, type Budget } from '../pipeline/budget.js';
import type { RecallInput, RecallResult } from '../types.js';
import type { RecallCandidates, RecallOptions } from '../storage/recall.js';
import { hydrateRecallCandidates } from '../storage/recall.js';
import { evidenceTransaction } from '../storage/evidence.js';
import { recallAuthorityMetadata, enrollRecallSources, currentRecallEnvelopes } from '../storage/recall-authority.js';
import type { EvidenceEnvelope } from '../evidence/model.js';
import { decideEvidencePolicy, type EvidenceAuthorityContext, type EvidencePolicy } from '../evidence/policy.js';
import type { Reranking } from '../reranking/provider.js';
import { runReranking, type RerankingDiagnostic } from '../reranking/runner.js';
import type { BudgetReason } from '../pipeline/receipts.js';

interface AdmittedRecall {
  results: RecallResult[];
  versions: Map<string, string>;
  diagnostic: RerankingDiagnostic;
}
// Bounded identities only, scoped to the owned application Pool. No payload,
// envelope or authorization decision survives a request. All hits recheck SQL.
const sourceVersions = new WeakMap<pg.Pool, Map<string, string>>();
const destination = (config: Reranking, now: number) => ({ locality: config.adapter.local ? 'local' as const : 'hosted' as const,
  authority: config.providerAuthority(now) });
function decideSource(actor: string, envelope: EvidenceEnvelope, provider?: EvidenceAuthorityContext['provider']) {
  const policy: EvidencePolicy = { version: 'recall-source-v1', currentVersion: 'recall-source-v1', scopeIds: [envelope.scopeId],
    state: 'active', expiresAt: envelope.expiresAt, residency: 'any', connector: 'not-required', repository: 'not-required' };
  const source = { kind: 'source-document-version' as const, policy, authorityDependencies: envelope.policies };
  // Only current locked SQL may establish these Continuum facts. Both branches
  // describe this same source; there is no assertion/document declassification.
  return decideEvidencePolicy({ now: envelope.now, action: provider ? 'provider-disclosure' : 'text-hydration',
    continuum: { principalId: actor, enabled: true, checkedAt: envelope.now,
      readableScopeIds: [...new Set([envelope.scopeId, ...envelope.policies.flatMap(p => p.scopeIds)])] },
    artifact: source, sourceDocument: source, providerInput: 'source-document', provider });
}
function canDisclose(actor: string, envelope: EvidenceEnvelope, config: Reranking): boolean {
  try { return decideSource(actor, envelope, destination(config, envelope.now)).providerDisclosure.decision === 'allow'; }
  catch { return false; }
}

/** Current source authority is established by SQL, then consumed by the pure
 * policy. Never call the exclusive autocommit authority adapter here. */
export async function currentRecallIds(client: pg.PoolClient, actor: string,
  versions: ReadonlyMap<string, string>, config?: Reranking): Promise<Set<string>> {
  const decision = await currentRecallEligibility(client, actor, versions, config);
  return config ? decision.disclosable : decision.readable;
}
export async function currentRecallEligibility(client: pg.PoolClient, actor: string,
  versions: ReadonlyMap<string, string>, config?: Reranking) {
  const readable = new Set<string>(); const disclosable = new Set<string>();
  for (const { id, envelope } of await currentRecallEnvelopes(client, actor, versions)) {
    if (!envelope || envelope.kind !== 'source-document-version') continue;
    if (decideSource(actor, envelope).sourceDocumentRead.decision !== 'allow') continue;
    readable.add(id);
    if (config && canDisclose(actor, envelope, config)) disclosable.add(id);
  }
  return { readable, disclosable };
}

export async function rerankRecallPool(pool: pg.Pool, actor: string, input: RecallInput, opts: RecallOptions,
  selected: RecallCandidates, config: Reranking, budget: Budget, signal?: AbortSignal, localOnlyScopes: ReadonlySet<string> = new Set(), fallbackReason?: BudgetReason): Promise<AdmittedRecall> {
  const limit = input.limit ?? 10;
  const known = sourceVersions.get(pool) ?? new Map<string, string>();
  sourceVersions.set(pool, known);
  let reason: RerankingDiagnostic | undefined = fallbackReason ? { status: 'fallback', reason: fallbackReason } : undefined;
  const admitted = await evidenceTransaction(pool, async client => {
    // Metadata before lazy source enrollment or body hydration. Current membership
    // applies even if a previously resolved readable-scope list is stale.
    const metadata = await recallAuthorityMetadata(client, actor, selected.candidates.map(c => c.id), opts.scopeIds);
    const sizes = new Map(metadata.map(r => [r.id, Number(r.bytes)]));
    let candidates = selected.candidates.filter(c => sizes.has(c.id));
    const fits = (rows: typeof candidates) => rows.length <= budget.available('candidates')
      && rows.every(c => sizes.get(c.id)! <= budget.profile.maxItemHydratedBytes)
      && rows.reduce((n, c) => n + sizes.get(c.id)!, 1024) <= Math.min(opts.readBudgetBytes ?? Infinity, budget.available('hydratedBytes'));
    if (!fits(candidates) || config.candidateLimit < limit) {
      candidates = candidates.slice(0, limit);
      reason = { status: 'fallback', reason: 'budget_exhausted' };
    }
    if (!fits(candidates)) throw new BudgetError();
    const versions = new Map<string, string>();
    const sources = await enrollRecallSources(client, actor, candidates.map(c => c.id).sort(), known);
    if (sources.length !== candidates.length) reason = { status: 'fallback', reason: 'policy_denied' };
    for (const { id, version, envelope } of sources) {
      if (envelope && envelope.kind === 'source-document-version'
        && decideSource(actor, envelope).sourceDocumentRead.decision === 'allow') {
        versions.set(id, version);
        known.delete(id); known.set(id, version);
        if (known.size > 100) known.delete(known.keys().next().value!);
        if ((!config.adapter.local && localOnlyScopes.has(envelope.scopeId))
          || !canDisclose(actor, envelope, config)) {
          reason = { status: 'fallback', reason: 'policy_denied' };
        }
      } else reason = { status: 'fallback', reason: 'policy_denied' };
    }
    candidates = candidates.filter(c => versions.has(c.id));
    budget.consume({ candidates: candidates.length });
    const results = await hydrateRecallCandidates(client, candidates.map(c => c.id), input.query,
      new Map(candidates.map(c => [c.id, c.score])), opts.scopeIds, opts.types, opts.readBudgetBytes, budget, true);
    return { results, versions };
  });
  if (admitted.results.length < 2 || reason) return { ...admitted, diagnostic: reason ?? { status: 'fallback', reason: 'capability_unavailable' } };
  const candidates = Object.freeze(admitted.results.map((r, i) => Object.freeze({ id: `c${i}`, title: r.memory.title, excerpt: r.excerpt })));
  const authorize = () => evidenceTransaction(pool, async client =>
    (await currentRecallIds(client, actor, admitted.versions, config)).size === admitted.results.length);
  // Conservative complete-service output reserve for any order/refill, plus
  // transport wrappers and the existing optional enrichment ceiling.
  let finalBytes: number;
  try { finalBytes = Buffer.byteLength(boundedJson(admitted.results, budget.available('outputBytes'))) + 32_768; }
  catch { return { ...admitted, diagnostic: { status: 'fallback', reason: 'budget_exhausted' } }; }
  const outcome = await runReranking(config, budget, Object.freeze({ query: input.query, candidates }), authorize, finalBytes, { signal });
  if (outcome.status === 'fallback') return { ...admitted, diagnostic: outcome };
  return { ...admitted, diagnostic: { status: 'used' }, results: admitted.results
    .map((result, i) => ({ ...result, rerankScore: outcome.scores.get(`c${i}`)!, fusionRank: i }))
    .sort((a, b) => b.rerankScore - a.rerankScore || a.fusionRank - b.fusionRank || a.memory.id.localeCompare(b.memory.id))
    .map(({ fusionRank: _rank, ...result }) => result) };
}
