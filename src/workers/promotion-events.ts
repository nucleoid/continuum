import type pg from 'pg';
import type { RuntimeWorker } from '../api/runtime.js';
import type { PromotionWebhookRegistry } from '../extensions/promotion.js';
import {
  claimPromotionDeliveries,
  completePromotionDelivery,
  failPromotionDelivery,
  releasePromotionDeliveries,
  type ClaimedPromotionDelivery,
} from '../storage/promotion-events.js';

export interface PromotionWorkerLogger {
  info(event: Record<string, unknown>): void;
  warn(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

export interface PromotionWorkerOptions {
  owner: string;
  pollMs: number;
  claimBatch: number;
  leaseMs: number;
  callbackTimeoutMs: number;
  shutdownWaitMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  random?: () => number;
  logger?: PromotionWorkerLogger;
}

function positiveEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!/^\d+$/.test(raw ?? String(fallback))
    || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

export function promotionWorkerOptionsFromEnv(
  owner: string,
  env: NodeJS.ProcessEnv = process.env,
): PromotionWorkerOptions {
  return {
    owner,
    pollMs: positiveEnv(env, 'CONTINUUM_PROMOTION_POLL_MS', 1_000),
    claimBatch: positiveEnv(env, 'CONTINUUM_PROMOTION_CLAIM_BATCH', 10, 100),
    leaseMs: positiveEnv(env, 'CONTINUUM_PROMOTION_LEASE_MS', 30_000),
    callbackTimeoutMs: positiveEnv(env, 'CONTINUUM_PROMOTION_CALLBACK_TIMEOUT_MS', 5_000),
    shutdownWaitMs: positiveEnv(env, 'CONTINUUM_PROMOTION_SHUTDOWN_WAIT_MS', 5_000),
    maxAttempts: positiveEnv(env, 'CONTINUUM_PROMOTION_MAX_ATTEMPTS', 10, 1_000),
    baseBackoffMs: positiveEnv(env, 'CONTINUUM_PROMOTION_BASE_BACKOFF_MS', 1_000),
    maxBackoffMs: positiveEnv(env, 'CONTINUUM_PROMOTION_MAX_BACKOFF_MS', 300_000),
  };
}

const defaultLogger: PromotionWorkerLogger = {
  info: (event) => { console.info(JSON.stringify(event)); },
  warn: (event) => { console.warn(JSON.stringify(event)); },
  error: (event) => { console.error(JSON.stringify(event)); },
};

export class PromotionEventWorker implements RuntimeWorker {
  private stopped = false;
  private started = false;
  private timer?: NodeJS.Timeout;
  private readonly active = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private readonly logger: PromotionWorkerLogger;
  private readonly random: () => number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: PromotionWebhookRegistry,
    private readonly options: PromotionWorkerOptions,
  ) {
    for (const [name, value] of Object.entries({
      pollMs: options.pollMs,
      claimBatch: options.claimBatch,
      leaseMs: options.leaseMs,
      callbackTimeoutMs: options.callbackTimeoutMs,
      shutdownWaitMs: options.shutdownWaitMs,
      maxAttempts: options.maxAttempts,
      baseBackoffMs: options.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs,
    })) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
    if (options.claimBatch > 100) throw new Error('claimBatch must not exceed 100');
    if (options.baseBackoffMs > options.maxBackoffMs) {
      throw new Error('baseBackoffMs must not exceed maxBackoffMs');
    }
    if (options.callbackTimeoutMs >= options.leaseMs) {
      throw new Error('callbackTimeoutMs must be less than leaseMs');
    }
    this.logger = options.logger ?? defaultLogger;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.runLoop();
  }

  async drainOnce(): Promise<number> {
    if (this.stopped) return 0;
    const deliveries = await claimPromotionDeliveries(this.pool, {
      owner: this.options.owner,
      webhookIds: this.registry.ids(),
      limit: this.options.claimBatch,
      leaseMs: this.options.leaseMs,
    });
    const tasks = deliveries.map((delivery) => {
      const task = this.deliver(delivery);
      this.active.add(task);
      void task.finally(() => this.active.delete(task));
      return task;
    });
    await Promise.all(tasks);
    return deliveries.length;
  }

  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    let timeout: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      Promise.allSettled([...this.active]).then(() => 'drained' as const),
      new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), this.options.shutdownWaitMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (outcome === 'timeout') {
      for (const controller of this.controllers) controller.abort();
      await Promise.allSettled([...this.active]);
      this.logger.warn({
        event: 'promotion_worker_shutdown_timeout',
        reason,
        active: this.active.size,
      });
    }
    const released = await releasePromotionDeliveries(this.pool, this.options.owner);
    this.logger.info({ event: 'promotion_worker_stopped', reason, released });
  }

  private async runLoop(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.drainOnce();
    } catch {
      this.logger.error({ event: 'promotion_worker_drain_failed' });
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(() => { void this.runLoop(); }, this.options.pollMs);
      }
    }
  }

  private async deliver(delivery: ClaimedPromotionDelivery): Promise<void> {
    const webhook = this.registry.get(delivery.webhookId);
    if (!webhook) return;
    const event = Object.freeze({
      ...delivery.event,
      occurredAt: new Date(delivery.event.occurredAt),
      destinationScope: Object.freeze({ ...delivery.event.destinationScope }),
    });
    const eventId = event.eventId;
    const webhookId = delivery.webhookId;
    const controller = new AbortController();
    this.controllers.add(controller);
    this.logger.info({
      event: 'promotion_delivery_claimed',
      eventId,
      webhookId,
      attempt: delivery.attemptCount,
      pendingAgeMs: Math.max(0, Date.now() - delivery.event.occurredAt.getTime()),
      leaseRecovered: delivery.leaseRecovered,
    });

    let timer: NodeJS.Timeout | undefined;
    try {
      const callback = Promise.resolve().then(() => webhook.onPromoted(
        event,
        { signal: controller.signal },
      )).then(() => 'success' as const, () => 'failure' as const);
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          resolve('timeout');
          controller.abort();
        }, this.options.callbackTimeoutMs);
      });
      const shutdown = new Promise<'shutdown'>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve('shutdown'), { once: true });
      });
      const outcome = await Promise.race([callback, timeout, shutdown]);
      if (timer) clearTimeout(timer);

      if (outcome === 'success') {
        const acknowledged = await completePromotionDelivery(
          this.pool,
          eventId,
          webhookId,
          this.options.owner,
        );
        this.logger.info({
          event: 'promotion_delivery_succeeded',
          eventId,
          webhookId,
          attempt: delivery.attemptCount,
          acknowledged,
        });
        return;
      }
      if (outcome === 'shutdown' && this.stopped) return;

      const retryDelayMs = this.retryDelay(delivery.attemptCount);
      const state = await failPromotionDelivery(
        this.pool,
        eventId,
        webhookId,
        this.options.owner,
        {
          maxAttempts: this.options.maxAttempts,
          retryDelayMs,
          error: new Error('callback failed'),
        },
      );
      this.logger.warn({
        event: 'promotion_delivery_failed',
        eventId,
        webhookId,
        attempt: delivery.attemptCount,
        reason: outcome === 'timeout' ? 'timeout' : 'error',
        state,
        retryDelayMs: state === 'pending' ? retryDelayMs : undefined,
      });
    } finally {
      if (timer) clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  private retryDelay(attempt: number): number {
    const exponential = Math.min(
      this.options.maxBackoffMs,
      this.options.baseBackoffMs * (2 ** Math.max(0, attempt - 1)),
    );
    const jittered = Math.floor(exponential * (0.5 + this.random()));
    return Math.max(1, Math.min(this.options.maxBackoffMs, jittered));
  }
}
