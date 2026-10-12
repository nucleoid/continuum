import { randomUUID } from 'node:crypto';
import express from 'express';
import pg from 'pg';
import { getPool, closePool } from '../storage/pool.js';
import {
  authModeFromEnv,
  bearerAuth,
  createAuthenticator,
  entraConfigFromEnv,
  type Authenticator,
  warnOnDevAuthMode,
} from './auth.js';
import { captureRouter } from './routes/capture.js';
import { recallRouter } from './routes/recall.js';
import { agentsMdRouter } from './routes/agents-md.js';
import { auditRouter } from './routes/audit.js';
import { insightsRouter } from './routes/insights.js';
import { gapConfigFromEnv, type GapConfig } from '../insights/gaps.js';
import { makeEmbeddingRouterFromEnv } from '../embeddings/factory.js';
import { warnOnMissingEmbeddingRoutingScopes } from '../embeddings/router.js';
import { asEmbeddingRouter, type EmbeddingRouting } from '../embeddings/router.js';
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
import { memoriesRouter } from './routes/memories.js';
import { ingestRouter } from './routes/ingest.js';
import { ingestConfigFromEnv, type IngestConfig, type IngestPluginId } from '../ingest/config.js';
import { cliSupportRouter } from './routes/cli.js';
import { supersedeRouter } from './routes/supersede.js';
import { offboardingRouter } from './routes/offboarding.js';
import { locksRouter } from './routes/locks.js';
import { applicationSchemaFromEnv, reconcilePgvectorProviderGrants, requireCoordinationContractReady, requirePromotionOutboxReady, requireStandupReady } from '../storage/provider-lifecycle.js';
import { tagVocabulariesRouter } from './routes/tag-vocabularies.js';
import { getPrincipalByExternalId } from '../storage/principals.js';
import { standupRouter } from './routes/standup.js';
import { producerContext, requireProducerMatch } from '../standup/activity.js';
import type { CaptureRegistry } from '../capture/plugin.js';
import {
  enrichmentConfigFromEnv,
  RetrievalEnricherRegistry,
  type EnrichmentOptions,
} from '../extensions/retrieval.js';
import { defaultExtensionRegistries } from '../extensions/index.js';
import {
  PromotionEventWorker,
  promotionWorkerOptionsFromEnv,
} from '../workers/promotion-events.js';
import { PromotionWebhookRegistry } from '../extensions/promotion.js';

export { createReadinessState } from './readiness.js';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    clientRequestId?: string;
    rawBody?: Buffer;
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
  info?(event: CompletionLog | Record<string, unknown>): void;
  warn?(event: Record<string, unknown>): void;
}

