import { randomUUID } from 'node:crypto';
import express from 'express';
import type pg from 'pg';
import { getPool, closePool } from '../storage/pool.js';
import { bearerAuth } from './auth.js';
import { captureRouter } from './routes/capture.js';
import { recallRouter } from './routes/recall.js';
import { agentsMdRouter } from './routes/agents-md.js';
import { auditRouter } from './routes/audit.js';
import { insightsRouter } from './routes/insights.js';
import { gapConfigFromEnv, type GapConfig } from '../insights/gaps.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { makeEmbeddingProviderFromEnv } from '../embeddings/factory.js';
import { isDirectEntrypoint } from './entrypoint.js';
import { assertEmbeddingProviderDimension } from '../storage/schema.js';
import { asServiceError, ServiceError, type ServiceLogger } from '../services/errors.js';
import { startRuntime } from './runtime.js';
import { createReadinessState, type ReadinessState } from './readiness.js';
import { reviewQueueRouter } from './routes/review-queue.js';
import { configuredReviewHorizonDays } from '../services/review-queue.js';
import {
  DEFAULT_RELATION_THRESHOLD,
  relationThresholdFromEnv,
  validateRelationThreshold,
} from '../services/relations.js';

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
  reviewHorizonDays?: number;
  gapConfig?: GapConfig;
  relationThreshold?: number;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const KNOWN_LOG_PATHS = new Set([
  '/health', '/health/live', '/health/ready',
  '/api/v0/capture', '/api/v0/recall', '/api/v0/agents-md', '/api/v0/audit',
  '/api/v0/agents-md/freshness',
  '/api/v0/review-queue',
  '/api/v0/insights/gaps',
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
  const query: pg.QueryConfig & { query_timeout: number } = {
    text: 'SELECT 1',
    query_timeout: timeoutMs,
  };
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Database readiness check exceeded ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([
      Promise.resolve().then(async () => { await pool.query(query); }),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function formatOperationalError(error: unknown): {
  message: string;
  code?: string;
} {
  const candidate = error as { message?: unknown; code?: unknown };
  const rawMessage = typeof candidate?.message === 'string'
    ? candidate.message
    : 'Unknown error';
  const message = rawMessage
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s@/]+@/gi, '$1[REDACTED]@')
    .replace(/\b(password|passwd|pwd|token|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 512);
  const formatted: { message: string; code?: string } = { message };
  if (typeof candidate?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(candidate.code)) {
    formatted.code = candidate.code;
  }
  return formatted;
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
      const cause = serviceError.cause ?? error;
      logger.error('REST: internal service error', {
        code: serviceError.code,
        requestId: req.requestId,
        error: formatOperationalError(cause),
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
  const gapConfig = opts.gapConfig ?? gapConfigFromEnv();
  const relationThreshold = validateRelationThreshold(
    opts.relationThreshold ?? DEFAULT_RELATION_THRESHOLD,
  );
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
  app.get('/health/ready', async (req, res) => {
    const embedding = embeddingStatus(provider);
    if (!readiness.isReady()) {
      res.status(503).json({ ok: false, database: 'shutting_down', embedding });
      return;
    }
    try {
      await queryWithTimeout(pool, readinessTimeoutMs);
      res.json({ ok: true, database: 'ready', embedding });
    } catch (error) {
      logger.error('REST: readiness dependency unavailable', {
        dependency: 'database',
        requestId: req.requestId,
        error: formatOperationalError(error),
      });
      res.status(503).json({ ok: false, database: 'unavailable', embedding });
    }
  });

  const v0 = express.Router();
  v0.use(bearerAuth(pool));
  v0.use(captureRouter(pool, provider, relationThreshold));
  v0.use(recallRouter(pool, provider));
  v0.use(agentsMdRouter(pool));
  v0.use(auditRouter(pool));
  v0.use(reviewQueueRouter(pool, opts.reviewHorizonDays));
  v0.use(insightsRouter(pool, provider, gapConfig, () => new Date((opts.clock ?? Date.now)())));
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
    reviewHorizonDays: configuredReviewHorizonDays(),
    relationThreshold: relationThresholdFromEnv(),
  });
  await startRuntime(app, { port, readiness, closePool, shutdownTimeoutMs });
  console.log(`Continuum API listening on :${port}`);
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
  void main().catch((error: unknown) => {
    console.error(JSON.stringify({
      event: 'startup_failed',
      error: formatOperationalError(error),
    }));
    process.exitCode = 1;
  });
}
