import type pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { dropIsolatedTestDatabase } from './test-helpers.js';

afterEach(() => vi.useRealTimers());

function fixture(options: {
  drop(attempt: number, statementMs: number): void;
  sessions?: (checks: number) => number;
  restoreError?: Error;
}) {
  let attempts = 0;
  let checks = 0;
  let statement = '30s';
  let lock = '250ms';
  const drops: Array<{ sql: string; statementMs: number; lock: string }> = [];
  const queries: string[] = [];
  const query = vi.fn(async (sql: string, values?: string[]) => {
    queries.push(sql);
    if (sql.includes('pg_catalog.current_setting')) return { rows: [{ statement: '30s', lock: '250ms',
      database: 'maintenance', statement_ms: '30000', lock_ms: '250' }] };
    if (sql.includes('pg_catalog.pg_stat_activity')) {
      checks += 1;
      return { rows: [{ sessions: options.sessions?.(checks) ?? 0 }] };
    }
    if (sql.includes("set_config('statement_timeout'")) {
      if (values?.[0] === '30s' && options.restoreError) throw options.restoreError;
      statement = values![0]; lock = values![1];
      return { rows: [] };
    }
    if (sql.startsWith('DROP DATABASE IF EXISTS')) {
      attempts += 1;
      const statementMs = Number.parseInt(statement, 10);
      drops.push({ sql, statementMs, lock });
      options.drop(attempts, statementMs);
      return { rows: [] };
    }
    throw new Error('Unexpected cleanup fixture SQL');
  });
  const release = vi.fn();
  const maintenance = { connect: vi.fn(async () => ({ query, release })) } as unknown as pg.Pool;
  return { maintenance, drops, queries, release, checks: () => checks,
    settings: () => ({ statement, lock }) };
}

it('retries canceled normal DROP safely with per-attempt caps, zero-session checks and exact setting restoration', async () => {
  const cancellations = [{ code: '57014' }, { code: '55P03' }];
  const state = fixture({ drop: (attempt) => { if (attempt <= 2) throw cancellations[attempt - 1]; } });
  await dropIsolatedTestDatabase(state.maintenance, 'fixture "quoted"');
  expect(state.drops).toEqual(Array.from({ length: 3 }, () => ({
    sql: 'DROP DATABASE IF EXISTS "fixture ""quoted"""', statementMs: 5000, lock: '250ms',
  })));
  expect(state.checks()).toBeGreaterThanOrEqual(4);
  expect(state.settings()).toEqual({ statement: '30s', lock: '250ms' });
  expect(state.release).toHaveBeenCalledTimes(1);
  expect(state.release).toHaveBeenCalledWith(false);
  expect(state.queries.every((sql) => !/\bFORCE\b|pg_(?:terminate|cancel)_backend/i.test(sql))).toBe(true);
});

it('stops repeated DROP cancellations within the aggregate budget and preserves the last server error', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
  const started = Date.now();
  const cancellation = Object.assign(new Error('bounded DROP canceled'), { code: '57014' });
  const state = fixture({ drop: (_attempt, statementMs) => {
    vi.setSystemTime(Date.now() + statementMs);
    throw cancellation;
  } });
  await expect(dropIsolatedTestDatabase(state.maintenance, 'fixture_budget')).rejects.toBe(cancellation);
  expect(state.drops.length).toBeGreaterThan(1);
  expect(state.drops.length).toBeLessThanOrEqual(12);
  expect(state.drops.every((drop) => drop.statementMs > 0 && drop.statementMs <= 5000)).toBe(true);
  expect(Date.now() - started).toBeLessThanOrEqual(60_000);
  expect(state.settings()).toEqual({ statement: '30s', lock: '250ms' });
  expect(state.release).toHaveBeenCalledTimes(1);
  expect(state.release).toHaveBeenCalledWith(false);
});

it('does not retry a terminal DROP error or force a newly active target session', async () => {
  const denied = Object.assign(new Error('DROP denied'), { code: '42501' });
  const terminal = fixture({ drop: () => { throw denied; } });
  await expect(dropIsolatedTestDatabase(terminal.maintenance, 'fixture_denied')).rejects.toBe(denied);
  expect(terminal.drops).toHaveLength(1);
  expect(terminal.settings()).toEqual({ statement: '30s', lock: '250ms' });
  const reconnecting = fixture({ sessions: (check) => check >= 3 ? 1 : 0,
    drop: () => { throw { code: '55P03' }; } });
  await expect(dropIsolatedTestDatabase(reconnecting.maintenance, 'fixture_reconnected'))
    .rejects.toThrow('acquired active sessions');
  expect(reconnecting.drops).toHaveLength(1);
  expect(reconnecting.queries.every((sql) => !/\bFORCE\b|pg_(?:terminate|cancel)_backend/i.test(sql))).toBe(true);
  expect(reconnecting.release).toHaveBeenCalledTimes(1);
  expect(reconnecting.release).toHaveBeenCalledWith(false);
});

it('discards on restoration failure while retaining the original DROP failure', async () => {
  const denied = Object.assign(new Error('DROP denied'), { code: '42501' });
  const restoration = new Error('session restore failed');
  const state = fixture({ drop: () => { throw denied; }, restoreError: restoration });
  const error = await dropIsolatedTestDatabase(state.maintenance, 'fixture_restore')
    .then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([denied, restoration]);
  expect((error as AggregateError).cause).toBe(denied);
  expect(state.release).toHaveBeenCalledTimes(1);
  expect(state.release).toHaveBeenCalledWith(true);
});

it('refuses the maintenance database before issuing any DROP', async () => {
  const state = fixture({ drop: () => { throw new Error('DROP must not be reached'); } });
  await expect(dropIsolatedTestDatabase(state.maintenance, 'maintenance')).rejects.toThrow('separate, nonempty');
  expect(state.drops).toHaveLength(0);
  expect(state.settings()).toEqual({ statement: '30s', lock: '250ms' });
  expect(state.release).toHaveBeenCalledTimes(1);
  expect(state.release).toHaveBeenCalledWith(false);
});


it('honors a finite caller-specific cleanup budget without changing per-statement limits', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
  const started = Date.now();
  const cancellation = Object.assign(new Error('bounded DROP canceled'), { code: '57014' });
  const state = fixture({ drop: (_attempt, statementMs) => {
    vi.setSystemTime(Date.now() + statementMs);
    throw cancellation;
  } });
  await expect(dropIsolatedTestDatabase(state.maintenance, 'fixture_checkpoint', {
    cleanupTimeoutMs: 90_000,
  })).rejects.toBe(cancellation);
  expect(state.drops.length).toBeGreaterThan(12);
  expect(state.drops.length).toBeLessThanOrEqual(18);
  expect(state.drops.every((drop) => drop.statementMs > 0 && drop.statementMs <= 5000
    && drop.lock === '250ms')).toBe(true);
  expect(Date.now() - started).toBeLessThanOrEqual(90_000);
  expect(state.settings()).toEqual({ statement: '30s', lock: '250ms' });
  expect(state.release).toHaveBeenCalledWith(false);
  expect(state.queries.every((sql) => !/\bFORCE\b|pg_(?:terminate|cancel)_backend/i.test(sql))).toBe(true);
});
