import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { getMemoryForPrincipal, listMemoriesForPrincipal } from './memories.js';

describe('memory read service', () => {
  let pool: pg.Pool;
  let reader: Awaited<ReturnType<typeof createPrincipal>>;
  let author: Awaited<ReturnType<typeof createPrincipal>>;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
    reader = await createPrincipal(pool, {
      externalId: 'reader', kind: 'user', displayName: 'Reader',
    });
    author = await createPrincipal(pool, {
      externalId: 'author', kind: 'user', displayName: 'Original Author',
    });
  });

  afterAll(async () => { await pool?.end(); });

  it('returns complete records, current author names, implicit org reads, and one point audit', async () => {
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const memory = await createMemory(pool, {
      scopeId: org.id, scopeKind: 'org', type: 'decision', title: 'Complete',
      body: 'full private body', metadata: { key: 'value' }, tags: ['decision'],
      authorId: author.id, source: 'manual', sourceRef: 'private-source-ref',
    });
    await pool.query(
      `UPDATE principals SET display_name = 'Renamed Author' WHERE id = $1`, [author.id],
    );

    const result = await getMemoryForPrincipal(pool, reader, memory.id, { transport: 'test' });

    expect(result).toMatchObject({
      scope: 'org', authorDisplayName: 'Renamed Author',
      memory: {
        id: memory.id, body: 'full private body', metadata: { key: 'value' },
        tags: ['decision'], authorId: author.id, sourceRef: 'private-source-ref',
      },
    });
    const { rows } = await pool.query(
      `SELECT memory_id, scope_id, query, metadata FROM audit_log ORDER BY id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      memory_id: null,
      scope_id: null,
      query: null,
      metadata: {
        operation: 'get_memory', transport: 'test', record_kind: 'summary',
      },
    });
    expect(rows[1]).toMatchObject({
      memory_id: memory.id,
      scope_id: org.id,
      query: null,
      metadata: { rank: 1, transport: 'test', record_kind: 'result' },
    });
    expect(rows[1].metadata.request_id).toBe(rows[0].metadata.request_id);
    expect(JSON.stringify(rows)).not.toContain('full private body');
    expect(JSON.stringify(rows)).not.toContain('private-source-ref');
  });

  it('masks missing and forbidden valid UUIDs with the same error and no audit', async () => {
    const hidden = await createScope(pool, { kind: 'project', name: 'hidden' });
    const memory = await createMemory(pool, {
      scopeId: hidden.id, scopeKind: 'project', type: 'fact', title: 'Hidden',
      body: 'secret', authorId: author.id, source: 'manual',
    });
    const missing = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    for (const id of [memory.id, missing, '00000000-0000-0000-0000-000000000000']) {
      await expect(getMemoryForPrincipal(pool, reader, id)).rejects.toMatchObject({
        code: 'MEMORY_NOT_FOUND', status: 404, publicMessage: 'Memory not found',
      });
    }
    await expect(getMemoryForPrincipal(pool, reader, 'not-a-uuid')).rejects.toMatchObject({
      code: 'INVALID_INPUT', status: 400,
    });
    expect((await pool.query('SELECT 1 FROM audit_log')).rowCount).toBe(0);
  });

  it('browses only readable records with defaults, filters, stable ordering, and pagination', async () => {
    const readable = await createScope(pool, { kind: 'project', name: 'readable' });
    const hidden = await createScope(pool, { kind: 'project', name: 'hidden' });
    await addMembership(pool, reader.id, readable.id, 'reader');
    const older = await createMemory(pool, {
      scopeId: readable.id, scopeKind: 'project', type: 'decision', title: 'Older ID',
      body: 'first', authorId: author.id, source: 'manual',
    });
    const newer = await createMemory(pool, {
      scopeId: readable.id, scopeKind: 'project', type: 'decision', title: 'Newer ID',
      body: 'second', authorId: author.id, source: 'manual',
    });
    const stale = await createMemory(pool, {
      scopeId: readable.id, scopeKind: 'project', type: 'fact', title: 'Stale',
      body: 'stale', authorId: author.id, source: 'manual',
    });
    await createMemory(pool, {
      scopeId: hidden.id, scopeKind: 'project', type: 'decision', title: 'Hidden',
      body: 'hidden', authorId: author.id, source: 'manual',
    });
    const tied = new Date('2026-10-04T00:00:00Z');
    await pool.query('UPDATE memories SET updated_at = $1 WHERE id = ANY($2::uuid[])', [tied, [older.id, newer.id]]);
    await pool.query(`UPDATE memories SET state = 'stale' WHERE id = $1`, [stale.id]);

    const expected = [older.id, newer.id].sort().reverse();
    const defaults = await listMemoriesForPrincipal(pool, reader);
    expect(defaults.limit).toBe(50);
    expect(defaults.offset).toBe(0);
    expect(defaults.items.map((item) => item.memory.id)).toEqual(expected);
    const page = await listMemoriesForPrincipal(pool, reader, {
      scope: 'project:readable', type: 'decision', limit: 1, offset: 1,
    });
    expect(page.items.map((item) => item.memory.id)).toEqual([expected[1]]);
    const staleResult = await listMemoriesForPrincipal(pool, reader, { state: 'stale' });
    expect(staleResult.items.map((item) => item.memory.id)).toEqual([stale.id]);
    const audits = await pool.query(
      `SELECT metadata FROM audit_log WHERE metadata->>'operation' = 'list_memories'`,
    );
    expect(audits.rowCount).toBe(3);
    expect(JSON.stringify(audits.rows)).not.toContain('first');
    expect(JSON.stringify(audits.rows)).not.toContain('hidden');
    expect(JSON.stringify(audits.rows)).not.toContain('Original Author');
  });

  it('returns empty for unknown or inaccessible scopes and validates every filter', async () => {
    expect((await listMemoriesForPrincipal(pool, reader, { scope: 'project:unknown' })).items)
      .toEqual([]);
    for (const input of [
      { scope: 'bad' }, { type: 'bogus' }, { state: 'bogus' },
      { limit: 0 }, { limit: 101 }, { offset: -1 },
    ]) {
      await expect(listMemoriesForPrincipal(pool, reader, input as never)).rejects.toMatchObject({
        status: 400,
      });
    }
  });

  it('excludes the database-time expiry boundary before stable pagination and audits only returns', async () => {
    const readable = await createScope(pool, { kind: 'project', name: 'expiry-page' });
    await addMembership(pool, reader.id, readable.id, 'reader');
    const first = await createMemory(pool, {
      scopeId: readable.id, scopeKind: 'project', type: 'fact', title: 'First',
      body: 'first-secret-body', authorId: author.id, source: 'manual',
    });
    const expired = await createMemory(pool, {
      scopeId: readable.id, scopeKind: 'project', type: 'fact', title: 'Boundary',
      body: 'expired-secret-body', authorId: author.id, source: 'manual',
    });
    const second = await createMemory(pool, {
      scopeId: readable.id, scopeKind: 'project', type: 'fact', title: 'Second',
      body: 'second-secret-body', authorId: author.id, source: 'manual',
    });
    await pool.query(
      `UPDATE memories
          SET updated_at = CASE id
            WHEN $1 THEN TIMESTAMPTZ '2026-10-05 03:00:00+00'
            WHEN $2 THEN TIMESTAMPTZ '2026-10-05 02:00:00+00'
            ELSE TIMESTAMPTZ '2026-10-05 01:00:00+00'
          END,
              expires_at = CASE WHEN id = $2 THEN now() ELSE expires_at END
        WHERE id = ANY($3::uuid[])`,
      [first.id, expired.id, [first.id, expired.id, second.id]],
    );

    await expect(getMemoryForPrincipal(pool, reader, expired.id)).rejects.toMatchObject({
      code: 'MEMORY_NOT_FOUND', status: 404,
    });
    const page = await listMemoriesForPrincipal(pool, reader, { limit: 1, offset: 1 }, {
      transport: 'test',
    });

    expect(page.items.map((item) => item.memory.id)).toEqual([second.id]);
    const { rows } = await pool.query(
      `SELECT memory_id, metadata FROM audit_log ORDER BY id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].memory_id).toBeNull();
    expect(rows[0].metadata).toMatchObject({
      operation: 'list_memories', count: 1, limit: 1, offset: 1,
      record_kind: 'summary', transport: 'test',
    });
    expect(rows[1]).toMatchObject({
      memory_id: second.id,
      metadata: { rank: 1, record_kind: 'result', transport: 'test' },
    });
    expect(rows[1].metadata.request_id).toBe(rows[0].metadata.request_id);
    expect(JSON.stringify(rows)).not.toContain('secret-body');
    expect(JSON.stringify(rows)).not.toContain(expired.id);
  });

  it('keeps a zero-hit browse summary and rolls back all browse audits on failure', async () => {
    const empty = await listMemoriesForPrincipal(pool, reader, { scope: 'project:none' });
    expect(empty.items).toEqual([]);
    const summaries = await pool.query(
      `SELECT memory_id, metadata FROM audit_log ORDER BY id`,
    );
    expect(summaries.rows).toHaveLength(1);
    expect(summaries.rows[0]).toMatchObject({
      memory_id: null,
      metadata: { operation: 'list_memories', count: 0, record_kind: 'summary' },
    });

    await resetData(pool);
    const replacementReader = await createPrincipal(pool, {
      externalId: 'replacement-reader', kind: 'user', displayName: 'Reader',
    });
    const replacementAuthor = await createPrincipal(pool, {
      externalId: 'replacement-author', kind: 'user', displayName: 'Author',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await createMemory(pool, {
      scopeId: org.id, scopeKind: 'org', type: 'fact', title: 'Atomic browse',
      body: 'must not escape unaudited', authorId: replacementAuthor.id, source: 'manual',
    });
    await expect(listMemoriesForPrincipal(
      poolRejecting(pool, 'INSERT INTO audit_log'), replacementReader,
    )).rejects.toMatchObject({ code: 'INTERNAL' });
    expect((await pool.query('SELECT 1 FROM audit_log')).rowCount).toBe(0);
  });

  it('does not return a point read when its audit write fails', async () => {
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const memory = await createMemory(pool, {
      scopeId: org.id, scopeKind: 'org', type: 'fact', title: 'Atomic',
      body: 'body', authorId: author.id, source: 'manual',
    });
    await expect(getMemoryForPrincipal(
      poolRejecting(pool, 'INSERT INTO audit_log'), reader, memory.id,
    )).rejects.toMatchObject({ code: 'INTERNAL' });
    expect((await pool.query('SELECT 1 FROM audit_log')).rowCount).toBe(0);
  });
});

function poolRejecting(pool: pg.Pool, sqlFragment: string): pg.Pool {
  return {
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return async (text: string, ...args: unknown[]) => {
              if (text.includes(sqlFragment)) throw new Error('private database failure');
              return (target.query as (...queryArgs: unknown[]) => unknown)(text, ...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as pg.Pool;
}
