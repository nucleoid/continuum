import type pg from 'pg';
import { Budget } from '../pipeline/budget.js';
import type { Principal, RecallInput, RecallResult } from '../types.js';
import { asEmbeddingRouter, type EmbeddingRouting } from '../embeddings/router.js';
import { recall, recallCandidates, type RecallDiagnostics, type RecallOptions } from '../storage/recall.js';
import { evidenceTransaction } from '../storage/evidence.js';
import type { Queryable } from '../storage/queryable.js';
import { assertRerankingEmbeddingBudget, type Reranking } from '../reranking/provider.js';
import type { RerankingDiagnostic } from '../reranking/runner.js';
import { EVIDENCE_POLICY_VERSION } from '../evidence/policy.js';
import { currentRecallEligibility, rerankRecallPool } from './recall-reranking.js';
import { recordRead as recordReadAudit } from '../audit/log.js';
import { resolveReadableScopeIds, type AccessibleScope } from './access.js';
import { asServiceError, dependencyUnavailable } from './errors.js';
import { parseScopeString } from './scopes.js';
import {
  applyRetrievalEnrichers,
  type EnrichmentOptions,
  type RetrievalEnricherRegistry,
} from '../extensions/retrieval.js';

export interface PrincipalRecallResult {
  results: RecallResult[];
  accessible: Map<string, AccessibleScope>;
  diagnostics: RecallDiagnostics & { localOnlyUnavailableScopes?: number; reranking?: RerankingDiagnostic };
}

export interface RecallLogger {
  error(message: string, error: unknown): void;
  info?(event: Record<string, unknown>): void;
}

export interface RecallEnrichment {
  readBudgetBytes?: number;
  validateResult?: (result: PrincipalRecallResult) => void;
  registry: RetrievalEnricherRegistry;
  options: EnrichmentOptions;
}

