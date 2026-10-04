import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { accessibleScopes, requireOrgAdmin } from '../../services/access.js';
import { promoteForPrincipal, verifyForPrincipal } from '../../services/lifecycle.js';
import { changeMembershipForPrincipal } from '../../services/memberships.js';
import { ServiceError } from '../../services/errors.js';
import { listAllScopes } from '../../storage/scopes.js';
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
const membershipSchema = z.object({
  role: z.enum(['reader', 'writer', 'admin']),
}).strict();

function invalid(): ServiceError {
  return new ServiceError('INVALID_INPUT', 'Invalid request');
}

export function cliSupportRouter(pool: pg.Pool): Router {
  const router = Router();

  router.get('/scopes', async (req, res, next) => {
    try {
      if (req.query.manage !== undefined && req.query.manage !== 'true') throw invalid();
      const readable = await accessibleScopes(pool, req.principal!.id);
      const source = req.query.manage === 'true'
        ? await (async () => {
          await requireOrgAdmin(pool, req.principal!.id);
          return Promise.all((await listAllScopes(pool)).map(async (scope) => ({
            ...scope,
            label: scope.kind === 'org' ? 'org' : `${scope.kind}:${scope.name}`,
            role: (await getMembership(pool, req.principal!.id, scope.id))?.role ?? null,
          })));
        })()
        : [...readable.values()];
      const scopes = source
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((scope) => ({
          id: scope.id,
          scope: scope.label,
          kind: scope.kind,
          name: scope.name,
          role: scope.kind === 'org' && scope.role === 'reader'
            ? 'implicit-reader'
            : scope.role,
        }));
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

  router.put('/scopes/:scopeId/members/:principalId', async (req, res, next) => {
    try {
      const scopeId = idSchema.safeParse(req.params.scopeId);
      const principalId = idSchema.safeParse(req.params.principalId);
      const body = membershipSchema.safeParse(req.body);
      if (!scopeId.success || !principalId.success || !body.success) throw invalid();
      const result = await changeMembershipForPrincipal(
        pool, req.principal!, scopeId.data, principalId.data, body.data.role,
      );
      res.json({ scopeId: scopeId.data, principalId: principalId.data, role: result.role });
    } catch (error) { next(error); }
  });

  router.delete('/scopes/:scopeId/members/:principalId', async (req, res, next) => {
    try {
      const scopeId = idSchema.safeParse(req.params.scopeId);
      const principalId = idSchema.safeParse(req.params.principalId);
      if (!scopeId.success || !principalId.success) throw invalid();
      const result = await changeMembershipForPrincipal(
        pool, req.principal!, scopeId.data, principalId.data, null,
      );
      res.json({ scopeId: scopeId.data, principalId: principalId.data, removed: result.removed });
    } catch (error) { next(error); }
  });

  return router;
}
