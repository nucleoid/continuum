import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { parseScopeString } from '../../scopes/model.js';
import { getScopeByRef } from '../../storage/scopes.js';
import { getScopesForPrincipal } from '../../storage/memberships.js';
import { recall } from '../../storage/recall.js';
import { record as recordAudit } from '../../audit/log.js';
import type { EmbeddingProvider } from '../../embeddings/provider.js';

const recallSchema = z.object({
  query: z.string().min(1).max(2000),
  scopes: z.array(z.string()).optional(),
  types: z
    .array(z.enum(['fact', 'decision', 'context', 'playbook', 'relationship']))
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export function recallRouter(
  pool: pg.Pool,
  embeddingProvider: EmbeddingProvider | null = null,
): Router {
  const router = Router();

  router.post('/recall', async (req, res) => {
    const parsed = recallSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', details: parsed.error.issues });
      return;
    }
    const principal = req.principal!;
    const { query, scopes: scopeStrings, types, limit } = parsed.data;

    const memberships = await getScopesForPrincipal(pool, principal.id);
    const accessible = new Map<string, string>(memberships.map((s) => [s.id, `${s.kind}:${s.name}`]));
    const orgScope = await getScopeByRef(pool, { kind: 'org', name: '' });
    if (orgScope) accessible.set(orgScope.id, 'org');

    let scopeIds: string[];
    if (scopeStrings && scopeStrings.length > 0) {
      const ids: string[] = [];
      for (const s of scopeStrings) {
        let ref;
        try {
          ref = parseScopeString(s);
        } catch {
          res.status(400).json({ error: `invalid scope string: ${s}` });
          return;
        }
        const scope = await getScopeByRef(pool, ref);
        if (!scope) continue;
        if (!accessible.has(scope.id)) continue;
        ids.push(scope.id);
      }
      scopeIds = ids;
    } else {
      scopeIds = Array.from(accessible.keys());
    }

    const results = await recall(pool, {
      query,
      scopeIds,
      types,
      limit: limit ?? 10,
      embeddingProvider,
    });

    await recordAudit(pool, {
      principalId: principal.id,
      action: 'read',
      query,
      metadata: {
        scopes: scopeIds.length,
        hits: results.length,
        embedded: Boolean(embeddingProvider),
      },
    });

    res.json({
      results: results.map((r) => ({
        id: r.memory.id,
        score: r.score,
        scope: accessible.get(r.memory.scopeId) ?? null,
        type: r.memory.type,
        title: r.memory.title,
        excerpt: r.excerpt,
        sourceRef: r.memory.sourceRef,
        createdAt: r.memory.createdAt,
      })),
    });
  });

  return router;
}
