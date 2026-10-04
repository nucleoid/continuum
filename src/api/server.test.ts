import { Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type express from 'express';
import type pg from 'pg';
import request from 'supertest';
import { ServiceError } from '../services/errors.js';
import {
  createApp,
  createReadinessState,
  errorMiddleware,
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

  it('preserves a conservative inbound request ID and replaces unsafe values', async () => {
    const requestIdFactory = vi.fn()
      .mockReturnValueOnce('generated-for-control-char')
      .mockReturnValueOnce('generated-for-oversized');
    const app = createApp(unusedPool, appOptions({ requestIdFactory }));

    const accepted = await request(app).get('/health').set('X-Request-Id', 'safe.ID:42-abc');
    const control = await request(app).get('/health').set('X-Request-Id', 'unsafe value');
    const oversized = await request(app).get('/health').set('X-Request-Id', 'x'.repeat(65));

    expect(accepted.headers['x-request-id']).toBe('safe.ID:42-abc');
    expect(control.headers['x-request-id']).toBe('generated-for-control-char');
    expect(oversized.headers['x-request-id']).toBe('generated-for-oversized');
    expect(requestIdFactory).toHaveBeenCalledTimes(2);
  });

  it('adds request identity to authentication failures and API 404s', async () => {
    const app = createApp(unusedPool, appOptions());
    const authFailure = await request(app).post('/api/v0/capture').send({});
    const missing = await request(app).get('/api/v0/private-memory-id?query=secret-recall');

    expect(authFailure.headers['x-request-id']).toBe(fixedRequestId);
    expect(authFailure.body).toMatchObject({ requestId: fixedRequestId });
    expect(missing.status).toBe(404);
    expect(missing.type).toBe('application/json');
    expect(missing.body).toEqual({
      code: 'NOT_FOUND', error: 'Not found', requestId: fixedRequestId,
    });
  });

  it('emits one bounded completion log without headers, query values, body, or unmatched IDs', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const app = createApp(unusedPool, appOptions({ logger, clock: () => 1234 }));
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
    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(embed).not.toHaveBeenCalled();
  });

  it('returns a sanitized 503 when unready, the database fails, or the check times out', async () => {
    const state = createReadinessState();
    state.markUnready();
    const notAccepting = await request(createApp(unusedPool, appOptions({ readiness: state })))
      .get('/health/ready');
    expect(notAccepting.status).toBe(503);
    expect(notAccepting.body).toMatchObject({ ok: false, database: 'unavailable' });

    const secret = 'postgres://secret-host/private';
    const failed = await request(createApp({
      query: vi.fn().mockRejectedValue(new Error(secret)),
    } as unknown as pg.Pool, appOptions())).get('/health/ready');
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain(secret);

    vi.useFakeTimers();
    try {
      const query = vi.fn(() => new Promise(() => {}));
      const pending = request(createApp({
        query,
      } as unknown as pg.Pool, appOptions({ readinessTimeoutMs: 25 }))).get('/health/ready');
      const responsePromise = pending.then((response) => response);
      await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(25);
      const timedOut = await responsePromise;
      expect(timedOut.status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });
});
