import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { createMemory } from './memories.js';
import { storeMemoryEmbeddingVector } from './embeddings.js';
import { recall } from './recall.js';
import type { Queryable } from './queryable.js';

const vector = Array(768).fill(0.25) as number[];
const provider = { id: 'test:recall-review', dim: 768, local: true,
  embed: async (texts: string[]) => texts.map(() => vector) };

describe('embedding recall review', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => { await pool?.end(); });

  async function seed(db: Queryable, label: string, body: string) {
    const author = await createPrincipal(db, { externalId: `recall-review:${label}`, kind: 'service', displayName: 'Author' });
    const scope = await createScope(db, { kind: 'project', name: label });
    const memory = await createMemory(db, { scopeId: scope.id, scopeKind: scope.kind,
      authorId: author.id, type: 'fact', title: 'Reference', body, source: 'manual' });
    await storeMemoryEmbeddingVector(db, memory.id, vector, provider);
    return { memory, scope };
  }

  it('uses vectors through a checked-out client without committing its caller transaction', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const value = await seed(client, 'caller-owned', 'Unrelated reference text');
      const before = (await client.query("SELECT pg_catalog.current_setting('statement_timeout') AS timeout")).rows[0].timeout;
      const result = await recall(client, { query: 'semantic-only-probe', scopeIds: [value.scope.id], limit: 1,
        embeddingGroups: [{ scopeIds: [value.scope.id], provider }], embeddingDeadlineMs: 500 });
      expect(result.diagnostics.vector).toBe('used');
      expect(result.results.map((hit) => hit.memory.id)).toEqual([value.memory.id]);
      expect((await pool.query('SELECT count(*)::int AS count FROM memories WHERE id=$1::uuid', [value.memory.id])).rows)
        .toEqual([{ count: 0 }]);
      expect((await client.query("SELECT pg_catalog.current_setting('statement_timeout') AS timeout")).rows[0].timeout).toBe(before);
      await client.query('ROLLBACK');
      expect((await pool.query('SELECT count(*)::int AS count FROM memories WHERE id=$1::uuid', [value.memory.id])).rows)
        .toEqual([{ count: 0 }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  for (const failSecond of [false, true]) {
    it(`preserves caller transaction and locks across two vector groups ${failSecond ? 'with a SQL failure' : 'on success'}`, async () => {
      const client = await pool.connect();
      const observer = await pool.connect();
      const key = String(Date.now());
      const second = { ...provider, id: `${provider.id}:second` };
      let released = false;
      const borrowed = new Proxy(client, { get(target, property) {
        if (property === 'release') return (destroy?: boolean) => {
          released = true;
          target.release(destroy);
        };
        if (property === 'query') return async (...args: unknown[]) => {
          if (failSecond && typeof args[0] === 'string'
            && args[0].includes('WITH provider_embeddings AS MATERIALIZED')
            && (args[1] as unknown[] | undefined)?.[2] === second.id) {
            // An actual statement error must roll back only this group's work.
            return target.query('SELECT 1 / 0');
          }
          return Reflect.apply(target.query, target, args);
        };
        const member = Reflect.get(target, property);
        return typeof member === 'function' ? member.bind(target) : member;
      } });
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout='1s'");
        await client.query('SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)', [key]);
        const value = await seed(client, `two-groups-${failSecond}`, 'Uncommitted reference text');
        await storeMemoryEmbeddingVector(client, value.memory.id, vector, second);
        const result = await recall(borrowed, { query: 'semantic-only-probe', scopeIds: [value.scope.id], limit: 1,
          embeddingGroups: [{ scopeIds: [value.scope.id], provider }, { scopeIds: [value.scope.id], provider: second }],
          embeddingDeadlineMs: 500 });
        expect(result.diagnostics.vector).toBe(failSecond ? 'partial' : 'used');
        expect(result.diagnostics.groups.map((group) => group.status)).toEqual(failSecond ? ['used', 'failed'] : ['used', 'used']);
        expect(released).toBe(false);
        expect((await observer.query('SELECT count(*)::int AS count FROM memories WHERE id=$1::uuid', [value.memory.id])).rows)
          .toEqual([{ count: 0 }]);
        expect((await client.query('SELECT count(*)::int AS count FROM memories WHERE id=$1::uuid', [value.memory.id])).rows)
          .toEqual([{ count: 1 }]);
        expect((await client.query("SELECT pg_catalog.current_setting('statement_timeout') AS timeout")).rows)
          .toEqual([{ timeout: '1s' }]);
        expect((await observer.query('SELECT pg_catalog.pg_try_advisory_lock($1::bigint) AS acquired', [key])).rows)
          .toEqual([{ acquired: false }]);
        await client.query('ROLLBACK');
      } finally {
        await observer.query('SELECT pg_catalog.pg_advisory_unlock($1::bigint)', [key]);
        observer.release();
        if (!released) {
          await client.query('ROLLBACK');
          client.release();
        }
      }
    });
  }

  it('reserves only the remaining vector budget for distance SQL after a slow catalog lookup', async () => {
    const value = await seed(pool, 'shared-query-budget', 'Unique fallback needle');
    const base = (pool as unknown as { options: pg.PoolConfig }).options;
    const work = new pg.Pool({ ...base, max: 1, connectionTimeoutMillis: 1_000 });
    const blocker = await pool.connect();
    let vectorStarted = 0;
    let distanceBudget = 0;
    let remainingAtDistance = 0;
    let delayedCatalog = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE memory_embeddings IN ACCESS EXCLUSIVE MODE');
      const observed = { query: work.query.bind(work), connect: async () => {
        const client = await work.connect();
        return new Proxy(client, { get(target, key) {
          if (key === 'query') return async (...args: unknown[]) => {
            const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string }).text ?? '';
            if (sql.trim() === 'BEGIN') vectorStarted = Date.now();
            if (!delayedCatalog && sql.includes('FROM pg_catalog.pg_extension')) {
              delayedCatalog = true;
              await target.query('SELECT pg_catalog.pg_sleep(0.14)');
            }
            if (sql.includes('WITH provider_embeddings AS MATERIALIZED')) {
              distanceBudget = Number((await target.query("SELECT setting FROM pg_catalog.pg_settings WHERE name='statement_timeout'")).rows[0].setting);
              remainingAtDistance = Math.max(0, 200 - (Date.now() - vectorStarted));
            }
            return Reflect.apply(target.query, target, args);
          };
          const member = Reflect.get(target, key);
          return typeof member === 'function' ? member.bind(target) : member;
        } });
      } } as unknown as pg.Pool;
      const result = await recall(observed, { query: 'needle', scopeIds: [value.scope.id], limit: 1,
        embeddingGroups: [{ scopeIds: [value.scope.id], provider }], embeddingDeadlineMs: 200 });
      expect(delayedCatalog).toBe(true);
      expect(distanceBudget).toBeGreaterThan(0);
      expect(distanceBudget).toBeLessThanOrEqual(remainingAtDistance + 10);
      expect(result.diagnostics.vector).toBe('failed');
      expect(result.results.map((hit) => hit.memory.id)).toEqual([value.memory.id]);
      expect((await work.query('SELECT 1 AS ready')).rows).toEqual([{ ready: 1 }]);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await work.end();
    }
  }, 5_000);
});
