import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from './server.js';
import { buildMcpServer } from './mcp.js';
import type { RecallResult } from '../types.js';
import { RetrievalEnricherRegistry } from '../extensions/retrieval.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';

describe('extension handoff current recall contract', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => { await pool?.end(); });

  async function fixture() {
    const principal = await createPrincipal(pool, { externalId: 'entra:user:extension-handoff',
      kind: 'user', displayName: 'Extension Reader' });
    const scope = await createScope(pool, { kind: 'project', name: 'extension-handoff' });
    await addMembership(pool, principal.id, scope.id, 'writer');
    const memory = await createMemory(pool, { scopeId: scope.id, scopeKind: scope.kind,
      authorId: principal.id, type: 'fact', title: 'Extension searchable reference',
      body: 'A bounded authorized reference.', source: 'manual' });
    return { principal, scope, memory };
  }

  function requestedEnrichment() {
    const enrich = vi.fn(async (results: readonly Readonly<RecallResult>[], context: { principalId: string }) =>
      results.map((result) => ({ principal: context.principalId, reference: result.memory.id })));
    const extension = { id: 'links', enrich };
    const registry = new RetrievalEnricherRegistry();
    registry.register(extension);
    return { registry, enrich };
  }

  async function expectReadAudit(principalId: string, memoryId: string) {
    const summaries = await pool.query(`SELECT metadata FROM audit_log
      WHERE principal_id=$1::uuid AND action='read' AND memory_id IS NULL`, [principalId]);
    expect(summaries.rows).toHaveLength(1);
    expect(summaries.rows[0].metadata).toMatchObject({ hits: 1, vector_status: 'disabled' });
    expect((await pool.query(`SELECT memory_id FROM audit_log
      WHERE principal_id=$1::uuid AND action='read' AND memory_id=$2::uuid`, [principalId, memoryId])).rows)
      .toEqual([{ memory_id: memoryId }]);
  }

  it('retains authentication, ranked base fields and disabled-vector diagnostics without extensions', async () => {
    const value = await fixture();
    const app = createApp(pool, { embeddingProvider: null });
    const input = { query: 'extension searchable', scopes: [`project:${value.scope.name}`] };
    expect((await request(app).post('/api/v0/recall').send(input)).status).toBe(401);
    const response = await request(app).post('/api/v0/recall')
      .set('Authorization', `Bearer ${value.principal.externalId}`).send(input);
    expect(response.status).toBe(200);
    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]).toMatchObject({ id: value.memory.id, title: value.memory.title });
    expect(response.body.results[0]).not.toHaveProperty('enrichments');
    expect(response.body.diagnostics).toEqual({ vector: 'disabled', groups: [] });
    await expectReadAudit(value.principal.id, value.memory.id);
  });

  it('attaches requested REST namespaced enrichment after ranked audited recall without losing diagnostics', async () => {
    const value = await fixture();
    const extension = requestedEnrichment();
    const options = { embeddingProvider: null, retrievalEnrichers: extension.registry,
      enrichment: { timeoutMs: 100, maxBytes: 1024 } };
    const response = await request(createApp(pool, options)).post('/api/v0/recall')
      .set('Authorization', `Bearer ${value.principal.externalId}`)
      .send({ query: 'extension searchable', scopes: [`project:${value.scope.name}`] });
    expect(response.status).toBe(200);
    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]).toMatchObject({ id: value.memory.id, title: value.memory.title });
    expect(response.body.diagnostics).toEqual({ vector: 'disabled', groups: [] });
    await expectReadAudit(value.principal.id, value.memory.id);
    expect(response.body.results[0].enrichments)
      .toEqual({ links: { principal: value.principal.id, reference: value.memory.id } });
    expect(extension.enrich).toHaveBeenCalledOnce();
  });

  it('attaches requested MCP namespaced enrichment without losing current meta diagnostics or read audit', async () => {
    const value = await fixture();
    const extension = requestedEnrichment();
    const dependencies = { pool, principal: value.principal, embeddingProvider: null,
      retrievalEnrichers: extension.registry, enrichment: { timeoutMs: 100, maxBytes: 1024 } };
    const server = buildMcpServer(dependencies);
    const client = new Client({ name: 'extension-handoff', version: '0.0.1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: 'continuum.recall',
        arguments: { query: 'extension searchable', scopes: [`project:${value.scope.name}`] } });
      expect(result.isError).not.toBe(true);
      const content = JSON.parse(result.content.map((item) => item.type === 'text' ? item.text : '').join(''));
      expect(content).toHaveLength(1);
      expect(content[0]).toMatchObject({ id: value.memory.id, title: value.memory.title });
      expect(result._meta).toMatchObject({ diagnostics: { vector: 'disabled', groups: [] } });
      await expectReadAudit(value.principal.id, value.memory.id);
      expect(content[0].enrichments)
        .toEqual({ links: { principal: value.principal.id, reference: value.memory.id } });
      expect(extension.enrich).toHaveBeenCalledOnce();
    } finally { await client.close(); await server.close(); }
  });
});
