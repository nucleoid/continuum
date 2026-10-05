import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { EmbeddingRouting } from '../../embeddings/router.js';
import { decisionHistoryForPrincipal, supersedeForPrincipal } from '../../services/supersede.js';

const supersedeSchema = z.object({
  supersededId: z.string().uuid(),
  title: z.string().min(1).max(500),
  body: z.string().min(1),
  tags: z.array(z.string()).optional(),
  source: z.string().min(1).optional(),
  sourceRef: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
const historyParams = z.object({ id: z.string().uuid() });

export function supersedeRouter(pool: pg.Pool, embeddingRouting: EmbeddingRouting): Router {
  const router = Router();
  router.post('/supersede', async (req, res) => {
    const parsed = supersedeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_INPUT', error: 'Invalid request' });
      return;
    }
    const result = await supersedeForPrincipal(
      pool, embeddingRouting, req.principal!, parsed.data, { transport: 'rest' },
    );
    res.status(201).json({
      supersededId: result.predecessor.id,
      successorId: result.successor.id,
      scopeId: result.successor.scopeId,
      predecessorState: result.predecessor.state,
      embedded: result.embedded,
      ...(result.embedErrorCode ? { embeddingErrorCode: result.embedErrorCode } : {}),
    });
  });
  router.get('/decisions/:id/history', async (req, res) => {
    const parsed = historyParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_INPUT', error: 'Invalid request' });
      return;
    }
    const result = await decisionHistoryForPrincipal(
      pool, req.principal!, parsed.data.id, { transport: 'rest' },
    );
    res.json({
      currentId: result.currentId,
      decisions: result.decisions.map((memory) => ({
        id: memory.id, title: memory.title, body: memory.body, tags: memory.tags,
        metadata: memory.metadata, authorId: memory.authorId, source: memory.source,
        sourceRef: memory.sourceRef, state: memory.state, supersedesId: memory.supersedesId,
        createdAt: memory.createdAt,
      })),
    });
  });
  return router;
}
