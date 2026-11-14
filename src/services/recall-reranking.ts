import type pg from 'pg';
import { BudgetError, boundedJson, type Budget } from '../pipeline/budget.js';
import type { RecallInput, RecallResult } from '../types.js';
import type { RecallCandidates, RecallOptions } from '../storage/recall.js';
import { hydrateRecallCandidates } from '../storage/recall.js';
import { evidenceEnvelope, evidenceTransaction } from '../storage/evidence.js';
import { MEMORY_READ_BUDGET_BYTES_SQL } from '../storage/memory-reads.js';
import { decideManagedEvidence } from './evidence.js';
import type { Reranking } from '../reranking/provider.js';
import { runReranking, type RerankingDiagnostic } from '../reranking/runner.js';

interface AdmittedRecall {
  results: RecallResult[];
  versions: Map<string, string>;
  diagnostic: RerankingDiagnostic;
}
const destination = (config: Reranking, now: number) => ({ locality: config.adapter.local ? 'local' as const : 'hosted' as const,
  authority: config.providerAuthority(now) });

/** Current source authority is established by SQL, then consumed by the pure
 * policy. Never call the exclusive autocommit authority adapter here. */
export async function currentRecallIds(client: pg.PoolClient, actor: string,
  versions: ReadonlyMap<string, string>, config?: Reranking): Promise<Set<string>> {
  const permitted = new Set<string>();
  for (const [id, version] of [...versions].sort(([a], [b]) => a.localeCompare(b))) {
    const envelope = await evidenceEnvelope(client, actor, version);
    if (!envelope || envelope.kind !== 'source-document-version') continue;
    const decision = decideManagedEvidence(actor, envelope, config && destination(config, envelope.now));
    if ((config ? decision.providerDisclosure : decision.artifactRead).decision !== 'allow') continue;
    const live = await client.query('SELECT id FROM memories WHERE id=$1 AND state=\'live\' AND (expires_at IS NULL OR expires_at>pg_catalog.clock_timestamp())', [id]);
    if (live.rowCount) permitted.add(id);
  }
  return permitted;
}

export async function rerankRecallPool(pool: pg.Pool, actor: string, input: RecallInput, opts: RecallOptions,
  selected: RecallCandidates, config: Reranking, budget: Budget, signal?: AbortSignal, localOnlyScopes: ReadonlySet<string> = new Set()): Promise<AdmittedRecall> {
  const limit = input.limit ?? 10;
  let reason: RerankingDiagnostic | undefined;
  const admitted = await evidenceTransaction(pool, async client => {
    // Metadata before lazy source enrollment or body hydration. Current membership
    // applies even if a previously resolved readable-scope list is stale.
    const metadata = await client.query<{ id: string; bytes: string }>(
      `SELECT m.id, ${MEMORY_READ_BUDGET_BYTES_SQL} AS bytes FROM memories m JOIN scopes s ON s.id=m.scope_id
       WHERE m.id=ANY($1::uuid[]) AND m.scope_id=ANY($2::uuid[]) AND m.state='live'
       AND (m.expires_at IS NULL OR m.expires_at>pg_catalog.clock_timestamp())
       AND EXISTS(SELECT 1 FROM principals p WHERE p.id=$3 AND p.disabled_at IS NULL)
       AND (s.kind='org' OR EXISTS(SELECT 1 FROM scope_memberships sm WHERE sm.scope_id=m.scope_id AND sm.principal_id=$3
         AND sm.active AND continuum_membership_is_effective(sm.active,sm.source_kind))) ORDER BY m.id FOR SHARE OF m`,
      [selected.candidates.map(c => c.id), opts.scopeIds, actor]);
    const sizes = new Map(metadata.rows.map(r => [r.id, Number(r.bytes)]));
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
    for (const candidate of [...candidates].sort((a, b) => a.id.localeCompare(b.id))) {
      // Oversized optional snapshots never hydrate. The required fallback still
      // goes through the ordinary bounded read gate and fails if it cannot fit.
      if (sizes.get(candidate.id)! > budget.profile.maxItemHydratedBytes) continue;
      await client.query('SAVEPOINT reranking_source');
      try {
        const version = (await client.query<{ id: string }>('SELECT continuum_evidence_source($1,$2) AS id', [actor, candidate.id])).rows[0].id;
        const envelope = await evidenceEnvelope(client, actor, version);
        if (envelope && envelope.kind === 'source-document-version'
          && decideManagedEvidence(actor, envelope).artifactRead.decision === 'allow') {
          versions.set(candidate.id, version);
          if ((!config.adapter.local && localOnlyScopes.has(envelope.scopeId))
            || decideManagedEvidence(actor, envelope, destination(config, envelope.now)).providerDisclosure.decision !== 'allow') {
            reason = { status: 'fallback', reason: 'policy_denied' };
          }
        }
        await client.query('RELEASE SAVEPOINT reranking_source');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT reranking_source');
        await client.query('RELEASE SAVEPOINT reranking_source');
        if (!['23514', '42501'].includes(String((error as { code?: string }).code))) throw error;
        // A denied identity never enters inputs, diagnostics, counts or receipts.
        reason = { status: 'fallback', reason: 'policy_denied' };
      }
    }
    candidates = candidates.filter(c => versions.has(c.id));
    budget.consume({ candidates: candidates.length });
    const results = await hydrateRecallCandidates(client, candidates.map(c => c.id), input.query,
      new Map(candidates.map(c => [c.id, c.score])), opts.scopeIds, opts.types, opts.readBudgetBytes, budget);
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
