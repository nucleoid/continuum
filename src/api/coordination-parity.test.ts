import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './server.js';
import { buildMcpServer } from './mcp.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function toolJson(result: ToolResult): any {
  return JSON.parse(result.content.map((item) => item.text ?? '').join(''));
}

describe('coordination REST/MCP parity', () => {
  let pool: pg.Pool;
  let principal: Awaited<ReturnType<typeof createPrincipal>>;
  let client: Client;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
    principal = await createPrincipal(pool, {
      externalId: 'service:coordination-parity',
      kind: 'service',
      displayName: 'Coordination parity',
    });
    const scope = await createScope(pool, { kind: 'project', name: 'parity' });
    await addMembership(pool, principal.id, scope.id, 'writer');
    const server = buildMcpServer({ pool, embeddingProvider: null, principal });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'coordination-parity', version: '1.0.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('publishes all four MCP tools with the settled names', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'continuum.lock_acquire',
      'continuum.lock_renew',
      'continuum.lock_release',
      'continuum.lock_inspect',
    ]));
  });

  it('keeps acquire/renew/release semantics equivalent with transport casing', async () => {
    const restRun = randomUUID();
    const restAcquire = await request(createApp(pool))
      .post('/api/v0/locks/acquire')
      .set('Authorization', 'Bearer service:coordination-parity')
      .send({
        scope: 'project:parity',
        resource: 'rest-resource',
        runId: restRun,
        requestId: randomUUID(),
        ttlSeconds: 300,
      });
    expect(restAcquire.status).toBe(200);
    expect(restAcquire.body).toMatchObject({
      acquired: true,
      scope: 'project:parity',
      resource: 'rest-resource',
      runId: restRun,
      fencingToken: '1',
      leaseId: expect.any(String),
      expiresAt: expect.any(String),
      serverTime: expect.any(String),
    });
    expect(restAcquire.body).not.toHaveProperty('lease_id');

    const mcpRun = randomUUID();
    const mcpAcquire = toolJson(await client.callTool({
      name: 'continuum.lock_acquire',
      arguments: {
        scope: 'project:parity',
        resource: 'mcp-resource',
        run_id: mcpRun,
        request_id: randomUUID(),
        ttl_seconds: 300,
      },
    }) as ToolResult);
    expect(mcpAcquire).toMatchObject({
      acquired: true,
      scope: 'project:parity',
      resource: 'mcp-resource',
      run_id: mcpRun,
      fencing_token: '1',
      lease_id: expect.any(String),
      expires_at: expect.any(String),
      server_time: expect.any(String),
    });
    expect(mcpAcquire).not.toHaveProperty('leaseId');

    const restRenew = await request(createApp(pool))
      .post('/api/v0/locks/renew')
      .set('Authorization', 'Bearer service:coordination-parity')
      .send({
        leaseId: restAcquire.body.leaseId,
        runId: restRun,
        requestId: randomUUID(),
      });
    const mcpRenew = toolJson(await client.callTool({
      name: 'continuum.lock_renew',
      arguments: {
        lease_id: mcpAcquire.lease_id,
        run_id: mcpRun,
        request_id: randomUUID(),
      },
    }) as ToolResult);
    expect(restRenew.status).toBe(200);
    expect(restRenew.body).toMatchObject({ renewed: true, fencingToken: '1' });
    expect(mcpRenew).toMatchObject({ renewed: true, fencing_token: '1' });

    const restRelease = await request(createApp(pool))
      .post('/api/v0/locks/release')
      .set('Authorization', 'Bearer service:coordination-parity')
      .send({
        leaseId: restAcquire.body.leaseId,
        runId: restRun,
        requestId: randomUUID(),
      });
    const mcpRelease = toolJson(await client.callTool({
      name: 'continuum.lock_release',
      arguments: {
        lease_id: mcpAcquire.lease_id,
        run_id: mcpRun,
        request_id: randomUUID(),
      },
    }) as ToolResult);
    expect(restRelease.body).toEqual({ released: true });
    expect(mcpRelease).toEqual({ released: true });
  });

  it('maps masked errors and contention equivalently', async () => {
    const unknownRest = await request(createApp(pool))
      .get('/api/v0/locks')
      .query({ scope: 'project:unknown', resource: 'x' })
      .set('Authorization', 'Bearer service:coordination-parity');
    const unknownMcp = await client.callTool({
      name: 'continuum.lock_inspect',
      arguments: { scope: 'project:unknown', resource: 'x' },
    }) as ToolResult;
    expect(unknownRest.status).toBe(404);
    expect(unknownRest.body.code).toBe('SCOPE_NOT_FOUND');
    expect(unknownMcp.isError).toBe(true);
    expect(toolJson(unknownMcp)).toEqual({
      error: { code: 'SCOPE_NOT_FOUND', message: 'Scope not found' },
    });

    const runId = randomUUID();
    await request(createApp(pool))
      .post('/api/v0/locks/acquire')
      .set('Authorization', 'Bearer service:coordination-parity')
      .send({
        scope: 'project:parity',
        resource: 'contended',
        runId,
        requestId: randomUUID(),
      })
      .expect(200);
    const rest = await request(createApp(pool))
      .post('/api/v0/locks/acquire')
      .set('Authorization', 'Bearer service:coordination-parity')
      .send({
        scope: 'project:parity',
        resource: 'contended',
        runId,
        requestId: randomUUID(),
      });
    const mcp = toolJson(await client.callTool({
      name: 'continuum.lock_acquire',
      arguments: {
        scope: 'project:parity',
        resource: 'contended',
        run_id: runId,
        request_id: randomUUID(),
      },
    }) as ToolResult);
    expect(rest.status).toBe(200);
    expect(rest.body).toMatchObject({ acquired: false, reason: 'LOCK_HELD' });
    expect(mcp).toMatchObject({ acquired: false, reason: 'LOCK_HELD' });
    for (const body of [rest.body, mcp]) {
      expect(body).not.toHaveProperty('principalId');
      expect(body).not.toHaveProperty('leaseId');
      expect(body).not.toHaveProperty('lease_id');
      expect(body).not.toHaveProperty('runId');
      expect(body).not.toHaveProperty('run_id');
      expect(body).not.toHaveProperty('fencingToken');
      expect(body).not.toHaveProperty('fencing_token');
    }
  });

  it('uses strict REST schemas and stable conflict/timeout status mappings', async () => {
    const malformed = await request(createApp(pool))
      .post('/api/v0/locks/acquire')
      .set('Authorization', 'Bearer service:coordination-parity')
      .send({
        scope: 'project:parity',
        resource: 'x',
        runId: randomUUID(),
        requestId: randomUUID(),
        extra: true,
      });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('INVALID_INPUT');

    const runId = randomUUID();
    const requestId = randomUUID();
    await request(createApp(pool))
      .post('/api/v0/locks/acquire')
      .set('Authorization', 'Bearer service:coordination-parity')
      .send({ scope: 'project:parity', resource: 'one', runId, requestId })
      .expect(200);
    const conflict = await request(createApp(pool))
      .post('/api/v0/locks/acquire')
      .set('Authorization', 'Bearer service:coordination-parity')
      .send({ scope: 'project:parity', resource: 'two', runId, requestId });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it.each([
    { field: 'runId', restValue: 'not-a-uuid', mcpField: 'run_id', mcpValue: 'not-a-uuid' },
    { field: 'requestId', restValue: 'bad', mcpField: 'request_id', mcpValue: 'bad' },
    { field: 'ttlSeconds', restValue: 29, mcpField: 'ttl_seconds', mcpValue: 29 },
    { field: 'ttlSeconds', restValue: '300', mcpField: 'ttl_seconds', mcpValue: '300' },
  ])('returns the stable INVALID_INPUT envelope for malformed $field', async (sample) => {
    const baseRest: Record<string, unknown> = {
      scope: 'project:parity', resource: 'malformed',
      runId: randomUUID(), requestId: randomUUID(), ttlSeconds: 300,
    };
    baseRest[sample.field] = sample.restValue;
    const rest = await request(createApp(pool))
      .post('/api/v0/locks/acquire')
      .set('Authorization', 'Bearer service:coordination-parity')
      .send(baseRest);

    const baseMcp: Record<string, unknown> = {
      scope: 'project:parity', resource: 'malformed',
      run_id: randomUUID(), request_id: randomUUID(), ttl_seconds: 300,
    };
    baseMcp[sample.mcpField] = sample.mcpValue;
    const mcp = await client.callTool({
      name: 'continuum.lock_acquire', arguments: baseMcp,
    }) as ToolResult;

    expect(rest.status).toBe(400);
    expect(rest.body.code).toBe('INVALID_INPUT');
    expect(mcp.isError).toBe(true);
    expect(toolJson(mcp)).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });
});
