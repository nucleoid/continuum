import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { EmbeddingRouting } from '../../embeddings/router.js';
import { recallForPrincipal } from '../../services/recall.js';
import type { OperationalLogger } from '../server.js';

const recallSchema = z.object({
  query: z.string().min(1).max(2000),
  scopes: z.array(z.string()).optional(),
  types: z
    .array(z.enum(['fact', 'decision', 'context', 'playbook', 'relationship']))
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export function recallRouter(
  pool: pg.Pool,
  embeddingProvider: EmbeddingRouting = null,
  logger?: OperationalLogger,
): Router {
  const router = Router();

  router.post('/recall', async (req, res) => {
    const parsed = recallSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_INPUT', error: 'Invalid request' });
      return;
    }
    const { results, accessible, diagnostics } = await recallForPrincipal(
      pool,
      embeddingProvider,
      req.principal!,
      parsed.data,
      { transport: 'rest' },
      logger,
    );
    res.json({
      results: results.map((r) => ({
        id: r.memory.id,
        score: r.score,
        scope: accessible.get(r.memory.scopeId)?.label ?? null,
        type: r.memory.type,
        title: r.memory.title,
        excerpt: r.excerpt,
        bodyTruncated: r.bodyTruncated,
        sourceRef: r.memory.sourceRef,
        ...(r.memory.supersedesId ? { supersedesId: r.memory.supersedesId } : {}),
        createdAt: r.memory.createdAt,
      })),
      diagnostics,
    });
  });

  return router;
}
