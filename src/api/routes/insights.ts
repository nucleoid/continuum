import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { EmbeddingProvider } from '../../embeddings/provider.js';
import type { GapConfig } from '../../insights/gaps.js';
import { getKnowledgeGaps } from '../../services/gaps.js';
import { ServiceError } from '../../services/errors.js';

const sincePattern = /^([1-9]\d{0,2})d$/;
const unitDecimalPattern = /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/;

export function insightsRouter(
  pool: pg.Pool,
  provider: EmbeddingProvider | null,
  config: GapConfig,
  now: () => Date = () => new Date(),
): Router {
  const router = Router();
  const schema = z.object({
    since: z.string().regex(sincePattern).default('30d')
      .transform((value) => Number(sincePattern.exec(value)![1]))
      .refine((value) => value <= 365, 'since must not exceed 365d'),
    limit: z.coerce.number().int().min(1).max(config.maxLimit).default(config.defaultLimit),
    minFrequency: z.coerce.number().int().min(1).max(config.candidateLimit)
      .default(config.defaultMinFrequency),
    threshold: z.string().regex(unitDecimalPattern).default(String(config.threshold))
      .transform(Number),
  }).strict();

  router.get('/insights/gaps', async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
    try {
      const parsed = schema.safeParse(req.query);
      if (!parsed.success) throw new ServiceError('INVALID_INPUT', 'Invalid gap insight query');
      const report = await getKnowledgeGaps(pool, provider, req.principal!, {
        sinceDays: parsed.data.since,
        limit: parsed.data.limit,
        minFrequency: parsed.data.minFrequency,
        threshold: parsed.data.threshold,
        candidateLimit: config.candidateLimit,
        scanLimit: config.scanLimit,
        maxQueryChars: config.maxQueryChars,
        embeddingTimeoutMs: config.embeddingTimeoutMs,
        now: now(),
        transport: 'rest',
      });
      res.json(report);
    } catch (error) {
      next(error);
    }
  });
  return router;
}
