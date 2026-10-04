import { randomUUID } from 'node:crypto';
import express from 'express';
import type pg from 'pg';
import { getPool, closePool } from '../storage/pool.js';
import { bearerAuth } from './auth.js';
import { captureRouter } from './routes/capture.js';
import { recallRouter } from './routes/recall.js';
import { agentsMdRouter } from './routes/agents-md.js';
import { auditRouter } from './routes/audit.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { makeEmbeddingProviderFromEnv } from '../embeddings/factory.js';
import { isDirectEntrypoint } from './entrypoint.js';
import { assertEmbeddingProviderDimension } from '../storage/schema.js';
import { asServiceError, ServiceError, type ServiceLogger } from '../services/errors.js';
import { startRuntime } from './runtime.js';
import { createReadinessState, type ReadinessState } from './readiness.js';

export { createReadinessState } from './readiness.js';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
  }
}

export interface CompletionLog {
  event: 'http_request_complete';
  timestamp: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  principalId?: string;
}

export interface OperationalLogger extends ServiceLogger {
  info?(event: CompletionLog): void;
}

export interface AppOptions {
  embeddingProvider?: EmbeddingProvider | null;
  logger?: OperationalLogger;
  requestIdFactory?: () => string;
  clock?: () => number;
  readiness?: ReadinessState;
  readinessTimeoutMs?: number;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const KNOWN_LOG_PATHS = new Set([
  '/health', '/health/live', '/health/ready',
  '/api/v0/capture', '/api/v0/recall', '/api/v0/agents-md', '/api/v0/audit',
]);

const defaultLogger: OperationalLogger = {
  info(event) {
    console.info(JSON.stringify(event));
  },
  error(message, detail) {
    console.error(JSON.stringify({ message, detail }));
  },
};

function safeLogPath(req: express.Request): string {
  const pathname = req.originalUrl.split('?', 1)[0];
  if (KNOWN_LOG_PATHS.has(pathname)) return pathname;
  const routePath = req.route?.path;
  if (typeof routePath === 'string') return routePath.slice(0, 128);
  if (pathname.startsWith('/api/v0/')) return '/api/v0/:unmatched';
  if (pathname.startsWith('/api/')) return '/api/:unmatched';
  return '/:unmatched';
}

function embeddingStatus(provider: EmbeddingProvider | null): {
  configured: boolean;
  provider: string | null;
} {
  if (!provider) return { configured: false, provider: null };
  return {
    configured: true,
    provider: SAFE_PROVIDER_ID.test(provider.id) ? provider.id : 'configured',
  };
}

async function queryWithTimeout(pool: pg.Pool, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('readiness timeout')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requestContext(
  logger: OperationalLogger,
  requestIdFactory: () => string,
  clock: () => number,
): express.RequestHandler {
  return (req, res, next) => {
    const inbound = req.header('x-request-id');
    if (inbound && REQUEST_ID_PATTERN.test(inbound)) {
      req.requestId = inbound;
    } else {
      const generated = requestIdFactory();
      req.requestId = REQUEST_ID_PATTERN.test(generated) ? generated : randomUUID();
    }
    res.setHeader('X-Request-Id', req.requestId);

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (
        res.statusCode >= 400
        && body !== null
        && typeof body === 'object'
        && !Array.isArray(body)
        && !Object.hasOwn(body, 'requestId')
      ) {
        return originalJson({ ...body, requestId: req.requestId });
      }
      return originalJson(body);
    }) as express.Response['json'];

    const startedAt = clock();
    let logged = false;
    const complete = () => {
      if (logged) return;
      logged = true;
      const event: CompletionLog = {
        event: 'http_request_complete',
        timestamp: new Date(startedAt).toISOString(),
        requestId: req.requestId,
        method: req.method,
        path: safeLogPath(req),
        status: res.statusCode,
        durationMs: Math.max(0, Math.round(clock() - startedAt)),
      };
      if (req.principal?.id) event.principalId = req.principal.id;
      logger.info?.(event);
    };
    res.once('finish', complete);
    res.once('close', complete);
    next();
  };
}

export function errorMiddleware(logger: OperationalLogger): express.ErrorRequestHandler {
  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const serviceError = mapRestError(error);
    if (serviceError.code === 'INTERNAL') {
      logger.error('REST: internal service error', {
        code: serviceError.code,
        requestId: req.requestId,
        errorType: error instanceof Error ? 'Error' : 'UnknownError',
      });
    }
    res.status(serviceError.status).json({
      code: serviceError.code,
      error: serviceError.publicMessage,
      requestId: req.requestId,
    });
  };
}

export function createApp(pool: pg.Pool, opts: AppOptions = {}): express.Express {
  const app = express();
  const logger = opts.logger ?? defaultLogger;
  const provider = opts.embeddingProvider ?? null;
  const readiness = opts.readiness ?? createReadinessState();
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? 1_000;
  if (!Number.isFinite(readinessTimeoutMs) || readinessTimeoutMs <= 0) {
    throw new Error('readinessTimeoutMs must be positive');
  }
  if (provider) assertEmbeddingProviderDimension(provider);

  app.use(requestContext(
    logger,
    opts.requestIdFactory ?? randomUUID,
    opts.clock ?? Date.now,
  ));
  app.use(express.json({ limit: '1mb' }));

  const liveness: express.RequestHandler = (_req, res) => { res.json({ ok: true }); };
  app.get('/health', liveness);
  app.get('/health/live', liveness);
  app.get('/health/ready', async (_req, res) => {
    const embedding = embeddingStatus(provider);
    if (!readiness.isReady()) {
      res.status(503).json({ ok: false, database: 'unavailable', embedding });
      return;
    }
    try {
      await queryWithTimeout(pool, readinessTimeoutMs);
      res.json({ ok: true, database: 'ready', embedding });
    } catch {
      res.status(503).json({ ok: false, database: 'unavailable', embedding });
    }
  });

  const v0 = express.Router();
  v0.use(/^\/(?:capture|recall|agents-md|audit)\/?$/, bearerAuth(pool));
  v0.use(captureRouter(pool, provider));
  v0.use(recallRouter(pool, provider));
  v0.use(agentsMdRouter(pool));
  v0.use(auditRouter(pool));
  app.use('/api/v0', v0);

  app.use('/api', (_req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', error: 'Not found' });
  });
  app.use(errorMiddleware(logger));
  return app;
}

export function mapRestError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
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

async function main(): Promise<void> {
  const port = Number(process.env.CONTINUUM_API_PORT ?? 4000);
  const readinessTimeoutMs = positiveIntegerEnv('CONTINUUM_READINESS_TIMEOUT_MS', 1_000);
  const shutdownTimeoutMs = positiveIntegerEnv('CONTINUUM_SHUTDOWN_TIMEOUT_MS', 10_000);
  const pool = getPool();
  const readiness = createReadinessState();
  const app = createApp(pool, {
    embeddingProvider: makeEmbeddingProviderFromEnv(),
    readiness,
    readinessTimeoutMs,
  });
  await startRuntime(app, { port, readiness, closePool, shutdownTimeoutMs });
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

if (isDirectEntrypoint(import.meta.url)) {
  void main().catch(() => {
    console.error('Continuum API failed to start');
    process.exitCode = 1;
  });
}
