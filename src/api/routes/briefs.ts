import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { briefForPrincipal, briefHistoryForPrincipal, configureBrief, refreshBrief } from '../../services/briefs.js';
import { ServiceError } from '../../services/errors.js';

export function briefsRouter(pool: pg.Pool): Router {
  const router=Router();
  const wire = (value: Record<string, unknown>, budget: import('../../pipeline/budget.js').Budget) => { budget.serializeOutput(value); };
  router.use(['/briefs','/scopes/:id/brief'],(_req,res,next) => { res.setHeader('Cache-Control','private, no-store'); res.vary('Authorization'); next(); });
  router.get('/briefs',async (req,res,next) => {
    try {
      const input=z.object({ project: z.string().min(1).max(500) }).strict().safeParse(req.query);
      if (!input.success) throw new ServiceError('INVALID_INPUT','Invalid brief query');
      res.json(await briefForPrincipal(pool,req.principal!,input.data.project,{ validateResult: wire }));
    } catch(error) { next(error); }
  });
  router.post('/briefs/refresh',async (req,res,next) => {
    try { res.json(await refreshBrief(pool,req.principal!,req.body,{ validateResult: wire })); } catch(error) { next(error); }
  });
  router.get('/briefs/:id/versions',async (req,res,next) => {
    try {
      const input=z.object({ cursor: z.string().uuid().optional(),limit: z.coerce.number().int().min(1).max(10).optional() }).strict().safeParse(req.query);
      if (!input.success) throw new ServiceError('INVALID_INPUT','Invalid brief history query');
      res.json(await briefHistoryForPrincipal(pool,req.principal!,req.params.id as string,input.data,{ validateResult: wire }));
    } catch(error) { next(error); }
  });
  router.put('/scopes/:id/brief',async (req,res,next) => {
    try {
      const input=z.object({ profile: z.string().max(64),enabled: z.boolean() }).strict().safeParse(req.body);
      if (!input.success) throw new ServiceError('INVALID_INPUT','Invalid brief configuration');
      res.json(await configureBrief(pool,req.principal!,req.params.id as string,input.data.profile,input.data.enabled,{ validateResult: wire }));
    } catch(error) { next(error); }
  });
  return router;
}
