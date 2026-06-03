import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { getScopeByRef } from '../../storage/scopes.js';
import { createMemory } from '../../storage/memories.js';
import { hasRole } from '../../storage/memberships.js';
import { record as recordAudit } from '../../audit/log.js';

const captureSchema = z.object({
  scope: z.object({
    kind: z.enum(['org', 'team', 'project', 'user', 'role']),
    name: z.string(),
  }),
  type: z.enum(['fact', 'decision', 'context', 'playbook', 'relationship']),
  title: z.string().min(1).max(500),
  body: z.string().min(1),
  tags: z.array(z.string()).optional(),
  source: z.string().min(1),
  sourceRef: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export function captureRouter(pool: pg.Pool): Router {
  const router = Router();

  router.post('/capture', async (req, res) => {
    const parsed = captureSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', details: parsed.error.issues });
      return;
    }
    const principal = req.principal!;
    const { scope: scopeRef, type, title, body, tags, source, sourceRef, metadata } = parsed.data;

    if (scopeRef.kind === 'org' && scopeRef.name !== '') {
      res.status(400).json({ error: 'org scope cannot have a name' });
      return;
    }
    if (scopeRef.kind !== 'org' && scopeRef.name === '') {
      res.status(400).json({ error: `scope ${scopeRef.kind} requires a name` });
      return;
    }

    const scope = await getScopeByRef(pool, scopeRef);
    if (!scope) {
      res.status(404).json({ error: 'scope not found' });
      return;
    }

    if (!(await hasRole(pool, principal.id, scope.id, 'writer'))) {
      res.status(403).json({ error: 'principal lacks writer role on scope' });
      return;
    }

    const memory = await createMemory(pool, {
      scopeId: scope.id,
      scopeKind: scope.kind,
      type,
      title,
      body,
      authorId: principal.id,
      source,
      sourceRef: sourceRef ?? null,
      tags,
      metadata,
    });

    await recordAudit(pool, {
      principalId: principal.id,
      action: 'write',
      memoryId: memory.id,
      scopeId: scope.id,
      metadata: { source, type },
    });

    res.status(201).json({
      id: memory.id,
      scopeId: memory.scopeId,
      expiresAt: memory.expiresAt,
    });
  });

  return router;
}
