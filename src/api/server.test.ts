import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { createApp, mapRestError } from './server.js';

const unusedPool = {} as pg.Pool;

describe('REST error middleware', () => {
  it('returns a stable safe error for malformed JSON', async () => {
    const response = await request(createApp(unusedPool))
      .post('/api/v0/capture')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: 'INVALID_INPUT',
      error: 'Malformed JSON request body',
    });
  });

  it('returns a stable safe error for bodies over 1 MB', async () => {
    const response = await request(createApp(unusedPool))
      .post('/api/v0/capture')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ body: 'x'.repeat(1024 * 1024 + 1) }));

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      error: 'Request body exceeds the 1 MB limit',
    });
  });

  it('preserves an exposed unsupported-charset 415 without internal logging', async () => {
    const logger = { error: vi.fn() };
    const response = await request(createApp(unusedPool, { logger }))
      .post('/api/v0/capture')
      .set('Content-Type', 'application/json; charset=made-up')
      .send('{}');

    expect(response.status).toBe(415);
    expect(response.body).toEqual({
      code: 'INVALID_INPUT',
      error: 'unsupported charset "MADE-UP"',
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('preserves an exposed unsupported content-encoding 415 without internal logging', async () => {
    const logger = { error: vi.fn() };
    const response = await request(createApp(unusedPool, { logger }))
      .post('/api/v0/capture')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'made-up')
      .send('{}');

    expect(response.status).toBe(415);
    expect(response.body).toEqual({
      code: 'INVALID_INPUT',
      error: 'unsupported content encoding "made-up"',
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('preserves a safe exposed request-aborted 400', () => {
    expect(mapRestError({
      type: 'request.aborted',
      status: 400,
      expose: true,
      message: 'request aborted',
    })).toMatchObject({
      code: 'INVALID_INPUT',
      status: 400,
      publicMessage: 'request aborted',
    });
  });

  it('logs internal causes without returning private database details', async () => {
    const privateMessage = 'postgres password=private-value';
    const pool = {
      query: vi.fn().mockRejectedValue(new Error(privateMessage)),
    } as unknown as pg.Pool;
    const logger = { error: vi.fn() };

    const response = await request(createApp(pool, { logger }))
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer anyone')
      .send({});

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ code: 'INTERNAL', error: 'An internal error occurred' });
    expect(JSON.stringify(response.body)).not.toContain(privateMessage);
    expect(logger.error).toHaveBeenCalledWith(
      'REST: internal service error',
      expect.objectContaining({ message: privateMessage }),
    );
  });
});
