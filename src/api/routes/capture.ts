import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { EmbeddingProvider } from '../../embeddings/provider.js';
import { captureMemory } from '../../services/capture.js';

const captureSchema = z.object({
  scope: z.object({
    kind: z.enum(['org', 'team', 'project', 'user', 'role']),
    name: z.string(),
  }),
  type: z.enum(['fact', 'decision', 'context', 'playbook', 'relationship']),
  title: z.string().min(1).max(500),
  body: z.string().min(1),
  tags: z.array(z.string()).optional(),
  source: z.string().min(1),
  sourceRef: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export function captureRouter(
  pool: pg.Pool,
  embeddingProvider: EmbeddingProvider | null = null,
): Router {
  const router = Router();

  router.post('/capture', async (req, res, next) => {
    const parsed = captureSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_INPUT', error: 'Invalid request' });
      return;
    }
    const principal = req.principal!;
    try {
      const result = await captureMemory(pool, embeddingProvider, principal, parsed.data);
      res.status(201).json({
        id: result.memory.id,
        scopeId: result.memory.scopeId,
        expiresAt: result.memory.expiresAt,
        embedded: result.embedded,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
