import type pg from 'pg';
import type { ScopeRef } from '../types.js';
import type { PromotionEvent } from '../extensions/promotion.js';
import type { Queryable } from './queryable.js';

export interface ClaimedPromotionDelivery {
  event: PromotionEvent;
  webhookId: string;
  attemptCount: number;
  leaseGeneration: number;
  leaseRecovered: boolean;
}

export interface PromotionLeaseRenewalResult {
  renewed: ClaimedPromotionDelivery[];
  terminalOwned: ClaimedPromotionDelivery[];
  lost: ClaimedPromotionDelivery[];
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

function parseLeaseGeneration(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('lease generation is outside the supported range');
  }
  return parsed;
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
  input: {
    owner: string;
    webhookIds: readonly string[];
    limit: number;
    leaseMs: number;
    maxAttempts?: number;
    perWebhookLimit?: number;
    excluded?: readonly Pick<ClaimedPromotionDelivery, 'webhookId' | 'event'>[];
  },
): Promise<ClaimedPromotionDelivery[]> {
  if (!input.owner || input.owner.length > 128) throw new Error('owner must be 1 to 128 characters');
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error('limit must be between 1 and 100');
  }
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) {
    throw new Error('leaseMs must be positive');
  }
  const maxAttempts = input.maxAttempts ?? 10;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be positive');
  }
  const perWebhookLimit = input.perWebhookLimit ?? input.limit;
  if (!Number.isSafeInteger(perWebhookLimit) || perWebhookLimit < 1 || perWebhookLimit > 100) {
    throw new Error('perWebhookLimit must be between 1 and 100');
  }
  if (input.webhookIds.length === 0) return [];
  const excludedEventIds = (input.excluded ?? []).map((delivery) => delivery.event.eventId);
  const excludedWebhookIds = (input.excluded ?? []).map((delivery) => delivery.webhookId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE promotion_event_deliveries
          SET state = 'dead_letter', dead_lettered_at = now(),
              last_error = 'maximum attempts exhausted after interrupted delivery',
              lease_owner = NULL, lease_expires_at = NULL
        WHERE state = 'pending'
          AND available_at <= now()
          AND (lease_expires_at IS NULL OR lease_expires_at <= now())
          AND webhook_id = ANY($1::text[])
          AND attempt_count >= $2
          AND (event_id, webhook_id) NOT IN (
            SELECT * FROM unnest($3::uuid[], $4::text[])
          )`,
      [
        [...new Set(input.webhookIds)].sort(),
        maxAttempts,
        excludedEventIds,
        excludedWebhookIds,
      ],
    );
    const { rows } = await client.query<PromotionEventRow & {
      webhook_id: string;
      attempt_count: number;
      lease_generation: string;
      lease_recovered: boolean;
    }>(
      `WITH ranked AS MATERIALIZED (
         SELECT d.event_id, d.webhook_id,
                row_number() OVER (
                  PARTITION BY d.webhook_id
                  ORDER BY d.available_at, d.event_id
                ) AS webhook_rank
           FROM promotion_event_deliveries d
          WHERE d.state = 'pending'
            AND d.available_at <= now()
            AND (d.lease_expires_at IS NULL OR d.lease_expires_at <= now())
            AND d.webhook_id = ANY($2::text[])
            AND d.attempt_count < $5
            AND (d.event_id, d.webhook_id) NOT IN (
              SELECT * FROM unnest($6::uuid[], $7::text[])
            )
       ), candidates AS (
         SELECT d.event_id, d.webhook_id,
                (d.lease_expires_at IS NOT NULL) AS lease_recovered
           FROM promotion_event_deliveries d
           JOIN ranked r USING (event_id, webhook_id)
          WHERE r.webhook_rank <= $8
          ORDER BY d.available_at, d.event_id, d.webhook_id
          FOR UPDATE OF d SKIP LOCKED
          LIMIT $3
       ), claimed AS (
         UPDATE promotion_event_deliveries d
            SET lease_owner = $1,
                lease_expires_at = now() + ($4 * interval '1 millisecond'),
                attempt_count = d.attempt_count + 1,
                lease_generation = d.lease_generation + 1
           FROM candidates c
          WHERE d.event_id = c.event_id AND d.webhook_id = c.webhook_id
          RETURNING d.event_id, d.webhook_id, d.attempt_count, d.lease_generation,
                    c.lease_recovered
       )
       SELECT e.*, c.webhook_id, c.attempt_count, c.lease_generation, c.lease_recovered
         FROM claimed c
         JOIN promotion_events e ON e.id = c.event_id
        ORDER BY c.webhook_id`,
      [
        input.owner,
        [...new Set(input.webhookIds)].sort(),
        input.limit,
        input.leaseMs,
        maxAttempts,
        excludedEventIds,
        excludedWebhookIds,
        perWebhookLimit,
      ],
    );
    await client.query('COMMIT');
    return rows.map((row) => ({
      event: rowToEvent(row),
      webhookId: row.webhook_id,
      attemptCount: row.attempt_count,
      leaseGeneration: parseLeaseGeneration(row.lease_generation),
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
  attemptCount: number,
  leaseGeneration: number,
): Promise<boolean> {
  const result = await queryable.query(
    `UPDATE promotion_event_deliveries
        SET state = 'delivered', delivered_at = now(),
            lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
      WHERE event_id = $1 AND webhook_id = $2
        AND state IN ('pending', 'dead_letter')
        AND lease_owner = $3 AND attempt_count = $4 AND lease_generation = $5`,
    [eventId, webhookId, owner, attemptCount, leaseGeneration],
  );
  return result.rowCount === 1;
}

export async function failPromotionDelivery(
  queryable: Queryable,
  eventId: string,
  webhookId: string,
  owner: string,
  input: {
    maxAttempts: number;
    retryDelayMs: number;
    error: unknown;
    attemptCount: number;
    leaseGeneration: number;
  },
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
        AND lease_owner = $3 AND attempt_count = $6 AND lease_generation = $7
      RETURNING state`,
    [
      eventId, webhookId, owner, input.maxAttempts, input.retryDelayMs,
      input.attemptCount, input.leaseGeneration,
    ],
  );
  return rows[0]?.state ?? 'lost_lease';
}

