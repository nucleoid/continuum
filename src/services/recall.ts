import type pg from 'pg';
import type { Principal, RecallInput, RecallResult } from '../types.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { EmbeddingProviderUnavailableError, recall } from '../storage/recall.js';
import { record as recordAudit } from '../audit/log.js';
import { resolveReadableScopeIds, type AccessibleScope } from './access.js';
import { asServiceError, dependencyUnavailable } from './errors.js';
import { parseScopeString } from './scopes.js';

export interface PrincipalRecallResult {
  results: RecallResult[];
  accessible: Map<string, AccessibleScope>;
}

export async function recallForPrincipal(
  pool: pg.Pool,
  embeddingProvider: EmbeddingProvider | null,
  principal: Principal,
  input: RecallInput,
  auditMetadata: Record<string, unknown> = {},
): Promise<PrincipalRecallResult> {
  try {
    const refs = input.scopes?.map(parseScopeString);
    const { accessible, scopeIds } = await resolveReadableScopeIds(
      pool,
      principal.id,
      refs,
    );
    const results = await recall(pool, {
      query: input.query,
      scopeIds,
      types: input.types,
      limit: input.limit ?? 10,
      embeddingProvider,
    });

    // Recall auditing is required. Results are not returned if this write fails.
    await recordAudit(pool, {
      principalId: principal.id,
      action: 'read',
      query: input.query,
      metadata: {
        scopes: scopeIds.length,
        hits: results.length,
        embedded: Boolean(embeddingProvider),
        ...auditMetadata,
      },
    });
    return { results, accessible };
  } catch (error) {
    if (error instanceof EmbeddingProviderUnavailableError) {
      throw dependencyUnavailable(error.cause ?? error);
    }
    throw asServiceError(error);
  }
}