export async function recallForPrincipal(
  pool: pg.Pool,
  embeddingRouting: EmbeddingRouting,
  principal: Principal,
  input: RecallInput,
  auditMetadata: Record<string, unknown> = {},
  logger?: RecallLogger,
  enrichment?: RecallEnrichment,
  budget?: Budget,
  reranking?: Reranking,
): Promise<PrincipalRecallResult> {
  budget ??= reranking ? new Budget(reranking.profile) : undefined;
  const signal = enrichment?.options.signal;
  const cancel = () => budget?.cancel();
  if (reranking) {
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  }
  try {
    if (reranking) assertRerankingEmbeddingBudget(embeddingRouting);
    budget?.assertLive();
    const refs = input.scopes?.map(parseScopeString);
    const { accessible, scopeIds } = await resolveReadableScopeIds(
      pool,
      principal.id,
      refs,
    );
    const router = asEmbeddingRouter(embeddingRouting);
    const grouped = new Map<string, {
      scopeIds: string[];
      provider: NonNullable<ReturnType<typeof router.resolve>['provider']>;
    }>();
    let localOnlyUnavailable = 0;
    const localOnlyScopes = new Set<string>();
    for (const scopeId of scopeIds) {
      const scope = accessible.get(scopeId);
      if (!scope) continue;
      const route = router.resolve({ kind: scope.kind, name: scope.name });
      if (router.requiresLocal?.(scope) || route.policy === 'local-only-unavailable') localOnlyScopes.add(scopeId);
      if (!route.provider) {
        if (route.policy === 'local-only-unavailable') localOnlyUnavailable += 1;
        continue;
      }
      const key = `${route.provider.id}\u0000${route.provider.dim}`;
      const group = grouped.get(key) ?? { scopeIds: [], provider: route.provider };
      group.scopeIds.push(scopeId);
      grouped.set(key, group);
    }
    const embeddingGroups = [...grouped.values()];
    const recallOptions: RecallOptions = {
      query: input.query,
      scopeIds,
      types: input.types,
      limit: input.limit ?? 10,
      embeddingGroups,
      readBudgetBytes: enrichment?.readBudgetBytes,
      budget,
    };
    const candidatePool = reranking ? await recallCandidates(pool, recallOptions, Math.max(input.limit ?? 10, reranking.candidateLimit), true) : undefined;
    const ranked = reranking && candidatePool ? await rerankRecallPool(pool, principal.id, input, recallOptions, candidatePool, reranking, budget!, signal, localOnlyScopes) : undefined;
    const recalled = ranked && candidatePool ? { results: ranked.results, diagnostics: candidatePool.diagnostics } : await recall(pool, recallOptions);
    const embeddingAuditGroups = recalled.diagnostics.groups.map((group) => ({
      provider: group.provider,
      dim: group.dim,
      scopes: embeddingGroups.find((candidate) => candidate.provider.id === group.provider
        && candidate.provider.dim === group.dim)?.scopeIds.length ?? 0,
      status: group.status === 'used' ? 'succeeded' as const : 'failed' as const,
    }));
    const succeededEmbeddingGroups = embeddingAuditGroups
      .filter((group) => group.status === 'succeeded').length;
    const failedEmbeddingGroups = embeddingAuditGroups
      .filter((group) => group.status === 'failed').length;
    const diagnostics = {
      ...recalled.diagnostics,
      ...(ranked ? { reranking: ranked.diagnostic } : {}),
      ...(localOnlyUnavailable > 0
        ? { localOnlyUnavailableScopes: localOnlyUnavailable }
        : {}),
    };
    if (diagnostics.vector === 'failed' || diagnostics.vector === 'partial') {
      logger?.info?.({
        event: 'embedding_recall_fallback',
        vectorStatus: diagnostics.vector,
        failedGroups: diagnostics.groups.filter((group) => group.status === 'failed').length,
        totalGroups: diagnostics.groups.length,
      });
    }
    const results = recalled.results.slice(0, input.limit ?? 10);

    // Remote delivery validation includes optional enrichments before the required audit.
    // Existing callers retain their audit-before-enrichment ordering.
    const preparedResults = enrichment && (enrichment.validateResult || budget)
      ? await applyRetrievalEnrichers(results, principal.id, enrichment.registry, { ...enrichment.options, budget })
      : undefined;
    const deliver = async (auditPool: Queryable, deliveredResults: RecallResult[]): Promise<PrincipalRecallResult> => {
      enrichment?.validateResult?.({ results: deliveredResults, accessible, diagnostics });
      budget?.serializeOutput({ results: deliveredResults, diagnostics });

      // Recall auditing is required. Results are not returned if this write fails.
      await recordReadAudit(auditPool, {
        principalId: principal.id,
        query: input.query,
        metadata: {
          scopes: scopeIds.length,
          scope_ids: scopeIds,
          hits: deliveredResults.length,
          ...(ranked ? { reranking_status: ranked.diagnostic.status,
            reranking_adapter: { id: reranking!.adapter.id, version: reranking!.adapter.version,
              model: reranking!.adapter.model, profile: reranking!.adapter.profile },
            evidence_policy_version: EVIDENCE_POLICY_VERSION,
            ...(ranked.diagnostic.status === 'fallback' ? { reranking_reason: ranked.diagnostic.reason } : {}) } : {}),
          embedded: succeededEmbeddingGroups > 0,
          embedding_status: failedEmbeddingGroups > 0 || localOnlyUnavailable > 0
            ? 'degraded'
            : succeededEmbeddingGroups > 0 ? 'succeeded' : 'not-requested',
          embedding_groups: embeddingAuditGroups,
          vector_status: diagnostics.vector,
          ...(localOnlyUnavailable > 0
            ? { local_only_unavailable_scopes: localOnlyUnavailable }
            : {}),
          ...auditMetadata,
        },
        memories: deliveredResults.map((result, index) => ({
          memoryId: result.memory.id,
          scopeId: result.memory.scopeId,
          metadata: { rank: index + 1, score: result.score,
            ...(ranked ? { source_version: ranked.versions.get(result.memory.id)!, evidence_policy_version: EVIDENCE_POLICY_VERSION } : {}),
            ...(result.rerankScore === undefined ? {} : { rerank_score: result.rerankScore }) },
        })),
      });
      const enrichedResults = preparedResults || ranked ? deliveredResults : (enrichment
        ? await applyRetrievalEnrichers(
          results,
          principal.id,
          enrichment.registry,
          enrichment.options,
        )
        : results);
      budget?.assertLive();
      return { results: enrichedResults, accessible, diagnostics };
    };
    if (ranked) {
      const delivered = await evidenceTransaction(pool, async client => {
        const { readable: eligible, disclosable } = await currentRecallEligibility(client, principal.id, ranked.versions, reranking);
        if (ranked.diagnostic.status === 'used'
          && disclosable.size !== ranked.results.length) {
          diagnostics.reranking = ranked.diagnostic = { status: 'fallback', reason: 'policy_denied' };
          const fusionOrder = new Map(candidatePool!.candidates.map((c, i) => [c.id, i]));
          ranked.results = ranked.results.map(({ rerankScore: _score, ...r }) => r)
            .sort((a, b) => fusionOrder.get(a.memory.id)! - fusionOrder.get(b.memory.id)!);
        }
        const enriched = new Map((preparedResults ?? results).map(r => [r.memory.id, r]));
        return deliver(client, ranked.results.filter(r => eligible.has(r.memory.id)).slice(0, input.limit ?? 10)
          .map(r => ({ ...r, ...(enriched.get(r.memory.id)?.enrichments ? { enrichments: enriched.get(r.memory.id)!.enrichments } : {}) })));
      });
      // A committed authorized-read audit is not a network receipt. Cancellation
      // or expiry during COMMIT still suppresses the successful response.
      budget?.assertLive();
      return delivered;
    }
    return await deliver(pool, preparedResults ?? results);
  } catch (error) {
    if (reranking && ['55P03', '57014', '40P01'].includes(String((error as { code?: string })?.code))) {
      throw dependencyUnavailable(error);
    }
    throw asServiceError(error);
  } finally {
    if (reranking) signal?.removeEventListener('abort', cancel);
  }
}
