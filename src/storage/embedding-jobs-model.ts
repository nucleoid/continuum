import type { EmbeddingTarget } from '../embeddings/target.js';
import type { EmbeddingFailure } from '../embeddings/failure-policy.js';
import type { BudgetProfile, DurableAttempt } from '../pipeline/budget.js';

export const EMBEDDING_STATUSES = ['queued', 'processing', 'retry_wait', 'ready', 'not_configured',
  'blocked_policy', 'permanent_failure', 'cancelled', 'superseded'] as const;
export type EmbeddingStatus = typeof EMBEDDING_STATUSES[number];
export interface EmbeddingPolicyIdentity { generation: string; digest: string; }
export interface EmbeddingJobIdentity {
  id: string;
  memoryId: string;
  sourceGeneration: string;
  leaseGeneration: string;
}
/** Metadata only. Attempt identities are original durable accounting identities;
 * reclaim/requeue must not manufacture replacements for ambiguous calls. */
export interface EmbeddingJobClaim {
  id: string;
  owner: string;
  generation: string;
  target: string;
  policyGeneration: string;
  policyDigest: string;
  workflowId: string;
  attemptId: string;
  attemptOwner: string;
  attemptGeneration: number;
  retry: boolean;
  remainingMs: number;
  jobs: EmbeddingJobIdentity[];
}
export interface EmbeddingJobInput { id: string; title: string; body: string; }
export interface EmbeddingJobHydration {
  items: EmbeddingJobInput[];
  /** Oversize disposition is committed without loading the body. */
  oversized: string[];
}
export type EmbeddingAttemptFailure = EmbeddingFailure | { code: 'EMBEDDING_STORAGE' | 'EMBEDDING_BUDGET'
  | 'EMBEDDING_POLICY' | 'EMBEDDING_CANCELLED'; action: 'retry' };

/** Narrow bound-LOGIN SQL capability port. None of these methods is an
 * authenticated service API. Implementations must release DB clients before
 * provider work, use fresh DB time, and perform current gates in SQL. */
export interface EmbeddingJobStore {
  /** Local metadata-only accounting debt still blocks truthful clean shutdown. */
  unsettledAccounting?(): boolean;
  claim(target: EmbeddingTarget, policy: EmbeddingPolicyIdentity, owner: string, batchSize: number, profile: Readonly<BudgetProfile>): Promise<EmbeddingJobClaim | null>;
  hydrate(claim: EmbeddingJobClaim, maxBytes: number): Promise<EmbeddingJobHydration>;
  renew(claim: EmbeddingJobClaim): Promise<boolean>;
  authorize(claim: EmbeddingJobClaim): Promise<boolean>;
  attempt(claim: EmbeddingJobClaim): DurableAttempt;
  /** Atomic vector + server-owned related merge + completion audit. SQL repeats
   * source/expiry/privacy/policy/vector-space/lease gates under locks. */
  apply(claim: EmbeddingJobClaim, vectors: Array<{ id: string; vector: number[] }>): Promise<boolean>;
  fail(claim: EmbeddingJobClaim, failure: EmbeddingAttemptFailure): Promise<boolean>;
  /** Release only undispatched claims. Ambiguous dispatched attempts keep their
   * original reservations and are reconciled using actual settlement evidence. */
  release(claim: EmbeddingJobClaim): Promise<boolean>;
}

export const EMBEDDING_WORKER_DEFAULTS = Object.freeze({ batchSize: 32, hydrationBytes: 4 * 1024 * 1024,
  leaseMs: 30_000, renewMs: 10_000, pollMs: 1000, shutdownMs: 5000, poolMax: 2 });

export function embeddingBatchSize(adapterMax = 32): number {
  if (!Number.isSafeInteger(adapterMax) || adapterMax < 1 || adapterMax > 1000) throw new TypeError('Invalid embedding batch capability');
  return Math.min(EMBEDDING_WORKER_DEFAULTS.batchSize, adapterMax);
}

/** Only operational timestamps/counts belong on authorized single-memory reads.
 * embedded is supplied from an exact current vector check, not job state alone. */
export function publicEmbeddingState(status: EmbeddingStatus, matchingVector: boolean): { embeddingStatus: EmbeddingStatus; embedded: boolean } {
  if (!EMBEDDING_STATUSES.includes(status)) throw new TypeError('Invalid embedding status');
  if (status === 'ready' && !matchingVector) throw new TypeError('Ready requires a matching current vector');
  return { embeddingStatus: status, embedded: matchingVector };
}
