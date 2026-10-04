import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import type { EmbeddingProvider } from '../../embeddings/provider.js';
import { EmbeddingRegistry, ScopeEmbeddingRouter } from '../../embeddings/router.js';
import { StubEmbeddingProvider } from '../../embeddings/stub.js';
import { addMembership } from '../../storage/memberships.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope } from '../../storage/scopes.js';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createApp } from '../server.js';
import { captureMemory } from '../../services/capture.js';
import { promoteForPrincipal } from '../../services/lifecycle.js';
import { supersedeForPrincipal } from '../../services/supersede.js';
import { createMemory } from '../../storage/memories.js';

describe('scope-pinned embedding routing', () => {
  let pool: pg.Pool;
  const vectors = new StubEmbeddingProvider();

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });
  afterAll(async () => pool?.end());

  async function seedActor() {
    const principal = await createPrincipal(pool, {
      externalId: 'entra:routing', kind: 'user', displayName: 'Routing User',
    });
    const team = await createScope(pool, { kind: 'team', name: 'payments' });
    const project = await createScope(pool, { kind: 'project', name: 'shop' });
    await addMembership(pool, principal.id, team.id, 'writer');
    await addMembership(pool, principal.id, project.id, 'writer');
    return { principal, team, project };
  }

  it('routes capture by scope and embeds recall once per provider group', async () => {
    await seedActor();
    const localEmbed = vi.fn(async (texts: string[]) => vectors.embed(texts));
    const hostedEmbed = vi.fn(async (texts: string[]) => vectors.embed(texts));
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
        rules: [
          { match: { kind: 'team' }, provider: 'local-only' },
          { match: { kind: 'project' }, provider: 'local-only' },
        ],
      },
    );
    const app = createApp(pool, { embeddingProvider: router });

    for (const [kind, name] of [['team', 'payments'], ['project', 'shop']] as const) {
      const response = await request(app).post('/api/v0/capture')
        .set('Authorization', 'Bearer entra:routing')
        .send({
          scope: { kind, name }, type: 'fact', title: `${kind} vector`,
          body: 'Material without query terms.', source: 'manual',
        });
      expect(response.status).toBe(201);
    }
    expect(hostedEmbed).not.toHaveBeenCalled();
    expect(localEmbed).toHaveBeenCalledTimes(2);
    localEmbed.mockClear();
    hostedEmbed.mockClear();

    const response = await request(app).post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:routing')
      .send({ query: 'unmatched semantic query' });

    expect(response.status).toBe(200);
    expect(localEmbed).toHaveBeenCalledTimes(1);
    expect(hostedEmbed).toHaveBeenCalledTimes(1);
    const { rows } = await pool.query(
      'SELECT DISTINCT provider FROM memory_embeddings ORDER BY provider',
    );
    expect(rows).toEqual([{ provider: 'ollama:local' }]);
  });

  it('keeps local-only scopes full-text-only when no local provider exists', async () => {
    await seedActor();
    const hostedEmbed = vi.fn(async (texts: string[]) => vectors.embed(texts));
    const hosted: EmbeddingProvider = {
      id: 'openai:hosted', dim: 768, local: false, embed: hostedEmbed,
    };
    const router = new ScopeEmbeddingRouter(
      new EmbeddingRegistry([['hosted', hosted]]),
      { default: 'hosted', rules: [{ match: { kind: 'team' }, provider: 'local-only' }] },
    );
    const app = createApp(pool, { embeddingProvider: router });

    const captured = await request(app).post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:routing')
      .send({
        scope: { kind: 'team', name: 'payments' }, type: 'fact',
        title: 'Private full text sentinel', body: 'Sensitive local material.', source: 'manual',
      });
    expect(captured.status).toBe(201);
    expect(captured.body.embedded).toBe(false);
    expect(hostedEmbed).not.toHaveBeenCalled();

    const recalled = await request(app).post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:routing')
      .send({ query: 'private full text sentinel', scopes: ['team:payments'] });
    expect(recalled.status).toBe(200);
    expect(recalled.body.results.map((item: { id: string }) => item.id))
      .toContain(captured.body.id);
    expect(hostedEmbed).not.toHaveBeenCalled();
  });

  it('degrades an unavailable provider group to full-text results', async () => {
    await seedActor();
    const failing: EmbeddingProvider = {
      id: 'ollama:down', dim: 768, local: true,
      async embed() { throw new Error('offline private detail'); },
    };
    const app = createApp(pool, { embeddingProvider: failing });
    const captured = await request(app).post('/api/v0/capture')
      .set('Authorization', 'Bearer entra:routing')
      .send({
        scope: { kind: 'team', name: 'payments' }, type: 'fact',
        title: 'Outage fallback sentinel', body: 'Still searchable.', source: 'manual',
      });

    const recalled = await request(app).post('/api/v0/recall')
      .set('Authorization', 'Bearer entra:routing')
      .send({ query: 'outage fallback sentinel' });
    expect(recalled.status).toBe(200);
    expect(recalled.body.results.map((item: { id: string }) => item.id))
      .toContain(captured.body.id);
  });

  it('does not copy a source embedding across a promotion boundary', async () => {
    const { principal } = await seedActor();
    const hosted: EmbeddingProvider = {
      id: 'openai:hosted', dim: 768, local: false,
      embed: (texts) => vectors.embed(texts),
    };
    const source = await captureMemory(pool, hosted, principal, {
      scope: { kind: 'project', name: 'shop' }, type: 'decision',
      title: 'Promotion boundary', body: 'Provider spaces stay scoped.', source: 'manual',
    });

    const promoted = await promoteForPrincipal(
      pool, principal, source.memory.id, { kind: 'team', name: 'payments' },
    );
    const { rows } = await pool.query(
      'SELECT memory_id, provider FROM memory_embeddings ORDER BY memory_id',
    );
    expect(rows).toEqual([{ memory_id: source.memory.id, provider: hosted.id }]);
    expect(rows.some((row) => row.memory_id === promoted.destination.id)).toBe(false);
  });

  it('routes a superseding decision embedding by its scope policy', async () => {
    const { principal, project } = await seedActor();
    const localEmbed = vi.fn(async (texts: string[]) => vectors.embed(texts));
    const hostedEmbed = vi.fn(async (texts: string[]) => vectors.embed(texts));
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
        rules: [{ match: { kind: 'project' }, provider: 'local-only' }],
      },
    );
    const predecessor = await createMemory(pool, {
      scopeId: project.id, scopeKind: project.kind, type: 'decision',
      title: 'Original route', body: 'Original decision.', authorId: principal.id,
      source: 'manual',
    });

    const result = await supersedeForPrincipal(pool, router, principal, {
      supersededId: predecessor.id, title: 'Routed head', body: 'Replacement decision.',
    });

    expect(result.embedded).toBe(true);
    expect(localEmbed).toHaveBeenCalledOnce();
    expect(hostedEmbed).not.toHaveBeenCalled();
    const { rows } = await pool.query(
      'SELECT memory_id, provider FROM memory_embeddings ORDER BY memory_id',
    );
    expect(rows).toEqual([{ memory_id: result.successor.id, provider: local.id }]);
  });
});
