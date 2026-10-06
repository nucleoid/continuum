import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { standupForPrincipal } from '../../services/standup.js';
import { ServiceError } from '../../services/errors.js';

const sincePattern = /^([1-9]\d{0,2})h$/;
const querySchema = z.object({
  since: z.string().regex(sincePattern).optional()
    .transform((value) => value === undefined ? undefined : Number(sincePattern.exec(value)![1])),
  date: z.string().optional(),
  timezone: z.string().optional(),
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().optional(),
  openThreadDays: z.coerce.number().int().optional(),
  openThreadLimit: z.coerce.number().int().optional(),
}).strict();

export function standupRouter(
  pool: pg.Pool,
  now: () => Date = () => new Date(),
  enabled = true,
): Router {
  const router = Router();
  router.get('/standup', async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
    try {
      if (!enabled) {
        throw new ServiceError(
          'DEPENDENCY_UNAVAILABLE',
          'Standup reads are disabled until trusted activity writers are active',
        );
      }
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) throw new ServiceError('INVALID_INPUT', 'Invalid standup query');
      const result = await standupForPrincipal(pool, req.principal!, {
        sinceHours: parsed.data.since,
        date: parsed.data.date,
        timezone: parsed.data.timezone,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        openThreadDays: parsed.data.openThreadDays,
        openThreadLimit: parsed.data.openThreadLimit,
      }, { now: now(), transport: 'rest' });
      const item = (memory: (typeof result.activity)[number]) => ({
        id: memory.id,
        scope: memory.scope,
        type: memory.type,
        title: memory.title,
        source: memory.source,
        sourceRef: memory.sourceRef,
        threadKey: memory.threadKey,
        actor: memory.actor,
        createdAt: memory.createdAt,
      });
      res.json({
        window: result.window,
        activity: result.activity.map(item),
        openThreads: result.openThreads.map(item),
        page: result.page,
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
