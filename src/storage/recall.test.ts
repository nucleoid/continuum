import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPrincipal } from './principals.js';
import { recall } from './recall.js';
import { createScope } from './scopes.js';
import { makeTestPool, resetData } from './test-helpers.js';
import { createMemory } from './memories.js';
import type { Queryable } from './queryable.js';

describe('recall expiry enforcement', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function seedMemory(title: string) {
    const principal = await createPrincipal(pool, {
      externalId: `service:${title}`,
      kind: 'service',
      displayName: title,
    });
    const scope = await createScope(pool, { kind: 'project', name: title });
    const memory = await createMemory(pool, {
      scopeId: scope.id,
      scopeKind: 'project',
      type: 'decision',
      title,
      body: `${title} searchable content`,
      authorId: principal.id,
      source: 'manual',
    });
    return { memory, scope };
  }

  it('drops a candidate that expires after ranking but before hydration', async () => {
    const { memory, scope } = await seedMemory('hydration race sentinel');
    await pool.query(
      `UPDATE memories SET expires_at = now() + interval '1 hour' WHERE id = $1`,
      [memory.id],
    );

    let expiredAfterRanking = false;
    const queryable = {
      query: async (text: string, params?: unknown[]) => {
        const result = await pool.query(text, params);
        if (!expiredAfterRanking && text.includes('ts_rank(')) {
          expect(result.rows.map((row) => row.id)).toContain(memory.id);
          await pool.query(
            `UPDATE memories SET expires_at = now() - interval '1 microsecond' WHERE id = $1`,
            [memory.id],
          );
          expiredAfterRanking = true;
        }
        return result;
      },
    } as unknown as Queryable;

    const { results } = await recall(queryable, {
      query: 'hydration race sentinel',
      scopeIds: [scope.id],
      limit: 10,
    });

    expect(expiredAfterRanking).toBe(true);
    expect(results).toEqual([]);
  });

  it('treats expires_at equal to the database transaction time as expired', async () => {
    const { memory, scope } = await seedMemory('boundary sentinel');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE memories SET expires_at = now() WHERE id = $1', [memory.id]);

      const { results } = await recall(client, {
        query: 'boundary sentinel',
        scopeIds: [scope.id],
        limit: 10,
      });

      expect(results).toEqual([]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('rechecks expiry against the wall clock inside a long-lived transaction', async () => {
    const { memory, scope } = await seedMemory('wall clock expiry sentinel');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE memories SET expires_at = clock_timestamp() + interval '20 milliseconds' WHERE id = $1`,
        [memory.id],
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      const { results } = await recall(client, {
        query: 'wall clock expiry sentinel', scopeIds: [scope.id], limit: 10,
      });
      expect(results).toEqual([]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('runs provider groups concurrently under one overall deadline', async () => {
    const { scope } = await seedMemory('concurrent groups');
    let resolveFirst!: (vectors: number[][]) => void;
    let resolveSecond!: (vectors: number[][]) => void;
    const first = {
      id: 'provider:first', dim: 768,
      embed: vi.fn(() => new Promise<number[][]>((resolve) => { resolveFirst = resolve; })),
    };
    const second = {
      id: 'provider:second', dim: 768,
      embed: vi.fn(() => new Promise<number[][]>((resolve) => { resolveSecond = resolve; })),
    };
    const pending = recall(pool, {
      query: 'concurrent groups', scopeIds: [scope.id], limit: 10,
      embeddingDeadlineMs: 1_000,
      embeddingGroups: [
        { scopeIds: [scope.id], provider: first },
        { scopeIds: [scope.id], provider: second },
      ],
    });
    for (let attempt = 0; attempt < 100 && second.embed.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    try {
      expect(first.embed).toHaveBeenCalledOnce();
      expect(second.embed).toHaveBeenCalledOnce();
    } finally {
      resolveFirst?.([Array(768).fill(0)]);
      resolveSecond?.([Array(768).fill(0)]);
    }
    await expect(pending).resolves.toMatchObject({ diagnostics: { vector: 'used' } });
  });

  it('returns settled provider results when another group exceeds the shared deadline', async () => {
    const { scope } = await seedMemory('shared deadline');
    const fast = { id: 'provider:fast', dim: 768, async embed() { return [Array(768).fill(0)]; } };
    const stuck = { id: 'provider:stuck', dim: 768, async embed() { return new Promise<number[][]>(() => undefined); } };
    const recalled = await recall(pool, {
      query: 'shared deadline', scopeIds: [scope.id], limit: 10,
      embeddingDeadlineMs: 100,
      embeddingGroups: [
        { scopeIds: [scope.id], provider: fast },
        { scopeIds: [scope.id], provider: stuck },
      ],
    });
    expect(recalled.diagnostics).toEqual({
      vector: 'partial',
      groups: [
        { provider: 'provider:fast', dim: 768, status: 'used' },
        { provider: 'provider:stuck', dim: 768, status: 'failed', errorCode: 'EMBEDDING_TIMEOUT' },
      ],
    });
  });

  it('cancels vector SQL inside the shared recall deadline', async () => {
    const { scope } = await seedMemory('bounded vector sql');
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE memory_embeddings IN ACCESS EXCLUSIVE MODE');
    const provider = {
      id: 'provider:sql-timeout', dim: 768,
      async embed() { return [Array(768).fill(0) as number[]]; },
    };
    const started = Date.now();
    try {
      const recalled = await recall(pool, {
        query: 'bounded vector sql', scopeIds: [scope.id], limit: 10,
        embeddingDeadlineMs: 100,
        embeddingGroups: [{ scopeIds: [scope.id], provider }],
      });
      expect(Date.now() - started).toBeLessThan(750);
      expect(recalled.diagnostics.groups).toEqual([
        { provider: provider.id, dim: 768, status: 'failed', errorCode: 'EMBEDDING_TIMEOUT' },
      ]);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it.each([
    [199, false],
    [200, false],
    [201, true],
  ])('marks a %i-character body truncation as %s', async (length, expected) => {
    const marker = 'boundary';
    const { memory, scope } = await seedMemory(`truncate ${length}`);
    const prefixLength = Math.floor((length - marker.length - 2) / 2);
    const body = `${'x'.repeat(prefixLength)} ${marker} ${'y'.repeat(length - prefixLength - marker.length - 2)}`;
    await pool.query('UPDATE memories SET body = $2 WHERE id = $1', [memory.id, body]);

    const { results: [result] } = await recall(pool, {
      query: marker, scopeIds: [scope.id], limit: 1,
    });

    expect(result).toBeDefined();
    expect(result.bodyTruncated).toBe(expected);
    expect(result.memory.body).toHaveLength(length);
    if (length > 200) expect(result.excerpt).toMatch(/^\.\.\./);
  });

  it('degrades a vector SQL failure to FTS with bounded diagnostics', async () => {
    const { memory, scope } = await seedMemory('vector sql fallback');
    const queryable = {
      query: async (text: string, params?: unknown[]) => {
        if (text.includes('FROM memory_embeddings')) throw new Error('password=private');
        return pool.query(text, params);
      },
    } as unknown as Queryable;
    const provider = {
      id: 'ollama:local', dim: 768, local: true,
      async embed() { return [Array(768).fill(0) as number[]]; },
    };

    const recalled = await recall(queryable, {
      query: 'vector sql fallback', scopeIds: [scope.id], limit: 10,
      embeddingGroups: [{ scopeIds: [scope.id], provider }],
    });

    expect(recalled.results.map((result) => result.memory.id)).toContain(memory.id);
    expect(recalled.diagnostics).toEqual({
      vector: 'failed',
      groups: [{ provider: 'ollama:local', dim: 768, status: 'failed', errorCode: 'VECTOR_SEARCH_FAILED' }],
    });
    expect(JSON.stringify(recalled.diagnostics)).not.toContain('private');
  });
});
