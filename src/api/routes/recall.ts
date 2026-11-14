import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { EmbeddingRouting } from '../../embeddings/router.js';
import type { OperationalLogger } from '../server.js';
import { recallForPrincipal, type RecallEnrichment, type PrincipalRecallResult } from '../../services/recall.js';
import type { Reranking } from '../../reranking/provider.js';
import { Budget } from '../../pipeline/budget.js';
import { RetrievalEnricherRegistry, enrichmentConfigFromEnv } from '../../extensions/retrieval.js';

const recallSchema = z.object({
  query: z.string().min(1).max(2000),
  scopes: z.array(z.string()).optional(),
  types: z
    .array(z.enum(['fact', 'decision', 'context', 'playbook', 'relationship']))
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

function projection({ results, accessible, diagnostics }: PrincipalRecallResult) {
  return { results: results.map((r) => ({
    id: r.memory.id, score: r.score,
    ...(r.rerankScore === undefined ? {} : { rerankScore: r.rerankScore }),
    scope: accessible.get(r.memory.scopeId)?.label ?? null, type: r.memory.type,
    title: r.memory.title, excerpt: r.excerpt, bodyTruncated: r.bodyTruncated, sourceRef: r.memory.sourceRef,
    ...(r.memory.supersedesId ? { supersedesId: r.memory.supersedesId } : {}), createdAt: r.memory.createdAt,
    ...(r.enrichments ? { enrichments: r.enrichments } : {}),
  })), diagnostics };
}

export function recallRouter(
  pool: pg.Pool,
  embeddingProvider: EmbeddingRouting = null,
  logger?: OperationalLogger,
  enrichment?: RecallEnrichment,
  reranking?: Reranking,
): Router {
  const router = Router();

  router.post('/recall', async (req, res) => {
    const parsed = recallSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_INPUT', error: 'Invalid request' });
      return;
    }
    const budget = reranking ? new Budget(reranking.profile) : undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!res.writableEnded) abort(); };
    if (reranking) { req.once('aborted', abort); res.once('close', close); }
    try {
      const result = await recallForPrincipal(
        pool,
        embeddingProvider,
        req.principal!,
        parsed.data,
        { transport: 'rest' },
        logger,
        reranking ? {
          ...enrichment,
          registry: enrichment?.registry ?? new RetrievalEnricherRegistry(),
          options: { ...(enrichment?.options ?? enrichmentConfigFromEnv()), signal: enrichment?.options.signal
            ? AbortSignal.any([controller.signal, enrichment.options.signal]) : controller.signal },
          validateResult: value => { enrichment?.validateResult?.(value); budget!.serializeOutput(projection(value)); },
        } : enrichment,
        budget,
        reranking,
      );
      res.json(projection(result));
    } finally { if (reranking) { req.removeListener('aborted', abort); res.removeListener('close', close); } }
  });

  return router;
}
