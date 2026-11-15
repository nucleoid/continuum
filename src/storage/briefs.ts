import type pg from 'pg';
import { evidenceTransaction } from './evidence.js';
import type { DurableAttempt } from '../pipeline/budget.js';
import type { BriefSection } from '../briefs/model.js';

export async function briefOperation<T>(pool: pg.Pool, sql: string, values: unknown[], beforeCommit?: () => void): Promise<T> {
  return evidenceTransaction(pool, async client => {
    const value = (await client.query<{ result: T }>(sql, values)).rows[0].result;
    beforeCommit?.(); return value;
  });
}
export interface BriefClaimLease {
  outcome: 'claimed'; id: string; generation: number; attemptId: string; sections: BriefSection[]; remainingMs: number;
  candidates: number; hydratedBytes: number; storageBytes: number; retry: boolean;
}
export async function briefAttempt(pool: pg.Pool, lease: BriefClaimLease, worker: string,
  sections: BriefSection[]): Promise<{ id: string; durable: DurableAttempt }> {
  const id = await briefOperation<string>(pool, 'SELECT continuum_brief_budget($1,$2,$3,\'open\',$4,0) AS result',
    [lease.id, worker, lease.generation, JSON.stringify(sections)]);
  const call = (phase: string, value: unknown = {}, retained = 0) => briefOperation<boolean>(pool,
    'SELECT continuum_brief_budget($1,$2,$3,$4,$5,$6) AS result',
    [lease.id, worker, lease.generation, phase, { attemptId: id, amounts: value }, retained]);
  return { id, durable: { reserve: (values, retained) => call('reserve', values, retained), dispatch: () => call('dispatch'),
    settle: (values, provenance = 'unknown') => call('settle', { ...values, provenance }) } };
}
