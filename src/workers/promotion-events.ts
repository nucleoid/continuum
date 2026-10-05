import type pg from 'pg';
import type { RuntimeWorker } from '../api/runtime.js';
import type { PromotionWebhookRegistry } from '../extensions/promotion.js';
import {
  abandonPromotionDeliveries,
  claimPromotionDeliveries,
  completePromotionDelivery,
  failPromotionDelivery,
  releasePromotionDeliveries,
  renewPromotionDeliveries,
  timeoutPromotionDelivery,
  type ClaimedPromotionDelivery,
  type PromotionLeaseRenewalResult,
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
    input: {
      owner: string;
      webhookIds: readonly string[];
      limit: number;
      leaseMs: number;
      maxAttempts: number;
      excluded: readonly ClaimedPromotionDelivery[];
    },
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
  abandon(
    pool: pg.Pool,
    owner: string,
    deliveries: readonly ClaimedPromotionDelivery[],
  ): Promise<number>;
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
  ): Promise<PromotionLeaseRenewalResult | number>;
}

const defaultStore: PromotionWorkerStore = {
  abandon: abandonPromotionDeliveries,
  claim: claimPromotionDeliveries,
  complete: completePromotionDelivery,
  fail: failPromotionDelivery,
  timeout: timeoutPromotionDelivery,
  release: releasePromotionDeliveries,
  renew: renewPromotionDeliveries,
};

function deliveryKey(delivery: Pick<ClaimedPromotionDelivery, 'webhookId' | 'event'>): string {
  return `${delivery.event.eventId}\u0000${delivery.webhookId}`;
}

// Multiple workers can briefly coexist in one process during shutdown/startup handoff. Keep the
// callback fence process-wide so a lease expiry cannot start a second local callback while the
// first callback is still ignoring its AbortSignal.
const inFlightCallbacks = new Map<string, ClaimedPromotionDelivery>();

