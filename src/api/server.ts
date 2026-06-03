import express from 'express';
import type pg from 'pg';
import { getPool } from '../storage/pool.js';
import { bearerAuth } from './auth.js';
import { captureRouter } from './routes/capture.js';
import { recallRouter } from './routes/recall.js';
import { agentsMdRouter } from './routes/agents-md.js';
import { auditRouter } from './routes/audit.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { makeEmbeddingProviderFromEnv } from '../embeddings/factory.js';

export interface AppOptions {
  embeddingProvider?: EmbeddingProvider | null;
}

export function createApp(pool: pg.Pool, opts: AppOptions = {}): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  const provider = opts.embeddingProvider ?? null;
  const v0 = express.Router();
  v0.use(bearerAuth(pool));
  v0.use(captureRouter(pool, provider));
  v0.use(recallRouter(pool, provider));
  v0.use(agentsMdRouter(pool));
  v0.use(auditRouter(pool));

  app.use('/api/v0', v0);

  return app;
}

function main(): void {
  const port = Number(process.env.CONTINUUM_API_PORT ?? 4000);
  const app = createApp(getPool(), {
    embeddingProvider: makeEmbeddingProviderFromEnv(),
  });
  app.listen(port, () => {
    console.log(`Continuum API listening on :${port}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
