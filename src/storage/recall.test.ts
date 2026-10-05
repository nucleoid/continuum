import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