type CallbackOutcome = 'success' | 'failure' | 'not_started';

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
  private readonly ownershipLost = new Set<AbortController>();
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
    if (options.shutdownWaitMs >= options.leaseMs) {
      throw new Error('shutdownWaitMs must be less than leaseMs');
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
      maxAttempts: this.options.maxAttempts,
      excluded: [...inFlightCallbacks.values()],
    });
    if (this.stopped) {
      await this.abandonDeliveries(deliveries, 'promotion_worker_stopped_claim_abandoned');
      return deliveries.length;
    }
    const tasks = deliveries.map((delivery) => {
      return this.deliver(delivery);
    });
    const results = await Promise.allSettled(tasks);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) throw rejected.reason;
    return deliveries.length;
  }

  private async stopWorker(reason: string): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    const deadline = Date.now() + this.options.shutdownWaitMs;
    let timeout: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      Promise.allSettled([...this.active]).then(() => 'drained' as const),
      new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(
          () => resolve('timeout'),
          Math.max(0, deadline - Date.now()),
        );
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
    this.leaseTimer = undefined;
    if (this.leaseRenewal) {
      await this.beforeDeadline(this.leaseRenewal, deadline);
    }
    const retained = [...this.retainedLeases.values()];
    const release = this.store.release(this.pool, this.options.owner, retained);
    const released = await this.beforeDeadline(release, deadline);
    this.logger.info({
      event: 'promotion_worker_stopped',
      reason,
      released: released.settled ? released.value : undefined,
      retained: retained.length,
      databaseTimedOut: !released.settled,
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
    if (!webhook) {
      await this.abandonDeliveries([delivery], 'promotion_delivery_webhook_unavailable');
      return;
    }
    const event = Object.freeze({
      ...delivery.event,
      occurredAt: new Date(delivery.event.occurredAt),
      destinationScope: Object.freeze({ ...delivery.event.destinationScope }),
    });
    const eventId = event.eventId;
    const webhookId = delivery.webhookId;
    const key = deliveryKey(delivery);
    if (inFlightCallbacks.has(key)) {
      await this.abandonDeliveries([delivery], 'promotion_delivery_in_flight_abandoned');
      return;
    }
    const controller = new AbortController();
    this.controllers.set(controller, delivery);
    inFlightCallbacks.set(key, delivery);
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
    let lateFollower = false;
    try {
      let callback: Promise<CallbackOutcome>;
      if (this.stopped || controller.signal.aborted) {
        callback = Promise.resolve('not_started');
      } else {
        try {
          callback = Promise.resolve(webhook.onPromoted(
            event,
            { signal: controller.signal },
          )).then(() => 'success', () => 'failure');
        } catch {
          callback = Promise.resolve('failure');
        }
      }
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
        lateFollower = true;
        this.followLateCallback(delivery, controller, callback, 'timeout');
      }

      if (outcome === 'success') {
        this.finishCallback(delivery, controller);
        await this.persistCallbackOutcome(delivery, outcome);
        return;
      }
      if (outcome === 'timeout') {
        const retryDelayMs = this.retryDelay(delivery.attemptCount);
        let state: 'pending' | 'dead_letter' | 'lost_lease';
        try {
          state = await this.store.timeout(
            this.pool,
            eventId,
            webhookId,
            this.options.owner,
            { maxAttempts: this.options.maxAttempts, retryDelayMs },
          );
        } catch (error) {
          // The callback follower remains as an in-process fence, but a failed timeout write
          // must not keep extending an ownership claim the database never recorded.
          this.stopRenewingCallback(controller);
          throw error;
        }
        this.logger.warn({
          event: 'promotion_delivery_timed_out',
          eventId,
          webhookId,
          attempt: delivery.attemptCount,
          leaseRetained: true,
          state,
          retryDelayMs: state === 'pending' ? retryDelayMs : undefined,
        });
        // The durable timeout state controls when a pending row is claimable again. The
        // process-local callback fence remains until settlement, but a callback that ignores
        // abort must never cause unbounded lease extension.
        this.stopLeaseRenewal(controller);
        return;
      }
      if (outcome === 'shutdown' || this.stopped) {
        if (!this.ownershipLost.has(controller)) this.retainLease(delivery);
        lateFollower = true;
        this.followLateCallback(delivery, controller, callback, 'shutdown');
        return;
      }
      if (outcome === 'not_started') return;
      this.finishCallback(delivery, controller);
      await this.persistCallbackOutcome(delivery, outcome);
    } finally {
      if (timer) clearTimeout(timer);
      // A retained lease is only useful while an actual callback follower owns its cleanup.
      // Persistence errors before follower installation must never strand fences or renewals.
      if (!lateFollower) this.finishCallback(delivery, controller);
    }
  }

  private ensureLeaseRenewal(): void {
    if (this.stopped || this.leaseTimer || this.leaseRenewal) return;
    const renewalMs = Math.max(1, Math.floor(this.options.leaseMs / 3));
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = undefined;
      const deliveries = [...this.controllers.values()];
      this.leaseRenewal = this.renewLeases(deliveries, renewalMs).finally(() => {
        this.leaseRenewal = undefined;
        if (!this.stopped && this.controllers.size > 0) {
          this.ensureLeaseRenewal();
        }
      });
    }, renewalMs);
  }

  private async renewLeases(
    deliveries: readonly ClaimedPromotionDelivery[],
    timeoutMs: number,
  ): Promise<void> {
    if (deliveries.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const operation = Promise.resolve().then(() => this.store.renew(
      this.pool,
      this.options.owner,
      deliveries,
      this.options.leaseMs,
    ));
    const result = await Promise.race([
      operation.then(
        (renewal) => ({ state: 'settled' as const, renewal }),
        () => ({ state: 'failed' as const }),
      ),
      new Promise<{ state: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ state: 'timeout' }), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (result.state === 'settled' && typeof result.renewal !== 'number') {
      const terminalKeys = new Set(result.renewal.terminalOwned.map(deliveryKey));
      const lostKeys = new Set(result.renewal.lost.map(deliveryKey));
      for (const [controller, delivery] of [...this.controllers]) {
        const key = deliveryKey(delivery);
        if (terminalKeys.has(key)) this.stopLeaseRenewal(controller);
        else if (lostKeys.has(key)) this.abortForOwnershipLoss(controller);
      }
      if (lostKeys.size === 0) return;
    } else if (result.state === 'settled') {
      const activeKeys = new Set([...this.controllers.values()].map(deliveryKey));
      if ((result.renewal as number) >= activeKeys.size) return;
      for (const controller of [...this.controllers.keys()]) {
        this.abortForOwnershipLoss(controller);
      }
    } else {
      void operation.catch(() => undefined);
      for (const [controller, delivery] of [...this.controllers]) {
        this.retainLease(delivery);
        this.abortForOwnershipLoss(controller);
      }
    }
    this.logger.error({
      event: 'promotion_worker_lease_renewal_failed',
      reason: result.state,
      expected: deliveries.length,
      renewed: result.state === 'settled'
        ? typeof result.renewal === 'number'
          ? result.renewal
          : result.renewal.renewed.length
        : undefined,
    });
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
    this.retainedLeases.set(deliveryKey(delivery), delivery);
  }

  private followLateCallback(
    delivery: ClaimedPromotionDelivery,
    controller: AbortController,
    callback: Promise<CallbackOutcome>,
    abortReason: 'timeout' | 'shutdown',
  ): void {
    void callback.then(async (outcome) => {
      // The callback fence covers callback execution, not potentially unbounded persistence.
      // Once the callback settles, an expired lease may safely be retried at least once.
      this.finishCallback(delivery, controller);
      if (outcome === 'success') {
        await this.persistCallbackOutcome(delivery, outcome);
      } else if (outcome === 'failure' && abortReason === 'shutdown') {
        // A callback that rejects after this worker signalled shutdown is not evidence that the
        // consumer failed. Return the owned claim without charging an attempt so another worker
        // can make a clean delivery attempt.
        await this.abandonDeliveries(
          [delivery],
          'promotion_delivery_shutdown_abort_abandoned',
        );
      }
    }).catch(() => {
      this.logger.error({ event: 'promotion_delivery_late_settlement_failed' });
    }).finally(() => {
      this.finishCallback(delivery, controller);
    });
  }

  private async persistCallbackOutcome(
    delivery: ClaimedPromotionDelivery,
    outcome: Exclude<CallbackOutcome, 'not_started'>,
  ): Promise<void> {
    const eventId = delivery.event.eventId;
    const webhookId = delivery.webhookId;
    if (outcome === 'success') {
      const acknowledged = await this.store.complete(
        this.pool, eventId, webhookId, this.options.owner,
      );
      this.logger.info({
        event: 'promotion_delivery_succeeded', eventId, webhookId,
        attempt: delivery.attemptCount, acknowledged,
      });
      return;
    }
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
      event: 'promotion_delivery_failed', eventId, webhookId,
      attempt: delivery.attemptCount, reason: 'error', state,
      retryDelayMs: state === 'pending' ? retryDelayMs : undefined,
    });
  }

  private finishCallback(
    delivery: ClaimedPromotionDelivery,
    controller: AbortController,
  ): void {
    const key = deliveryKey(delivery);
    this.stopRenewingCallback(controller);
    this.retainedLeases.delete(key);
    inFlightCallbacks.delete(key);
  }

  private stopRenewingCallback(controller: AbortController): void {
    this.ownershipLost.delete(controller);
    this.controllers.delete(controller);
    if (this.controllers.size === 0 && this.leaseTimer) {
      clearTimeout(this.leaseTimer);
      this.leaseTimer = undefined;
    }
  }

  private stopLeaseRenewal(controller: AbortController): void {
    this.controllers.delete(controller);
    if (this.controllers.size === 0 && this.leaseTimer) {
      clearTimeout(this.leaseTimer);
      this.leaseTimer = undefined;
    }
  }

  private abortForOwnershipLoss(controller: AbortController): void {
    this.ownershipLost.add(controller);
    this.stopLeaseRenewal(controller);
    controller.abort();
  }

  private async abandonDeliveries(
    deliveries: readonly ClaimedPromotionDelivery[],
    event: string,
  ): Promise<void> {
    if (deliveries.length === 0) return;
    try {
      const abandoned = await this.store.abandon(this.pool, this.options.owner, deliveries);
      this.logger.warn({ event, deliveries: deliveries.length, abandoned });
    } catch {
      this.logger.error({ event: `${event}_failed`, deliveries: deliveries.length });
      throw new Error(event);
    }
  }

  private async beforeDeadline<T>(
    operation: Promise<T>,
    deadline: number,
  ): Promise<{ settled: true; value: T } | { settled: false }> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      void operation.catch(() => undefined);
      return { settled: false };
    }
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      operation.then(
        (value) => ({ settled: true as const, value }),
        () => ({ settled: false as const }),
      ),
      new Promise<{ settled: false }>((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), remainingMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return result;
  }
}
