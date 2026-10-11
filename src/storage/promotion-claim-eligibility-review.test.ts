import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { createMemory } from './memories.js';
import { promoteMemoryWithAudit } from './promote.js';
import {
  claimPromotionDeliveries, completePromotionDelivery, renewPromotionDeliveries,
  type ClaimedPromotionDelivery,
} from './promotion-events.js';

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

describe('promotion claim eligibility review', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => pool?.end());

  async function seedExpiredClaim(): Promise<ClaimedPromotionDelivery> {
    const principal = await createPrincipal(pool, {
      externalId: `claim-review-${randomUUID()}`, kind: 'user', displayName: 'Claim Review',
    });
    const sourceScope = await createScope(pool, { kind: 'team', name: 'claim-review-source' });
    const destinationScope = await createScope(pool, { kind: 'project', name: 'claim-review-target' });
    await addMembership(pool, principal.id, sourceScope.id, 'writer');
    await addMembership(pool, principal.id, destinationScope.id, 'writer');
    const source = await createMemory(pool, {
      scopeId: sourceScope.id, scopeKind: sourceScope.kind, type: 'decision',
      title: 'Claim eligibility', body: 'A committed promotion.',
      authorId: principal.id, source: 'manual',
    });
    await promoteMemoryWithAudit(
      pool, principal.id, source.id, { kind: 'project', name: destinationScope.name }, {}, ['review-hook'],
    );
    const claims = await claimPromotionDeliveries(pool, {
      owner: 'previous-owner', webhookIds: ['review-hook'], limit: 1, leaseMs: 60_000,
    });
    expect(claims).toHaveLength(1);
    // Expiry is the supported recovery shape. Only fixture time is changed;
    // event identity, owner, attempts and generation all come from real claims.
    await pool.query(
      `UPDATE promotion_event_deliveries SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE event_id=$1::uuid AND webhook_id=$2::text`,
      [claims[0].event.eventId, claims[0].webhookId],
    );
    return claims[0];
  }

  it.each(['renewal', 'competing claim', 'completion'] as const)(
    'does not reclaim a stale materialized candidate after concurrent %s',
    async (change) => {
      const previous = await seedExpiredClaim();
      const controller = await pool.connect();
      const schema = (await controller.query<{ schema: string }>(
        'SELECT pg_catalog.current_schema() AS schema',
      )).rows[0].schema;
      const name = `claim_review_barrier_${randomUUID().replaceAll('-', '')}`;
      const functionName = `${identifier(schema)}.${identifier(name)}`;
      const key = BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 14)}`).toString();
      const controllerPid = (await controller.query<{ pid: number }>(
        'SELECT pg_catalog.pg_backend_pid() AS pid',
      )).rows[0].pid;
      let claimPid: number | undefined;
      let instrumentedCalls = 0;
      let pending: Promise<ClaimedPromotionDelivery[]> | undefined;
      let functionCreated = false;
      try {
        await controller.query(`CREATE FUNCTION ${functionName}(ranked_count BIGINT, barrier_key BIGINT)
          RETURNS BOOLEAN LANGUAGE plpgsql AS $review$
          BEGIN
            IF ranked_count <> 1 THEN RAISE EXCEPTION 'review fixture expected one ranked row'; END IF;
            PERFORM pg_catalog.pg_advisory_lock(barrier_key);
            PERFORM pg_catalog.pg_advisory_unlock(barrier_key);
            RETURN TRUE;
          END $review$`);
        functionCreated = true;
        await controller.query('SELECT pg_catalog.pg_advisory_lock($1::bigint)', [key]);

        const instrumentedPool = new Proxy(pool, {
          get(target, property, receiver) {
            if (property !== 'connect') return Reflect.get(target, property, receiver);
            return async () => {
              const client = await target.connect();
              claimPid = (await client.query<{ pid: number }>(
                'SELECT pg_catalog.pg_backend_pid() AS pid',
              )).rows[0].pid;
              await client.query("SET statement_timeout='10s'");
              const originalQuery = client.query;
              const originalRelease = client.release;
              client.query = new Proxy(originalQuery, {
                apply(query, thisArg, args: unknown[]) {
                  if (typeof args[0] === 'string' && args[0].includes('WITH ranked AS MATERIALIZED')) {
                    const sql = args[0];
                    expect(sql).toContain('), candidates AS (');
                    expect(sql).toContain('JOIN ranked r USING (event_id, webhook_id)');
                    expect(sql).toContain('WHERE r.webhook_rank <= $8');
                    // Keep the production query and its binds intact. The sole
                    // fixture addition consumes the entire real ranked CTE, then
                    // pauses its candidate path before LockRows can acquire d.
                    args[0] = sql.replace('), candidates AS (',
                      `), review_barrier AS MATERIALIZED (
                         SELECT ${functionName}(count(*), ${key}::bigint) AS released FROM ranked
                       ), candidates AS (`)
                      .replace('JOIN ranked r USING (event_id, webhook_id)',
                        'JOIN ranked r USING (event_id, webhook_id) CROSS JOIN review_barrier b')
                      .replace('WHERE r.webhook_rank <= $8', 'WHERE r.webhook_rank <= $8 AND b.released');
                    instrumentedCalls += 1;
                  }
                  return Reflect.apply(query, thisArg, args);
                },
              });
              client.release = () => {
                client.query = originalQuery;
                client.release = originalRelease;
                // This is a fixture-owned connection with a temporary timeout.
                originalRelease.call(client, true);
              };
              return client;
            };
          },
        });
        pending = claimPromotionDeliveries(instrumentedPool, {
          owner: 'stale-ranked-owner', webhookIds: ['review-hook'], limit: 1, leaseMs: 60_000,
        });
        void pending.catch(() => undefined);
        const deadline = Date.now() + 4_000;
        let reached = false;
        while (Date.now() < deadline) {
          if (claimPid !== undefined) {
            reached = (await pool.query<{ blocked: boolean }>(
              `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity
                 WHERE pid=$1::int AND wait_event='advisory'
                   AND $2::int=ANY(pg_catalog.pg_blocking_pids(pid))) AS blocked`,
              [claimPid, controllerPid],
            )).rows[0].blocked;
            if (reached) break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(reached, 'production claim must reach the post-ranking advisory barrier').toBe(true);
        expect(instrumentedCalls).toBe(1);

        if (change === 'renewal') {
          const renewed = await renewPromotionDeliveries(pool, 'previous-owner', [previous], 60_000);
          expect(renewed.renewed).toHaveLength(1);
        } else if (change === 'competing claim') {
          const newer = await claimPromotionDeliveries(pool, {
            owner: 'new-owner', webhookIds: ['review-hook'], limit: 1, leaseMs: 60_000,
          });
          expect(newer).toHaveLength(1);
          expect(newer[0].leaseGeneration).toBe(previous.leaseGeneration + 1);
        } else {
          expect(await completePromotionDelivery(pool, previous.event.eventId,
            previous.webhookId, 'previous-owner', previous.attemptCount, previous.leaseGeneration)).toBe(true);
        }
        const beforeResume = (await pool.query(
          `SELECT state,lease_owner,lease_expires_at,attempt_count,lease_generation,delivered_at
             FROM promotion_event_deliveries WHERE event_id=$1::uuid AND webhook_id=$2::text`,
          [previous.event.eventId, previous.webhookId],
        )).rows[0];
        await controller.query('SELECT pg_catalog.pg_advisory_unlock($1::bigint)', [key]);
        expect(await pending).toEqual([]);
        const afterResume = (await pool.query(
          `SELECT state,lease_owner,lease_expires_at,attempt_count,lease_generation,delivered_at
             FROM promotion_event_deliveries WHERE event_id=$1::uuid AND webhook_id=$2::text`,
          [previous.event.eventId, previous.webhookId],
        )).rows[0];
        expect(afterResume).toEqual(beforeResume);
      } finally {
        await controller.query('SELECT pg_catalog.pg_advisory_unlock($1::bigint)', [key]).catch(() => undefined);
        if (pending) await pending.catch(() => undefined);
        if (functionCreated) await controller.query(`DROP FUNCTION ${functionName}(BIGINT,BIGINT)`);
        controller.release();
      }
    },
    15_000,
  );
});
