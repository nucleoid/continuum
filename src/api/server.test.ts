import { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type express from 'express';
import type pg from 'pg';
import request from 'supertest';
import { ServiceError } from '../services/errors.js';
import {
  createApp,
  createReadinessState,
  errorMiddleware,
  formatOperationalError,
  mapRestError,
} from './server.js';

const unusedPool = { query: vi.fn() } as unknown as pg.Pool;
const fixedRequestId = 'request-test-123';

function appOptions(overrides: Parameters<typeof createApp>[1] = {}) {
  return {
    requestIdFactory: () => fixedRequestId,
    logger: { info: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe('createApp operational middleware', () => {
  it('lists every known operational log path once', async () => {
    const source = await readFile(new URL('./server.ts', import.meta.url), 'utf8');
    expect(source.match(/'\/api\/v0\/scopes'/g)).toHaveLength(1);
  });

  it('is pure and creates no listener, signal handler, query, worker, or provider side effect', () => {
    const listen = vi.spyOn(Server.prototype, 'listen');
    const processOn = vi.spyOn(process, 'on');
    const query = vi.fn();
    const embed = vi.fn();

    createApp({ query } as unknown as pg.Pool, appOptions({
      embeddingProvider: { id: 'hosted:model', dim: 768, embed },
    }));

    expect(listen).not.toHaveBeenCalled();
    expect(processOn).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it('rejects an injected provider incompatible with the database schema', () => {
    expect(() => createApp(unusedPool, appOptions({
      embeddingProvider: { id: 'hosted:model', dim: 384, embed: vi.fn() },
    }))).toThrow(/provider dimension.*768.*database vector\(768\)/i);
  });

  it('always mints request identity and never uses inbound IDs as linking identity', async () => {
    const requestIdFactory = vi.fn()
      .mockReturnValueOnce('generated-for-safe-client')
      .mockReturnValueOnce('generated-for-control-char')
      .mockReturnValueOnce('generated-for-oversized');
    const app = createApp(unusedPool, appOptions({ requestIdFactory }));

    const accepted = await request(app).get('/health').set('X-Request-Id', 'safe.ID:42-abc');
    const control = await request(app).get('/health').set('X-Request-Id', 'unsafe value');
    const oversized = await request(app).get('/health').set('X-Request-Id', 'x'.repeat(65));

    expect(accepted.headers['x-request-id']).toBe('generated-for-safe-client');
    expect(control.headers['x-request-id']).toBe('generated-for-control-char');
    expect(oversized.headers['x-request-id']).toBe('generated-for-oversized');
    expect(requestIdFactory).toHaveBeenCalledTimes(3);
  });

  it('adds request identity to authentication failures and API 404s', async () => {
    const principal = {
      id: '11111111-1111-4111-8111-111111111111',
      external_id: 'known',
      kind: 'user',
      display_name: 'Known',
      created_at: new Date(),
    };
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [principal] }),
    } as unknown as pg.Pool;
    const app = createApp(pool, appOptions());
    const authFailure = await request(app).post('/api/v0/capture').send({});
    const missing = await request(app)
      .get('/api/v0/private-memory-id?query=secret-recall')
      .set('Authorization', 'Bearer known');

    expect(authFailure.headers['x-request-id']).toBe(fixedRequestId);
    expect(authFailure.body).toMatchObject({ requestId: fixedRequestId });
    expect(missing.status).toBe(404);
    expect(missing.type).toBe('application/json');
    expect(missing.body).toEqual({
      code: 'NOT_FOUND', error: 'Not found', requestId: fixedRequestId,
    });
  });

  it.each([
    ['post', '/api/v0/CAPTURE'],
    ['get', '/api/v0/Agents-MD'],
    ['get', '/api/v0/AUDIT'],
  ] as const)('fails closed before database work for mixed-case protected %s %s', async (method, path) => {
    const query = vi.fn();
    const app = createApp({ query } as unknown as pg.Pool, appOptions());

    const response = await request(app)[method](path).send({});

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: 'missing or malformed bearer token', requestId: fixedRequestId,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('fails closed for an arbitrary future mixed-case v0 route', async () => {
    const query = vi.fn();
    const app = createApp({ query } as unknown as pg.Pool, appOptions());

    const response = await request(app).post('/api/v0/FuTuRe-RoUtE').send({});

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: 'missing or malformed bearer token', requestId: fixedRequestId,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('emits one bounded completion log without headers, query values, body, or unmatched IDs', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{
        id: '11111111-1111-4111-8111-111111111111',
        external_id: 'private-token',
        kind: 'user',
        display_name: 'Known',
        created_at: new Date(),
      }] }),
    } as unknown as pg.Pool;
    const app = createApp(pool, appOptions({ logger, clock: () => 1234 }));
    const response = await request(app)
      .post('/api/v0/secret-memory-id?query=private-recall-text')
      .set('Authorization', 'Bearer private-token')
      .set('Cookie', 'session=private-cookie')
      .send({ body: 'private-body' });

    expect(response.status).toBe(404);
    expect(logger.info).toHaveBeenCalledOnce();
    const event = logger.info.mock.calls[0][0];
    expect(event).toMatchObject({
      event: 'http_request_complete',
      timestamp: new Date(1234).toISOString(),
      requestId: fixedRequestId,
      method: 'POST',
      path: '/api/v0/:unmatched',
      status: 404,
      durationMs: 0,
    });
    const serialized = JSON.stringify(event);
    for (const secret of [
      'private-token', 'private-cookie', 'private-body',
      'private-recall-text', 'secret-memory-id',
    ]) expect(serialized).not.toContain(secret);
  });

  it('includes an authenticated principal UUID in the completion log', async () => {
    const principalId = '11111111-1111-4111-8111-111111111111';
    const logger = { info: vi.fn(), error: vi.fn() };
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{
        id: principalId,
        external_id: 'known',
        kind: 'user',
        display_name: 'Known',
        created_at: new Date(),
      }] }),
    } as unknown as pg.Pool;

    await request(createApp(pool, appOptions({ logger })))
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer known')
      .send({});

    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ principalId }));
  });
});

