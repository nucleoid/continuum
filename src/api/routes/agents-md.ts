import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { renderAgentsMdForPrincipal } from '../../services/agents-md.js';

const querySchema = z.object({
  project: z.string().optional(),
  team: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export function agentsMdRouter(pool: pg.Pool): Router {
  const router = Router();

  router.get('/agents-md', async (req, res, next) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_INPUT', error: 'Invalid query' });
      return;
    }
    try {
      const markdown = await renderAgentsMdForPrincipal(
        pool,
        req.principal!,
        parsed.data,
      );
      res.set('Content-Type', 'text/markdown; charset=utf-8');
      res.send(markdown);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
