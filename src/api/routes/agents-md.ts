import { Router } from 'express';
import type { Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import {
  auditAgentsMdRead,
  prepareAgentsMdForPrincipal,
} from '../../services/agents-md.js';

const querySchema = z.object({
  project: z.string().max(500).optional(),
  team: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const freshnessQuerySchema = querySchema.extend({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});

const ENTITY_TAG = /^(?:W\/)?"([0-9a-f]{64})"$/;

export function matchesIfNoneMatch(value: string | undefined, hash: string): boolean {
  if (value === undefined) return false;
  const trimmedValue = value.trim();
  if (trimmedValue === '*') return true;
  return trimmedValue.split(',').some((candidate) => {
    const trimmed = candidate.trim();
    return ENTITY_TAG.exec(trimmed)?.[1] === hash;
  });
}

function setPrivateBundleHeaders(res: Response, etag: string): void {
  res.set('ETag', etag);
  res.set('Cache-Control', 'private, no-cache');
  res.vary('Authorization');
}

export function agentsMdRouter(pool: pg.Pool): Router {
  const router = Router();

  router.get('/agents-md/freshness', async (req, res) => {
    const parsed = freshnessQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_INPUT', error: 'Invalid query' });
      return;
    }
    const { hash, ...input } = parsed.data;
    const bundle = await prepareAgentsMdForPrincipal(pool, req.principal!, input);
    const fresh = bundle.hash === hash;
    await auditAgentsMdRead(pool, req.principal!, input, bundle, false, {
      transport: 'rest',
      view: 'agents-md-freshness',
      fresh,
    });
    res.set('Cache-Control', 'private, no-store');
    res.vary('Authorization');
    res.json({ fresh });
  });

  router.get('/agents-md', async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_INPUT', error: 'Invalid query' });
      return;
    }
    const bundle = await prepareAgentsMdForPrincipal(pool, req.principal!, parsed.data);
    const notModified = matchesIfNoneMatch(req.header('if-none-match'), bundle.hash);
    await auditAgentsMdRead(pool, req.principal!, parsed.data, bundle, !notModified, {
      transport: 'rest',
      not_modified: notModified,
    });
    setPrivateBundleHeaders(res, bundle.etag);
    if (notModified) {
      res.status(304).end();
      return;
    }
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.send(bundle.markdown);
  });

  return router;
}