describe('REST error middleware', () => {
  it('returns stable safe errors with request IDs for malformed and oversized JSON', async () => {
    const app = createApp(unusedPool, appOptions());
    const malformed = await request(app)
      .post('/api/v0/capture')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    const oversized = await request(app)
      .post('/api/v0/capture')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ body: 'x'.repeat(1024 * 1024 + 1) }));

    expect(malformed.body).toEqual({
      code: 'INVALID_INPUT', error: 'Malformed JSON request body', requestId: fixedRequestId,
    });
    expect(oversized.body).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      error: 'Request body exceeds the 1 MB limit',
      requestId: fixedRequestId,
    });
  });

  it('maps every stable ServiceError code and sanitizes unknown failures', async () => {
    const cases = [
      ['INVALID_INPUT', 400], ['INVALID_SCOPE', 400], ['FORBIDDEN', 403],
      ['SCOPE_NOT_FOUND', 404], ['MEMORY_NOT_FOUND', 404], ['CONFLICT', 409],
      ['NOT_FOUND', 404],
      ['IDEMPOTENCY_CONFLICT', 409], ['LEASE_LOST', 409],
      ['COORDINATION_QUOTA_EXCEEDED', 409], ['FENCING_TOKEN_EXHAUSTED', 409],
      ['COORDINATION_TIMEOUT', 503],
      ['PAYLOAD_TOO_LARGE', 413], ['DEPENDENCY_UNAVAILABLE', 503], ['INTERNAL', 500],
    ] as const;

    for (const [code, status] of cases) {
      const mapped = mapRestError(new ServiceError(code, 'safe message'));
      expect(mapped).toMatchObject({ code, status, publicMessage: 'safe message' });
    }

    const privateMessage = 'postgres password=private-value';
    const logger = { info: vi.fn(), error: vi.fn() };
    const pool = { query: vi.fn().mockRejectedValue(new Error(privateMessage)) } as unknown as pg.Pool;
    const response = await request(createApp(pool, appOptions({ logger })))
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer anyone')
      .send({});

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      code: 'INTERNAL', error: 'An internal error occurred', requestId: fixedRequestId,
    });
    expect(JSON.stringify(response.body)).not.toContain(privateMessage);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(privateMessage);
    expect(logger.error).toHaveBeenCalledWith(
      'REST: internal service error',
      expect.objectContaining({
        code: 'INTERNAL',
        requestId: fixedRequestId,
        error: expect.objectContaining({ message: 'postgres password=[REDACTED]' }),
      }),
    );
  });

  it('delegates to Express when headers were already sent', () => {
    const next = vi.fn();
    const middleware = errorMiddleware({ info: vi.fn(), error: vi.fn() });
    middleware(
      new Error('private'),
      { requestId: fixedRequestId } as express.Request,
      { headersSent: true } as express.Response,
      next,
    );
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('does not allow service error details to replace stable REST envelope fields', () => {
    const json = vi.fn();
    const response = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json,
    } as unknown as express.Response;
    const middleware = errorMiddleware({ info: vi.fn(), error: vi.fn() });

    middleware(
      new ServiceError('CONFLICT', 'Stable message', {
        details: {
          code: 'INTERNAL', error: 'unsafe replacement', requestId: 'unsafe-request',
          successorId: 'safe-successor',
        },
      }),
      { requestId: fixedRequestId } as express.Request,
      response,
      vi.fn(),
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      code: 'CONFLICT', error: 'Stable message', requestId: fixedRequestId,
      successorId: 'safe-successor',
    });
  });

  it('preserves safe exposed parser statuses', () => {
    expect(mapRestError({
      type: 'request.aborted', status: 400, expose: true, message: 'request aborted',
    })).toMatchObject({ code: 'INVALID_INPUT', status: 400, publicMessage: 'request aborted' });
  });
});

