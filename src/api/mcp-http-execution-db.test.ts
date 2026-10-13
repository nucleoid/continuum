import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { remoteExecutionContext } from './mcp-http-execution.js';

const pools: pg.Pool[] = [];
afterEach(async () => { await Promise.all(pools.splice(0).map(pool => pool.end())); });
const fixture = () => {
  if (!process.env.CONTINUUM_TEST_DATABASE_URL) throw new Error('Explicit isolated test database is required');
  const pool = new pg.Pool({ connectionString: process.env.CONTINUUM_TEST_DATABASE_URL,
    max: 1, connectionTimeoutMillis: 1000, statement_timeout: 1000, idleTimeoutMillis: 1000 });
  pools.push(pool);
  return { pool, context: remoteExecutionContext(pool, null) };
};
const queued = async (pool: pg.Pool) => {
  const deadline = Date.now() + 1000;
  while (!pool.waitingCount && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  expect(pool.waitingCount).toBe(1);
};

describe('real queued PostgreSQL request cancellation', () => {
  it('does not abort a healthy queued pool.query under the cancelled releaser scope', async () => {
    const { pool, context } = fixture();
    const owner = new AbortController(); const waiter = new AbortController();
    await context.run(owner.signal, async () => {
      const borrowed = await context.pool.connect();
      const work = context.run(waiter.signal, () => context.pool.query('SELECT 42 AS value'));
      // Attach rejection handling before releasing the queued callback.
      const result = work.then(value => ({ value }), error => ({ error }));
      await queued(pool); owner.abort(); borrowed.release();
      expect(await result).toEqual({ value: expect.objectContaining({ rows: [{ value: 42 }] }) });
    });
  });
  it('checks the cancelled queued caller rather than its healthy releaser before SQL', async () => {
    const { pool, context } = fixture();
    const owner = new AbortController(); const waiter = new AbortController();
    await context.run(owner.signal, async () => {
      const borrowed = await context.pool.connect();
      const work = context.run(waiter.signal, () => context.pool.query('SELECT 42 AS value'));
      const result = work.then(value => ({ value }), error => ({ error }));
      await queued(pool); waiter.abort(); borrowed.release();
      expect(await result).toEqual({ error: expect.objectContaining({ name: 'AbortError' }) });
    });
  });
  it('keeps a promise-borrowed client bound to its acquiring caller and permits rollback', async () => {
    const { pool, context } = fixture();
    const owner = new AbortController(); const waiter = new AbortController();
    const first = await context.run(owner.signal, () => context.pool.connect());
    const work = context.run(waiter.signal, () => context.pool.connect());
    await queued(pool); await context.run(owner.signal, async () => first.release());
    const borrowed = await work;
    try {
      waiter.abort();
      await context.run(owner.signal, async () => {
        let failure: unknown;
        try { await borrowed.query('SELECT 42'); } catch (error) { failure = error; }
        expect(failure).toMatchObject({ name: 'AbortError' });
        await borrowed.query('ROLLBACK');
      });
    } finally { borrowed.release(); }
  });
});

