import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { createApp } from '../server.js';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';
import { createMemory } from '../../storage/memories.js';

describe('memory REST routes', () => {
  let pool: pg.Pool;
  const token = 'rest-memory-reader';

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });
  afterAll(async () => { await pool?.end(); });

  it('fetches and browses full camelCase records and masks inaccessible IDs', async () => {
    const reader = await createPrincipal(pool, {
      externalId: token, kind: 'user', displayName: 'REST Reader',
    });
    const author = await createPrincipal(pool, {
      externalId: 'rest-author', kind: 'user', displayName: 'REST Author',
    });
    const visible = await createScope(pool, { kind: 'team', name: 'visible' });
    const hidden = await createScope(pool, { kind: 'team', name: 'hidden' });
    await addMembership(pool, reader.id, visible.id, 'reader');
    const memory = await createMemory(pool, {
      scopeId: visible.id, scopeKind: 'team', type: 'fact', title: 'Full record',
      body: 'complete body', metadata: { safe: true }, tags: ['session'],
      authorId: author.id, source: 'manual', sourceRef: 'ref',
    });
    const privateMemory = await createMemory(pool, {
      scopeId: hidden.id, scopeKind: 'team', type: 'fact', title: 'Private',
      body: 'private body', authorId: author.id, source: 'manual',
    });
    const app = createApp(pool);
    const fetched = await request(app).get(`/api/v0/memories/${memory.id}`)
      .set('Authorization', `Bearer ${token}`);
    const listed = await request(app).get('/api/v0/memories?scope=team:visible')
      .set('Authorization', `Bearer ${token}`);
    const forbidden = await request(app).get(`/api/v0/memories/${privateMemory.id}`)
      .set('Authorization', `Bearer ${token}`);
    const missing = await request(app).get('/api/v0/memories/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      .set('Authorization', `Bearer ${token}`);

    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({
      id: memory.id, scope: 'team:visible', body: 'complete body',
      metadata: { safe: true }, tags: ['session'], authorId: author.id,
      authorDisplayName: 'REST Author', sourceRef: 'ref',
      expiresAt: expect.any(String), createdAt: expect.any(String), updatedAt: expect.any(String),
    });
    expect(listed.body).toMatchObject({ items: [{ id: memory.id, body: 'complete body' }], limit: 50, offset: 0 });
    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(forbidden.body.code).toBe('MEMORY_NOT_FOUND');
    expect(missing.body.code).toBe('MEMORY_NOT_FOUND');
    expect(forbidden.body.error).toBe(missing.body.error);
  });

  it('returns typed 400 responses for malformed point and browse inputs', async () => {
    await createPrincipal(pool, { externalId: token, kind: 'user', displayName: 'Reader' });
    const app = createApp(pool);
    const malformedId = await request(app).get('/api/v0/memories/not-a-uuid')
      .set('Authorization', `Bearer ${token}`);
    const malformedList = await request(app).get('/api/v0/memories?limit=101')
      .set('Authorization', `Bearer ${token}`);
    expect(malformedId.status).toBe(400);
    expect(malformedId.body.code).toBe('INVALID_INPUT');
    expect(malformedList.status).toBe(400);
    expect(malformedList.body.code).toBe('INVALID_INPUT');
  });
});
