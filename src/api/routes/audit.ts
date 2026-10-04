import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { queryAudit } from '../../audit/query.js';
import { record as recordAudit } from '../../audit/log.js';
import { getScopeByRef } from '../../storage/scopes.js';
import { hasRole } from '../../storage/memberships.js';

const strictRfc3339Timestamp = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const auditTimestampSchema = z.string()
  .datetime({ offset: true })
  .regex(strictRfc3339Timestamp, 'timestamp must be strict RFC 3339 with an explicit timezone')
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    'timestamp must represent a valid instant',
  );

const auditQuerySchema = z.object({
  principalId: z.string().uuid().optional(),
  scopeId: z.string().uuid().optional(),
  memoryId: z.string().uuid().optional(),
  action: z.enum(['read', 'write', 'promote', 'archive', 'verify']).optional(),
  since: auditTimestampSchema.optional(),
  until: auditTimestampSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).superRefine((query, ctx) => {
  if (
    query.since !== undefined
    && query.until !== undefined
    && new Date(query.since).getTime() >= new Date(query.until).getTime()
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['until'],
      message: 'until must be later than since',
    });
  }
});

export function auditRouter(pool: pg.Pool): Router {
  const router = Router();

  router.get('/audit', async (req, res) => {
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', details: parsed.error.issues });
      return;
    }
    const principal = req.principal!;
    const f = parsed.data;

    const orgScope = await getScopeByRef(pool, { kind: 'org', name: '' });
    const isOrgAdmin = orgScope
      ? await hasRole(pool, principal.id, orgScope.id, 'admin')
      : false;

    if (!isOrgAdmin) {
      if (f.principalId !== undefined && f.principalId !== principal.id) {
        res.status(403).json({ error: 'principal can only query its own audit entries' });
        return;
      }
      f.principalId = principal.id;
    }

    const rows = await queryAudit(pool, {
      principalId: f.principalId,
      scopeId: f.scopeId,
      memoryId: f.memoryId,
      action: f.action,
      since: f.since ? new Date(f.since) : undefined,
      until: f.until ? new Date(f.until) : undefined,
      limit: f.limit,
      offset: f.offset,
    });

    await recordAudit(pool, {
      principalId: principal.id,
      action: 'read',
      metadata: {
        view: 'audit',
        filter: {
          principalId: f.principalId ?? null,
          scopeId: f.scopeId ?? null,
          memoryId: f.memoryId ?? null,
          action: f.action ?? null,
          since: f.since ?? null,
          until: f.until ?? null,
        },
        resultCount: rows.length,
        orgAdmin: isOrgAdmin,
      },
    });

    res.json({
      count: rows.length,
      orgAdmin: isOrgAdmin,
      entries: rows.map((r) => ({
        id: r.id,
        at: r.at,
        principalId: r.principalId,
        action: r.action,
        memoryId: r.memoryId,
        scopeId: r.scopeId,
        query: r.query,
        metadata: r.metadata,
      })),
    });
  });

  return router;
}
