import { Router } from 'express';
import type { Request, Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import {
  acquireLease,
  inspectLease,
  releaseLease,
  renewLease,
} from '../../services/coordination.js';

const acquireSchema = z.object({
  scope: z.string(),
  resource: z.string(),
  runId: z.string(),
  requestId: z.string(),
  ttlSeconds: z.number().int().optional(),
}).strict();

const renewSchema = z.object({
  leaseId: z.string(),
  runId: z.string(),
  requestId: z.string(),
  ttlSeconds: z.number().int().optional(),
}).strict();

const releaseSchema = z.object({
  leaseId: z.string(),
  runId: z.string(),
  requestId: z.string(),
}).strict();

const inspectSchema = z.object({
  scope: z.string(),
  resource: z.string(),
}).strict();

function requestSignal(req: Request, res: Response): AbortSignal {
  const controller = new AbortController();
  req.once('aborted', () => controller.abort());
  res.once('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}

function invalidInput(): never {
  const error = new Error('Invalid coordination input') as Error & {
    type: string;
    status: number;
    expose: boolean;
  };
  error.type = 'entity.validation.failed';
  error.status = 400;
  error.expose = true;
  throw error;
}

export function locksRouter(pool: pg.Pool): Router {
  const router = Router();

  router.post('/locks/acquire', async (req, res) => {
    const parsed = acquireSchema.safeParse(req.body);
    if (!parsed.success) invalidInput();
    const result = await acquireLease(pool, req.principal!, parsed.data, {
      signal: requestSignal(req, res),
      transport: 'rest',
    });
    res.json(result);
  });

  router.post('/locks/renew', async (req, res) => {
    const parsed = renewSchema.safeParse(req.body);
    if (!parsed.success) invalidInput();
    const result = await renewLease(pool, req.principal!, parsed.data, {
      signal: requestSignal(req, res),
      transport: 'rest',
    });
    res.json(result);
  });

  router.post('/locks/release', async (req, res) => {
    const parsed = releaseSchema.safeParse(req.body);
    if (!parsed.success) invalidInput();
    const result = await releaseLease(pool, req.principal!, parsed.data, {
      signal: requestSignal(req, res),
      transport: 'rest',
    });
    res.json(result);
  });

  router.get('/locks', async (req, res) => {
    const parsed = inspectSchema.safeParse(req.query);
    if (!parsed.success) invalidInput();
    const result = await inspectLease(pool, req.principal!, parsed.data, {
      signal: requestSignal(req, res),
      transport: 'rest',
    });
    res.json(result);
  });

  return router;
}
