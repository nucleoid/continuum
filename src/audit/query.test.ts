import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { record } from './log.js';
import { queryAudit } from './query.js';

describe('queryAudit', () => {
  let pool: pg.Pool;
  let alice: string;
  let bob: string;
  let teamScope: string;
  let projectScope: string;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
    alice = (
      await createPrincipal(pool, {
        externalId: 'alice',
        kind: 'user',
        displayName: 'Alice',
      })
    ).id;
    bob = (
      await createPrincipal(pool, {
        externalId: 'bob',
        kind: 'user',
        displayName: 'Bob',
      })
    ).id;
    teamScope = (await createScope(pool, { kind: 'team', name: 'payments' })).id;
    projectScope = (await createScope(pool, { kind: 'project', name: 'booking-engine' })).id;

    await record(pool, { principalId: alice, action: 'read', scopeId: teamScope });
    await record(pool, { principalId: alice, action: 'write', scopeId: teamScope, memoryId: '00000000-0000-0000-0000-000000000001' });
    await record(pool, { principalId: bob, action: 'read', scopeId: projectScope });
    await record(pool, { principalId: bob, action: 'promote', scopeId: projectScope });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('returns all entries when no filter is applied', async () => {
    const rows = await queryAudit(pool, {});
    expect(rows).toHaveLength(4);
  });

  it('filters by principal', async () => {
    const rows = await queryAudit(pool, { principalId: alice });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.principalId === alice)).toBe(true);
  });

  it('filters by scope', async () => {
    const rows = await queryAudit(pool, { scopeId: projectScope });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.scopeId === projectScope)).toBe(true);
  });

  it('filters by action', async () => {
    const rows = await queryAudit(pool, { action: 'promote' });
    expect(rows).toHaveLength(1);
    expect(rows[0].principalId).toBe(bob);
  });

  it('filters by memoryId', async () => {
    const rows = await queryAudit(pool, {
      memoryId: '00000000-0000-0000-0000-000000000001',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('write');
  });

  it('orders by at DESC (most recent first)', async () => {
    const rows = await queryAudit(pool, {});
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].at.getTime()).toBeGreaterThanOrEqual(rows[i].at.getTime());
    }
  });

  it('honors limit and offset', async () => {
    const page1 = await queryAudit(pool, { limit: 2, offset: 0 });
    const page2 = await queryAudit(pool, { limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    const ids = [...page1, ...page2].map((r) => r.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('caps limit at 500', async () => {
    const rows = await queryAudit(pool, { limit: 100000 });
    expect(rows.length).toBeLessThanOrEqual(500);
  });

  it('filters by since/until time window', async () => {
    const allRows = await queryAudit(pool, {});
    const middleAt = allRows[Math.floor(allRows.length / 2)].at;

    const before = await queryAudit(pool, { until: middleAt });
    const after = await queryAudit(pool, { since: middleAt });

    expect(before.length + after.length).toBeGreaterThanOrEqual(allRows.length);
    expect(after.every((r) => r.at.getTime() >= middleAt.getTime())).toBe(true);
    expect(before.every((r) => r.at.getTime() < middleAt.getTime())).toBe(true);
  });

  it('compares offset timestamps by their UTC instants', async () => {
    await pool.query(
      `UPDATE audit_log
          SET at = CASE action
            WHEN 'read' THEN '2026-01-01T00:15:00Z'::timestamptz
            ELSE '2026-01-01T00:45:00Z'::timestamptz
          END
        WHERE principal_id = $1`,
      [alice],
    );

    const rows = await queryAudit(pool, {
      principalId: alice,
      since: new Date('2026-01-01T12:30:00+12:00'),
      until: new Date('2025-12-31T22:00:00-03:00'),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('write');
    expect(rows[0].at.toISOString()).toBe('2026-01-01T00:45:00.000Z');
  });
});
