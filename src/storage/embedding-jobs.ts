import type pg from 'pg';
import { evidenceTransaction } from './evidence.js';
import { checkedProfile, type BudgetProfile, type DurableAttempt } from '../pipeline/budget.js';
import type { EmbeddingTarget } from '../embeddings/target.js';
import type { EmbeddingAttemptFailure, EmbeddingJobClaim, EmbeddingJobHydration, EmbeddingJobStore, EmbeddingPolicyIdentity } from './embedding-jobs-model.js';
import { EMBEDDING_WORKER_DEFAULTS } from './embedding-jobs-model.js';

/** Preparation adapter for the private embedding SQL proposal. These functions
 * DO NOT exist in the published schema. No stock runtime instantiates this
 * adapter; migration, readiness, LOGIN binding and exact grants are pending.
 * Every function is claim-scoped and must implement its current gates in SQL. */
export class SqlEmbeddingJobStore implements EmbeddingJobStore {
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
  claim(target: EmbeddingTarget, policy: EmbeddingPolicyIdentity, owner: string, batchSize: number, profile: Readonly<BudgetProfile>): Promise<EmbeddingJobClaim | null> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 32) throw new TypeError('Invalid embedding claim bound');
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
    const call = (phase: string, value: unknown = {}, retained = 0) => this.operation<boolean>(
      'SELECT continuum_embedding_attempt($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result', [...values, phase, value, retained]);
    return { reserve: (amount, retained) => call('reserve', amount, retained), dispatch: () => call('dispatch'),
      settle: (actual, provenance = 'unknown') => call('settle', { ...actual, provenance }) };
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
