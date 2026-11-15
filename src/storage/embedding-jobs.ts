import type pg from 'pg';
import { evidenceTransaction } from './evidence.js';
import { checkedProfile, type BudgetProfile, type DurableAttempt } from '../pipeline/budget.js';
import type { EmbeddingTarget } from '../embeddings/target.js';
import type { EmbeddingAttemptFailure, EmbeddingJobClaim, EmbeddingJobHydration, EmbeddingJobStore, EmbeddingPolicyIdentity } from './embedding-jobs-model.js';
import { EMBEDDING_WORKER_DEFAULTS } from './embedding-jobs-model.js';
import type { EmbeddingStatus } from './embedding-jobs-model.js';
import type { Queryable } from './queryable.js';

export interface EmbeddingInspection {
  embeddingStatus: EmbeddingStatus;
  embedded: boolean;
  attempts: number;
  acceptedAt: string | null;
  completedAt: string | null;
  nextAttemptAt: string | null;
}
export async function readEmbeddingStatus(client: Queryable, principalId: string, memoryId: string): Promise<EmbeddingInspection | null> {
  return (await client.query<{ result: EmbeddingInspection | null }>(
    'SELECT continuum_embedding_status($1,$2) AS result', [principalId, memoryId],
  )).rows[0].result;
}

/** Narrow claim-scoped capabilities, available only to the approved actual
 * worker LOGIN. Every call owns a bounded transaction and returns its client. */
