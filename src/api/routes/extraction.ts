import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { configureExtraction, extractionForPrincipal, retryExtraction } from '../../services/extraction.js';
import { ServiceError } from '../../services/errors.js';

export function extractionRouter(pool: pg.Pool): Router {
  const router = Router();
  const config = z.object({ profile: z.string(), sources: z.array(z.string()), enabled: z.boolean() }).strict();
  router.get('/memories/:id/extraction', async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const query = z.object({ assertions: z.enum(['true','false']).optional() }).strict().safeParse(req.query);
      if (!query.success) throw new ServiceError('INVALID_INPUT', 'Invalid extraction query');
      res.json(await extractionForPrincipal(pool, req.principal!, req.params.id as string, query.data.assertions === 'true'));
    } catch (error) { next(error); }
  });
  router.post('/memories/:id/extraction/retry', async (req, res, next) => {
    try {
      if (!z.object({}).strict().safeParse(req.body ?? {}).success) throw new ServiceError('INVALID_INPUT', 'Invalid extraction retry');
      res.json(await retryExtraction(pool, req.principal!, req.params.id as string));
    } catch (error) { next(error); }
  });
  router.put('/scopes/:id/extraction', async (req, res, next) => {
    try {
      const parsed = config.safeParse(req.body);
      if (!parsed.success) throw new ServiceError('INVALID_INPUT', 'Invalid extraction configuration');
      const { profile, sources, enabled } = parsed.data;
      res.json(await configureExtraction(pool, req.principal!, req.params.id as string, profile, sources, enabled));
    } catch (error) { next(error); }
  });
  return router;
}
