import { EventEmitter } from 'node:events';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createReadinessState } from './server.js';
import { startRuntime, type RuntimeProcess } from './runtime.js';

class FakeProcess extends EventEmitter implements RuntimeProcess {
  exit = vi.fn();
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe.each(['SIGTERM', 'SIGINT'] as const)('runtime shutdown on %s', (signal) => {
  it('marks unready, stops workers, drains in-flight HTTP, closes once, and exits zero', async () => {
    const entered = deferred();
    const release = deferred();
    const app = express();
    app.get('/slow', async (_req, res) => {
      entered.resolve();
      await release.promise;
      res.json({ ok: true });
    });
    const readiness = createReadinessState();
    const worker = { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };
    const closePool = vi.fn().mockResolvedValue(undefined);
    const runtimeProcess = new FakeProcess();
    const runtime = await startRuntime(app, {
      port: 0, host: '127.0.0.1', readiness, workers: [worker], closePool,
      process: runtimeProcess, shutdownTimeoutMs: 1000,
      logger: { info: vi.fn(), error: vi.fn() },
    });
    expect(worker.start).toHaveBeenCalledOnce();

    const responsePromise = request(runtime.server).get('/slow').then((response) => response);
    await entered.promise;
    runtimeProcess.emit(signal);

    expect(readiness.isReady()).toBe(false);
    expect(worker.stop).toHaveBeenCalledOnce();
    expect(closePool).not.toHaveBeenCalled();
    release.resolve();

    expect((await responsePromise).status).toBe(200);
    await vi.waitFor(() => expect(runtimeProcess.exit).toHaveBeenCalledWith(0));
    expect(runtimeProcess.exit).toHaveBeenCalledOnce();
    expect(closePool).toHaveBeenCalledOnce();
    expect(runtimeProcess.listenerCount('SIGTERM')).toBe(0);
    expect(runtimeProcess.listenerCount('SIGINT')).toBe(0);
    expect((await runtime.shutdown('again')).timedOut).toBe(false);
    expect(worker.stop).toHaveBeenCalledOnce();
    expect(closePool).toHaveBeenCalledOnce();
  });
});

describe('runtime timeout behavior', () => {
  it('takes the forced path deterministically and performs cleanup once', async () => {
    vi.useFakeTimers();
    try {
      const app = express();
      const worker = { stop: vi.fn(() => new Promise<void>(() => {})) };
      const closePool = vi.fn().mockResolvedValue(undefined);
      const runtimeProcess = new FakeProcess();
      const logger = { info: vi.fn(), error: vi.fn() };
      const runtime = await startRuntime(app, {
        port: 0, host: '127.0.0.1', workers: [worker], closePool,
        process: runtimeProcess, shutdownTimeoutMs: 50, logger,
      });

      runtimeProcess.emit('SIGTERM');
      await vi.advanceTimersByTimeAsync(50);
      await vi.waitFor(() => expect(runtimeProcess.exit).toHaveBeenCalledWith(1));

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
        event: 'shutdown_timeout', reason: 'SIGTERM', timeoutMs: 50,
      }));
      expect(worker.stop).toHaveBeenCalledOnce();
      expect(closePool).toHaveBeenCalledOnce();
      runtimeProcess.emit('SIGINT');
      await vi.advanceTimersByTimeAsync(50);
      expect(runtimeProcess.exit).toHaveBeenCalledOnce();
      expect(closePool).toHaveBeenCalledOnce();
      expect((await runtime.shutdown('again')).timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains a request that becomes idle on a keep-alive socket before the deadline', async () => {
    const entered = deferred();
    const release = deferred();
    const app = express();
    app.get('/slow', async (_req, res) => {
      entered.resolve();
      await release.promise;
      res.json({ ok: true });
    });
    const runtime = await startRuntime(app, {
      port: 0, host: '127.0.0.1', closePool: vi.fn(), shutdownTimeoutMs: 500,
      logger: { info: vi.fn(), error: vi.fn() },
    });
    const address = runtime.server.address();
    if (!address || typeof address === 'string') throw new Error('missing server address');
    const agent = new http.Agent({ keepAlive: true });
    const responseDone = deferred();
    const req = http.get({ host: '127.0.0.1', port: address.port, path: '/slow', agent }, (res) => {
      res.resume();
      res.once('end', responseDone.resolve);
    });
    req.once('error', responseDone.resolve);
    await entered.promise;

    const shutdown = runtime.shutdown('test');
    release.resolve();
    await responseDone.promise;

    await expect(shutdown).resolves.toEqual({ timedOut: false });
    agent.destroy();
  });

  it('forces exit on a second signal instead of waiting for the deadline', async () => {
    const runtimeProcess = new FakeProcess();
    const runtime = await startRuntime(express(), {
      port: 0, host: '127.0.0.1', process: runtimeProcess,
      workers: [{ stop: vi.fn(() => new Promise<void>(() => {})) }],
      closePool: vi.fn(), shutdownTimeoutMs: 60_000,
      logger: { info: vi.fn(), error: vi.fn() },
    });

    runtimeProcess.emit('SIGTERM');
    runtimeProcess.emit('SIGINT');

    await vi.waitFor(() => expect(runtimeProcess.exit).toHaveBeenCalledWith(1));
    runtime.server.closeAllConnections?.();
  });
});

describe('runtime startup failures', () => {
  it('rejects invalid shutdown timeout with actionable detail', async () => {
    await expect(startRuntime(express(), {
      port: 0, closePool: vi.fn(), shutdownTimeoutMs: 0,
    })).rejects.toThrow('shutdownTimeoutMs must be positive');
  });

  it('preserves listen failure code and message', async () => {
    const occupied = http.createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('missing occupied address');
    const closePool = vi.fn(() => { throw new Error('pool cleanup failed'); });
    try {
      await expect(startRuntime(express(), {
        port: address.port, host: '127.0.0.1', closePool,
      })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(closePool).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it('closes the listener and preserves a worker start failure', async () => {
    const failure = new Error('worker bootstrap failed');
    const closePool = vi.fn(() => { throw new Error('pool cleanup failed'); });
    const startedEntered = deferred();
    const failedEntered = deferred();
    const finishStarting = deferred();
    const startedWorker = {
      start: vi.fn(async () => {
        startedEntered.resolve();
        await finishStarting.promise;
      }),
      stop: vi.fn(),
    };
    const failedWorker = {
      start: vi.fn(async () => {
        failedEntered.resolve();
        throw failure;
      }),
      stop: vi.fn(),
    };
    const starting = startRuntime(express(), {
      port: 0, host: '127.0.0.1', closePool,
      workers: [startedWorker, failedWorker],
    });
    await Promise.all([startedEntered.promise, failedEntered.promise]);
    expect(startedWorker.stop).not.toHaveBeenCalled();
    expect(closePool).not.toHaveBeenCalled();
    finishStarting.resolve();

    await expect(starting).rejects.toBe(failure);
    expect(startedWorker.stop).toHaveBeenCalledOnce();
    expect(startedWorker.stop).toHaveBeenCalledWith('startup_failed');
    expect(failedWorker.stop).toHaveBeenCalledOnce();
    expect(failedWorker.stop).toHaveBeenCalledWith('startup_failed');
    expect(closePool).toHaveBeenCalledOnce();
  });
});