describe('health and readiness', () => {
  it('keeps liveness database-independent and exposes readiness metadata without embedding', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const embed = vi.fn();
    const app = createApp({ query } as unknown as pg.Pool, appOptions({
      embeddingProvider: { id: 'ollama:nomic-embed-text', dim: 768, embed },
    }));

    expect((await request(app).get('/health')).body).toEqual({ ok: true });
    expect((await request(app).get('/health/live')).body).toEqual({ ok: true });
    expect(query).not.toHaveBeenCalled();

    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({
      ok: true,
      database: 'ready',
      embedding: { configured: true, provider: 'ollama:nomic-embed-text' },
    });
    expect(query).toHaveBeenCalledWith({ text: 'SELECT 1', query_timeout: 1_000 });
    expect(embed).not.toHaveBeenCalled();
  });

  it('returns a sanitized 503 when unready, the database fails, or the check times out', async () => {
    const state = createReadinessState();
    state.markUnready();
    const notAccepting = await request(createApp(unusedPool, appOptions({ readiness: state })))
      .get('/health/ready');
    expect(notAccepting.status).toBe(503);
    expect(notAccepting.body).toMatchObject({ ok: false, database: 'shutting_down' });

    const secret = 'postgres://admin:hunter2@private-host/private';
    const logger = { info: vi.fn(), error: vi.fn() };
    const failed = await request(createApp({
      query: vi.fn().mockRejectedValue(new Error(secret)),
    } as unknown as pg.Pool, appOptions({ logger }))).get('/health/ready');
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain(secret);
    expect(logger.error).toHaveBeenCalledWith(
      'REST: readiness dependency unavailable',
      expect.objectContaining({
        dependency: 'database',
        requestId: fixedRequestId,
        error: { message: 'postgres://[REDACTED]@private-host/private' },
      }),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('hunter2');

    vi.useFakeTimers();
    try {
      const query = vi.fn((config: { query_timeout: number }) => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('query timeout')), config.query_timeout);
      }));
      const pending = request(createApp({
        query,
      } as unknown as pg.Pool, appOptions({ readinessTimeoutMs: 25 }))).get('/health/ready');
      const responsePromise = pending.then((response) => response);
      await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(25);
      const timedOut = await responsePromise;
      expect(timedOut.status).toBe(503);
      expect(query).toHaveBeenCalledWith({ text: 'SELECT 1', query_timeout: 25 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds readiness when pool acquisition never settles', async () => {
    vi.useFakeTimers();
    let rejectQuery!: (error: Error) => void;
    const query = vi.fn(() => new Promise((_resolve, reject) => {
      rejectQuery = reject;
    }));
    try {
      const responsePromise = request(createApp(
        { query } as unknown as pg.Pool,
        appOptions({ readinessTimeoutMs: 20 }),
      )).get('/health/ready').then((response) => response);
      await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(20);

      const response = await responsePromise;
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ ok: false, database: 'unavailable' });
      expect(vi.getTimerCount()).toBe(0);

      rejectQuery(new Error('late stalled query failure'));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('operational error sanitization', () => {
  it.each([
    [new Error('CONTINUUM_SHUTDOWN_TIMEOUT_MS must be a positive integer'),
      { message: 'CONTINUUM_SHUTDOWN_TIMEOUT_MS must be a positive integer' }],
    [Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:4000'), { code: 'EADDRINUSE' }),
      { code: 'EADDRINUSE', message: 'listen EADDRINUSE: address already in use 127.0.0.1:4000' }],
    [new Error('worker failed for postgres://admin:secret@db/private password=hunter2'),
      { message: 'worker failed for postgres://[REDACTED]@db/private password=[REDACTED]' }],
  ])('retains actionable configuration/listen/start detail without secrets', (error, expected) => {
    const formatted = formatOperationalError(error);
    expect(formatted).toMatchObject(expected);
    expect(JSON.stringify(formatted)).not.toContain('secret');
    expect(JSON.stringify(formatted)).not.toContain('hunter2');
  });
});
