import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { decisionHistoryForPrincipal, supersedeForPrincipal } from './supersede.js';
import { StubEmbeddingProvider } from '../embeddings/stub.js';
import { storeMemoryEmbedding } from '../storage/embeddings.js';

describe('decision history service', () => {
  let pool: pg.Pool;
  let reader: Awaited<ReturnType<typeof createPrincipal>>;
  let author: Awaited<ReturnType<typeof createPrincipal>>;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
    reader = await createPrincipal(pool, {
      externalId: 'history-reader', kind: 'user', displayName: 'History Reader',
    });
    author = await createPrincipal(pool, {
      externalId: 'history-author', kind: 'user', displayName: 'History Author',
    });
  });

  afterAll(async () => { await pool?.end(); });

  it('returns an authorized chain oldest-to-newest and audits every delivered decision', async () => {
    const scope = await createScope(pool, { kind: 'project', name: 'readable-history' });
    await addMembership(pool, reader.id, scope.id, 'reader');
    const first = await createMemory(pool, {
      scopeId: scope.id, scopeKind: scope.kind, type: 'decision', title: 'First',
      body: 'First body', authorId: author.id, source: 'manual',
    });
    await pool.query(`UPDATE memories SET state = 'archived' WHERE id = $1`, [first.id]);
    const second = await createMemory(pool, {
      scopeId: scope.id, scopeKind: scope.kind, type: 'decision', title: 'Second',
      body: 'Second body', authorId: author.id, source: 'manual', supersedesId: first.id,
    });

    const result = await decisionHistoryForPrincipal(pool, reader, first.id, {
      transport: 'test',
    });

    expect(result.currentId).toBe(second.id);
    expect(result.decisions.map((decision) => decision.id)).toEqual([first.id, second.id]);
    const { rows } = await pool.query(
      `SELECT memory_id, metadata FROM audit_log ORDER BY id`,
    );
    expect(rows.map((row) => row.memory_id)).toEqual([null, first.id, second.id]);
    expect(rows[0].metadata).toMatchObject({
      view: 'decision-history', anchor_id: first.id, current_id: second.id,
      transport: 'test', record_kind: 'summary',
    });
  });

  it('masks inaccessible and missing decision IDs with the same error and no audit', async () => {
    const hidden = await createScope(pool, { kind: 'project', name: 'hidden-history' });
    const decision = await createMemory(pool, {
      scopeId: hidden.id, scopeKind: hidden.kind, type: 'decision', title: 'Hidden',
      body: 'Private body', authorId: author.id, source: 'manual',
    });
    const missing = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    for (const id of [decision.id, missing]) {
      await expect(decisionHistoryForPrincipal(pool, reader, id)).rejects.toMatchObject({
        code: 'MEMORY_NOT_FOUND', status: 404, publicMessage: 'Memory not found',
      });
    }
    expect((await pool.query('SELECT 1 FROM audit_log')).rowCount).toBe(0);
  });

  it('masks unreadable supersede predecessors as missing but preserves forbidden for readers', async () => {
    const hidden = await createScope(pool, { kind: 'project', name: 'hidden-supersede' });
    const readable = await createScope(pool, { kind: 'project', name: 'readable-supersede' });
    await addMembership(pool, reader.id, readable.id, 'reader');
    const hiddenDecision = await createMemory(pool, {
      scopeId: hidden.id, scopeKind: hidden.kind, type: 'decision', title: 'Hidden',
      body: 'Hidden body', authorId: author.id, source: 'manual',
    });
    const readableDecision = await createMemory(pool, {
      scopeId: readable.id, scopeKind: readable.kind, type: 'decision', title: 'Readable',
      body: 'Readable body', authorId: author.id, source: 'manual',
    });
    const input = { title: 'Replacement', body: 'Replacement body' };

    for (const supersededId of [
      hiddenDecision.id,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ]) {
      await expect(supersedeForPrincipal(pool, null, reader, {
        supersededId, ...input,
      })).rejects.toMatchObject({
        code: 'MEMORY_NOT_FOUND', status: 404, publicMessage: 'Memory not found',
      });
    }
    await expect(supersedeForPrincipal(pool, null, reader, {
      supersededId: readableDecision.id, ...input,
    })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect((await pool.query('SELECT 1 FROM audit_log')).rowCount).toBe(0);
  });

  it('rejects stale decisions until they are verified back to live', async () => {
    const scope = await createScope(pool, { kind: 'project', name: 'stale-supersede' });
    await addMembership(pool, author.id, scope.id, 'writer');
    const stale = await createMemory(pool, {
      scopeId: scope.id, scopeKind: scope.kind, type: 'decision', title: 'Stale',
      body: 'Stale body', authorId: author.id, source: 'manual',
    });
    await pool.query(`UPDATE memories SET state = 'stale' WHERE id = $1`, [stale.id]);

    await expect(supersedeForPrincipal(pool, null, author, {
      supersededId: stale.id, title: 'Replacement', body: 'Replacement body',
    })).rejects.toMatchObject({
      code: 'CONFLICT', status: 409, publicMessage: 'Decision is not live',
    });
    expect((await pool.query('SELECT 1 FROM audit_log')).rowCount).toBe(0);
  });

  it('durably records successor embedding failure and retains the archived vector', async () => {
    const scope = await createScope(pool, { kind: 'project', name: 'embedding-failure' });
    await addMembership(pool, author.id, scope.id, 'writer');
    const predecessor = await createMemory(pool, {
      scopeId: scope.id, scopeKind: scope.kind, type: 'decision', title: 'Original',
      body: 'Original body', authorId: author.id, source: 'manual',
    });
    await storeMemoryEmbedding(pool, predecessor.id, 'original vector', new StubEmbeddingProvider());
    const provider = {
      id: 'failing-provider', dim: 768,
      async embed(): Promise<number[][]> { throw new Error('deterministic provider failure'); },
    };

    const result = await supersedeForPrincipal(pool, provider, author, {
      supersededId: predecessor.id, title: 'Replacement', body: 'Replacement body',
    });

    expect(result).toMatchObject({ embedded: false, embedErrorCode: 'EMBEDDING_FAILED' });
    expect((await pool.query(
      'SELECT memory_id FROM memory_embeddings ORDER BY memory_id',
    )).rows).toEqual([{ memory_id: predecessor.id }]);
    const embeddingAudit = await pool.query(
      `SELECT memory_id, metadata FROM audit_log
        WHERE metadata->>'record_kind' = 'embedding'`,
    );
    expect(embeddingAudit.rows).toEqual([{
      memory_id: result.successor.id,
      metadata: expect.objectContaining({
        embedded: false,
        embedding_error_code: 'EMBEDDING_FAILED',
        embedding: { provider: 'failing-provider', dim: 768, status: 'failed' },
      }),
    }]);
  });

  it('stores Continuum-owned empty related metadata and rejects caller forgery', async () => {
    const scope = await createScope(pool, { kind: 'project', name: 'related-contract' });
    await addMembership(pool, author.id, scope.id, 'writer');
    const predecessor = await createMemory(pool, {
      scopeId: scope.id, scopeKind: scope.kind, type: 'decision', title: 'Original',
      body: 'Original body', authorId: author.id, source: 'manual',
    });

    await expect(supersedeForPrincipal(pool, null, author, {
      supersededId: predecessor.id, title: 'Forged', body: 'Forged body',
      metadata: { related: [{ id: 'forged' }] },
    })).rejects.toMatchObject({
      code: 'INVALID_INPUT', publicMessage: 'metadata.related is reserved by Continuum',
    });

    const result = await supersedeForPrincipal(pool, null, author, {
      supersededId: predecessor.id, title: 'Replacement', body: 'Replacement body',
      metadata: { reason: 'latency' },
    });
    expect(result.successor.metadata).toEqual({ reason: 'latency', related: [] });
  });

  it('maps pool connection outages to dependency unavailable', async () => {
    const unavailablePool = {
      connect: async () => { throw new Error('database offline'); },
    } as unknown as pg.Pool;
    const input = {
      supersededId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'Replacement', body: 'Replacement body',
    };

    await expect(supersedeForPrincipal(unavailablePool, null, author, input))
      .rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', status: 503 });
    await expect(decisionHistoryForPrincipal(unavailablePool, author, input.supersededId))
      .rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', status: 503 });
  });
});
