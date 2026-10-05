import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { accessibleScopes } from '../../services/access.js';
import { promoteForPrincipal, verifyForPrincipal } from '../../services/lifecycle.js';
import { ServiceError } from '../../services/errors.js';
import { getMembership } from '../../storage/memberships.js';

const idSchema = z.string().uuid();
const promoteSchema = z.object({
  targetScope: z.object({
    kind: z.enum(['org', 'team', 'project', 'user', 'role']),
    name: z.string(),
  }).strict(),
}).strict();
const verifySchema = z.object({
  stillTrue: z.boolean(),
  note: z.string().optional(),
}).strict();

function invalid(): ServiceError {
  return new ServiceError('INVALID_INPUT', 'Invalid request');
}

export function cliSupportRouter(pool: pg.Pool): Router {
  const router = Router();

  router.get('/scopes', async (req, res, next) => {
    try {
      if (Object.keys(req.query).length > 0) throw invalid();
      const readable = await accessibleScopes(pool, req.principal!.id);
      const source = [...readable.values()].sort((a, b) => a.label.localeCompare(b.label));
      const scopes = await Promise.all(source.map(async (scope) => ({
        id: scope.id,
        scope: scope.label,
        kind: scope.kind,
        name: scope.name,
        role: scope.kind === 'org' && scope.role === 'reader'
          && !await getMembership(pool, req.principal!.id, scope.id)
          ? 'implicit-reader'
          : scope.role,
      })));
      res.json({ scopes });
    } catch (error) { next(error); }
  });

  router.post('/memories/:memoryId/promote', async (req, res, next) => {
    try {
      const memoryId = idSchema.safeParse(req.params.memoryId);
      const body = promoteSchema.safeParse(req.body);
      if (!memoryId.success || !body.success) throw invalid();
      const { source, destination } = await promoteForPrincipal(
        pool, req.principal!, memoryId.data, body.data.targetScope, { transport: 'rest' },
      );
      res.status(201).json({
        sourceId: source.id,
        destinationId: destination.id,
        destinationScopeId: destination.scopeId,
      });
    } catch (error) { next(error); }
  });

  router.post('/memories/:memoryId/verify', async (req, res, next) => {
    try {
      const memoryId = idSchema.safeParse(req.params.memoryId);
      const body = verifySchema.safeParse(req.body);
      if (!memoryId.success || !body.success) throw invalid();
      const memory = await verifyForPrincipal(
        pool, req.principal!, memoryId.data, body.data.stillTrue, body.data.note,
        { transport: 'rest' },
      );
      res.json({ id: memory.id, state: memory.state, lastVerified: memory.lastVerified });
    } catch (error) { next(error); }
  });

  return router;
}
