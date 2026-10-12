import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from './server.js';
import { buildMcpServer } from './mcp.js';
import { PromotionWebhookRegistry } from '../extensions/promotion.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory, getMemory } from '../storage/memories.js';

describe('promotion registry parity review', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => { await pool?.end(); });
  async function seed() {
    const principal = await createPrincipal(pool, { externalId: 'entra:user:registry-review', kind: 'user', displayName: 'Registry review' });
    const source = await createScope(pool, { kind: 'team', name: 'registry-review-source' });
    const target = await createScope(pool, { kind: 'project', name: 'registry-review-target' });
    await addMembership(pool, principal.id, source.id, 'writer');
    await addMembership(pool, principal.id, target.id, 'writer');
    const memories = [];
    for (let index = 0; index < 2; index += 1) memories.push(await createMemory(pool, { scopeId: source.id, scopeKind: 'team',
      type: 'fact', title: `Registry source ${index}`, body: 'Normal promotion.', authorId: principal.id, source: 'manual' }));
    // Owner fixture configures the durable producer contract before either transport runs.
    await pool.query("UPDATE promotion_webhook_registry SET webhook_ids=ARRAY['expected-hook']::text[] WHERE singleton");
    const registry = new PromotionWebhookRegistry();
    registry.register({ id: 'expected-hook', onPromoted: async () => undefined });
    const app = createApp(pool, { promotionWebhooks: registry, embeddingProvider: null });
    const input = { targetScope: { kind: 'project', name: target.name } };
    expect((await request(app).post(`/api/v0/memories/${memories[0].id}/promote`).send(input)).status).toBe(401);
    const first = await request(app).post(`/api/v0/memories/${memories[0].id}/promote`)
      .set('Authorization', `Bearer ${principal.externalId}`).send(input);
    expect(first.status).toBe(201);
    expect((await pool.query(`SELECT delivery.webhook_id FROM promotion_event_deliveries delivery JOIN promotion_events event ON event.id=delivery.event_id
      WHERE event.source_memory_id=$1::uuid`, [memories[0].id])).rows).toEqual([{ webhook_id: 'expected-hook' }]);
    return { principal, target, memories, input };
  }
  it('does not silently omit the expected delivery when MCP uses its stock empty registry', async () => {
    const value = await seed();
    const server = buildMcpServer({ pool, principal: value.principal, embeddingProvider: null });
    const client = new Client({ name: 'registry-parity-review', version: '0.0.1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: 'continuum.promote', arguments: { memory_id: value.memories[1].id,
        target_scope_kind: 'project', target_scope_name: value.target.name } });
      expect(result.isError).not.toBe(true);
      expect((await pool.query(`SELECT delivery.webhook_id FROM promotion_event_deliveries delivery JOIN promotion_events event ON event.id=delivery.event_id
        WHERE event.source_memory_id=$1::uuid`, [value.memories[1].id])).rows).toEqual([{ webhook_id: 'expected-hook' }]);
    } finally { await client.close(); await server.close(); }
  });
  it('rejects a conflicting nonempty producer registry instead of committing different delivery IDs', async () => {
    const value = await seed();
    const wrong = new PromotionWebhookRegistry();
    wrong.register({ id: 'wrong-hook', onPromoted: async () => undefined });
    const app = createApp(pool, { promotionWebhooks: wrong, embeddingProvider: null });
    const before = (await pool.query('SELECT count(*)::int AS count FROM promotion_events')).rows;
    const response = await request(app).post(`/api/v0/memories/${value.memories[1].id}/promote`)
      .set('Authorization', `Bearer ${value.principal.externalId}`).send(value.input);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONFLICT');
    expect(await getMemory(pool, value.memories[1].id)).toMatchObject({ state: 'live', promotedToId: null });
    expect((await pool.query('SELECT count(*)::int AS count FROM promotion_events')).rows).toEqual(before);
  });
});
