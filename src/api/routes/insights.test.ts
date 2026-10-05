import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createPrincipal } from '../../storage/principals.js';
import { addMembership } from '../../storage/memberships.js';
import { getScopeByRef } from '../../storage/scopes.js';
import { recordRead } from '../../audit/log.js';
import { createApp } from '../server.js';
import type { EmbeddingProvider } from '../../embeddings/provider.js';
import { createMemory } from '../../storage/memories.js';

describe('GET /api/v0/insights/gaps', () => {
  let pool: pg.Pool;

  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); });
  afterAll(async () => { await pool?.end(); });

  async function seed(role: 'reader' | 'admin') {
    const principal = await createPrincipal(pool, {
      externalId: `entra:${role}`, kind: 'user', displayName: role,
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, principal.id, org.id, role);
    return principal;
  }

  it('is org-admin-only, JSON, private/no-store, and preserves the response envelope', async () => {
    await seed('reader');
    const denied = await request(createApp(pool))
      .get('/api/v0/insights/gaps')
      .set('Authorization', 'Bearer entra:reader');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'FORBIDDEN', error: expect.any(String) });

    const admin = await seed('admin');
    await recordRead(pool, { principalId: admin.id, query: 'rollback runbook', metadata: { hits: 0 }, memories: [] });
    const res = await request(createApp(pool))
      .get('/api/v0/insights/gaps')
      .set('Authorization', 'Bearer entra:admin');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.type).toMatch(/json/);
    expect(res.body).toMatchObject({
      window: { days: 30 },
      parameters: { similarityThreshold: 0.85 },
      gaps: [{ representative: 'rollback runbook' }],
    });
    expect(JSON.stringify(res.body)).not.toContain(admin.id);
  });

  it.each([
    ['since', '0d'], ['since', '366d'], ['since', '30'],
    ['limit', '0'], ['limit', '101'], ['threshold', '-0.1'], ['threshold', '1.1'],
    ['minFrequency', '0'], ['format', 'markdown'],
    ['threshold', ''], ['threshold', ' '], ['threshold', '.85'],
    ['threshold', '+0.85'], ['threshold', '8.5e-1'],
  ])('rejects invalid or unsupported %s=%s', async (name, value) => {
    await seed('admin');
    const res = await request(createApp(pool))
      .get('/api/v0/insights/gaps')
      .query({ [name]: value })
      .set('Authorization', 'Bearer entra:admin');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });

  it('does not leak query or provider text into operational logs during safe fallback', async () => {
    const admin = await seed('admin');
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await recordRead(pool, {
      principalId: admin.id, query: 'secret-token-gap',
      metadata: { hits: 0, scope_ids: [org.id] }, memories: [],
    });
    const privateError = 'provider failed while embedding secret-token-gap';
    const provider: EmbeddingProvider = {
      id: 'test:failing', dim: 768, async embed() { throw new Error(privateError); },
    };
    const events: unknown[] = [];
    const app = createApp(pool, {
      embeddingProvider: provider,
      logger: { info: (event) => events.push(event), error: (...args) => events.push(args) },
    });
    const res = await request(app)
      .get('/api/v0/insights/gaps')
      .set('Authorization', 'Bearer entra:admin');
    expect(res.status).toBe(200);
    expect(res.body.semanticClustering).toBe(false);
    expect(res.body.embedding).toMatchObject({ status: 'degraded', failedGroups: 1 });
    expect(JSON.stringify(events)).not.toContain('secret-token-gap');
    expect(JSON.stringify(events)).not.toContain(privateError);
  });

  it('reports exact empty scope searches as unresolved despite matching org memory', async () => {
    const admin = await seed('admin');
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await createMemory(pool, {
      scopeId: org.id, scopeKind: 'org', type: 'playbook', title: 'Release rollback guide',
      body: 'Unrelated org answer.', authorId: admin.id, source: 'manual',
    });
    await recordRead(pool, {
      principalId: admin.id, query: 'release rollback',
      metadata: { hits: 0, scope_ids: [] }, memories: [],
    });

    const res = await request(createApp(pool))
      .get('/api/v0/insights/gaps')
      .set('Authorization', 'Bearer entra:admin');

    expect(res.status).toBe(200);
    expect(res.body.gaps[0].resolution).toEqual({ status: 'unresolved', scopeFidelity: 'exact' });
  });
});
