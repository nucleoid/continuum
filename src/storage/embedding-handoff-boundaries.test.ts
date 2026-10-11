import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { createMemory } from './memories.js';
import { storeMemoryEmbeddingVector } from './embeddings.js';

describe('embedding handoff storage boundaries', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let original: { statement: string; lock: string };
  let checkedOut = false;
  const firstVector = Array(768).fill(0.25) as number[];
  const secondVector = Array(768).fill(0.5) as number[];

  beforeEach(async () => {
    checkedOut = false;
    pool ??= await makeTestPool();
    await resetData(pool);
    client = await pool.connect();
    checkedOut = true;
    original = (await client.query(
      `SELECT pg_catalog.current_setting('statement_timeout') AS statement,
              pg_catalog.current_setting('lock_timeout') AS lock`,
    )).rows[0];
    await client.query("SET statement_timeout='5s'; SET lock_timeout='1s'");
  }, 30_000);

  afterEach(async () => {
    if (!checkedOut) return;
    let discard = false;
    try {
      await client.query('SELECT pg_catalog.set_config(\'statement_timeout\',$1,FALSE), pg_catalog.set_config(\'lock_timeout\',$2,FALSE)',
        [original.statement, original.lock]);
    } catch (error) { discard = true; throw error; }
    finally { checkedOut = false; client.release(discard); }
  });
  afterAll(async () => { await pool?.end(); });

  async function memory() {
    const author = await createPrincipal(client, {
      externalId: 'embedding-handoff-author', kind: 'user', displayName: 'Author',
    });
    const scope = await createScope(client, { kind: 'project', name: 'embedding-handoff' });
    return createMemory(client, { scopeId: scope.id, scopeKind: scope.kind,
      type: 'fact', title: 'Eligible memory', body: 'Bounded fixture body',
      authorId: author.id, source: 'manual' });
  }

  it('keeps independent provider vectors for the same live memory', async () => {
    const value = await memory();
    await storeMemoryEmbeddingVector(client, value.id, firstVector, { id: 'test:provider-a', dim: 768 });
    await storeMemoryEmbeddingVector(client, value.id, secondVector, { id: 'test:provider-b', dim: 768 });
    const rows = await client.query(
      `SELECT provider,dim,CASE WHEN provider='test:provider-a'
           THEN embedding::text=$2::text ELSE embedding::text=$3::text END AS expected_vector
         FROM memory_embeddings WHERE memory_id=$1::uuid ORDER BY provider`,
      [value.id, `[${firstVector.join(',')}]`, `[${secondVector.join(',')}]`],
    );
    expect(rows.rows).toEqual([
      { provider: 'test:provider-a', dim: 768, expected_vector: true },
      { provider: 'test:provider-b', dim: 768, expected_vector: true },
    ]);
  });

  async function boundedWorker() {
    const worker = await pool.connect();
    const before = (await worker.query(`SELECT pg_catalog.current_setting('statement_timeout') AS statement,
      pg_catalog.current_setting('lock_timeout') AS lock`)).rows[0];
    await worker.query("SET statement_timeout='5s'; SET lock_timeout='1s'");
    const pid = (await worker.query('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0].pid as number;
    return { worker, pid, release: async () => {
      let discard = false;
      try {
        await worker.query("SELECT pg_catalog.set_config('statement_timeout',$1::text,FALSE),pg_catalog.set_config('lock_timeout',$2::text,FALSE)",
          [before.statement, before.lock]);
      } catch (error) { discard = true; throw error; }
      finally { worker.release(discard); }
    } };
  }

  async function waitForBlocked(pids: number[]) {
    const deadline = Date.now() + 750;
    while (Date.now() < deadline) {
      const result = await client.query(`SELECT count(*)::int AS blocked FROM pg_catalog.unnest($1::integer[]) pid
        WHERE pg_catalog.cardinality(pg_catalog.pg_blocking_pids(pid))>0`, [pids]);
      if (result.rows[0].blocked === pids.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Embedding writers did not reach the held-row barrier within 750ms');
  }

  it('persists simultaneous providers after a shared held-row barrier without a lock upgrade deadlock', async () => {
    const value = await memory();
    const first = await boundedWorker();
    const second = await boundedWorker();
    let writes: Promise<unknown>[] = [];
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM memories WHERE id=$1::uuid FOR UPDATE', [value.id]);
      writes = [storeMemoryEmbeddingVector(first.worker, value.id, firstVector, { id: 'test:provider-a', dim: 768 }),
        storeMemoryEmbeddingVector(second.worker, value.id, secondVector, { id: 'test:provider-b', dim: 768 })];
      const outcomes = Promise.allSettled(writes);
      await waitForBlocked([first.pid, second.pid]);
      await client.query('COMMIT');
      expect(await Promise.all(writes)).toEqual([true, true]);
      await outcomes;
      expect((await client.query('SELECT provider FROM memory_embeddings WHERE memory_id=$1::uuid ORDER BY provider', [value.id])).rows)
        .toEqual([{ provider: 'test:provider-a' }, { provider: 'test:provider-b' }]);
    } finally {
      await client.query('ROLLBACK');
      await Promise.allSettled(writes);
      await first.release(); await second.release();
    }
  });

  for (const change of ['expiry', 'archive'] as const) {
    it(`does not reinsert a vector when ${change} wins the held-row persistence race`, async () => {
      const value = await memory();
      const writer = await boundedWorker();
      let write: Promise<boolean> | undefined;
      try {
        if (change === 'expiry') {
          await client.query("UPDATE memories SET expires_at=pg_catalog.clock_timestamp()+INTERVAL '300 milliseconds' WHERE id=$1::uuid", [value.id]);
        }
        await client.query('BEGIN');
        await client.query('SELECT id FROM memories WHERE id=$1::uuid FOR UPDATE', [value.id]);
        write = storeMemoryEmbeddingVector(writer.worker, value.id, firstVector, { id: 'test:late-provider', dim: 768 });
        void write.catch(() => undefined);
        await waitForBlocked([writer.pid]);
        if (change === 'expiry') {
          const deadline = Date.now() + 750;
          let expired = false;
          while (Date.now() < deadline) {
            expired = (await client.query('SELECT expires_at<=pg_catalog.clock_timestamp() AS expired FROM memories WHERE id=$1::uuid',
              [value.id])).rows[0].expired;
            if (expired) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(expired).toBe(true);
        } else {
          await client.query("UPDATE memories SET state='archived' WHERE id=$1::uuid", [value.id]);
        }
        await client.query('COMMIT');
        expect(await write).toBe(false);
        expect((await client.query('SELECT count(*)::int AS count FROM memory_embeddings WHERE memory_id=$1::uuid', [value.id])).rows)
          .toEqual([{ count: 0 }]);
      } finally {
        await client.query('ROLLBACK');
        await write?.catch(() => undefined);
        await writer.release();
      }
    });
  }

  it('does not persist a vector for an expired live memory', async () => {
    const value = await memory();
    await client.query('UPDATE memories SET expires_at=pg_catalog.clock_timestamp()-INTERVAL \'1 second\' WHERE id=$1::uuid', [value.id]);
    expect((await client.query("SELECT state,expires_at<=pg_catalog.clock_timestamp() AS expired FROM memories WHERE id=$1::uuid", [value.id])).rows)
      .toEqual([{ state: 'live', expired: true }]);
    await storeMemoryEmbeddingVector(client, value.id, firstVector, { id: 'test:provider-a', dim: 768 });
    expect((await client.query('SELECT count(*)::int AS count FROM memory_embeddings WHERE memory_id=$1::uuid', [value.id])).rows)
      .toEqual([{ count: 0 }]);
  });

  it('retains the published archived-state persistence guard', async () => {
    const value = await memory();
    await client.query("UPDATE memories SET state='archived' WHERE id=$1::uuid", [value.id]);
    await storeMemoryEmbeddingVector(client, value.id, firstVector, { id: 'test:provider-a', dim: 768 })
      .catch((error: Error) => { expect(error.message).toMatch(/live memory/i); });
    // The public storage API may later choose a safe no-op. The published
    // database boundary must still reject an actual late INSERT.
    await expect(client.query(
      `INSERT INTO memory_embeddings(memory_id,provider,dim,embedding)
       VALUES($1::uuid,'test:provider-a',768,$2)`, [value.id, `[${firstVector.join(',')}]`],
    )).rejects.toThrow(/live memory/i);
    expect((await client.query('SELECT count(*)::int AS count FROM memory_embeddings WHERE memory_id=$1::uuid', [value.id])).rows)
      .toEqual([{ count: 0 }]);
  });

  it('retains dimension rejection before database access', async () => {
    const query = vi.fn();
    await expect(storeMemoryEmbeddingVector({ query } as never,
      '00000000-0000-4000-8000-000000000001', Array(384).fill(0), { id: 'test:wrong-dimension', dim: 384 }))
      .rejects.toThrow(/provider dimension.*768/i);
    expect(query).not.toHaveBeenCalled();
  });
});
