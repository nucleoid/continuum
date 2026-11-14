import type pg from 'pg';
import { evidenceTransaction } from './evidence.js';
import type { DurableAttempt, BudgetAmounts } from '../pipeline/budget.js';

/** Owned transactions with the same bounded SQL limits as evidence operations. */
export async function extractionOperation<T>(pool: pg.Pool, sql: string, values: unknown[]): Promise<T> {
  return evidenceTransaction(pool, async client => (await client.query<{ result: T }>(sql, values)).rows[0].result);
}
export interface ExtractionClaim {
  outcome: 'claimed'; id: string; generation: number; sourceVersion: string; sourceBytes: number; leaseUntil: string;
  workflow: { id: string; owner: string; generation: number; deadline_at: string; used: BudgetAmounts };
  attempts: Array<{ id: string; index: number; generation: number; state: string | null }>;
}
export function extractionAttempt(pool: pg.Pool, claim: ExtractionClaim, worker: string, attempt: string): DurableAttempt {
  const call = (phase: string, value: unknown = {}, retained = 0) => extractionOperation<boolean>(pool,
    'SELECT continuum_extraction_budget($1,$2,$3,$4,$5,$6,$7) AS result', [claim.id, worker, claim.generation, attempt, phase, value, retained]);
  return { reserve: (amount, retained) => call('reserve', amount, retained), dispatch: () => call('dispatch'),
    settle: (actual, provenance = 'unknown') => call('settle', { ...actual, provenance }) };
}
