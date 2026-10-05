import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import {
  getMemoryForPrincipal,
  listMemoriesForPrincipal,
} from '../../services/memories.js';
import type { MemoryReadRecord } from '../../storage/memory-reads.js';

const memoryTypes = ['fact', 'decision', 'context', 'playbook', 'relationship'] as const;
const memoryStates = ['live', 'stale', 'archived', 'promoted'] as const;

const memoryListQuery = z.object({
  scope: z.string().optional(),
  type: z.enum(memoryTypes).optional(),
  state: z.enum(memoryStates).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
}).strict();

export function restMemory(record: MemoryReadRecord) {
  const { memory } = record;
  return {
    id: memory.id,
    scope: record.scope,
    type: memory.type,
    title: memory.title,
    body: memory.body,
    metadata: memory.metadata,
    tags: memory.tags,
    state: memory.state,
    expiresAt: memory.expiresAt,
    supersedesId: memory.supersedesId,
    promotedToId: memory.promotedToId,
    authorId: memory.authorId,
    authorDisplayName: record.authorDisplayName,
    source: memory.source,
    sourceRef: memory.sourceRef,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    lastVerified: memory.lastVerified,
  };
}

export function memoriesRouter(pool: pg.Pool): Router {
  const router = Router();

  router.get('/memories', async (req, res) => {
    const parsed = memoryListQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_INPUT', error: 'Invalid query' });
      return;
    }
    const result = await listMemoriesForPrincipal(
      pool,
      req.principal!,
      parsed.data,
      { transport: 'rest' },
    );
    res.json({
      items: result.items.map(restMemory),
      limit: result.limit,
      offset: result.offset,
    });
  });

  router.get('/memories/:id', async (req, res) => {
    const result = await getMemoryForPrincipal(
      pool,
      req.principal!,
      req.params.id,
      { transport: 'rest' },
    );
    res.json(restMemory(result));
  });

  return router;
}
