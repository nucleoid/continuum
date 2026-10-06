import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  EmbeddingItemError,
  EmbeddingProviderError,
  type EmbeddingProvider,
} from '../embeddings/provider.js';
import { OpenAIEmbeddingProvider, VoyageEmbeddingProvider } from '../embeddings/hosted.js';
import { OllamaEmbeddingProvider } from '../embeddings/ollama.js';
import { EmbeddingRegistry, ScopeEmbeddingRouter } from '../embeddings/router.js';
import { StubEmbeddingProvider } from '../embeddings/stub.js';
import { createMemory } from '../storage/memories.js';
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { runAuditRetention } from './audit-retention.js';
import { runEmbeddingBackfill } from './embed-backfill.js';

describe('embedding backfill', () => {
  let pool: pg.Pool;
  const vectors = new StubEmbeddingProvider();

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });
  afterAll(async () => pool?.end());

  async function seed(scopeKind: 'team' | 'project', scopeName: string, titles: string[]) {
    const principal = await createPrincipal(pool, {
      externalId: `svc:${scopeKind}:${scopeName}`, kind: 'service', displayName: scopeName,
    });
    const scope = await createScope(pool, { kind: scopeKind, name: scopeName });
    const memories = [];
    for (const title of titles) {
      memories.push(await createMemory(pool, {
        scopeId: scope.id, scopeKind, type: 'decision', title,
        body: `body for ${title}`, authorId: principal.id, source: 'manual',
      }));
    }
    return { scope, memories };
  }

  it('routes each scope before sending text and stores provider-qualified rows', async () => {
    await seed('team', 'sensitive', ['local only secret']);
    await seed('project', 'public', ['hosted project text']);
    const localEmbed = vi.fn((texts: string[]) => vectors.embed(texts));
    const hostedEmbed = vi.fn((texts: string[]) => vectors.embed(texts));
    const local: EmbeddingProvider = {
      id: 'ollama:local', dim: 768, local: true, embed: localEmbed,
    };
    const hosted: EmbeddingProvider = {
      id: 'openai:hosted', dim: 768, local: false, embed: hostedEmbed,
    };
    const router = new ScopeEmbeddingRouter(
      new EmbeddingRegistry([['local', local], ['hosted', hosted]]),
      {
        default: 'hosted',
        rules: [{ match: { kind: 'team', name: 'sensitive' }, provider: 'local-only' }],
      },
    );

    const report = await runEmbeddingBackfill(pool, router, { batchSize: 8, maxRows: 10 });

    expect(report.embedded).toBe(2);
    expect(localEmbed.mock.calls.flatMap(([texts]) => texts).join(' ')).toContain('local only secret');
    expect(hostedEmbed.mock.calls.flatMap(([texts]) => texts).join(' ')).not.toContain('local only secret');
    const stored = await pool.query('SELECT provider, count(*)::int AS count FROM memory_embeddings GROUP BY provider ORDER BY provider');
    expect(stored.rows).toEqual([
      { provider: 'ollama:local', count: 1 },
      { provider: 'openai:hosted', count: 1 },
    ]);
  });

  it('persists a stable cursor, resumes, and remains idempotent', async () => {
    await seed('project', 'resume', ['one', 'two', 'three']);
    const provider: EmbeddingProvider = {
      id: 'ollama:resume', dim: 768, local: true,
      embed: (texts) => vectors.embed(texts),
    };

    const first = await runEmbeddingBackfill(pool, provider, { batchSize: 1, maxRows: 1 });
    const second = await runEmbeddingBackfill(pool, provider, { batchSize: 1, maxRows: 1 });
    await runEmbeddingBackfill(pool, provider, { batchSize: 8, maxRows: 10 });
    const final = await runEmbeddingBackfill(pool, provider, { batchSize: 8, maxRows: 10 });

    expect(first).toMatchObject({ embedded: 1, completed: false });
    expect(second).toMatchObject({ embedded: 1, completed: false });
    expect(final).toMatchObject({ embedded: 0, failed: 0, completed: true });
    expect((await pool.query('SELECT count(*)::int AS count FROM memory_embeddings')).rows[0].count).toBe(3);
  });

  it('adds the active provider without overwriting an older provider embedding', async () => {
    const { memories } = await seed('project', 'migration', ['model migration']);
    const oldProvider: EmbeddingProvider = {
      id: 'ollama:old', dim: 768, local: true,
      embed: (texts) => vectors.embed(texts),
    };
    const newProvider: EmbeddingProvider = {
      id: 'ollama:new', dim: 768, local: true,
      embed: (texts) => vectors.embed(texts),
    };
    const [oldVector] = await oldProvider.embed(['old']);
    await storeMemoryEmbeddingVector(pool, memories[0]!.id, oldVector!, oldProvider);

    await runEmbeddingBackfill(pool, newProvider, { maxRows: 10 });

    const rows = await pool.query(
      'SELECT provider FROM memory_embeddings WHERE memory_id = $1 ORDER BY provider',
      [memories[0]!.id],
    );
    expect(rows.rows).toEqual([{ provider: 'ollama:new' }, { provider: 'ollama:old' }]);
  });

  it('does not reinsert a vector when a memory is archived during provider work', async () => {
    const { memories } = await seed('project', 'archive-race', ['archive me']);
    const provider: EmbeddingProvider = {
      id: 'ollama:archive-race', dim: 768, local: true,
      async embed(texts) {
        await pool.query(`UPDATE memories SET state = 'archived' WHERE id = $1`, [memories[0]!.id]);
        return vectors.embed(texts);
      },
    };

    const report = await runEmbeddingBackfill(pool, provider, { maxRows: 10 });

    expect(report).toMatchObject({ embedded: 0, failed: 0, completed: true });
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM memory_embeddings WHERE memory_id = $1',
      [memories[0]!.id],
    )).rows[0].count).toBe(0);
  });

  it('serializes behind lifecycle archival and does not recreate its deleted vector', async () => {
    const { memories } = await seed('project', 'archive-lock-race', ['archive me']);
    const memoryId = memories[0]!.id;
    const lifecycle = await pool.connect();
    const writer = await pool.connect();
    const provider = { id: 'ollama:archive-lock-race', dim: 768 };
    const vector = (await vectors.embed(['archive me']))[0]!;
    const lockKey = 34_065;
    const backend = await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const writerPid = backend.rows[0]!.pid;

    try {
      await pool.query(
        `CREATE FUNCTION test_block_embedding_insert() RETURNS trigger
         LANGUAGE plpgsql AS $body$
         BEGIN
           PERFORM pg_advisory_lock(${lockKey});
           PERFORM pg_advisory_unlock(${lockKey});
           RETURN NEW;
         END
         $body$`,
      );
      await pool.query(
        `CREATE TRIGGER test_block_embedding_insert
         BEFORE INSERT ON memory_embeddings
         FOR EACH ROW EXECUTE FUNCTION test_block_embedding_insert()`,
      );
      await lifecycle.query('SELECT pg_advisory_lock($1)', [lockKey]);
      await lifecycle.query('BEGIN');
      await lifecycle.query(
        `UPDATE memories SET state = 'archived', updated_at = now() WHERE id = $1`,
        [memoryId],
      );
      await lifecycle.query('DELETE FROM memory_embeddings WHERE memory_id = $1', [memoryId]);
      const write = storeMemoryEmbeddingVector(writer, memoryId, vector, provider);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        const activity = await pool.query<{ waiting: boolean }>(
          `SELECT wait_event_type = 'Lock' AS waiting
             FROM pg_stat_activity WHERE pid = $1`,
          [writerPid],
        );
        waiting = activity.rows[0]?.waiting === true;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await lifecycle.query('COMMIT');
      await lifecycle.query('SELECT pg_advisory_unlock($1)', [lockKey]);

      await expect(write).resolves.toBe(false);
      expect((await pool.query(
        'SELECT count(*)::int AS count FROM memory_embeddings WHERE memory_id = $1',
        [memoryId],
      )).rows[0].count).toBe(0);
    } finally {
      await lifecycle.query('ROLLBACK').catch(() => undefined);
      await lifecycle.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch(() => undefined);
      lifecycle.release();
      writer.release();
      await pool.query('DROP TRIGGER IF EXISTS test_block_embedding_insert ON memory_embeddings');
      await pool.query('DROP FUNCTION IF EXISTS test_block_embedding_insert()');
    }
  });

  it('does not store a vector when a memory expires during provider work', async () => {
    const { memories } = await seed('project', 'expiry-race', ['expire me']);
    const provider: EmbeddingProvider = {
      id: 'ollama:expiry-race', dim: 768, local: true,
      async embed(texts) {
        await pool.query(
          `UPDATE memories SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
          [memories[0]!.id],
        );
        return vectors.embed(texts);
      },
    };

    const report = await runEmbeddingBackfill(pool, provider, { maxRows: 10 });

    expect(report).toMatchObject({ embedded: 0, failed: 0, completed: true });
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM memory_embeddings WHERE memory_id = $1',
      [memories[0]!.id],
    )).rows[0].count).toBe(0);
  });

  it('rejects a concurrent run for the same provider advisory lock', async () => {
    await seed('project', 'locked', ['waiting']);
    const provider: EmbeddingProvider = {
      id: 'ollama:locked', dim: 768, local: true,
      embed: (texts) => vectors.embed(texts),
    };
    const lockName = 'continuum:embed-backfill:ollama:locked:768';
    const client = await pool.connect();
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockName]);
    try {
      await expect(runEmbeddingBackfill(pool, provider, {
        maxRows: 10, scope: { kind: 'project', name: 'locked' },
      }))
        .rejects.toThrow(/already running/i);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]);
      client.release();
    }
  });

  it('isolates a deterministic poison item without retrying, audits it, and continues', async () => {
    const { memories } = await seed('project', 'poison', ['healthy one', 'poison item', 'healthy two']);
    const provider: EmbeddingProvider = {
      id: 'ollama:poison', dim: 768, local: true,
      async embed(texts) {
        if (texts.some((text) => text.includes('poison item'))) {
          throw new EmbeddingItemError('private provider detail');
        }
        return vectors.embed(texts);
      },
    };

    const report = await runEmbeddingBackfill(pool, provider, {
      batchSize: 3, maxRows: 10,
    });

    expect(report).toMatchObject({ embedded: 2, failed: 1, completed: true });
    const stored = await pool.query('SELECT memory_id FROM memory_embeddings ORDER BY memory_id');
    expect(stored.rows.map((row) => row.memory_id)).not.toContain(memories[1]!.id);
    const audit = await pool.query(
      `SELECT metadata::text AS metadata FROM audit_log
        WHERE memory_id = $1 AND metadata->>'operation' = 'embedding_backfill'`,
      [memories[1]!.id],
    );
    expect(audit.rows[0].metadata).toContain('EMBEDDING_FAILED');
    expect(audit.rows[0].metadata).not.toContain('private provider detail');
  });

  it('keeps poison-row suppression after audit retention deletes its audit', async () => {
    await seed('project', 'retained-poison-state', ['poison item']);
    const embed = vi.fn(async () => {
      throw new EmbeddingItemError('private provider detail');
    });
    const provider: EmbeddingProvider = {
      id: 'ollama:retained-poison-state', dim: 768, local: true, embed,
    };
    const first = await runEmbeddingBackfill(pool, provider, { maxRows: 10 });
    expect(first).toMatchObject({ failed: 1, completed: true });

    const admin = await createPrincipal(pool, {
      externalId: 'svc:retention-for-backfill', kind: 'service', displayName: 'retention',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    if (!org) throw new Error('org scope missing');
    await pool.query(
      `INSERT INTO scope_memberships (principal_id, scope_id, role)
       VALUES ($1, $2, 'admin')`,
      [admin.id, org.id],
    );
    await pool.query(
      `UPDATE audit_log SET at = '2020-01-01T00:00:00Z'
        WHERE metadata->>'operation' = 'embedding_backfill'`,
    );
    await runAuditRetention(pool, {
      retentionDays: 1,
      principalExternalId: admin.externalId!,
      runId: '11111111-1111-4111-8111-111111111111',
    });
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE metadata->>'operation' = 'embedding_backfill'`,
    )).rows[0].count).toBe(0);

    const resumed = await runEmbeddingBackfill(pool, provider, { maxRows: 10 });

    expect(resumed).toMatchObject({ embedded: 0, failed: 0, completed: true });
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('retries durable poison rows only through the explicit provider control', async () => {
    await seed('project', 'controlled-poison-retry', ['poison item']);
    let reject = true;
    const embed = vi.fn(async (texts: string[]) => {
      if (reject) throw new EmbeddingItemError('deterministic input rejection');
      return vectors.embed(texts);
    });
    const provider: EmbeddingProvider = {
      id: 'ollama:controlled-poison-retry', dim: 768, local: true, embed,
    };
    await runEmbeddingBackfill(pool, provider, { maxRows: 10 });
    reject = false;

    const suppressed = await runEmbeddingBackfill(pool, provider, { maxRows: 10 });
    expect(suppressed).toMatchObject({ embedded: 0, failuresCleared: 0 });
    expect(embed).toHaveBeenCalledTimes(1);

    const retried = await runEmbeddingBackfill(pool, provider, {
      providerId: provider.id, retryFailures: true, maxRows: 10,
    });
    expect(retried).toMatchObject({ embedded: 1, failed: 0, failuresCleared: 1, completed: true });
    expect(embed).toHaveBeenCalledTimes(2);
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM embedding_backfill_failures',
    )).rows[0].count).toBe(0);
  });

  it('bisects a realistic Voyage aggregate token-limit rejection and checkpoints progress', async () => {
    const { memories } = await seed('project', 'voyage-request-limit', [
      'healthy one', 'healthy two', 'healthy three', 'healthy four',
    ]);
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { input: string[] };
      if (payload.input.length > 2) {
        return new Response(JSON.stringify({
          detail: 'The total number of tokens in the batch (130001) exceeds the max allowed tokens per request (120000).',
        }), { status: 400 });
      }
      return new Response(JSON.stringify({
        data: payload.input.map((text, index) => ({
          index, embedding: [text.length, ...Array(767).fill(0)],
        })),
      }));
    });
    const provider = new VoyageEmbeddingProvider({
      apiKey: '***', model: 'model', dim: 768, fetchImpl,
    });

    const report = await runEmbeddingBackfill(pool, provider, { batchSize: 4, maxRows: 10 });

    expect(report).toMatchObject({ embedded: 4, failed: 0, completed: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect((await pool.query(
      'SELECT memory_id FROM memory_embeddings ORDER BY memory_id',
    )).rows.map((row) => row.memory_id)).toEqual(memories.map((memory) => memory.id).sort());
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE metadata->>'operation' = 'embedding_backfill'`,
    )).rows[0].count).toBe(0);
  });

  it.each([
    ['server response', new EmbeddingProviderError('EMBEDDING_SERVER', 'ambiguous upstream failure')],
    ['invalid response', new EmbeddingProviderError('EMBEDDING_INVALID_RESPONSE', 'ambiguous response')],
    ['unclassified response', new EmbeddingProviderError('EMBEDDING_FAILED', 'ambiguous rejection')],
  ])('diagnostically isolates one suspect row after an ambiguous %s', async (_label, failure) => {
    const { memories } = await seed('project', `ambiguous-${_label}`, [
      'healthy one', 'poison item', 'healthy two', 'healthy three',
    ]);
    const embed = vi.fn(async (texts: string[]) => {
      if (texts.some((text) => text.includes('poison item'))) throw failure;
      return vectors.embed(texts);
    });
    const provider: EmbeddingProvider = {
      id: `hosted:ambiguous-${_label}`, dim: 768, local: false, embed,
    };

    const report = await runEmbeddingBackfill(pool, provider, { batchSize: 4, maxRows: 10 });

    expect(report).toMatchObject({ embedded: 3, failed: 0, completed: false });
    expect(report.unresolvedIds).toEqual([memories[1]!.id]);
    expect((await pool.query(
      `SELECT memory_id FROM embedding_backfill_failures
        WHERE provider = $1 AND disposition = 'suspect'`,
      [provider.id],
    )).rows).toEqual([{ memory_id: memories[1]!.id }]);
  });

  it('does not convert a provider-wide ambiguous outage into durable row failures', async () => {
    await seed('project', 'ambiguous-outage', ['one', 'two', 'three', 'four']);
    const embed = vi.fn(async () => {
      throw new EmbeddingProviderError('EMBEDDING_SERVER', 'provider unavailable');
    });
    const provider: EmbeddingProvider = {
      id: 'hosted:ambiguous-outage', dim: 768, local: false, embed,
    };
    const report = await runEmbeddingBackfill(pool, provider, { batchSize: 4, maxRows: 10 });
    expect(report).toMatchObject({ embedded: 0, failed: 0, completed: false });
    expect(report.providerReports).toEqual([
      expect.objectContaining({ provider: provider.id, errorCode: 'EMBEDDING_SERVER' }),
    ]);
    expect((await pool.query('SELECT 1 FROM embedding_backfill_failures')).rowCount).toBe(0);
  });

  it('continues other providers and preserves per-provider cursors when one provider fails', async () => {
    await seed('team', 'failed-provider-scope', ['one']);
    await seed('project', 'healthy-provider-scope', ['two']);
    const failed: EmbeddingProvider = {
      id: 'hosted:failed', dim: 768, local: false,
      async embed() { throw new EmbeddingProviderError('EMBEDDING_AUTH', 'private'); },
    };
    const healthy: EmbeddingProvider = {
      id: 'ollama:healthy', dim: 768, local: true,
      embed: (texts) => vectors.embed(texts),
    };
    const router = new ScopeEmbeddingRouter(
      new EmbeddingRegistry([['failed', failed], ['healthy', healthy]]),
      {
        default: 'healthy',
        rules: [{ match: { kind: 'team', name: 'failed-provider-scope' }, provider: 'failed' }],
      },
    );
    const report = await runEmbeddingBackfill(pool, router, { maxRows: 10 });
    expect(report).toMatchObject({ embedded: 1, completed: false });
    expect(report.providerReports).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: failed.id, errorCode: 'EMBEDDING_AUTH' }),
      expect.objectContaining({ provider: healthy.id, embedded: 1, cursor: null }),
    ]));
  });

  it('aligns provider calls to its advertised batch size', async () => {
    await seed('project', 'provider-batch-alignment', ['one', 'two', 'three', 'four', 'five']);
    const embed = vi.fn((texts: string[]) => vectors.embed(texts));
    const provider: EmbeddingProvider = {
      id: 'hosted:small-batches', dim: 768, local: false, batchSize: 2, embed,
    };
    await runEmbeddingBackfill(pool, provider, { batchSize: 5, maxRows: 10 });
    expect(embed.mock.calls.map(([texts]) => texts.length)).toEqual([2, 2, 1]);
  });

  it('supports no-wrap and an explicit durable mark-failed operator escape hatch', async () => {
    const { memories } = await seed('project', 'operator-escape', ['lower', 'middle', 'upper']);
    const [lower, middle, upper] = [...memories].sort((left, right) => left.id.localeCompare(right.id));
    const embed = vi.fn((texts: string[]) => vectors.embed(texts));
    const provider: EmbeddingProvider = {
      id: 'ollama:operator-escape', dim: 768, local: true, embed,
    };
    const noWrap = await runEmbeddingBackfill(pool, provider, {
      providerId: provider.id, cursor: upper!.id, noWrap: true, maxRows: 10,
    });
    expect(noWrap).toMatchObject({ completed: true, embedded: 0 });
    expect(embed).not.toHaveBeenCalled();

    const progressed = await runEmbeddingBackfill(pool, provider, {
      providerId: provider.id, batchSize: 1, maxRows: 1,
    });
    expect(progressed).toMatchObject({ embedded: 1, completed: false, cursor: lower!.id });

    const marked = await runEmbeddingBackfill(pool, provider, {
      providerId: provider.id, markFailed: upper!.id, maxRows: 10,
    });
    expect(marked).toMatchObject({ failed: 1, completed: false, cursor: lower!.id });
    expect((await pool.query(
      `SELECT memory_id FROM embedding_backfill_failures
        WHERE provider = $1 AND dim = $2`,
      [provider.id, provider.dim],
    )).rows).toEqual([{ memory_id: upper!.id }]);
    expect((await pool.query(
      `SELECT cursor FROM embedding_backfill_checkpoints
        WHERE provider = $1 AND dim = $2 AND scope_filter = ''`,
      [provider.id, provider.dim],
    )).rows).toEqual([{ cursor: lower!.id }]);
    expect(middle).toBeDefined();
    expect(embed).toHaveBeenCalledOnce();
  });

  it('checkpoints the poison item before stopping at an exhausted error budget', async () => {
    const { memories } = await seed('project', 'error-budget-progress', [
      'healthy one', 'poison item', 'healthy two',
    ]);
    const provider: EmbeddingProvider = {
      id: 'ollama:error-budget', dim: 768, local: true,
      async embed(texts) {
        if (texts.some((text) => text.includes('poison item'))) {
          throw new EmbeddingItemError('deterministic input rejection');
        }
        return vectors.embed(texts);
      },
    };

    const exhausted = await runEmbeddingBackfill(pool, provider, {
      batchSize: 3, maxRows: 10, maxErrors: 1,
    });
    expect(exhausted).toMatchObject({
      completed: false, failed: 1, errorCodes: ['BACKFILL_ERROR_BUDGET'],
      providerReports: [expect.objectContaining({
        provider: provider.id,
        errorCode: 'BACKFILL_ERROR_BUDGET',
        cursor: memories[1]!.id,
      })],
    });

    const checkpoint = await pool.query(
      `SELECT cursor FROM embedding_backfill_checkpoints
        WHERE provider = $1 AND dim = $2 AND scope_filter = ''`,
      [provider.id, provider.dim],
    );
    expect(checkpoint.rows[0].cursor).toBe(memories[1]!.id);

    const resumed = await runEmbeddingBackfill(pool, provider, {
      batchSize: 3, maxRows: 10, maxErrors: 1,
    });
    expect(resumed.failed).toBe(0);
    expect((await pool.query(
      'SELECT memory_id FROM memory_embeddings ORDER BY memory_id',
    )).rows.map((row) => row.memory_id)).toEqual([memories[0]!.id, memories[2]!.id].sort());
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE memory_id = $1 AND metadata->>'operation' = 'embedding_backfill'`,
      [memories[1]!.id],
    )).rows[0].count).toBe(1);

    const settled = await runEmbeddingBackfill(pool, provider, {
      batchSize: 3, maxRows: 10, maxErrors: 1,
    });
    expect(settled).toMatchObject({ embedded: 0, failed: 0, completed: true, cursor: null });
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE memory_id = $1 AND metadata->>'operation' = 'embedding_backfill'`,
      [memories[1]!.id],
    )).rows[0].count).toBe(1);
  });

  it('wraps a saved cursor once so lower UUID work is not falsely reported complete', async () => {
    const { memories } = await seed('project', 'resume-wrap', ['lower UUID', 'cursor row']);
    const [lower, upper] = [...memories].sort((left, right) => left.id.localeCompare(right.id));
    const provider: EmbeddingProvider = {
      id: 'ollama:resume-wrap', dim: 768, local: true,
      embed: (texts) => vectors.embed(texts),
    };
    await pool.query(
      `INSERT INTO embedding_backfill_checkpoints (provider, dim, scope_filter, cursor)
       VALUES ($1, $2, '', $3)`,
      [provider.id, provider.dim, upper!.id],
    );

    const originalConnect = pool.connect.bind(pool);
    const wrappedBoundaries: unknown[] = [];
    let restoreQuery = () => undefined;
    const connect = vi.spyOn(pool, 'connect').mockImplementation(async () => {
      const client = await originalConnect();
      const originalQuery = client.query.bind(client);
      const query = vi.spyOn(client, 'query').mockImplementation(async (...args: unknown[]) => {
        if (String(args[0]).includes('FROM memories m')) {
          const params = args[1] as unknown[];
          if (params[0] === null) wrappedBoundaries.push(params[4]);
        }
        return originalQuery(...args as [never]);
      });
      restoreQuery = () => query.mockRestore();
      return client;
    });

    const report = await (async () => {
      try {
        return await runEmbeddingBackfill(pool, provider, { batchSize: 2, maxRows: 10 });
      } finally {
        restoreQuery();
        connect.mockRestore();
      }
    })();

    expect(report).toMatchObject({ embedded: 2, failed: 0, completed: true, cursor: null });
    expect(wrappedBoundaries).toContain(upper!.id);
    expect((await pool.query(
      'SELECT memory_id FROM memory_embeddings ORDER BY memory_id',
    )).rows.map((row) => row.memory_id)).toEqual([lower!.id, upper!.id].sort());
  });

  it('wraps an explicit cursor before reporting completion or clearing saved progress', async () => {
    const { memories } = await seed('project', 'explicit-cursor-wrap', ['lower UUID', 'upper UUID']);
    const [lower, upper] = [...memories].sort((left, right) => left.id.localeCompare(right.id));
    const provider: EmbeddingProvider = {
      id: 'ollama:explicit-cursor-wrap', dim: 768, local: true,
      embed: (texts) => vectors.embed(texts),
    };
    await pool.query(
      `INSERT INTO embedding_backfill_checkpoints (provider, dim, scope_filter, cursor)
       VALUES ($1, $2, '', $3)`,
      [provider.id, provider.dim, upper!.id],
    );

    const report = await runEmbeddingBackfill(pool, provider, {
      providerId: provider.id, cursor: upper!.id, batchSize: 2, maxRows: 10,
    });

    expect(report).toMatchObject({ embedded: 2, failed: 0, completed: true, cursor: null });
    expect((await pool.query(
      'SELECT memory_id FROM memory_embeddings ORDER BY memory_id',
    )).rows.map((row) => row.memory_id)).toEqual([lower!.id, upper!.id].sort());
    expect((await pool.query(
      `SELECT cursor FROM embedding_backfill_checkpoints
        WHERE provider = $1 AND dim = $2 AND scope_filter = ''`,
      [provider.id, provider.dim],
    )).rows[0].cursor).toBeNull();
  });

  it('destroys the pooled client when advisory unlock cannot be confirmed', async () => {
    await seed('project', 'unlock-failure', ['one']);
    const provider: EmbeddingProvider = {
      id: 'ollama:unlock-failure', dim: 768, local: true,
      embed: (texts) => vectors.embed(texts),
    };
    const originalConnect = pool.connect.bind(pool);
    let release: ReturnType<typeof vi.spyOn> | undefined;
    const connect = vi.spyOn(pool, 'connect').mockImplementation(async () => {
      const client = await originalConnect();
      const originalQuery = client.query.bind(client);
      vi.spyOn(client, 'query').mockImplementation(async (...args: unknown[]) => {
        if (String(args[0]).includes('pg_advisory_unlock')) {
          throw new Error('simulated unlock failure');
        }
        return originalQuery(...args as [never]);
      });
      release = vi.spyOn(client, 'release');
      return client;
    });

    await expect(runEmbeddingBackfill(pool, provider, { maxRows: 10 }))
      .resolves.toMatchObject({ embedded: 1 });
    expect(release).toHaveBeenCalledWith(true);
    connect.mockRestore();
  });

  it('reports database storage failures with accumulated provider progress', async () => {
    await seed('project', 'storage-failure', ['one']);
    const provider: EmbeddingProvider = {
      id: 'ollama:storage-failure', dim: 768, local: true,
      embed: (texts) => vectors.embed(texts),
    };
    const originalConnect = pool.connect.bind(pool);
    let restoreQuery = () => undefined;
    const connect = vi.spyOn(pool, 'connect').mockImplementation(async () => {
      const client = await originalConnect();
      const originalQuery = client.query.bind(client);
      const query = vi.spyOn(client, 'query').mockImplementation(async (...args: unknown[]) => {
        if (String(args[0]).includes('INSERT INTO memory_embeddings')) {
          throw new Error('synthetic database write failure');
        }
        return originalQuery(...args as [never]);
      });
      restoreQuery = () => query.mockRestore();
      return client;
    });

    let report;
    try {
      report = await runEmbeddingBackfill(pool, provider, { maxRows: 10 });
    } finally {
      restoreQuery();
      connect.mockRestore();
    }
    expect(report).toMatchObject({
      scanned: 1,
      eligible: 1,
      embedded: 0,
      completed: false,
      errorCodes: ['BACKFILL_STORE'],
      providerReports: [expect.objectContaining({
        provider: provider.id,
        scanned: 1,
        eligible: 1,
        errorCode: 'BACKFILL_STORE',
      })],
    });
  });

  it.each([
    ['OpenAI', 400, { error: {
      message: "This model's maximum context length is 8192 tokens, however you requested 9001 tokens (9001 in your prompt; 0 for the completion). Please reduce your prompt; or completion length.",
      type: 'invalid_request_error', param: null, code: null,
    } }, (fetchImpl: typeof fetch) => new OpenAIEmbeddingProvider({
      apiKey: 'private-key', model: 'model', dim: 768, fetchImpl,
    })],
    ['Voyage', 413, { detail: 'input exceeds maximum token limit' }, (fetchImpl: typeof fetch) => new VoyageEmbeddingProvider({
      apiKey: 'private-key', model: 'model', dim: 768, fetchImpl,
    })],
    ['Ollama', 422, { error: 'input exceeds context length' }, (fetchImpl: typeof fetch) => new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434', model: 'model', dim: 768, fetchImpl,
    })],
  ])('isolates a shipped %s provider HTTP %i input rejection and embeds healthy memories',
    async (name, status, errorBody, createProvider) => {
      const { memories } = await seed('project', `http-poison-${name}`, [
        'healthy one', 'healthy two', 'oversized item', 'healthy three',
      ]);
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as { input: string[] };
        if (payload.input.some((text) => text.includes('oversized item'))) {
          return new Response(JSON.stringify(errorBody), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        }
        const embeddings = payload.input.map((text) => [text.length, ...Array(767).fill(0)]);
        return {
          ok: true,
          json: async () => name === 'Ollama'
            ? { embeddings }
            : { data: embeddings.map((embedding, index) => ({ embedding, index })) },
        } as Response;
      }) as typeof fetch;
      const provider = createProvider(fetchImpl);

      const report = await runEmbeddingBackfill(pool, provider, {
        batchSize: 4, maxRows: 10,
      });

      expect(report).toMatchObject({ embedded: 3, failed: 1, completed: true });
      expect(fetchImpl).toHaveBeenCalledTimes(5);
      const stored = await pool.query(
        'SELECT memory_id FROM memory_embeddings ORDER BY memory_id',
      );
      expect(stored.rows.map((row) => row.memory_id)).toEqual([
        memories[0]!.id, memories[1]!.id, memories[3]!.id,
      ].sort());
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM audit_log
          WHERE memory_id = $1 AND metadata->>'operation' = 'embedding_backfill'`,
        [memories[2]!.id],
      )).rows[0].count).toBe(1);
    });

  it.each([
    ['OpenAI', (fetchImpl: typeof fetch) => new OpenAIEmbeddingProvider({
      apiKey: 'test-key', model: 'model', dim: 768, fetchImpl,
    })],
    ['Voyage', (fetchImpl: typeof fetch) => new VoyageEmbeddingProvider({
      apiKey: 'test-key', model: 'model', dim: 768, fetchImpl,
    })],
    ['Ollama', (fetchImpl: typeof fetch) => new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434', model: 'model', dim: 768, fetchImpl,
    })],
  ])('does not bisect a shipped %s provider-wide HTTP 400', async (name, createProvider) => {
    await seed('project', `provider-wide-400-${name}`, ['one', 'two', 'three', 'four']);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'invalid_model_configuration', message: 'provider configuration rejected' },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    const report = await runEmbeddingBackfill(pool, createProvider(fetchImpl), {
      batchSize: 4, maxRows: 10,
    });

    expect(report).toMatchObject({ completed: false, errorCodes: ['EMBEDDING_FAILED'] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT count(*)::int AS count FROM memory_embeddings')).rows[0].count).toBe(0);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE metadata->>'operation' = 'embedding_backfill'`,
    )).rows[0].count).toBe(0);
  });

  it.each([
    ['timeout', new EmbeddingProviderError('EMBEDDING_TIMEOUT', 'private timeout detail'), 'EMBEDDING_TIMEOUT', 1],
    ['network', new EmbeddingProviderError('EMBEDDING_NETWORK', 'private network detail'), 'EMBEDDING_NETWORK', 1],
    ['authentication', new EmbeddingProviderError('EMBEDDING_AUTH', 'private auth detail'), 'EMBEDDING_AUTH', 1],
    ['rate limit', new EmbeddingProviderError('EMBEDDING_RATE_LIMIT', 'private quota detail'), 'EMBEDDING_RATE_LIMIT', 1],
    ['server outage', new EmbeddingProviderError('EMBEDDING_SERVER', 'private upstream detail'), 'EMBEDDING_SERVER', 7],
    ['unknown provider outage', new Error('private unknown outage detail'), 'EMBEDDING_FAILED', 7],
  ])('reports a provider-wide %s without item audits', async (_label, failure, code, expectedCalls) => {
    await seed('project', `outage-${_label}`, ['one', 'two', 'three', 'four']);
    const embed = vi.fn(async () => { throw failure; });
    const provider: EmbeddingProvider = {
      id: 'ollama:outage', dim: 768, local: true, embed,
    };

    const report = await runEmbeddingBackfill(pool, provider, {
      batchSize: 4, maxRows: 10,
    });

    expect(report).toMatchObject({ completed: false, errorCodes: [code] });
    expect(embed).toHaveBeenCalledTimes(expectedCalls);
    expect(embed.mock.calls[0]?.[0]).toHaveLength(4);
    expect((await pool.query('SELECT count(*)::int AS count FROM memory_embeddings')).rows[0].count).toBe(0);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE metadata->>'operation' = 'embedding_backfill'`,
    )).rows[0].count).toBe(0);
  });

  it('keeps a uniformly invalid whole-batch response provider-wide without row failures', async () => {
    await seed('project', 'invalid-global-response', ['one', 'two', 'three']);
    const embed = vi.fn(async () => [[0]]);
    const provider: EmbeddingProvider = {
      id: 'ollama:invalid-response', dim: 768, local: true, embed,
    };

    const report = await runEmbeddingBackfill(pool, provider, { batchSize: 3, maxRows: 10 });
    expect(report).toMatchObject({ embedded: 0, failed: 0, completed: false });
    expect(report.providerReports[0]).toMatchObject({ errorCode: 'EMBEDDING_INVALID_RESPONSE' });
    expect(embed.mock.calls.length).toBeGreaterThan(1);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE metadata->>'operation' = 'embedding_backfill'`,
    )).rows[0].count).toBe(0);
  });

  it('contains token-limit item errors raised during diagnostic sub-batches', async () => {
    await seed('project', 'diagnostic-token-limit', ['healthy one', 'poison item', 'healthy two', 'healthy three']);
    const embed = vi.fn(async (texts: string[]) => {
      if (texts.length === 4) {
        throw new EmbeddingProviderError('EMBEDDING_SERVER', 'ambiguous batch failure', { diagnostic: true });
      }
      if (texts.some((text) => text.includes('poison item'))) {
        throw new EmbeddingItemError('aggregate token limit');
      }
      return vectors.embed(texts);
    });
    const provider: EmbeddingProvider = {
      id: 'voyage:diagnostic-token-limit', dim: 768, local: false, embed,
    };

    const report = await runEmbeddingBackfill(pool, provider, { batchSize: 4, maxRows: 10 });

    expect(report).toMatchObject({ embedded: 3, failed: 1, completed: true });
    expect(report.errorCodes).toEqual([]);
  });

  it('records intermittent 5xx isolation as a retryable suspect, not durable poison', async () => {
    const { memories } = await seed('project', 'transient-suspect', ['healthy one', 'transient item', 'healthy two']);
    let unhealthy = true;
    const embed = vi.fn(async (texts: string[]) => {
      if (unhealthy && texts.some((text) => text.includes('transient item'))) {
        throw new EmbeddingProviderError('EMBEDDING_SERVER', 'temporary upstream failure', { diagnostic: true });
      }
      return vectors.embed(texts);
    });
    const provider: EmbeddingProvider = {
      id: 'openai:transient-suspect', dim: 768, local: false, embed,
    };

    const first = await runEmbeddingBackfill(pool, provider, { batchSize: 3, maxRows: 10 });
    expect(first).toMatchObject({ embedded: 2, failed: 0, completed: false });
    expect(first.unresolvedIds).toEqual([memories[1]!.id]);
    expect((await pool.query(
      `SELECT disposition, reason FROM embedding_backfill_failures WHERE memory_id = $1`,
      [memories[1]!.id],
    )).rows).toEqual([{ disposition: 'suspect', reason: 'EMBEDDING_SERVER' }]);

    unhealthy = false;
    const second = await runEmbeddingBackfill(pool, provider, { batchSize: 3, maxRows: 10 });
    expect(second).toMatchObject({ embedded: 1, failed: 0, completed: true });
    expect(second.unresolvedIds).toEqual([]);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM embedding_backfill_failures WHERE memory_id = $1`,
      [memories[1]!.id],
    )).rows[0].count).toBe(0);
  });

  it('does not let a no-wrap cursor skip an unresolved ambiguous row', async () => {
    const { memories } = await seed('project', 'no-wrap-ambiguous', [
      'lower boundary', 'healthy before', 'ambiguous target', 'healthy after',
    ]);
    const ordered = [...memories].sort((left, right) => left.id.localeCompare(right.id));
    const labels = ['lower boundary', 'healthy before', 'ambiguous target', 'healthy after'];
    for (let index = 0; index < ordered.length; index += 1) {
      await pool.query('UPDATE memories SET title = $2, body = $3 WHERE id = $1', [
        ordered[index]!.id, labels[index], `body for ${labels[index]}`,
      ]);
    }
    let ambiguous = true;
    const provider: EmbeddingProvider = {
      id: 'hosted:no-wrap-ambiguous', dim: 768, local: false,
      async embed(texts) {
        if (ambiguous && (texts.length > 1
          || texts.some((text) => text.includes('ambiguous target')))) {
          throw new EmbeddingProviderError(
            'EMBEDDING_SERVER', 'ambiguous batch', { diagnostic: true },
          );
        }
        return vectors.embed(texts);
      },
    };

    const first = await runEmbeddingBackfill(pool, provider, {
      providerId: provider.id, cursor: ordered[0]!.id,
      noWrap: true, batchSize: 3, maxRows: 10,
    });
    expect(first).toMatchObject({
      completed: false,
      cursor: ordered[1]!.id,
      unresolvedIds: [ordered[2]!.id],
    });

    ambiguous = false;
    const retry = await runEmbeddingBackfill(pool, provider, {
      providerId: provider.id, cursor: first.cursor!,
      noWrap: true, batchSize: 3, maxRows: 10,
    });
    expect(retry).toMatchObject({ embedded: 1, completed: true, unresolvedCount: 0 });
    expect((await pool.query(
      `SELECT memory_id FROM memory_embeddings
        WHERE memory_id = $1 AND provider = $2 AND dim = $3`,
      [ordered[2]!.id, provider.id, provider.dim],
    )).rows).toEqual([{ memory_id: ordered[2]!.id }]);
  });

  it('stops a batch-size-one provider outage without suppressing every row', async () => {
    await seed('project', 'single-ambiguous', ['ambiguous one', 'ambiguous two', 'ambiguous three']);
    const embed = vi.fn(async () => {
      throw new EmbeddingProviderError('EMBEDDING_SERVER', 'temporary upstream failure', { diagnostic: true });
    });
    const provider: EmbeddingProvider = {
      id: 'ollama:single-ambiguous', dim: 768, local: true, embed,
    };

    const report = await runEmbeddingBackfill(pool, provider, { batchSize: 1, maxRows: 10 });

    expect(report).toMatchObject({ embedded: 0, failed: 0, completed: false });
    expect(report.errorCodes).toEqual(['EMBEDDING_SERVER']);
    expect(report.unresolvedIds).toEqual([]);
    expect(embed).toHaveBeenCalledOnce();
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM embedding_backfill_failures
        WHERE provider = $1 AND dim = $2`,
      [provider.id, provider.dim],
    )).rows[0].count).toBe(0);
  });

  it('stores already-paid valid vectors and retries only invalid response items', async () => {
    await seed('project', 'partial-invalid', ['one', 'two', 'three']);
    const embed = vi.fn(async (texts: string[]) => {
      if (texts.length === 3) {
        const valid = await vectors.embed(texts);
        valid[1] = [0];
        return valid;
      }
      return vectors.embed(texts);
    });
    const provider: EmbeddingProvider = {
      id: 'ollama:partial-invalid', dim: 768, local: true, embed,
    };

    const report = await runEmbeddingBackfill(pool, provider, { batchSize: 3, maxRows: 10 });

    expect(report).toMatchObject({ embedded: 3, failed: 0, completed: true });
    expect(embed.mock.calls.map(([texts]) => texts.length)).toEqual([3, 1]);
  });

  it('reports a provider-local lock error and continues an unrelated provider', async () => {
    await seed('project', 'locked-provider-scope', ['locked row']);
    await seed('project', 'healthy-provider-scope', ['healthy row']);
    const lockedProvider: EmbeddingProvider = {
      id: 'hosted:locked-provider', dim: 768, local: false, embed: (texts) => vectors.embed(texts),
    };
    const healthyProvider: EmbeddingProvider = {
      id: 'ollama:healthy-provider', dim: 768, local: true, embed: (texts) => vectors.embed(texts),
    };
    const router = new ScopeEmbeddingRouter(
      new EmbeddingRegistry([['locked', lockedProvider], ['healthy', healthyProvider]]),
      {
        default: 'healthy',
        rules: [{ match: { kind: 'project', name: 'locked-provider-scope' }, provider: 'locked' }],
      },
    );
    const lockName = `continuum:embed-backfill:${lockedProvider.id}:${lockedProvider.dim}`;
    const lockClient = await pool.connect();
    await lockClient.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockName]);
    try {
      const report = await runEmbeddingBackfill(pool, router, { maxRows: 10 });
      expect(report).toMatchObject({ embedded: 1, completed: false });
      expect(report.providerReports).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider: lockedProvider.id, errorCode: 'BACKFILL_LOCK' }),
        expect.objectContaining({ provider: healthyProvider.id, embedded: 1 }),
      ]));
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]);
      lockClient.release();
    }
  });

  it('supports count-only and dry-run without embeddings or checkpoint writes', async () => {
    await seed('project', 'preview', ['one', 'two']);
    const embed = vi.fn((texts: string[]) => vectors.embed(texts));
    const provider: EmbeddingProvider = {
      id: 'ollama:preview', dim: 768, local: true, embed,
    };

    const count = await runEmbeddingBackfill(pool, provider, { countOnly: true });
    const dryRun = await runEmbeddingBackfill(pool, provider, { dryRun: true, maxRows: 1 });

    expect(count).toMatchObject({ eligible: 2, embedded: 0 });
    expect(dryRun).toMatchObject({ eligible: 1, embedded: 0 });
    expect(embed).not.toHaveBeenCalled();
    expect((await pool.query('SELECT count(*)::int AS count FROM embedding_backfill_checkpoints')).rows[0].count).toBe(0);
  });

  it('bounds diagnostic probes during a provider-wide brownout', async () => {
    await seed('project', 'bounded-brownout', Array.from({ length: 32 }, (_, index) => `row ${index}`));
    const embed = vi.fn(async () => {
      throw new EmbeddingProviderError('EMBEDDING_SERVER', 'provider unavailable', { diagnostic: true });
    });
    const provider: EmbeddingProvider = {
      id: 'hosted:bounded-brownout', dim: 768, local: false, embed,
    };

    const report = await runEmbeddingBackfill(pool, provider, { batchSize: 32, maxRows: 32 });

    expect(report).toMatchObject({ completed: false, errorCodes: ['EMBEDDING_SERVER'] });
    expect(embed.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('stops diagnostic recursion at the error budget without advancing past unaudited rows', async () => {
    const { memories } = await seed('project', 'diagnostic-budget', [
      'healthy before', 'poison first', 'poison unaudited', 'healthy unaudited',
    ]);
    const embed = vi.fn(async (texts: string[]) => {
      if (texts.some((text) => text.includes('poison'))) {
        if (texts.length === 1) throw new EmbeddingItemError('deterministic poison');
        throw new EmbeddingProviderError('EMBEDDING_SERVER', 'ambiguous batch', { diagnostic: true });
      }
      return vectors.embed(texts);
    });
    const provider: EmbeddingProvider = {
      id: 'hosted:diagnostic-budget', dim: 768, local: false, embed,
    };
    const ordered = [...memories].sort((left, right) => left.id.localeCompare(right.id));
    const firstPoison = ordered.find((memory) => memory.title.includes('poison'))!;
    const embeddedBeforeBudget = ordered
      .filter((memory) => memory.id < firstPoison.id && !memory.title.includes('poison'))
      .map((memory) => ({ memory_id: memory.id }));

    const report = await runEmbeddingBackfill(pool, provider, {
      batchSize: 4, maxRows: 10, maxErrors: 1,
    });

    expect(report).toMatchObject({
      failed: 1,
      completed: false,
      errorCodes: ['BACKFILL_ERROR_BUDGET'],
      cursor: firstPoison.id,
    });
    expect((await pool.query(
      `SELECT memory_id FROM embedding_backfill_failures
        WHERE provider = $1 ORDER BY memory_id`,
      [provider.id],
    )).rows).toEqual([{ memory_id: firstPoison.id }]);
    expect((await pool.query(
      'SELECT memory_id FROM memory_embeddings ORDER BY memory_id',
    )).rows).toEqual(embeddedBeforeBudget);
  });

  it('records ambiguous rows found before diagnostic error-budget exhaustion', async () => {
    const { memories } = await seed('project', 'diagnostic-budget-ambiguous', [
      'placeholder one', 'placeholder two', 'placeholder three', 'placeholder four',
    ]);
    const ordered = [...memories].sort((left, right) => left.id.localeCompare(right.id));
    const labels = ['healthy before', 'ambiguous suspect', 'healthy after', 'poison budget'];
    for (let index = 0; index < ordered.length; index += 1) {
      await pool.query('UPDATE memories SET title = $2, body = $3 WHERE id = $1', [
        ordered[index]!.id, labels[index], `body for ${labels[index]}`,
      ]);
    }
    const embed = vi.fn(async (texts: string[]) => {
      if (texts.length === 4 || texts.some((text) => text.includes('ambiguous suspect'))) {
        throw new EmbeddingProviderError('EMBEDDING_SERVER', 'ambiguous batch', { diagnostic: true });
      }
      if (texts.some((text) => text.includes('poison budget'))) {
        if (texts.length === 1) throw new EmbeddingItemError('deterministic poison');
        throw new EmbeddingProviderError('EMBEDDING_SERVER', 'ambiguous batch', { diagnostic: true });
      }
      return vectors.embed(texts);
    });
    const provider: EmbeddingProvider = {
      id: 'hosted:diagnostic-budget-ambiguous', dim: 768, local: false, embed,
    };

    const report = await runEmbeddingBackfill(pool, provider, {
      batchSize: 4, maxRows: 10, maxErrors: 1,
    });

    expect(report).toMatchObject({
      failed: 1,
      completed: false,
      errorCodes: ['BACKFILL_ERROR_BUDGET'],
      cursor: ordered[0]!.id,
      unresolvedIds: [ordered[1]!.id],
      unresolvedCount: 1,
    });
    expect((await pool.query(
      `SELECT memory_id, disposition FROM embedding_backfill_failures
        WHERE provider = $1 ORDER BY memory_id`,
      [provider.id],
    )).rows).toEqual([
      { memory_id: ordered[1]!.id, disposition: 'suspect' },
      { memory_id: ordered[3]!.id, disposition: 'durable' },
    ]);
  });

  it('contains partial-invalid vectors discovered during diagnostic bisection', async () => {
    await seed('project', 'diagnostic-partial-invalid', ['one', 'invalid', 'three', 'four']);
    let first = true;
    const embed = vi.fn(async (texts: string[]) => {
      if (first) {
        first = false;
        throw new EmbeddingProviderError('EMBEDDING_SERVER', 'ambiguous batch', { diagnostic: true });
      }
      const result = await vectors.embed(texts);
      if (texts.length > 1) {
        const invalid = texts.findIndex((text) => text.includes('invalid'));
        if (invalid >= 0) result[invalid] = [0];
      }
      return result;
    });
    const provider: EmbeddingProvider = {
      id: 'hosted:diagnostic-partial-invalid', dim: 768, local: false, embed,
    };

    const report = await runEmbeddingBackfill(pool, provider, { batchSize: 4, maxRows: 10 });

    expect(report).toMatchObject({ embedded: 4, failed: 0, completed: true });
    expect(report.errorCodes).toEqual([]);
  });

  it('records top-level partial-invalid rows after storing valid vectors', async () => {
    const { memories } = await seed('project', 'top-level-partial-invalid', ['one', 'invalid', 'three']);
    const invalid = memories.find((memory) => memory.title === 'invalid')!;
    const embed = vi.fn(async (texts: string[]) => {
      const result = await vectors.embed(texts);
      const bad = texts.findIndex((text) => text.includes('invalid'));
      if (bad >= 0) result[bad] = [0];
      return result;
    });
    const provider: EmbeddingProvider = {
      id: 'hosted:top-level-partial-invalid', dim: 768, local: false, embed,
    };

    const report = await runEmbeddingBackfill(pool, provider, { batchSize: 3, maxRows: 10 });

    expect(report).toMatchObject({
      embedded: 2, failed: 0, completed: false,
      unresolvedIds: [invalid.id], unresolvedCount: 1,
    });
    expect(embed.mock.calls.map(([texts]) => texts.length)).toEqual([3, 1]);
    expect((await pool.query(
      `SELECT memory_id, disposition, reason FROM embedding_backfill_failures
        WHERE provider = $1`,
      [provider.id],
    )).rows).toEqual([{
      memory_id: invalid.id,
      disposition: 'suspect',
      reason: 'EMBEDDING_INVALID_RESPONSE',
    }]);
  });

  it('keeps provider calls within a bounded input-text budget', async () => {
    const { memories } = await seed('project', 'bounded-input-text', ['large one', 'large two']);
    const largeBody = 'x'.repeat(5 * 1024 * 1024);
    await pool.query('UPDATE memories SET body = $2 WHERE id = ANY($1::uuid[])', [
      memories.map((memory) => memory.id), largeBody,
    ]);
    const embed = vi.fn((texts: string[]) => vectors.embed(texts));
    const provider: EmbeddingProvider = {
      id: 'hosted:bounded-input-text', dim: 768, local: false, embed,
    };

    const report = await runEmbeddingBackfill(pool, provider, { batchSize: 1000, maxRows: 10 });

    expect(report).toMatchObject({ embedded: 2, completed: true });
    expect(embed.mock.calls.map(([texts]) => texts.length)).toEqual([1, 1]);
  });

  it('pages a large count-only scan in ID order without selecting or hydrating bodies', async () => {
    const titles = Array.from({ length: 257 }, (_, index) => `candidate ${index}`);
    await seed('project', 'two-phase-count', titles);
    const provider: EmbeddingProvider = {
      id: 'hosted:two-phase-count', dim: 768, local: false,
      embed: vi.fn(async () => { throw new Error('count-only must not embed'); }),
    };
    const client = await pool.connect();
    const statements: string[] = [];
    const cursors: Array<string | null> = [];
    const query = vi.fn(async (text: string, params?: unknown[]) => {
      statements.push(text);
      if (text.includes('octet_length(m.title)')) cursors.push((params?.[0] as string | null) ?? null);
      return client.query(text, params);
    });
    const observedPool = {
      connect: vi.fn(async () => ({ query, release: () => client.release() })),
    } as unknown as pg.Pool;

    const report = await runEmbeddingBackfill(observedPool, provider, {
      countOnly: true, batchSize: 1, maxRows: 1,
    });

    expect(report).toMatchObject({ scanned: 257, eligible: 257, embedded: 0, completed: true });
    expect(cursors.length).toBeGreaterThan(2);
    expect(cursors[0]).toBeNull();
    expect(cursors.slice(1).every((value) => typeof value === 'string')).toBe(true);
    expect(statements.filter((text) => text.includes('octet_length(m.title)'))
      .every((text) => !/m\.title\s*,\s*m\.body/i.test(text))).toBe(true);
    expect(statements.some((text) => /SELECT m\.id, m\.title, m\.body/i.test(text))).toBe(false);
    expect(provider.embed).not.toHaveBeenCalled();
  });

  it('caps unresolved ID samples while retaining the total suspect count', async () => {
    const titles = Array.from({ length: 52 }, (_, index) =>
      index % 2 === 0 ? `healthy ${index}` : `transient ${index}`);
    await seed('project', 'bounded-unresolved-report', titles);
    let singletonProbe = 0;
    const unitVector = Array<number>(768).fill(0);
    unitVector[0] = 1;
    const embed = vi.fn(async (texts: string[]) => {
      if (texts.length > 1) {
        throw new EmbeddingProviderError('EMBEDDING_SERVER', 'temporary upstream failure', { diagnostic: true });
      }
      singletonProbe += 1;
      if (singletonProbe % 2 === 0) {
        throw new EmbeddingProviderError('EMBEDDING_SERVER', 'temporary upstream failure', { diagnostic: true });
      }
      return texts.map(() => unitVector);
    });
    const provider: EmbeddingProvider = {
      id: 'hosted:bounded-unresolved-report', dim: 768, local: false, embed,
    };

    const report = await runEmbeddingBackfill(pool, provider, { batchSize: 2, maxRows: 52 });

    expect(report).toMatchObject({
      completed: false,
      unresolvedCount: 26,
      unresolvedTruncated: true,
    });
    expect(report.unresolvedIds).toHaveLength(25);
    expect(embed).toHaveBeenCalledTimes(78);
  });
});
