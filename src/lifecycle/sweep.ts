import type pg from 'pg';
import { record as recordAudit } from '../audit/log.js';
import { LIFECYCLE_PRINCIPAL_ID } from './principal.js';

export const DEFAULT_LIFECYCLE_BATCH_SIZE = 100;
export const MAX_LIFECYCLE_BATCH_SIZE = 1000;

type TransitionKey = 'archive:context' | 'stale:fact' | 'stale:relationship';

interface CandidateRow {
  id: string;
  scope_id: string;
  type: 'context' | 'fact' | 'relationship';
  expires_at: Date;
}

export interface SweepBatchOptions {
  now?: Date;
  batchSize?: number;
  dryRun?: boolean;
}

export interface SweepBatchResult {
  selected: number;
  transitioned: number;
  counts: Partial<Record<TransitionKey, number>>;
}

export interface SweepResult extends SweepBatchResult {
  batches: number;
}

function checkedBatchSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIFECYCLE_BATCH_SIZE) {
    throw new RangeError(`batchSize must be an integer from 1 to ${MAX_LIFECYCLE_BATCH_SIZE}`);
  }
  return value;
}

function transitionKey(row: CandidateRow): TransitionKey {
  return row.type === 'context' ? 'archive:context' : `stale:${row.type}`;
}

export async function sweepLifecycleBatch(
  pool: pg.Pool,
  options: SweepBatchOptions = {},
): Promise<SweepBatchResult> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new RangeError('now must be a valid date');
  const batchSize = checkedBatchSize(options.batchSize ?? DEFAULT_LIFECYCLE_BATCH_SIZE);
  const client = await pool.connect();
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<CandidateRow>(
      `SELECT id, scope_id, type, expires_at
         FROM memories
        WHERE state = 'live'
          AND type IN ('context', 'fact', 'relationship')
          AND expires_at IS NOT NULL
          AND expires_at <= $1
        ORDER BY expires_at ASC, id ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [now, batchSize],
    );
    const counts: SweepBatchResult['counts'] = {};
    for (const row of rows) {
      const key = transitionKey(row);
      counts[key] = (counts[key] ?? 0) + 1;
    }

    if (options.dryRun) {
      await client.query('ROLLBACK');
      return { selected: rows.length, transitioned: 0, counts };
    }

    const principal = await client.query<{ id: string }>(
      `SELECT p.id
         FROM principals p
        WHERE p.id = $1
          AND p.external_id IS NULL
          AND p.kind = 'service'
          AND p.disabled_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM scope_memberships sm WHERE sm.principal_id = p.id
          )`,
      [LIFECYCLE_PRINCIPAL_ID],
    );
    const lifecyclePrincipalId = principal.rows[0]?.id;
    if (!lifecyclePrincipalId) {
      throw new Error('Lifecycle system principal is missing');
    }

    let transitioned = 0;
    for (const row of rows) {
      const nextState = row.type === 'context' ? 'archived' : 'stale';
      const update = await client.query(
        `UPDATE memories
            SET state = $2, updated_at = $3
          WHERE id = $1
            AND state = 'live'
            AND expires_at IS NOT NULL
            AND expires_at <= $3
          RETURNING id`,
        [row.id, nextState, now],
      );
      if (!update.rowCount) continue;
      if (nextState === 'archived') {
        await client.query('DELETE FROM memory_embeddings WHERE memory_id = $1', [row.id]);
      }
      await recordAudit(client, {
        principalId: lifecyclePrincipalId,
        action: nextState === 'archived' ? 'archive' : 'verify',
        memoryId: row.id,
        scopeId: row.scope_id,
        metadata: {
          source: 'lifecycle',
          transition: `live:${nextState}`,
          reason: 'expired',
          due_at: row.expires_at.toISOString(),
        },
      });
      transitioned += 1;
    }
    await client.query('COMMIT');
    return { selected: rows.length, transitioned, counts };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroyClient = true;
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
}

export async function previewLifecycle(
  pool: pg.Pool,
  now: Date = new Date(),
): Promise<SweepBatchResult> {
  if (!Number.isFinite(now.getTime())) throw new RangeError('now must be a valid date');
  const { rows } = await pool.query<{ key: TransitionKey; count: number }>(
    `SELECT CASE WHEN type = 'context' THEN 'archive:context'
                 ELSE 'stale:' || type END AS key,
            count(*)::int AS count
       FROM memories
      WHERE state = 'live'
        AND type IN ('context', 'fact', 'relationship')
        AND expires_at IS NOT NULL
        AND expires_at <= $1
      GROUP BY key
      ORDER BY key`,
    [now],
  );
  const counts: SweepBatchResult['counts'] = {};
  let selected = 0;
  for (const row of rows) {
    counts[row.key] = row.count;
    selected += row.count;
  }
  return { selected, transitioned: 0, counts };
}

export async function sweepLifecycle(
  pool: pg.Pool,
  options: Omit<SweepBatchOptions, 'dryRun'> = {},
): Promise<SweepResult> {
  const batchSize = checkedBatchSize(options.batchSize ?? DEFAULT_LIFECYCLE_BATCH_SIZE);
  const total: SweepResult = { selected: 0, transitioned: 0, counts: {}, batches: 0 };
  while (true) {
    const batch = await sweepLifecycleBatch(pool, { ...options, batchSize });
    total.batches += 1;
    total.selected += batch.selected;
    total.transitioned += batch.transitioned;
    for (const [key, count] of Object.entries(batch.counts) as Array<[TransitionKey, number]>) {
      total.counts[key] = (total.counts[key] ?? 0) + count;
    }
    if (batch.selected < batchSize) return total;
  }
}