export class SqlEmbeddingJobStore implements EmbeddingJobStore {
  private readonly settlements = new Map<string, { target: string; values: unknown[]; value: Record<string, unknown> }>();
  private readonly settling = new Map<string, Promise<boolean>>();
  unsettledAccounting(): boolean { return this.settlements.size > 0 || this.settling.size > 0; }
  constructor(private readonly pool: pg.Pool) {
    if (!Number.isInteger(pool.options.max) || pool.options.max! < 1 || pool.options.max! > 2
      || !Number.isInteger(pool.options.connectionTimeoutMillis) || pool.options.connectionTimeoutMillis! < 1
      || pool.options.connectionTimeoutMillis! > 5000) throw new TypeError('Embedding worker requires a bounded dedicated Pool');
  }
  private async operation<T>(sql: string, values: unknown[]): Promise<T> {
    return evidenceTransaction(this.pool, async client => {
      const result = await client.query<{ result: T }>(sql, values);
      if (result.rows.length !== 1 || !Object.hasOwn(result.rows[0], 'result')) throw new Error('Invalid embedding capability response');
      return result.rows[0].result;
    });
  }
  private transient(error: unknown): boolean {
    return ['08000','08003','08006','57P01','57P02','57P03','53300','57014','55P03','40P01','40001',
      'ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE'].includes(String((error as { code?: unknown })?.code));
  }
  /** Metadata-only retry of an ORIGINAL settlement, never another provider call.
   * A process crash still needs the documented proved-exit recovery boundary. */
  private reconcileSettlement(target: string): Promise<boolean> {
    const active = this.settling.get(target);
    if (active) return active;
    const next = [...this.settlements].find(([, entry]) => entry.target === target);
    if (!next) return Promise.resolve(true);
    const [id, entry] = next;
    const work = (async () => {
      try {
        await this.operation<boolean>('SELECT continuum_embedding_attempt($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
          [...entry.values, 'settle', entry.value, 0]);
        this.settlements.delete(id);
        return true;
      } catch { return false; }
      finally { this.settling.delete(target); }
    })();
    this.settling.set(target, work);
    return work;
  }
  async claim(target: EmbeddingTarget, policy: EmbeddingPolicyIdentity, owner: string, batchSize: number, profile: Readonly<BudgetProfile>): Promise<EmbeddingJobClaim | null> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 32) throw new TypeError('Invalid embedding claim bound');
    if (!await this.reconcileSettlement(target.fingerprint)) return null;
    return this.operation('SELECT continuum_embedding_claim($1,$2,$3,$4,$5) AS result',
      [target, policy, owner, batchSize, checkedProfile(profile)]);
  }
  private fence(claim: EmbeddingJobClaim): unknown[] { return [claim.id, claim.owner, claim.generation]; }
  hydrate(claim: EmbeddingJobClaim, maxBytes: number): Promise<EmbeddingJobHydration> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > EMBEDDING_WORKER_DEFAULTS.hydrationBytes) throw new TypeError('Invalid embedding hydration bound');
    return this.operation('SELECT continuum_embedding_hydrate($1,$2,$3,$4) AS result', [...this.fence(claim), maxBytes]);
  }
  renew(claim: EmbeddingJobClaim): Promise<boolean> {
    return this.operation('SELECT continuum_embedding_renew($1,$2,$3) AS result', this.fence(claim));
  }
  authorize(claim: EmbeddingJobClaim): Promise<boolean> {
    return this.operation('SELECT continuum_embedding_authorize($1,$2,$3) AS result', this.fence(claim));
  }
  attempt(claim: EmbeddingJobClaim): DurableAttempt {
    // Snapshot original identities. Reclaim must not replace these fields on a
    // previously dispatched attempt or release its ambiguous reservations.
    const values = [...this.fence(claim), claim.workflowId, claim.attemptId, claim.attemptOwner, claim.attemptGeneration];
    const target = claim.target, attemptId = claim.attemptId;
    const call = (phase: string, value: unknown = {}, retained = 0) => this.operation<boolean>(
      'SELECT continuum_embedding_attempt($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result', [...values, phase, value, retained]);
    const remember = (value: Record<string, unknown>) => {
      if (!this.settlements.has(attemptId) && this.settlements.size >= 64) throw new Error('Embedding settlement retention is full');
      this.settlements.set(attemptId, { target, values, value });
    };
    return { reserve: async (amount, retained) => {
      try { return await call('reserve', amount, retained); }
      catch (error) {
        // The caller has not invoked any provider before reserve returns.
        if (this.transient(error)) remember({ spendMicros: 0, outputBytes: 0, outputTokens: 0, reasoningTokens: 0, completionTokens: 0, provenance: 'measured' });
        throw error;
      }
    }, dispatch: () => call('dispatch'), settle: async (actual, provenance = 'unknown') => {
      const keys = Object.keys(actual);
      if (!['measured','provider-reported','estimated','unknown'].includes(provenance)
        || keys.some(key => !['spendMicros','outputBytes','outputTokens','reasoningTokens','completionTokens'].includes(key)
          || !Number.isSafeInteger(actual[key as keyof typeof actual]) || actual[key as keyof typeof actual]! < 0)) throw new TypeError('Invalid embedding settlement');
      const value = { ...actual, provenance };
      try { const result = await call('settle', value); this.settlements.delete(attemptId); return result; }
      catch (error) { if (this.transient(error)) remember(value); throw error; }
    } };
  }
  apply(claim: EmbeddingJobClaim, vectors: Array<{ id: string; vector: number[] }>): Promise<boolean> {
    return this.operation('SELECT continuum_embedding_apply($1,$2,$3,$4) AS result', [...this.fence(claim), JSON.stringify(vectors)]);
  }
  fail(claim: EmbeddingJobClaim, failure: EmbeddingAttemptFailure): Promise<boolean> {
    // Project only the closed safe taxonomy; never serialize error objects.
    const value = { code: failure.code, action: failure.action,
      ...('retryAfterMs' in failure && failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) };
    return this.operation('SELECT continuum_embedding_fail($1,$2,$3,$4) AS result', [...this.fence(claim), value]);
  }
  release(claim: EmbeddingJobClaim): Promise<boolean> {
    return this.operation('SELECT continuum_embedding_release($1,$2,$3) AS result', this.fence(claim));
  }
}
