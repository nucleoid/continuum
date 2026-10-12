import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from './server.js';
import { buildMcpServer } from './mcp.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { mapOwnedUserScope } from '../services/offboarding.js';

describe('standup handoff current transport contract', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => { await pool?.end(); });

  async function fixture() {
    const admin = await createPrincipal(pool, { externalId: 'standup:admin', kind: 'user', displayName: 'Admin' });
    const owner = await createPrincipal(pool, { externalId: 'standup:owner', kind: 'user', displayName: 'Owner' });
    const outsider = await createPrincipal(pool, { externalId: 'standup:outsider', kind: 'user', displayName: 'Outsider' });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const personal = await createScope(pool, { kind: 'user', name: 'opaque-standup-owner' });
    await addMembership(pool, admin.id, org.id, 'admin');
    await addMembership(pool, owner.id, personal.id, 'writer');
    const mapping = await mapOwnedUserScope(pool, admin, owner.id, personal.id);
    const memory = await createMemory(pool, { scopeId: personal.id, scopeKind: personal.kind,
      authorId: owner.id, type: 'context', title: 'Private untrusted standup-shaped text',
      body: 'Private standup body must never become digest activity by metadata alone.', source: 'manual',
      metadata: { actor: 'Forged actor label', actor_principal_id: owner.id,
        thread_owner_principal_id: owner.id, thread_key: 'caller-supplied-thread',
        closes_thread_keys: ['another-caller-thread'] } });
    expect(mapping).toMatchObject({ principalId: owner.id, scopeId: personal.id, created: true });
    expect((await pool.query(`SELECT principal_id, scope_id FROM principal_user_scopes
      WHERE principal_id=$1::uuid`, [owner.id])).rows)
      .toEqual([{ principal_id: owner.id, scope_id: personal.id }]);
    return { owner, outsider, personal, memory };
  }

  it('preserves existing approved ownership, authentication and masked private reads', async () => {
    const value = await fixture();
    const app = createApp(pool, { embeddingProvider: null });
    expect((await request(app).get('/api/v0/scopes')).status).toBe(401);
    const path = `/api/v0/memories/${value.memory.id}`;
    const read = await request(app).get(path).set('Authorization', `Bearer ${value.owner.externalId}`);
    expect(read.status).toBe(200);
    expect(read.body.title).toBe(value.memory.title);
    const forbidden = await request(app).get(path).set('Authorization', `Bearer ${value.outsider.externalId}`);
    const missing = await request(app).get('/api/v0/memories/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      .set('Authorization', `Bearer ${value.outsider.externalId}`);
    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const { requestId: forbiddenRequestId, ...forbiddenEnvelope } = forbidden.body;
    const { requestId: missingRequestId, ...missingEnvelope } = missing.body;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(forbiddenRequestId).toMatch(uuid);
    expect(missingRequestId).toMatch(uuid);
    expect(forbiddenRequestId).toBe(forbidden.headers['x-request-id']);
    expect(missingRequestId).toBe(missing.headers['x-request-id']);
    expect(forbiddenEnvelope).toEqual(missingEnvelope);
    expect(forbiddenEnvelope).toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    expect(JSON.stringify(forbidden.body)).not.toContain(value.personal.name);
    expect(JSON.stringify(forbidden.body)).not.toContain(value.memory.title);
    expect((await pool.query(`SELECT count(*)::integer AS total FROM audit_log
      WHERE principal_id=$1::uuid AND memory_id=$2::uuid AND action='read'`,
    [value.owner.id, value.memory.id])).rows).toEqual([{ total: 1 }]);
  });

  it('serves an authenticated REST standup without exposing untrusted owned activity', async () => {
    const value = await fixture();
    const app = createApp(pool, { embeddingProvider: null });
    const response = await request(app).get('/api/v0/standup').query({ since: '24h' })
      .set('Authorization', `Bearer ${value.owner.externalId}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ activity: [], openThreads: [], page: { nextOffset: null } });
    expect(JSON.stringify(response.body)).not.toContain(value.memory.title);
    expect(JSON.stringify(response.body)).not.toContain('Forged actor label');
    const outsider = await request(app).get('/api/v0/standup').query({ since: '24h' })
      .set('Authorization', `Bearer ${value.outsider.externalId}`);
    expect(outsider.status).toBe(200);
    expect(outsider.body).toMatchObject({ activity: [], openThreads: [] });
    expect((await pool.query(`SELECT metadata->>'view' AS view FROM audit_log
      WHERE principal_id=$1::uuid AND action='read' AND memory_id IS NULL`, [value.owner.id])).rows)
      .toEqual([{ view: 'standup' }]);
  });

  it('registers authenticated MCP standup with the same empty trusted-activity and audit semantics', async () => {
    const value = await fixture();
    const server = buildMcpServer({ pool, principal: value.owner, embeddingProvider: null });
    const client = new Client({ name: 'standup-handoff', version: '0.0.1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('continuum.standup');
      const result = await client.callTool({ name: 'continuum.standup', arguments: { since: '24h' } });
      expect(result.isError).not.toBe(true);
      const text = result.content.map((item) => item.type === 'text' ? item.text : '').join('');
      expect(text).toContain('No attributed activity found.');
      expect(text).toContain('No open threads found.');
      expect(text).not.toContain(value.memory.title);
      expect(text).not.toContain('Forged actor label');
      expect((await pool.query(`SELECT metadata->>'view' AS view FROM audit_log
        WHERE principal_id=$1::uuid AND action='read' AND memory_id IS NULL`, [value.owner.id])).rows)
        .toEqual([{ view: 'standup' }]);
    } finally { await client.close(); await server.close(); }
  });
});
