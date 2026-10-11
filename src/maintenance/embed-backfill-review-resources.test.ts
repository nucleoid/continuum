import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createMemory } from '../storage/memories.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { EmbeddingRegistry, ScopeEmbeddingRouter } from '../embeddings/router.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { runEmbeddingBackfill } from './embed-backfill.js';

const hydrationLimit = 4 * 1024 * 1024;
const vector = Array(768).fill(0.25) as number[];
const sqlText = (value: unknown) => typeof value === 'string' ? value : (value as { text?: string }).text ?? '';

function observedPool(pool: pg.Pool, observe: (client: pg.PoolClient, sql: string,
  execute: () => Promise<pg.QueryResult>) => Promise<pg.QueryResult>): pg.Pool {
  return { query: pool.query.bind(pool), connect: async () => {
    const client = await pool.connect();
    return new Proxy(client, { get(target, key) {
      if (key === 'query') return (...args: unknown[]) => observe(target, sqlText(args[0]),
        () => Reflect.apply(target.query, target, args) as Promise<pg.QueryResult>);
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } } as unknown as pg.Pool;
}

describe('embedding resource review', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => { await pool?.end(); });

  async function seed(name: string, count = 1) {
    const author = await createPrincipal(pool, { externalId: `resource:${name}`, kind: 'service', displayName: 'Author' });
    const scope = await createScope(pool, { kind: 'project', name });
    const memories = [];
    for (let index = 0; index < count; index++) memories.push(await createMemory(pool,
      { scopeId: scope.id, scopeKind: scope.kind, authorId: author.id, type: 'context',
        title: `Small ${index}`, body: 'small initial body', source: 'manual' }));
    return { scope, memories };
  }

  it('marks an oversized input without transferring its title or body', async () => {
    const { memories } = await seed('manual-no-hydration');
    await pool.query('UPDATE memories SET body=repeat(\'x\',$2::integer) WHERE id=$1::uuid',
      [memories[0].id, hydrationLimit + 128]);
    const embed = vi.fn(async (texts: string[]) => texts.map(() => vector));
    const provider: EmbeddingProvider = { id: 'test:manual-no-hydration', dim: 768, local: true, embed };
    let transferred = 0;
    const observed = observedPool(pool, async (_client, _sql, execute) => {
      const result = await execute();
      for (const row of result.rows) transferred += Buffer.byteLength(row.title ?? '') + Buffer.byteLength(row.body ?? '');
      return result;
    });
    const report = await runEmbeddingBackfill(observed, provider,
      { providerId: provider.id, markFailed: memories[0].id, maxRows: 10 });
    expect(report.failed).toBe(1);
    expect(embed).not.toHaveBeenCalled();
    expect(transferred).toBe(0);
    expect((await pool.query('SELECT disposition FROM embedding_backfill_failures WHERE memory_id=$1::uuid', [memories[0].id])).rows)
      .toEqual([{ disposition: 'durable' }]);
  });

  it('bounds aggregate hydration after two packed rows grow before their content query', async () => {
    const { memories } = await seed('growth-after-scan', 2);
    let grew = false;
    let peak = 0;
    const observed = observedPool(pool, async (_client, sql, execute) => {
      if (!grew && sql.includes('FROM memories m') && /m\.id\s*=\s*ANY\(/.test(sql)) {
        grew = true;
        await pool.query('UPDATE memories SET body=repeat(\'x\',$2::integer) WHERE id=ANY($1::uuid[])',
          [memories.map((memory) => memory.id), 3 * 1024 * 1024]);
      }
      const result = await execute();
      peak = Math.max(peak, result.rows.reduce((bytes, row) => bytes
        + Buffer.byteLength(row.title ?? '') + Buffer.byteLength(row.body ?? ''), 0));
      return result;
    });
    const provider: EmbeddingProvider = { id: 'test:growth-after-scan', dim: 768, local: true,
      embed: async (texts) => texts.map(() => vector) };
    const report = await runEmbeddingBackfill(observed, provider, { batchSize: 2, maxRows: 10 });
    expect(grew).toBe(true);
    expect(peak).toBeLessThanOrEqual(hydrationLimit);
    expect(report).toMatchObject({ embedded: 2, completed: true });
    expect((await pool.query('SELECT count(*)::int AS count FROM memory_embeddings')).rows).toEqual([{ count: 2 }]);
  });

  it('bounds a held memory lock before continuing to an unrelated provider', async () => {
    const locked = await seed('blocked-provider');
    await seed('healthy-provider');
    const blockedProvider: EmbeddingProvider = { id: 'test:blocked-provider', dim: 768, local: true,
      embed: async (texts) => texts.map(() => vector) };
    const healthyEmbed = vi.fn(async (texts: string[]) => texts.map(() => vector));
    const healthyProvider: EmbeddingProvider = { id: 'test:healthy-provider', dim: 768, local: false, embed: healthyEmbed };
    const routing = new ScopeEmbeddingRouter(new EmbeddingRegistry([['blocked', blockedProvider], ['healthy', healthyProvider]]),
      { default: 'blocked', rules: [{ match: { kind: 'project', name: 'healthy-provider' }, provider: 'healthy' }] });
    const blocker = await pool.connect();
    let workerPid = 0;
    let safetyFired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancellation: Promise<unknown> | undefined;
    let operation: ReturnType<typeof runEmbeddingBackfill> | undefined;
    let settled = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM memories WHERE id=$1::uuid FOR UPDATE', [locked.memories[0].id]);
      const blockerPid = Number((await blocker.query('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0].pid);
      const observed = observedPool(pool, async (client, sql, execute) => {
        if (sql.includes('locked_memory') && workerPid === 0) {
          workerPid = Number((await client.query('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0].pid);
        }
        return execute();
      });
      operation = runEmbeddingBackfill(observed, routing, { batchSize: 1, maxRows: 10 });
      void operation.then(() => { settled = true; }, () => { settled = true; });
      let blocked = false;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (workerPid && (await pool.query('SELECT $2::integer=ANY(pg_catalog.pg_blocking_pids($1::integer)) AS blocked',
          [workerPid, blockerPid])).rows[0].blocked) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      timer = setTimeout(() => {
        safetyFired = true;
        cancellation = pool.query('SELECT pg_catalog.pg_cancel_backend($1::integer)', [workerPid]);
        void cancellation.catch(() => undefined);
      }, 2_500);
      const report = await operation;
      expect(healthyEmbed).toHaveBeenCalledOnce();
      expect(report.embedded).toBe(1);
      expect(safetyFired).toBe(false);
    } finally {
      clearTimeout(timer);
      if (workerPid && !settled && !safetyFired) await pool.query('SELECT pg_catalog.pg_cancel_backend($1::integer)', [workerPid]);
      await cancellation;
      await blocker.query('ROLLBACK');
      await operation?.catch(() => undefined);
      blocker.release();
    }
  }, 15_000);
});
