import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { createMemory } from '../storage/memories.js';
import { recordRead } from './log.js';
import { queryAudit } from './query.js';

describe('recordRead', () => {
  let pool: pg.Pool;
  let principalId: string;
  let scopeId: string;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
    principalId = (await createPrincipal(pool, {
      externalId: 'audit-reader', kind: 'user', displayName: 'Audit Reader',
    })).id;
    scopeId = (await createScope(pool, { kind: 'team', name: 'audit-team' })).id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('preserves a request summary for zero returned memories', async () => {
    await recordRead(pool, {
      principalId,
      query: 'no matches',
      metadata: { hits: 0, transport: 'rest' },
      memories: [],
    });

    const { rows } = await pool.query(
      'SELECT memory_id, scope_id, query, metadata FROM audit_log ORDER BY id',
    );
    expect(rows).toEqual([{
      memory_id: null,
      scope_id: null,
      query: 'no matches',
      metadata: {
        hits: 0,
        transport: 'rest',
        record_kind: 'summary',
        request_id: expect.any(String),
      },
    }]);
  });

  it('writes one correlated identity row per distinct returned memory in one statement', async () => {
    const memory = await createMemory(pool, {
      scopeId, scopeKind: 'team', type: 'fact', title: 'Safe title',
      body: 'Sensitive body text', authorId: principalId, source: 'manual',
    });
    let auditInsertCount = 0;
    const observedPool = {
      query: async (...args: Parameters<pg.Pool['query']>) => {
        const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
        if (sql.includes('INSERT INTO audit_log')) auditInsertCount += 1;
        return pool.query(...args as [never]);
      },
    } as unknown as pg.Pool;

    await recordRead(observedPool, {
      principalId,
      query: 'sensitive query text',
      metadata: { hits: 1, transport: 'mcp' },
      memories: [
        { memoryId: memory.id, scopeId, metadata: { rank: 1, score: 0.5 } },
        { memoryId: memory.id, scopeId, metadata: { rank: 2, score: 0.4 } },
      ],
    });

    expect(auditInsertCount).toBe(1);
    const { rows } = await pool.query(
      'SELECT memory_id, scope_id, query, metadata FROM audit_log ORDER BY id',
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      memory_id: memory.id,
      scope_id: scopeId,
      query: null,
      metadata: {
        record_kind: 'result', transport: 'mcp', rank: 1, score: 0.5,
      },
    });
    expect(rows[1].metadata.request_id).toBe(rows[0].metadata.request_id);
    const serializedResult = JSON.stringify(rows[1]);
    expect(serializedResult).not.toContain('sensitive query text');
    expect(serializedResult).not.toContain('Sensitive body text');
    expect(serializedResult).not.toContain('Safe title');

    const readsOfMemory = await queryAudit(pool, { memoryId: memory.id });
    expect(readsOfMemory).toHaveLength(1);
    expect(readsOfMemory[0]).toMatchObject({
      principalId, action: 'read', memoryId: memory.id, scopeId,
    });
  });

  it('does not leave a summary or partial result rows when the batch fails', async () => {
    await expect(recordRead(pool, {
      principalId,
      query: 'atomic query',
      metadata: { hits: 2 },
      memories: [
        { memoryId: '00000000-0000-4000-8000-000000000001', scopeId },
        { memoryId: 'not-a-uuid', scopeId },
      ],
    })).rejects.toThrow();

    const { rows } = await pool.query('SELECT count(*)::int AS count FROM audit_log');
    expect(rows[0].count).toBe(0);
  });
});
