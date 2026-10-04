import type pg from 'pg';
import type { ScopeRef } from '../types.js';
import type { PromotionEvent } from '../extensions/promotion.js';
import type { Queryable } from './queryable.js';

export interface ClaimedPromotionDelivery {
  event: PromotionEvent;
  webhookId: string;
  attemptCount: number;
  leaseRecovered: boolean;
}

interface PromotionEventRow {
  id: string;
  source_memory_id: string;
  destination_memory_id: string;
  destination_scope_id: string;
  destination_scope_kind: ScopeRef['kind'];
  destination_scope_name: string;
  principal_id: string;
  occurred_at: Date;
}

function rowToEvent(row: PromotionEventRow): PromotionEvent {
  return {
    eventId: row.id,
    sourceId: row.source_memory_id,
    destinationId: row.destination_memory_id,
    destinationScopeId: row.destination_scope_id,
    destinationScope: {
      kind: row.destination_scope_kind,
      name: row.destination_scope_name,
    },
    principalId: row.principal_id,
    occurredAt: row.occurred_at,
  };
}

export async function enqueuePromotionEvent(
  queryable: Queryable,
  input: {
    sourceId: string;
    destinationId: string;
    destinationScopeId: string;
    destinationScope: ScopeRef;
    principalId: string;
    webhookIds: readonly string[];
  },
): Promise<PromotionEvent> {
  const { rows } = await queryable.query<PromotionEventRow>(
    `INSERT INTO promotion_events
       (source_memory_id, destination_memory_id, destination_scope_id,
        destination_scope_kind, destination_scope_name, principal_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.sourceId,
      input.destinationId,
      input.destinationScopeId,
      input.destinationScope.kind,
      input.destinationScope.name,
      input.principalId,
    ],
  );
  const webhookIds = [...new Set(input.webhookIds)].sort();
  if (webhookIds.length > 0) {
    await queryable.query(
      `INSERT INTO promotion_event_deliveries (event_id, webhook_id)
       SELECT $1, unnest($2::text[])`,
      [rows[0].id, webhookIds],
    );
  }
  return rowToEvent(rows[0]);
}

export async function claimPromotionDeliveries(
  pool: pg.Pool,
  input: { owner: string; webhookIds: readonly string[]; limit: number; leaseMs: number },
): Promise<ClaimedPromotionDelivery[]> {
  if (!input.owner || input.owner.length > 128) throw new Error('owner must be 1 to 128 characters');
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error('limit must be between 1 and 100');
  }
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) {
    throw new Error('leaseMs must be positive');
  }
  if (input.webhookIds.length === 0) return [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<PromotionEventRow & {
      webhook_id: string;
      attempt_count: number;
      lease_recovered: boolean;
    }>(
      `WITH candidates AS (
         SELECT d.event_id, d.webhook_id,
                (d.lease_expires_at IS NOT NULL) AS lease_recovered
           FROM promotion_event_deliveries d
          WHERE d.state = 'pending'
            AND d.available_at <= now()
            AND (d.lease_expires_at IS NULL OR d.lease_expires_at <= now())
            AND d.webhook_id = ANY($2::text[])
          ORDER BY d.available_at, d.event_id, d.webhook_id
          FOR UPDATE SKIP LOCKED
          LIMIT $3
       ), claimed AS (
         UPDATE promotion_event_deliveries d
            SET lease_owner = $1,
                lease_expires_at = now() + ($4 * interval '1 millisecond'),
                attempt_count = d.attempt_count + 1
           FROM candidates c
          WHERE d.event_id = c.event_id AND d.webhook_id = c.webhook_id
          RETURNING d.event_id, d.webhook_id, d.attempt_count,
                    c.lease_recovered
       )
       SELECT e.*, c.webhook_id, c.attempt_count, c.lease_recovered
         FROM claimed c
         JOIN promotion_events e ON e.id = c.event_id
        ORDER BY c.webhook_id`,
      [input.owner, [...new Set(input.webhookIds)].sort(), input.limit, input.leaseMs],
    );
    await client.query('COMMIT');
    return rows.map((row) => ({
      event: rowToEvent(row),
      webhookId: row.webhook_id,
      attemptCount: row.attempt_count,
      leaseRecovered: row.lease_recovered,
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function completePromotionDelivery(
  queryable: Queryable,
  eventId: string,
  webhookId: string,
  owner: string,
): Promise<boolean> {
  const result = await queryable.query(
    `UPDATE promotion_event_deliveries
        SET state = 'delivered', delivered_at = now(),
            lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
      WHERE event_id = $1 AND webhook_id = $2 AND state = 'pending'
        AND lease_owner = $3 AND lease_expires_at > now()`,
    [eventId, webhookId, owner],
  );
  return result.rowCount === 1;
}

export async function failPromotionDelivery(
  queryable: Queryable,
  eventId: string,
  webhookId: string,
  owner: string,
  input: { maxAttempts: number; retryDelayMs: number; error: unknown },
): Promise<'pending' | 'dead_letter' | 'lost_lease'> {
  const { rows } = await queryable.query<{ state: 'pending' | 'dead_letter' }>(
    `UPDATE promotion_event_deliveries
        SET state = CASE WHEN attempt_count >= $4 THEN 'dead_letter' ELSE 'pending' END,
            available_at = CASE WHEN attempt_count >= $4 THEN available_at
                                ELSE now() + ($5 * interval '1 millisecond') END,
            dead_lettered_at = CASE WHEN attempt_count >= $4 THEN now() ELSE NULL END,
            last_error = 'callback failed',
            lease_owner = NULL,
            lease_expires_at = NULL
      WHERE event_id = $1 AND webhook_id = $2 AND state = 'pending'
        AND lease_owner = $3
      RETURNING state`,
    [eventId, webhookId, owner, input.maxAttempts, input.retryDelayMs],
  );
  return rows[0]?.state ?? 'lost_lease';
}

export async function manualRetryPromotionDelivery(
  queryable: Queryable,
  eventId: string,
  webhookId: string,
): Promise<boolean> {
  const result = await queryable.query(
    `UPDATE promotion_event_deliveries
        SET state = 'pending', available_at = now(), attempt_count = 0,
            lease_owner = NULL, lease_expires_at = NULL,
            last_error = NULL, dead_lettered_at = NULL
      WHERE event_id = $1 AND webhook_id = $2 AND state = 'dead_letter'`,
    [eventId, webhookId],
  );
  return result.rowCount === 1;
}

export async function releasePromotionDeliveries(
  queryable: Queryable,
  owner: string,
): Promise<number> {
  const result = await queryable.query(
    `UPDATE promotion_event_deliveries
        SET lease_owner = NULL, lease_expires_at = NULL, available_at = now()
      WHERE state = 'pending' AND lease_owner = $1`,
    [owner],
  );
  return result.rowCount ?? 0;
}
