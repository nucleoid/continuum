import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  EmbeddingItemError,
  EmbeddingProviderError,
  type EmbeddingProvider,
} from '../embeddings/provider.js';
import { EmbeddingRegistry, ScopeEmbeddingRouter } from '../embeddings/router.js';
import { StubEmbeddingProvider } from '../embeddings/stub.js';
import { createMemory } from '../storage/memories.js';
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
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

  it('rejects a concurrent run for the same provider advisory lock', async () => {
    await seed('project', 'locked', ['waiting']);
    const provider: EmbeddingProvider = {
      id: 'ollama:locked', dim: 768, local: true,
      embed: (texts) => vectors.embed(texts),
    };
    const lockName = 'continuum:embed-backfill:ollama:locked:768:';
    const client = await pool.connect();
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockName]);
    try {
      await expect(runEmbeddingBackfill(pool, provider, { maxRows: 10 }))
        .rejects.toThrow(/already running/i);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]);
      client.release();
    }
  });

  it('isolates a poison item, retries with bounded backoff, audits it, and continues', async () => {
    const { memories } = await seed('project', 'poison', ['healthy one', 'poison item', 'healthy two']);
    const sleep = vi.fn(async () => undefined);
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
      batchSize: 3, maxRows: 10, maxRetries: 2, retryBaseMs: 1, sleep,
    });

    expect(report).toMatchObject({ embedded: 2, failed: 1, completed: true });
    expect(sleep).toHaveBeenCalledTimes(2);
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

  it.each([
    ['timeout', new EmbeddingProviderError('EMBEDDING_TIMEOUT', 'private timeout detail')],
    ['network', new EmbeddingProviderError('EMBEDDING_NETWORK', 'private network detail')],
    ['authentication', new EmbeddingProviderError('EMBEDDING_AUTH', 'private auth detail')],
    ['rate limit', new EmbeddingProviderError('EMBEDDING_RATE_LIMIT', 'private quota detail')],
    ['server outage', new EmbeddingProviderError('EMBEDDING_SERVER', 'private upstream detail')],
    ['unknown provider outage', new Error('private unknown outage detail')],
  ])('fails a whole batch once on a provider-wide %s without delay or item audits', async (_label, failure) => {
    await seed('project', `outage-${_label}`, ['one', 'two', 'three', 'four']);
    const sleep = vi.fn(async () => undefined);
    const embed = vi.fn(async () => { throw failure; });
    const provider: EmbeddingProvider = {
      id: 'ollama:outage', dim: 768, local: true, embed,
    };

    await expect(runEmbeddingBackfill(pool, provider, {
      batchSize: 4, maxRows: 10, maxRetries: 3, retryBaseMs: 1, sleep,
    })).rejects.toMatchObject({ code: 'EMBEDDING_FAILED' });

    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0]?.[0]).toHaveLength(4);
    expect(sleep).not.toHaveBeenCalled();
    expect((await pool.query('SELECT count(*)::int AS count FROM memory_embeddings')).rows[0].count).toBe(0);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE metadata->>'operation' = 'embedding_backfill'`,
    )).rows[0].count).toBe(0);
  });

  it('treats an invalid whole-batch response as provider-wide without recursive calls', async () => {
    await seed('project', 'invalid-global-response', ['one', 'two', 'three']);
    const sleep = vi.fn(async () => undefined);
    const embed = vi.fn(async () => [[0]]);
    const provider: EmbeddingProvider = {
      id: 'ollama:invalid-response', dim: 768, local: true, embed,
    };

    await expect(runEmbeddingBackfill(pool, provider, {
      batchSize: 3, maxRows: 10, maxRetries: 3, retryBaseMs: 1, sleep,
    })).rejects.toMatchObject({ code: 'EMBEDDING_FAILED' });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE metadata->>'operation' = 'embedding_backfill'`,
    )).rows[0].count).toBe(0);
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
});
