import pg from 'pg';
import { amounts, checkedProfile, type BudgetAmounts, type BudgetProfile, type DurableAttempt } from '../pipeline/budget.js';
import { ServiceError } from '../services/errors.js';

export interface BudgetWorkflow {
  id: string; owner: string; generation: number; profile: BudgetProfile;
  used: BudgetAmounts; active: number; retainedBytes: number; deadlineAt: string; cancelled: boolean;
}
/** Owned transactions only. Never commit or alter a borrowed caller connection. */
async function operation<T>(pool: pg.Pool, sql: string, values: unknown[]): Promise<T> {
  if (pool instanceof pg.Client || typeof (pool as unknown as pg.PoolClient).release === 'function') throw new TypeError('Pipeline accounting requires an owned Pool');
  const client = await pool.connect(); let discard = false;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_catalog.set_config('statement_timeout',CASE WHEN setting::bigint BETWEEN 1 AND 5000 THEN setting||'ms' ELSE '5000ms' END,TRUE) FROM pg_catalog.pg_settings WHERE name='statement_timeout'`);
    await client.query(`SELECT pg_catalog.set_config('lock_timeout',CASE WHEN setting::bigint BETWEEN 1 AND 1000 THEN setting||'ms' ELSE '1000ms' END,TRUE) FROM pg_catalog.pg_settings WHERE name='lock_timeout'`);
    const result = await client.query<{ result: T }>(sql, values);
    await client.query('COMMIT');
    return result.rows[0].result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}
function workflow(row: Record<string, unknown>): BudgetWorkflow {
  if (!row) throw new Error('Unknown pipeline workflow');
  return { id: String(row.id), owner: String(row.owner), generation: Number(row.generation),
    profile: checkedProfile(row.profile as BudgetProfile), used: amounts(row.used as BudgetAmounts),
    active: Number(row.active), retainedBytes: Number(row.retained_bytes), deadlineAt: String(row.deadline_at), cancelled: row.cancelled === true };
}
/** Trusted composition API, not an authenticated operator or caller endpoint. */
export async function createBudgetWorkflow(pool: pg.Pool, id: string, owner: string, profile: BudgetProfile): Promise<BudgetWorkflow> {
  return workflow(await operation(pool, 'SELECT continuum_pipeline_create($1,$2,$3) AS result', [id, owner, checkedProfile(profile)]));
}
export async function readBudgetWorkflow(pool: pg.Pool, id: string): Promise<BudgetWorkflow> {
  return workflow(await operation(pool, 'SELECT continuum_pipeline_read($1) AS result', [id]));
}
export async function fenceBudgetWorkflow(pool: pg.Pool, id: string, owner: string, generation: number, replacement: string, cancel = false): Promise<BudgetWorkflow> {
  return workflow(await operation(pool, 'SELECT continuum_pipeline_fence($1,$2,$3,$4,$5) AS result', [id, owner, generation, replacement, cancel]));
}
export function pipelineAttempt(pool: pg.Pool, identity: { id: string; attemptId: string; owner: string; generation: number }): DurableAttempt {
  const { id, attemptId, owner, generation } = { ...identity };
  return {
    reserve: (requested, retained) => operation(pool, 'SELECT continuum_pipeline_reserve($1,$2,$3,$4,$5,$6) AS result', [id, attemptId, owner, generation, amounts(requested), retained]),
    dispatch: () => operation(pool, 'SELECT continuum_pipeline_dispatch($1,$2,$3,$4) AS result', [id, attemptId, owner, generation]),
    settle: (actual) => operation(pool, 'SELECT continuum_pipeline_settle($1,$2,$3,$4,$5) AS result', [id, attemptId, owner, generation, actual]),
  };
}
/** Startup gate for compositions enabling durable stages. Stock stages stay disabled. */
export async function requirePipelineBudgetsReady(pool: pg.Pool): Promise<void> {
  // The profile gate verifies the owner-controlled function allowlist and runtime path.
  await operation(pool, 'SELECT continuum_assert_current_pgvector_profile() AS result', []);
  const ready = await operation<boolean>(pool, 'SELECT continuum_pipeline_budgets_is_ready() AS result', []);
  if (!ready) throw new ServiceError('DEPENDENCY_UNAVAILABLE', 'Pipeline accounting schema is incomplete');
}
