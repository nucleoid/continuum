import type pg from 'pg';
import type { RuntimeWorker } from '../api/runtime.js';
import type { PromotionWebhookRegistry } from '../extensions/promotion.js';
import {
  claimPromotionDeliveries,
  completePromotionDelivery,
  failPromotionDelivery,
  releasePromotionDeliveries,
  renewPromotionDeliveries,
  timeoutPromotionDelivery,
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

export interface PromotionWorkerStore {
  claim(
    pool: pg.Pool,
    input: { owner: string; webhookIds: readonly string[]; limit: number; leaseMs: number },
  ): Promise<ClaimedPromotionDelivery[]>;
  complete(
    pool: pg.Pool,
    eventId: string,
    webhookId: string,
    owner: string,
  ): Promise<boolean>;
  fail(
    pool: pg.Pool,
    eventId: string,
    webhookId: string,
    owner: string,
    input: { maxAttempts: number; retryDelayMs: number; error: unknown },
  ): Promise<'pending' | 'dead_letter' | 'lost_lease'>;
  timeout(
    pool: pg.Pool,
    eventId: string,
    webhookId: string,
    owner: string,
    input: { maxAttempts: number; retryDelayMs: number },
  ): Promise<'pending' | 'dead_letter' | 'lost_lease'>;
  release(
    pool: pg.Pool,
    owner: string,
    retained?: readonly ClaimedPromotionDelivery[],
  ): Promise<number>;
  renew(
    pool: pg.Pool,
    owner: string,
    deliveries: readonly ClaimedPromotionDelivery[],
    leaseMs: number,
  ): Promise<number>;
}

const defaultStore: PromotionWorkerStore = {
  claim: claimPromotionDeliveries,
  complete: completePromotionDelivery,
  fail: failPromotionDelivery,
  timeout: timeoutPromotionDelivery,
  release: releasePromotionDeliveries,
  renew: renewPromotionDeliveries,
};

export class PromotionEventWorker implements RuntimeWorker {
  private stopped = false;
  private started = false;
  private stopPromise?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private leaseTimer?: NodeJS.Timeout;
  private leaseRenewal?: Promise<void>;
  private readonly active = new Set<Promise<number>>();
  private readonly controllers = new Map<AbortController, ClaimedPromotionDelivery>();
  private readonly retainedLeases = new Map<string, ClaimedPromotionDelivery>();
  private readonly logger: PromotionWorkerLogger;
  private readonly random: () => number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: PromotionWebhookRegistry,
    private readonly options: PromotionWorkerOptions,
    private readonly store: PromotionWorkerStore = defaultStore,
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

  drainOnce(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    const operation = this.drainCycle();
    this.active.add(operation);
    void operation.then(
      () => this.active.delete(operation),
      () => this.active.delete(operation),
    );
    return operation;
  }

  stop(reason: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = this.stopWorker(reason);
    return this.stopPromise;
  }

  private async drainCycle(): Promise<number> {
    const deliveries = await this.store.claim(this.pool, {
      owner: this.options.owner,
      webhookIds: this.registry.ids(),
      limit: this.options.claimBatch,
      leaseMs: this.options.leaseMs,
    });
    if (this.stopped) return deliveries.length;
    const tasks = deliveries.map((delivery) => {
      return this.deliver(delivery);
    });
    await Promise.all(tasks);
    return deliveries.length;
  }

  private async stopWorker(reason: string): Promise<void> {
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
      for (const [controller, delivery] of this.controllers) {
        this.retainLease(delivery);
        controller.abort();
      }
      this.logger.warn({
        event: 'promotion_worker_shutdown_timeout',
        reason,
        active: this.controllers.size,
      });
    }
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    await this.leaseRenewal;
    const retained = [...this.retainedLeases.values()];
    const released = await this.store.release(this.pool, this.options.owner, retained);
    this.logger.info({
      event: 'promotion_worker_stopped', reason, released, retained: retained.length,
    });
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
    this.controllers.set(controller, delivery);
    this.ensureLeaseRenewal();
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

      if (outcome === 'timeout') {
        controller.abort();
        this.retainLease(delivery);
      }

      if (outcome === 'success') {
        const acknowledged = await this.store.complete(
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
      if (outcome === 'timeout') {
        const retryDelayMs = this.retryDelay(delivery.attemptCount);
        const state = await this.store.timeout(
          this.pool,
          eventId,
          webhookId,
          this.options.owner,
          { maxAttempts: this.options.maxAttempts, retryDelayMs },
        );
        this.logger.warn({
          event: 'promotion_delivery_timed_out',
          eventId,
          webhookId,
          attempt: delivery.attemptCount,
          leaseRetained: true,
          state,
          retryDelayMs: state === 'pending' ? retryDelayMs : undefined,
        });
        return;
      }
      if (outcome === 'shutdown' || this.stopped) return;
      const retryDelayMs = this.retryDelay(delivery.attemptCount);
      const state = await this.store.fail(
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
        reason: 'error',
        state,
        retryDelayMs: state === 'pending' ? retryDelayMs : undefined,
      });
    } finally {
      if (timer) clearTimeout(timer);
      this.controllers.delete(controller);
      if (this.controllers.size === 0 && this.leaseTimer) {
        clearTimeout(this.leaseTimer);
        this.leaseTimer = undefined;
      }
    }
  }

  private ensureLeaseRenewal(): void {
    if (this.leaseTimer || this.leaseRenewal) return;
    const renewalMs = Math.max(1, Math.floor(this.options.leaseMs / 3));
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = undefined;
      this.leaseRenewal = this.store.renew(
        this.pool,
        this.options.owner,
        [...this.controllers.values()],
        this.options.leaseMs,
      ).then(() => undefined, () => {
        this.logger.error({ event: 'promotion_worker_lease_renewal_failed' });
      }).finally(() => {
        this.leaseRenewal = undefined;
        if (this.controllers.size > 0) this.ensureLeaseRenewal();
      });
    }, renewalMs);
  }

  private retryDelay(attempt: number): number {
    const exponential = Math.min(
      this.options.maxBackoffMs,
      this.options.baseBackoffMs * (2 ** Math.max(0, attempt - 1)),
    );
    const jittered = Math.floor(exponential * (0.5 + this.random()));
    return Math.max(1, Math.min(this.options.maxBackoffMs, jittered));
  }

  private retainLease(delivery: ClaimedPromotionDelivery): void {
    this.retainedLeases.set(`${delivery.event.eventId}\u0000${delivery.webhookId}`, delivery);
  }
}
