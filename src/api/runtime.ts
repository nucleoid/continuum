import type { Server } from 'node:http';
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
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await waitForListening(server);
  await Promise.all(workers.map(async (worker) => worker.start?.()));

  let closePoolPromise: Promise<void> | undefined;
  const closePoolOnce = () => {
    closePoolPromise ??= Promise.resolve().then(options.closePool);
    return closePoolPromise;
  };
  let shutdownPromise: Promise<ShutdownResult> | undefined;
  let signalPromise: Promise<void> | undefined;

  const removeSignalHandlers = () => {
    runtimeProcess.off('SIGTERM', onSigterm);
    runtimeProcess.off('SIGINT', onSigint);
  };

  const shutdown = (reason: string): Promise<ShutdownResult> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      readiness.markUnready();
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
      const orderly = Promise.all([serverClosed, workersStopped])
        .then(closePoolOnce)
        .then(() => 'drained' as const)
        .catch(() => 'failed' as const);
      const outcome = await Promise.race([
        orderly,
        deadline,
      ]);
      if (timeout) clearTimeout(timeout);
      removeSignalHandlers();

      if (outcome !== 'drained') {
        logger.error(outcome === 'timeout'
          ? { event: 'shutdown_timeout', reason, timeoutMs }
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
    signalPromise ??= shutdown(signal).then(({ timedOut }) => {
      runtimeProcess.exit(timedOut ? 1 : 0);
    });
  };
  function onSigterm() { shutdownFromSignal('SIGTERM'); }
  function onSigint() { shutdownFromSignal('SIGINT'); }
  runtimeProcess.on('SIGTERM', onSigterm);
  runtimeProcess.on('SIGINT', onSigint);

  return { server, readiness, shutdown };
}
