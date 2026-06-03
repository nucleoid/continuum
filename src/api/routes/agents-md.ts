import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { renderAgentsMd } from '../../agents-md/render.js';
import { record as recordAudit } from '../../audit/log.js';

const querySchema = z.object({
  project: z.string().optional(),
  team: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export function agentsMdRouter(pool: pg.Pool): Router {
  const router = Router();

  router.get('/agents-md', async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', details: parsed.error.issues });
      return;
    }
    const principal = req.principal!;
    const markdown = await renderAgentsMd(pool, {
      principalId: principal.id,
      project: parsed.data.project,
      team: parsed.data.team,
      perScopeLimit: parsed.data.limit,
    });
    await recordAudit(pool, {
      principalId: principal.id,
      action: 'read',
      metadata: {
        view: 'agents-md',
        project: parsed.data.project ?? null,
        team: parsed.data.team ?? null,
      },
    });
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.send(markdown);
  });

  return router;
}
