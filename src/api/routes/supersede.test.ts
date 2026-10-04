import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { createApp } from '../server.js';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';
import { createMemory } from '../../storage/memories.js';
import { StubEmbeddingProvider } from '../../embeddings/stub.js';
import { storeMemoryEmbedding } from '../../storage/embeddings.js';

describe('decision supersession REST API', () => {
  let pool: pg.Pool;
  let token: string;
  let scopeId: string;
  let decisionId: string;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
    token = 'entra:user:supersede';
    const principal = await createPrincipal(pool, {
      externalId: token, kind: 'user', displayName: 'Decision Owner',
    });
    const scope = await createScope(pool, { kind: 'project', name: 'continuum' });
    scopeId = scope.id;
    await addMembership(pool, principal.id, scope.id, 'writer');
    decisionId = (await createMemory(pool, {
      scopeId: scope.id, scopeKind: scope.kind, type: 'decision',
      title: 'Use REST', body: 'Original decision body', authorId: principal.id,
      source: 'manual',
    })).id;
  });

  afterAll(async () => { await pool?.end(); });

  it('atomically creates a linked head, archives the predecessor, and audits both rows', async () => {
    const response = await request(createApp(pool))
      .post('/api/v0/supersede')
      .set('Authorization', `Bearer ${token}`)
      .send({
        supersededId: decisionId, title: 'Use gRPC', body: 'Replacement decision body',
        tags: ['architecture'], source: 'manual', metadata: { reason: 'latency' },
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      supersededId: decisionId, successorId: expect.any(String), scopeId,
      predecessorState: 'archived', embedded: false,
    });
    const { rows } = await pool.query(
      `SELECT id, state, supersedes_id FROM memories ORDER BY created_at, id`,
    );
    expect(rows).toContainEqual({ id: decisionId, state: 'archived', supersedes_id: null });
    expect(rows).toContainEqual({
      id: response.body.successorId, state: 'live', supersedes_id: decisionId,
    });
    const audits = await pool.query(
      `SELECT action, memory_id FROM audit_log ORDER BY id`,
    );
    expect(audits.rows).toEqual([
      { action: 'write', memory_id: response.body.successorId },
      { action: 'archive', memory_id: decisionId },
    ]);
  });

  it('returns the same successor on a repeated request without branching', async () => {
    const app = createApp(pool);
    const first = await request(app).post('/api/v0/supersede')
      .set('Authorization', `Bearer ${token}`)
      .send({ supersededId: decisionId, title: 'New', body: 'New body' });
    const second = await request(app).post('/api/v0/supersede')
      .set('Authorization', `Bearer ${token}`)
      .send({ supersededId: decisionId, title: 'Other', body: 'Other body' });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: 'CONFLICT', successorId: first.body.successorId });
    expect((await pool.query('SELECT count(*)::int AS count FROM memories')).rows[0].count).toBe(2);
  });

  it('serializes concurrent requests into one head and one conflict', async () => {
    const app = createApp(pool);
    const responses = await Promise.all([
      request(app).post('/api/v0/supersede').set('Authorization', `Bearer ${token}`)
        .send({ supersededId: decisionId, title: 'Candidate A', body: 'Body A' }),
      request(app).post('/api/v0/supersede').set('Authorization', `Bearer ${token}`)
        .send({ supersededId: decisionId, title: 'Candidate B', body: 'Body B' }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const winner = responses.find((response) => response.status === 201)!;
    const conflict = responses.find((response) => response.status === 409)!;
    expect(conflict.body.successorId).toBe(winner.body.successorId);
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM memories WHERE supersedes_id = $1', [decisionId],
    )).rows[0].count).toBe(1);
  });

  it('removes the archived embedding and embeds the new head after commit', async () => {
    const provider = new StubEmbeddingProvider();
    await storeMemoryEmbedding(pool, decisionId, 'old embedding', provider);
    const response = await request(createApp(pool, { embeddingProvider: provider }))
      .post('/api/v0/supersede').set('Authorization', `Bearer ${token}`)
      .send({ supersededId: decisionId, title: 'Embedded head', body: 'New embedding body' });
    expect(response.status).toBe(201);
    expect(response.body.embedded).toBe(true);
    const embeddings = await pool.query('SELECT memory_id FROM memory_embeddings ORDER BY memory_id');
    expect(embeddings.rows).toEqual([{ memory_id: response.body.successorId }]);
  });

  it('returns history oldest-to-newest from any chain member', async () => {
    const app = createApp(pool);
    const second = await request(app).post('/api/v0/supersede')
      .set('Authorization', `Bearer ${token}`)
      .send({ supersededId: decisionId, title: 'Second', body: 'Second body' });
    const third = await request(app).post('/api/v0/supersede')
      .set('Authorization', `Bearer ${token}`)
      .send({ supersededId: second.body.successorId, title: 'Third', body: 'Third body' });
    for (const id of [decisionId, second.body.successorId, third.body.successorId]) {
      const history = await request(app).get(`/api/v0/decisions/${id}/history`)
        .set('Authorization', `Bearer ${token}`);
      expect(history.status).toBe(200);
      expect(history.body.currentId).toBe(third.body.successorId);
      expect(history.body.decisions.map((item: { id: string }) => item.id))
        .toEqual([decisionId, second.body.successorId, third.body.successorId]);
    }
  });

  it('requires explicit writer authority and readable history access', async () => {
    const reader = await createPrincipal(pool, {
      externalId: 'entra:user:reader', kind: 'user', displayName: 'Reader',
    });
    await addMembership(pool, reader.id, scopeId, 'reader');
    const denied = await request(createApp(pool)).post('/api/v0/supersede')
      .set('Authorization', 'Bearer entra:user:reader')
      .send({ supersededId: decisionId, title: 'Denied', body: 'Denied body' });
    expect(denied.status).toBe(403);
    const history = await request(createApp(pool)).get(`/api/v0/decisions/${decisionId}/history`)
      .set('Authorization', 'Bearer entra:user:reader');
    expect(history.status).toBe(200);
    expect(history.body.currentId).toBe(decisionId);
  });

  it('keeps archived content out of recall and AGENTS.md while showing head provenance', async () => {
    const app = createApp(pool);
    const superseded = await request(app).post('/api/v0/supersede')
      .set('Authorization', `Bearer ${token}`)
      .send({ supersededId: decisionId, title: 'Use gRPC', body: 'Replacement searchable phrase' });
    const recall = await request(app).post('/api/v0/recall')
      .set('Authorization', `Bearer ${token}`)
      .send({ query: 'decision body', scopes: ['project:continuum'] });
    expect(recall.body.results).toEqual([]);
    const headRecall = await request(app).post('/api/v0/recall')
      .set('Authorization', `Bearer ${token}`)
      .send({ query: 'replacement searchable', scopes: ['project:continuum'] });
    expect(headRecall.body.results[0]).toMatchObject({
      id: superseded.body.successorId, supersedesId: decisionId,
    });
    const agents = await request(app).get('/api/v0/agents-md?project=continuum')
      .set('Authorization', `Bearer ${token}`);
    expect(agents.text).not.toContain('Original decision body');
    expect(agents.text).toContain('Supersedes memory ID:**');
    expect(agents.text).toContain(decisionId.replaceAll('-', '\\-'));
  });
});
