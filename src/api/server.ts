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
import { isDirectEntrypoint } from './entrypoint.js';
import {
  asServiceError,
  logInternalServiceError,
  ServiceError,
  type ServiceLogger,
} from '../services/errors.js';

export interface AppOptions {
  embeddingProvider?: EmbeddingProvider | null;
  logger?: ServiceLogger;
}

export function createApp(pool: pg.Pool, opts: AppOptions = {}): express.Express {
  const app = express();
  const logger = opts.logger ?? console;
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

  app.use(((error, _req, res, _next) => {
    const serviceError = mapRestError(error);
    logInternalServiceError(logger, 'REST', serviceError);
    res.status(serviceError.status).json({
      code: serviceError.code,
      error: serviceError.publicMessage,
    });
  }) as express.ErrorRequestHandler);

  return app;
}

export function mapRestError(error: unknown): ServiceError {
  const bodyError = error as {
    type?: string;
    status?: number;
    expose?: boolean;
    message?: string;
  };
  if (bodyError.type === 'entity.parse.failed') {
    return new ServiceError('INVALID_INPUT', 'Malformed JSON request body');
  }
  if (bodyError.type === 'entity.too.large' || bodyError.status === 413) {
    return new ServiceError('PAYLOAD_TOO_LARGE', 'Request body exceeds the 1 MB limit');
  }
  if (bodyError.expose === true
    && bodyError.status !== undefined
    && bodyError.status >= 400
    && bodyError.status < 500) {
    return new ServiceError(
      'INVALID_INPUT',
      bodyError.message ?? 'Invalid request',
      { status: bodyError.status },
    );
  }
  return asServiceError(error);
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

if (isDirectEntrypoint(import.meta.url)) {
  main();
}
