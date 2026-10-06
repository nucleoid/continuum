import type pg from 'pg';
import type { Principal, RecallInput, RecallResult } from '../types.js';
import { asEmbeddingRouter, type EmbeddingRouting } from '../embeddings/router.js';
import { recall, type RecallDiagnostics } from '../storage/recall.js';
import { recordRead as recordReadAudit } from '../audit/log.js';
import { resolveReadableScopeIds, type AccessibleScope } from './access.js';
import { asServiceError } from './errors.js';
import { parseScopeString } from './scopes.js';

export interface PrincipalRecallResult {
  results: RecallResult[];
  accessible: Map<string, AccessibleScope>;
  diagnostics: RecallDiagnostics & { localOnlyUnavailableScopes?: number };
}

export interface RecallLogger {
  error(message: string, error: unknown): void;
  info?(event: Record<string, unknown>): void;
}

export async function recallForPrincipal(
  pool: pg.Pool,
  embeddingRouting: EmbeddingRouting,
  principal: Principal,
  input: RecallInput,
  auditMetadata: Record<string, unknown> = {},
  logger?: RecallLogger,
): Promise<PrincipalRecallResult> {
  try {
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
    for (const scopeId of scopeIds) {
      const scope = accessible.get(scopeId);
      if (!scope) continue;
      const route = router.resolve({ kind: scope.kind, name: scope.name });
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
    const recalled = await recall(pool, {
      query: input.query,
      scopeIds,
      types: input.types,
      limit: input.limit ?? 10,
      embeddingGroups,
    });
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
    const results = recalled.results;

    // Recall auditing is required. Results are not returned if this write fails.
    await recordReadAudit(pool, {
      principalId: principal.id,
      query: input.query,
      metadata: {
        scopes: scopeIds.length,
        scope_ids: scopeIds,
        hits: results.length,
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
      memories: results.map((result, index) => ({
        memoryId: result.memory.id,
        scopeId: result.memory.scopeId,
        metadata: { rank: index + 1, score: result.score },
      })),
    });
    return { results, accessible, diagnostics };
  } catch (error) {
    throw asServiceError(error);
  }
}