export async function timeoutPromotionDelivery(
  queryable: Queryable,
  eventId: string,
  webhookId: string,
  owner: string,
  input: {
    maxAttempts: number;
    retryDelayMs: number;
    attemptCount: number;
    leaseGeneration: number;
  },
): Promise<'pending' | 'dead_letter' | 'lost_lease'> {
  const { rows } = await queryable.query<{ state: 'pending' | 'dead_letter' }>(
    `UPDATE promotion_event_deliveries
        SET state = CASE WHEN attempt_count >= $4 THEN 'dead_letter' ELSE 'pending' END,
            available_at = CASE WHEN attempt_count >= $4 THEN available_at
                                ELSE GREATEST(
                                  now() + ($5 * interval '1 millisecond'),
                                  lease_expires_at
                                ) END,
            dead_lettered_at = CASE WHEN attempt_count >= $4 THEN now() ELSE NULL END,
            last_error = 'callback timed out'
      WHERE event_id = $1 AND webhook_id = $2 AND state = 'pending'
        AND lease_owner = $3 AND attempt_count = $6 AND lease_generation = $7
      RETURNING state`,
    [
      eventId, webhookId, owner, input.maxAttempts, input.retryDelayMs,
      input.attemptCount, input.leaseGeneration,
    ],
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
  retained: readonly Pick<
    ClaimedPromotionDelivery,
    'webhookId' | 'event' | 'attemptCount' | 'leaseGeneration'
  >[] = [],
): Promise<number> {
  const retainedEventIds = retained.map((delivery) => delivery.event.eventId);
  const retainedWebhookIds = retained.map((delivery) => delivery.webhookId);
  const retainedAttemptCounts = retained.map((delivery) => delivery.attemptCount);
  const retainedLeaseGenerations = retained.map((delivery) => delivery.leaseGeneration);
  const result = await queryable.query(
    `UPDATE promotion_event_deliveries
        SET lease_owner = NULL, lease_expires_at = NULL,
            available_at = GREATEST(available_at, now())
      WHERE state = 'pending' AND lease_owner = $1
        AND NOT EXISTS (
          SELECT 1
            FROM unnest($2::uuid[], $3::text[], $4::integer[], $5::bigint[])
                 AS retained(event_id, webhook_id, attempt_count, lease_generation)
           WHERE retained.event_id = promotion_event_deliveries.event_id
             AND retained.webhook_id = promotion_event_deliveries.webhook_id
             AND retained.attempt_count = promotion_event_deliveries.attempt_count
             AND retained.lease_generation = promotion_event_deliveries.lease_generation
        )`,
    [
      owner, retainedEventIds, retainedWebhookIds,
      retainedAttemptCounts, retainedLeaseGenerations,
    ],
  );
  return result.rowCount ?? 0;
}

export async function abandonPromotionDeliveries(
  queryable: Queryable,
  owner: string,
  deliveries: readonly ClaimedPromotionDelivery[],
): Promise<number> {
  if (deliveries.length === 0) return 0;
  const eventIds = deliveries.map((delivery) => delivery.event.eventId);
  const webhookIds = deliveries.map((delivery) => delivery.webhookId);
  const attemptCounts = deliveries.map((delivery) => delivery.attemptCount);
  const leaseGenerations = deliveries.map((delivery) => delivery.leaseGeneration);
  const result = await queryable.query(
    `UPDATE promotion_event_deliveries AS target
        SET attempt_count = GREATEST(target.attempt_count - 1, 0),
            lease_owner = NULL,
            lease_expires_at = NULL,
            available_at = now()
       FROM unnest($2::uuid[], $3::text[], $4::integer[], $5::bigint[])
            AS abandoned(event_id, webhook_id, attempt_count, lease_generation)
      WHERE target.event_id = abandoned.event_id
        AND target.webhook_id = abandoned.webhook_id
        AND target.attempt_count = abandoned.attempt_count
        AND target.lease_generation = abandoned.lease_generation
        AND target.state = 'pending'
        AND (target.lease_owner = $1 OR target.lease_owner IS NULL)`,
    [owner, eventIds, webhookIds, attemptCounts, leaseGenerations],
  );
  return result.rowCount ?? 0;
}

export async function renewPromotionDeliveries(
  pool: pg.Pool,
  owner: string,
  deliveries: readonly ClaimedPromotionDelivery[],
  leaseMs: number,
): Promise<PromotionLeaseRenewalResult> {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new Error('leaseMs must be positive');
  }
  if (deliveries.length === 0) return { renewed: [], terminalOwned: [], lost: [] };
  const eventIds = deliveries.map((delivery) => delivery.event.eventId);
  const webhookIds = deliveries.map((delivery) => delivery.webhookId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      event_id: string;
      webhook_id: string;
      state: string;
      lease_owner: string | null;
      attempt_count: number;
      lease_generation: string;
    }>(
      `SELECT event_id, webhook_id, state, lease_owner, attempt_count, lease_generation
         FROM promotion_event_deliveries
        WHERE (event_id, webhook_id) IN (
          SELECT * FROM unnest($1::uuid[], $2::text[])
        )
        FOR UPDATE`,
      [eventIds, webhookIds],
    );
    const rowByKey = new Map(rows.map((row) => [
      `${row.event_id}\u0000${row.webhook_id}`,
      row,
    ]));
    const renewed: ClaimedPromotionDelivery[] = [];
    const terminalOwned: ClaimedPromotionDelivery[] = [];
    const lost: ClaimedPromotionDelivery[] = [];
    for (const delivery of deliveries) {
      const row = rowByKey.get(`${delivery.event.eventId}\u0000${delivery.webhookId}`);
      const exactOwner = row?.lease_owner === owner
        && row.attempt_count === delivery.attemptCount
        && Number(row.lease_generation) === delivery.leaseGeneration;
      if (row?.state === 'pending' && exactOwner) renewed.push(delivery);
      else if (row?.state !== 'pending' && exactOwner) {
        terminalOwned.push(delivery);
      } else lost.push(delivery);
    }
    if (renewed.length > 0) {
      await client.query(
        `UPDATE promotion_event_deliveries
            SET lease_expires_at = now() + ($2 * interval '1 millisecond')
          WHERE state = 'pending' AND lease_owner = $1
            AND (event_id, webhook_id) IN (
              SELECT * FROM unnest($3::uuid[], $4::text[])
            )`,
        [
          owner,
          leaseMs,
          renewed.map((delivery) => delivery.event.eventId),
          renewed.map((delivery) => delivery.webhookId),
        ],
      );
    }
    await client.query('COMMIT');
    return { renewed, terminalOwned, lost };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
