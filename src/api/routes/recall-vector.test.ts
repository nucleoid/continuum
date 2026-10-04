import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createApp } from '../server.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';
import { StubEmbeddingProvider } from '../../embeddings/stub.js';
import type { EmbeddingProvider } from '../../embeddings/provider.js';

class NamedStubEmbeddingProvider implements EmbeddingProvider {
  readonly dim = 768;
  private readonly stub = new StubEmbeddingProvider(this.dim);

  constructor(readonly id: string) {}

  embed(texts: string[]): Promise<number[][]> {
    return this.stub.embed(texts);
  }
}

describe('capture + recall with embeddings', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  const provider = new StubEmbeddingProvider();

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
    app = createApp(pool, { embeddingProvider: provider });
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function seedActor() {
    const principal = await createPrincipal(pool, {
      externalId: 'entra:user:vec',
      kind: 'user',
      displayName: 'Vec User',
    });
    const scope = await createScope(pool, { kind: 'team', name: 'payments' });
    await addMembership(pool, principal.id, scope.id, 'writer');
    return { principal, scope };
  }

  it('persists an embedding row on capture and surfaces it on recall', async () => {
    await seedActor();
    const create = await request(app)
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:vec')
      .send({
        scope: { kind: 'team', name: 'payments' },
        type: 'decision',
        title: 'Checkout retry policy',
        body: 'Retry checkout requests with exponential backoff capped at 30 seconds.',
        source: 'manual',
      });
    expect(create.status).toBe(201);
    expect(create.body.embedded).toBe(true);

    const stored = await pool.query(
      'SELECT provider, dim FROM memory_embeddings WHERE memory_id = $1',
      [create.body.id],
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0].provider).toBe(provider.id);
    expect(stored.rows[0].dim).toBe(provider.dim);

    const recall = await request(app)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:vec')
      .send({ query: 'checkout retry policy' });
    expect(recall.status).toBe(200);
    const ids = recall.body.results.map((r: { id: string }) => r.id);
    expect(ids).toContain(create.body.id);
  });

  it('falls back gracefully when no embeddings exist for some memories', async () => {
    const { scope, principal } = await seedActor();
    // Insert one memory directly with no embedding row.
    const direct = await pool.query(
      `INSERT INTO memories (id, scope_id, type, title, body, author_id, source)
       VALUES (gen_random_uuid(), $1, 'fact', 'Plain fact', 'Some body about checkout pricing.', $2, 'manual')
       RETURNING id`,
      [scope.id, principal.id],
    );
    const plainId = direct.rows[0].id as string;

    const recall = await request(app)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:vec')
      .send({ query: 'checkout pricing' });
    expect(recall.status).toBe(200);
    // FTS half still finds it even without an embedding.
    expect(
      recall.body.results.map((r: { id: string }) => r.id),
    ).toContain(plainId);
  });

  it('uses only vector candidates from the exact active provider and dimension', async () => {
    await seedActor();
    const providerA = new NamedStubEmbeddingProvider('stub:model-a');
    const providerB = new NamedStubEmbeddingProvider('stub:model-b');
    const appA = createApp(pool, { embeddingProvider: providerA });
    const appB = createApp(pool, { embeddingProvider: providerB });

    const oldProviderMemory = await request(appA)
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:vec')
      .send({
        scope: { kind: 'team', name: 'payments' },
        type: 'fact',
        title: 'Old provider only',
        body: 'Material that does not contain the recall terms.',
        source: 'manual',
      });
    const activeProviderMemory = await request(appB)
      .post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:user:vec')
      .send({
        scope: { kind: 'team', name: 'payments' },
        type: 'fact',
        title: 'Active provider only',
        body: 'Different material without the recall terms.',
        source: 'manual',
      });

    const recall = await request(appB)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:vec')
      .send({ query: 'zyxwvu qqqqq' });

    expect(recall.status).toBe(200);
    const ids = recall.body.results.map((result: { id: string }) => result.id);
    expect(ids).toContain(activeProviderMemory.body.id);
    expect(ids).not.toContain(oldProviderMemory.body.id);

    const stored = await pool.query(
      'SELECT provider FROM memory_embeddings ORDER BY provider',
    );
    expect(stored.rows.map((row) => row.provider)).toEqual([
      providerA.id,
      providerB.id,
    ]);
  });

  it('ignores wrong-dimension rows and still returns FTS results', async () => {
    const { scope, principal } = await seedActor();
    const memory = await pool.query(
      `INSERT INTO memories (id, scope_id, type, title, body, author_id, source)
       VALUES (gen_random_uuid(), $1, 'fact', 'Provider migration fallback',
               'The migration fallback remains searchable through full text.', $2, 'manual')
       RETURNING id`,
      [scope.id, principal.id],
    );
    const [vector] = await provider.embed(['wrong dimension metadata']);
    await pool.query(
      `INSERT INTO memory_embeddings (memory_id, provider, dim, embedding)
       VALUES ($1, $2, 384, $3::vector)`,
      [memory.rows[0].id, provider.id, `[${vector.join(',')}]`],
    );

    const vectorOnlyRecall = await request(app)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:vec')
      .send({ query: 'zyxwvu qqqqq' });

    expect(vectorOnlyRecall.status).toBe(200);
    expect(vectorOnlyRecall.body.results).toEqual([]);

    const ftsRecall = await request(app)
      .post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:user:vec')
      .send({ query: 'migration fallback' });

    expect(ftsRecall.status).toBe(200);
    expect(ftsRecall.body.results.map((result: { id: string }) => result.id))
      .toContain(memory.rows[0].id);
  });
});
