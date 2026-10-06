import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { mapOwnedUserScope, offboardPrincipal } from '../../services/offboarding.js';
import { ServiceError } from '../../services/errors.js';

const uuid = z.string().uuid();
const mappingBody = z.object({
  scopeId: uuid,
  allowOtherActiveMembers: z.boolean().optional(),
}).strict();
const offboardBody = z.object({
  dryRun: z.boolean().optional(),
  confirmScopeId: uuid.optional(),
  batchSize: z.number().int().min(1).max(5_000).optional(),
}).strict();
const invalid = () => new ServiceError('INVALID_INPUT', 'Invalid request');
const requireInteractiveAdminCredential = (credential: string | undefined) => {
  if (credential === 'api-key') {
    throw new ServiceError('FORBIDDEN', 'API-key credentials cannot administer offboarding');
  }
};

export function offboardingRouter(pool: pg.Pool): Router {
  const router = Router();
  router.put('/admin/principals/:principalId/owned-user-scope', async (req, res, next) => {
    try {
      requireInteractiveAdminCredential(req.authContext?.credential);
      const principalId = uuid.safeParse(req.params.principalId);
      const body = mappingBody.safeParse(req.body);
      if (!principalId.success || !body.success) throw invalid();
      const result = await mapOwnedUserScope(
        pool, req.principal!, principalId.data, body.data.scopeId,
        body.data.allowOtherActiveMembers ?? false,
      );
      res.status(result.created ? 201 : 200).json(result);
    } catch (error) { next(error); }
  });
  router.post('/admin/principals/:principalId/offboard', async (req, res, next) => {
    try {
      requireInteractiveAdminCredential(req.authContext?.credential);
      const principalId = uuid.safeParse(req.params.principalId);
      const body = offboardBody.safeParse(req.body);
      if (!principalId.success || !body.success) throw invalid();
      const dryRun = body.data.dryRun ?? true;
      if (!dryRun && body.data.confirmScopeId === undefined) {
        throw new ServiceError(
          'INVALID_INPUT', 'confirmScopeId is required when dryRun is false',
        );
      }
      res.json(await offboardPrincipal(pool, req.principal!, principalId.data, {
        dryRun, confirmationScopeId: body.data.confirmScopeId,
        batchSize: body.data.batchSize,
      }));
    } catch (error) { next(error); }
  });
  return router;
}
