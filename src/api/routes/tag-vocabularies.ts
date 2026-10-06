import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { ScopeKind, TagVocabulary } from '../../types.js';
import {
  addTagVocabulary,
  changeTagVocabulary,
  listTagVocabulary,
  removeTagVocabulary,
} from '../../services/tag-vocabularies.js';

const scopeKindSchema = z.enum(['org', 'team', 'project', 'user', 'role']);
const listSchema = z.object({ scopeKind: scopeKindSchema }).strict();
const createSchema = z.object({
  scopeKind: scopeKindSchema,
  tag: z.string(),
  description: z.string().optional(),
}).strict();
const updateSchema = z.object({ description: z.string() }).strict();

function responseEntry(entry: TagVocabulary) {
  return {
    scopeKind: entry.scopeKind,
    tag: entry.tag,
    description: entry.description,
    isSystem: entry.isSystem,
    createdBy: entry.createdBy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export function tagVocabulariesRouter(pool: pg.Pool): Router {
  const router = Router();

  router.get('/tag-vocabularies', async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_INPUT', error: 'Invalid request' });
      return;
    }
    const entries = await listTagVocabulary(pool, parsed.data.scopeKind);
    res.json({ scopeKind: parsed.data.scopeKind, entries: entries.map(responseEntry) });
  });

  router.post('/tag-vocabularies', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_INPUT', error: 'Invalid request' });
      return;
    }
    const entry = await addTagVocabulary(pool, req.principal!, parsed.data);
    res.status(201).json(responseEntry(entry));
  });

  router.patch('/tag-vocabularies/:scopeKind/:tag', async (req, res) => {
    const scopeKind = scopeKindSchema.safeParse(req.params.scopeKind);
    const body = updateSchema.safeParse(req.body);
    if (!scopeKind.success || !body.success) {
      res.status(400).json({ code: 'INVALID_INPUT', error: 'Invalid request' });
      return;
    }
    const entry = await changeTagVocabulary(pool, req.principal!, {
      scopeKind: scopeKind.data,
      tag: req.params.tag,
      description: body.data.description,
    });
    res.json(responseEntry(entry));
  });

  router.delete('/tag-vocabularies/:scopeKind/:tag', async (req, res) => {
    const scopeKind = scopeKindSchema.safeParse(req.params.scopeKind);
    if (!scopeKind.success) {
      res.status(400).json({ code: 'INVALID_INPUT', error: 'Invalid request' });
      return;
    }
    await removeTagVocabulary(pool, req.principal!, {
      scopeKind: scopeKind.data as ScopeKind,
      tag: req.params.tag,
    });
    res.status(204).end();
  });

  return router;
}
