import { EventEmitter } from 'node:events';
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
});
