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
import { EmbeddingRegistry, ScopeEmbeddingRouter } from '../embeddings/router.js';

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

  it('durably records successor embedding failure and transactionally deletes the archived vector', async () => {
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
    )).rows).toEqual([]);
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

  it('reports a failed embedding when the successor is archived before vector storage', async () => {
    const scope = await createScope(pool, { kind: 'project', name: 'embedding-lifecycle-race' });
    await addMembership(pool, author.id, scope.id, 'writer');
    const predecessor = await createMemory(pool, {
      scopeId: scope.id, scopeKind: scope.kind, type: 'decision', title: 'Original',
      body: 'Original body', authorId: author.id, source: 'manual',
    });
    let signalStarted!: () => void;
    const embedStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let continueEmbed!: () => void;
    const embedMayFinish = new Promise<void>((resolve) => {
      continueEmbed = resolve;
    });
    const provider = {
      id: 'test:lifecycle-race', dim: 768,
      async embed() {
        signalStarted();
        await embedMayFinish;
        return [Array(768).fill(0) as number[]];
      },
    };
    const pending = supersedeForPrincipal(pool, provider, author, {
      supersededId: predecessor.id, title: 'Archived successor', body: 'No vector should survive',
    });
    await embedStarted;
    const successor = await pool.query<{ id: string }>(
      'SELECT id FROM memories WHERE supersedes_id = $1',
      [predecessor.id],
    );
    await pool.query(`UPDATE memories SET state = 'archived' WHERE id = $1`, [successor.rows[0]!.id]);
    continueEmbed();

    const result = await pending;
    expect(result).toMatchObject({ embedded: false, embedErrorCode: 'EMBEDDING_FAILED' });
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM memory_embeddings WHERE memory_id = $1',
      [result.successor.id],
    )).rows[0].count).toBe(0);
    expect((await pool.query(
      `SELECT metadata FROM audit_log
        WHERE memory_id = $1 AND metadata->>'record_kind' = 'embedding'`,
      [result.successor.id],
    )).rows[0].metadata).toMatchObject({
      embedded: false,
      embedding_error_code: 'EMBEDDING_FAILED',
    });
  });

  it('returns the committed supersession when post-commit pool connection fails', async () => {
    const scope = await createScope(pool, { kind: 'project', name: 'post-commit-connect' });
    await addMembership(pool, author.id, scope.id, 'writer');
    const predecessor = await createMemory(pool, {
      scopeId: scope.id, scopeKind: scope.kind, type: 'decision', title: 'Original',
      body: 'Original body', authorId: author.id, source: 'manual',
    });
    const provider = new StubEmbeddingProvider();
    let connects = 0;
    const postCommitUnavailable = {
      connect: async () => {
        connects += 1;
        if (connects > 1) throw new Error('post-commit database outage');
        return pool.connect();
      },
      query: pool.query.bind(pool),
    } as unknown as pg.Pool;

    const result = await supersedeForPrincipal(postCommitUnavailable, provider, author, {
      supersededId: predecessor.id, title: 'Replacement', body: 'Replacement body',
    });

    expect(result).toMatchObject({ embedded: false, embedErrorCode: 'EMBEDDING_FAILED' });
    expect((await pool.query('SELECT state FROM memories WHERE id = $1', [predecessor.id])).rows[0])
      .toEqual({ state: 'archived' });
    expect((await pool.query('SELECT state FROM memories WHERE id = $1', [result.successor.id])).rows[0])
      .toEqual({ state: 'live' });
  });

  it('returns the committed supersession when embedding outcome auditing fails', async () => {
    const scope = await createScope(pool, { kind: 'project', name: 'post-commit-audit' });
    await addMembership(pool, author.id, scope.id, 'writer');
    const predecessor = await createMemory(pool, {
      scopeId: scope.id, scopeKind: scope.kind, type: 'decision', title: 'Original',
      body: 'Original body', authorId: author.id, source: 'manual',
    });
    const provider = {
      id: 'failing-provider', dim: 768,
      async embed(): Promise<number[][]> { throw new Error('provider unavailable'); },
    };
    const auditUnavailable = {
      connect: pool.connect.bind(pool),
      query: async (query: string, values?: unknown[]) => {
        if (query.includes('INSERT INTO audit_log')) throw new Error('audit unavailable');
        return pool.query(query, values);
      },
    } as unknown as pg.Pool;

    const result = await supersedeForPrincipal(auditUnavailable, provider, author, {
      supersededId: predecessor.id, title: 'Replacement', body: 'Replacement body',
    });

    expect(result).toMatchObject({ embedded: false, embedErrorCode: 'EMBEDDING_FAILED' });
    expect((await pool.query('SELECT state FROM memories WHERE id = $1', [predecessor.id])).rows[0])
      .toEqual({ state: 'archived' });
  });

  it('degrades a successful embedding when its transactional outcome audit fails', async () => {
    const scope = await createScope(pool, { kind: 'project', name: 'success-audit-failure' });
    await addMembership(pool, author.id, scope.id, 'writer');
    const predecessor = await createMemory(pool, {
      scopeId: scope.id, scopeKind: scope.kind, type: 'decision', title: 'Original',
      body: 'Original body', authorId: author.id, source: 'manual',
    });
    let connects = 0;
    const auditUnavailable = {
      connect: async () => {
        const client = await pool.connect();
        connects += 1;
        if (connects === 1) return client;
        return {
          query: async (query: string, values?: unknown[]) => {
            if (query.includes('INSERT INTO audit_log')) throw new Error('audit unavailable');
            return client.query(query, values);
          },
          release: (destroy?: boolean) => client.release(destroy),
        };
      },
      query: async (query: string, values?: unknown[]) => {
        if (query.includes('INSERT INTO audit_log')) throw new Error('audit unavailable');
        return pool.query(query, values);
      },
    } as unknown as pg.Pool;

    const result = await supersedeForPrincipal(
      auditUnavailable,
      new StubEmbeddingProvider(),
      author,
      { supersededId: predecessor.id, title: 'Replacement', body: 'Replacement body' },
    );

    expect(result).toMatchObject({ embedded: false, embedErrorCode: 'EMBEDDING_FAILED' });
    expect((await pool.query('SELECT state FROM memories WHERE id = $1', [result.successor.id])).rows[0])
      .toEqual({ state: 'live' });
    expect((await pool.query('SELECT 1 FROM memory_embeddings WHERE memory_id = $1', [result.successor.id])).rowCount)
      .toBe(0);
  });

  it('audits unavailable local-only routing without using a hosted provider', async () => {
    const scope = await createScope(pool, { kind: 'project', name: 'local-only-unavailable' });
    await addMembership(pool, author.id, scope.id, 'writer');
    const predecessor = await createMemory(pool, {
      scopeId: scope.id, scopeKind: scope.kind, type: 'decision', title: 'Original',
      body: 'Original body', authorId: author.id, source: 'manual',
    });
    const routing = new ScopeEmbeddingRouter(
      new EmbeddingRegistry([]),
      { default: 'local-only' },
    );

    const result = await supersedeForPrincipal(pool, routing, author, {
      supersededId: predecessor.id, title: 'Replacement', body: 'Replacement body',
    });

    expect(result.embedded).toBe(false);
    const { rows } = await pool.query(
      `SELECT metadata FROM audit_log
        WHERE memory_id = $1 AND metadata->>'record_kind' = 'embedding'`,
      [result.successor.id],
    );
    expect(rows).toEqual([{
      metadata: expect.objectContaining({
        embedded: false,
        embedding_policy: 'local-only-unavailable',
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