export interface AppOptions {
  embeddingProvider?: EmbeddingRouting;
  logger?: OperationalLogger;
  requestIdFactory?: () => string;
  clock?: () => number;
  readiness?: ReadinessState;
  readinessTimeoutMs?: number;
  reviewHorizonDays?: number;
  gapConfig?: GapConfig;
  relationThreshold?: number;
  ingestConfig?: IngestConfig;
  ingestProducerPools?: Partial<Record<IngestPluginId, pg.Pool>>;
  authenticator?: Authenticator;
  captureRegistry?: CaptureRegistry;
  retrievalEnrichers?: RetrievalEnricherRegistry;
  promotionWebhooks?: PromotionWebhookRegistry;
  enrichment?: Omit<EnrichmentOptions, 'logger'>;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const KNOWN_LOG_PATHS = new Set([
  '/health', '/health/live', '/health/ready',
  '/api/v0/capture', '/api/v0/recall', '/api/v0/agents-md', '/api/v0/audit',
  '/api/v0/agents-md/freshness',
  '/api/v0/review-queue',
  '/api/v0/memories', '/api/v0/memories/:id',
  '/api/v0/insights/gaps',
  '/api/v0/ingest/:pluginId',
  '/api/v0/scopes',
  '/api/v0/supersede', '/api/v0/decisions/:id/history',
  '/api/v0/admin/principals/:principalId/owned-user-scope',
  '/api/v0/admin/principals/:principalId/offboard',
  '/api/v0/locks', '/api/v0/locks/acquire', '/api/v0/locks/renew',
  '/api/v0/locks/release',
  '/api/v0/tag-vocabularies',
]);

const defaultLogger: OperationalLogger = {
  info(event) {
    console.info(JSON.stringify(event));
  },
  error(message, detail) {
    console.error(JSON.stringify({ message, detail }));
  },
  warn(event) {
    console.warn(JSON.stringify(event));
  },
};

function safeLogPath(req: express.Request): string {
  const pathname = req.originalUrl.split('?', 1)[0];
  if (KNOWN_LOG_PATHS.has(pathname)) return pathname;
  if (pathname.startsWith('/api/v0/ingest/')) return '/api/v0/ingest/:pluginId';
  const routePath = req.route?.path;
  if (typeof routePath === 'string') return routePath.slice(0, 128);
  if (pathname.startsWith('/api/v0/')) return '/api/v0/:unmatched';
  if (pathname.startsWith('/api/')) return '/api/:unmatched';
  return '/:unmatched';
}

function embeddingStatus(routing: EmbeddingRouting): {
  configured: boolean;
  provider: string | null;
} {
  const providers = asEmbeddingRouter(routing).providers();
  if (providers.length === 0) return { configured: false, provider: null };
  const provider = providers.length === 1 ? providers[0]! : null;
  return {
    configured: true,
    provider: provider && SAFE_PROVIDER_ID.test(provider.id) ? provider.id : 'routed',
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
    if (inbound && REQUEST_ID_PATTERN.test(inbound)) req.clientRequestId = inbound;
    const generated = requestIdFactory();
    req.requestId = REQUEST_ID_PATTERN.test(generated) ? generated : randomUUID();
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
      ...(serviceError.details ?? {}),
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
  const ingestConfig = opts.ingestConfig ?? ingestConfigFromEnv();
  const authenticator = opts.authenticator
    ?? (process.env.NODE_ENV === 'test' ? createAuthenticator(pool, 'dev') : undefined);
  if (!Number.isFinite(readinessTimeoutMs) || readinessTimeoutMs <= 0) {
    throw new Error('readinessTimeoutMs must be positive');
  }
  for (const configuredProvider of asEmbeddingRouter(provider).providers()) {
    assertEmbeddingProviderDimension(configuredProvider);
  }

  app.use(requestContext(
    logger,
    opts.requestIdFactory ?? randomUUID,
    opts.clock ?? Date.now,
  ));
  app.use(express.json({
    limit: '1mb',
    verify(req, _res, buffer) {
      (req as express.Request).rawBody = Buffer.from(buffer);
    },
  }));

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
  v0.use(ingestRouter(pool, provider, ingestConfig, opts.captureRegistry, relationThreshold, authenticator, opts.ingestProducerPools));
  v0.use(bearerAuth(pool, authenticator));
  v0.use(captureRouter(pool, provider, relationThreshold));
  const retrievalEnrichers = opts.retrievalEnrichers ?? new RetrievalEnricherRegistry();
  const enrichment = opts.enrichment ?? enrichmentConfigFromEnv();
  v0.use(recallRouter(pool, provider, logger, {
    registry: retrievalEnrichers,
    options: {
      ...enrichment,
      logger: {
        warn: (event) => (logger.warn ?? defaultLogger.warn)!(event),
      },
    },
  }));
  v0.use(memoriesRouter(pool));
  v0.use(agentsMdRouter(pool));
  v0.use(auditRouter(pool));
  v0.use(cliSupportRouter(pool, opts.promotionWebhooks));
  v0.use(reviewQueueRouter(pool, opts.reviewHorizonDays));
  v0.use(insightsRouter(pool, provider, gapConfig, () => new Date((opts.clock ?? Date.now)())));
  v0.use(supersedeRouter(pool, provider));
  v0.use(offboardingRouter(pool));
  v0.use(locksRouter(pool));
  v0.use(tagVocabulariesRouter(pool));
  v0.use(standupRouter(pool, () => new Date((opts.clock ?? Date.now)())));
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

const servingProducerPools = new Set<pg.Pool>();
async function closeServingPools(): Promise<void> {
  const results = await Promise.allSettled([...servingProducerPools].map((pool) => pool.end()));
  servingProducerPools.clear();
  await closePool();
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Producer pool cleanup failed');
}

async function main(): Promise<void> {
  const port = Number(process.env.CONTINUUM_API_PORT ?? 4000);
  const readinessTimeoutMs = positiveIntegerEnv('CONTINUUM_READINESS_TIMEOUT_MS', 1_000);
  const shutdownTimeoutMs = positiveIntegerEnv('CONTINUUM_SHUTDOWN_TIMEOUT_MS', 10_000);
  const pool = getPool();
  const schemaOptions = { expectedSchema: applicationSchemaFromEnv() };
  await reconcilePgvectorProviderGrants(pool, schemaOptions);
  await requireCoordinationContractReady(pool, schemaOptions);
  await requirePromotionOutboxReady(pool, schemaOptions);
  await requireStandupReady(pool, { ...schemaOptions, servingPool: true });
  const authMode = authModeFromEnv();
  warnOnDevAuthMode(authMode);
  const authenticator = createAuthenticator(
    pool,
    authMode,
    authMode === 'entra' ? entraConfigFromEnv() : undefined,
  );
  const readiness = createReadinessState();
  const embeddingProvider = makeEmbeddingRouterFromEnv();
  await warnOnMissingEmbeddingRoutingScopes(pool, embeddingProvider);
  const ingestConfig = ingestConfigFromEnv();
  const ingestProducerPools: Partial<Record<IngestPluginId, pg.Pool>> = {};
  for (const [id, configured] of Object.entries(ingestConfig.plugins)) {
    if (!configured?.producerDatabaseUrl) continue;
    const producer = new pg.Pool({ connectionString: configured.producerDatabaseUrl,
      max: 1, connectionTimeoutMillis: 5_000 });
    servingProducerPools.add(producer);
    producer.on('error', () => console.error(JSON.stringify({ event: 'standup_producer_connection_failed' })));
    await reconcilePgvectorProviderGrants(producer, schemaOptions);
    await requireCoordinationContractReady(producer, schemaOptions);
    await requirePromotionOutboxReady(producer, schemaOptions);
    await requireStandupReady(producer, schemaOptions);
    const principal = await getPrincipalByExternalId(pool, configured.principalExternalId);
    if (!principal) throw new Error('Configured standup producer principal is unavailable');
    requireProducerMatch(await producerContext(producer), principal.id, id as IngestPluginId);
    ingestProducerPools[id as IngestPluginId] = producer;
  }
  const extensions = defaultExtensionRegistries();
  const enrichmentShutdown = new AbortController();
  const app = createApp(pool, {
    embeddingProvider,
    ingestConfig,
    ingestProducerPools,
    readiness,
    readinessTimeoutMs,
    reviewHorizonDays: configuredReviewHorizonDays(),
    relationThreshold: relationThresholdFromEnv(),
    authenticator,
    retrievalEnrichers: extensions.retrievalEnrichers,
    promotionWebhooks: extensions.promotionWebhooks,
    enrichment: { ...enrichmentConfigFromEnv(), signal: enrichmentShutdown.signal },
  });
  const promotionWorker = new PromotionEventWorker(
    pool,
    extensions.promotionWebhooks,
    promotionWorkerOptionsFromEnv(`api:${process.pid}:${randomUUID()}`),
  );
  await startRuntime(app, {
    port,
    readiness,
    workers: [
      { stop: () => { enrichmentShutdown.abort(); } },
      promotionWorker,
    ],
    closePool: closeServingPools,
    shutdownTimeoutMs,
  });
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
  void main().catch(async (error: unknown) => {
    console.error(JSON.stringify({
      event: 'startup_failed',
      error: formatOperationalError(error),
    }));
    process.exitCode = 1;
    // A rejected pre-listening readiness check still opened the shared pool.
    // Drain its sockets so exitCode can terminate startup without forced exit.
    try { await closeServingPools(); } catch (cleanupError) {
      console.error(JSON.stringify({
        event: 'startup_cleanup_failed',
        error: formatOperationalError(cleanupError),
      }));
    }
  });
}
