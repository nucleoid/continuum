import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { reviewQueueForPrincipal } from '../../services/review-queue.js';

const memoryTypes = ['fact', 'decision', 'context', 'playbook', 'relationship'] as const;
const repeatedString = z.union([z.string(), z.array(z.string())])
  .transform((value) => Array.isArray(value) ? value : [value]);

const reviewQueueQuery = z.object({
  scope: repeatedString.optional(),
  type: z.union([z.enum(memoryTypes), z.array(z.enum(memoryTypes))])
    .transform((value) => Array.isArray(value) ? value : [value])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
  horizonDays: z.coerce.number().int().min(0).max(365).optional(),
}).strict();

export function reviewQueueRouter(pool: pg.Pool, defaultHorizonDays = 14): Router {
  const router = Router();
  router.get('/review-queue', async (req, res) => {
    const parsed = reviewQueueQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_INPUT', error: 'Invalid query' });
      return;
    }
    const result = await reviewQueueForPrincipal(pool, req.principal!, {
      scopes: parsed.data.scope,
      types: parsed.data.type,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      horizonDays: parsed.data.horizonDays,
    }, { defaultHorizonDays, auditMetadata: { transport: 'rest' } });
    res.json({
      items: result.items.map((item) => ({
        id: item.id,
        scope: item.scope,
        type: item.type,
        title: item.title,
        state: item.state,
        reason: item.reason,
        due: item.due,
        lastVerified: item.lastVerified,
        author: item.author,
        canVerify: item.canVerify,
      })),
      limit: result.limit,
      offset: result.offset,
      horizonDays: result.horizonDays,
    });
  });
  return router;
}
