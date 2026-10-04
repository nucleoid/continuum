import type { Server } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type express from 'express';
import { createReadinessState, type ReadinessState } from './readiness.js';

export interface RuntimeWorker {
  start?(): void | Promise<void>;
  stop(reason: string): void | Promise<void>;
}

export interface RuntimeProcess {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
  exit(code: number): unknown;
}

export interface RuntimeLogger {
  info(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

export interface RuntimeOptions {
  port: number;
  host?: string;
  readiness?: ReadinessState;
  workers?: RuntimeWorker[];
  closePool: () => void | Promise<void>;
  shutdownTimeoutMs?: number;
  process?: RuntimeProcess;
  logger?: RuntimeLogger;
}

export interface ShutdownResult {
  timedOut: boolean;
}

export interface RuntimeHandle {
  server: Server;
  readiness: ReadinessState;
  shutdown(reason: string): Promise<ShutdownResult>;
}

const defaultRuntimeLogger: RuntimeLogger = {
  info: (event) => { console.info(JSON.stringify(event)); },
  error: (event) => { console.error(JSON.stringify(event)); },
};

function waitForListening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

export async function startRuntime(
  app: express.Express,
  options: RuntimeOptions,
): Promise<RuntimeHandle> {
  const runtimeProcess = options.process ?? process;
  const logger = options.logger ?? defaultRuntimeLogger;
  const readiness = options.readiness ?? createReadinessState();
  const workers = options.workers ?? [];
  const timeoutMs = options.shutdownTimeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('shutdownTimeoutMs must be positive');
  }

  const server = options.host === undefined
    ? app.listen(options.port)
    : app.listen(options.port, options.host);
  const sockets = new Set<Socket>();
  const responses = new Set<ServerResponse>();
  let shuttingDown = false;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('request', (_request, response) => {
    responses.add(response);
    const complete = () => {
      responses.delete(response);
      if (shuttingDown) server.closeIdleConnections?.();
    };
    response.once('finish', complete);
    response.once('close', complete);
  });
  try {
    await waitForListening(server);
    await Promise.all(workers.map(async (worker) => worker.start?.()));
  } catch (error) {
    readiness.markUnready();
    await Promise.allSettled(workers.map(async (worker) => worker.stop('startup_failed')));
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await Promise.resolve(options.closePool()).catch(() => undefined);
    throw error;
  }

  let closePoolPromise: Promise<void> | undefined;
  const closePoolOnce = () => {
    closePoolPromise ??= Promise.resolve().then(options.closePool);
    return closePoolPromise;
  };
  let shutdownPromise: Promise<ShutdownResult> | undefined;
  let signalPromise: Promise<void> | undefined;
  let forceShutdown: (() => void) | undefined;

  const removeSignalHandlers = () => {
    runtimeProcess.off('SIGTERM', onSigterm);
    runtimeProcess.off('SIGINT', onSigint);
  };

  const shutdown = (reason: string): Promise<ShutdownResult> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      shuttingDown = true;
      readiness.markUnready();
      for (const response of responses) {
        if (!response.headersSent) response.setHeader('Connection', 'close');
      }
      const serverClosed = new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => { if (error) reject(error); else resolve(); });
        server.closeIdleConnections?.();
      });
      const workersStopped = Promise.all(
        workers.map(async (worker) => worker.stop(reason)),
      ).then(() => undefined);

      let timeout: NodeJS.Timeout | undefined;
      const deadline = new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const forced = new Promise<'forced'>((resolve) => {
        forceShutdown = () => resolve('forced');
      });
      const orderly = Promise.all([serverClosed, workersStopped])
        .then(closePoolOnce)
        .then(() => 'drained' as const)
        .catch(() => 'failed' as const);
      const outcome = await Promise.race([
        orderly,
        deadline,
        forced,
      ]);
      if (timeout) clearTimeout(timeout);
      removeSignalHandlers();

      if (outcome !== 'drained') {
        logger.error(outcome === 'timeout'
          ? { event: 'shutdown_timeout', reason, timeoutMs }
          : outcome === 'forced'
            ? { event: 'shutdown_forced', reason }
            : { event: 'shutdown_failed', reason });
        for (const socket of sockets) socket.destroy();
        void closePoolOnce().catch(() => {
          logger.error({ event: 'pool_close_failed', reason });
        });
        return { timedOut: true };
      }

      logger.info({ event: 'shutdown_complete', reason });
      return { timedOut: false };
    })();
    return shutdownPromise;
  };

  const shutdownFromSignal = (signal: NodeJS.Signals) => {
    if (signalPromise) {
      for (const socket of sockets) socket.destroy();
      forceShutdown?.();
      return;
    }
    signalPromise = shutdown(signal).then(({ timedOut }) => {
      runtimeProcess.exit(timedOut ? 1 : 0);
    });
  };
  function onSigterm() { shutdownFromSignal('SIGTERM'); }
  function onSigint() { shutdownFromSignal('SIGINT'); }
  runtimeProcess.on('SIGTERM', onSigterm);
  runtimeProcess.on('SIGINT', onSigint);

  return { server, readiness, shutdown };
}
