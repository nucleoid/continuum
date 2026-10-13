import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMcpHttpController } from './mcp-http.js';
import { mcpHttpConfigFromEnv } from './mcp-http-config.js';
const config = mcpHttpConfigFromEnv({ CONTINUUM_MCP_HTTP_ENABLED: 'true',
  CONTINUUM_MCP_PUBLIC_URL: 'http://localhost:4000/mcp', CONTINUUM_MCP_HTTP_LOOPBACK_DEV: 'true' }, 'dev')!;
describe('authenticated remote MCP boundary', () => {
  it('authenticates every method and never treats a session ID as authority', async () => {
    let checks = 0;
    const controller = createMcpHttpController(config, {
      pool: {} as never, embeddingProvider: null,
      authenticator: { mode: 'dev', authenticate: async () => { checks++; return null; } },
    });
    const app = express(); app.use('/mcp', controller.router);
    for (const method of ['post', 'get', 'delete'] as const) {
      const response = await request(app)[method]('/mcp').set('Host', 'localhost:4000')
        .set('Authorization', 'Bearer absent').set('Mcp-Session-Id', 'unknown');
      expect(response.status).toBe(401);
      expect(response.text).not.toContain('absent');
    }
    expect(checks).toBe(3);
    await controller.stop('test');
  });
});
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { buildMcpServer } from './mcp.js';
import { createAuthenticator } from './auth.js';
const entra = { tenant: '00000000-0000-0000-0000-000000000001', audience: 'test', userScope: 'read',
  serviceAppRole: 'serve', allowedClientIds: ['00000000-0000-0000-0000-000000000002'] };
describe('real SDK remote MCP with current database authority', () => {
  let pool: pg.Pool;
  let server: Server;
  let controller: ReturnType<typeof createMcpHttpController>;
  let url: URL;
  let key: string;
  let otherKey: string;
  let principalId: string;
  let scopeId: string;
  let transport: StreamableHTTPClientTransport;
  let client: Client;
  beforeAll(async () => { pool = await makeTestPool(); }, 120000);
  beforeEach(async () => {
    await resetData(pool);
    const principal = await createPrincipal(pool, { externalId: 'remote-test-service', kind: 'service', displayName: 'Remote test' });
    principalId = principal.id;
    const scope = await createScope(pool, { kind: 'project', name: 'remote' }); scopeId = scope.id;
    await addMembership(pool, principal.id, scope.id, 'writer');
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, principal.id, org.id, 'admin');
    const issue = async () => { const credential = `ctm_${randomBytes(32).toString('base64url')}`;
      await pool.query('INSERT INTO service_api_keys (id,principal_id,key_hash,prefix,last_four) VALUES ($1,$2,$3,$4,$5)',
        [randomUUID(), principal.id, createHash('sha256').update(credential).digest(), 'ctm_test', credential.slice(-4)]);
      return credential;
    };
    key = await issue(); otherKey = await issue();
    const app = express();
    server = await new Promise<Server>((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const port = (server.address() as { port: number }).port;
    url = new URL(`http://127.0.0.1:${port}/mcp`);
    const selectedConfig = mcpHttpConfigFromEnv({ CONTINUUM_MCP_HTTP_ENABLED: 'true', CONTINUUM_MCP_PUBLIC_URL: url.href,
      CONTINUUM_MCP_HTTP_LOOPBACK_DEV: 'true', CONTINUUM_MCP_HTTP_PEER_BURST: '100',
      CONTINUUM_MCP_HTTP_MESSAGE_BURST: '100' }, 'entra')!;
    controller = createMcpHttpController(selectedConfig, { pool, embeddingProvider: null,
      authenticator: createAuthenticator(pool, 'entra', entra), now: () => new Date('2026-10-13T11:00:00Z') });
    app.use('/mcp', controller.router);
    transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `ApiKey ${key}` } } });
    client = new Client({ name: 'remote-test', version: '1' });
    await client.connect(transport);
  });
  afterAll(async () => { await pool?.end(); });
  // Each SDK close terminates its transport and all tracked local resources.
  const cleanup = async () => { await client.close(); await controller.stop('test');
    await new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); };
  it('matches tool schemas, agents bundle/freshness and Standup with shared registrations', async () => {
    try {
      const principal = (await pool.query('SELECT * FROM principals WHERE id=$1', [principalId])).rows[0];
      const shared = buildMcpServer({ pool, embeddingProvider: null, now: () => new Date('2026-10-13T11:00:00Z'), principal: { id: principal.id,
        externalId: principal.external_id, kind: principal.kind, displayName: principal.display_name, createdAt: principal.created_at } });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const local = new Client({ name: 'local-test', version: '1' });
      await Promise.all([shared.connect(a), local.connect(b)]);
      expect(await client.listTools()).toEqual(await local.listTools());
      const bundle = await client.callTool({ name: 'continuum.agents_md', arguments: { project: 'remote' } });
      expect(bundle).toEqual(await local.callTool({ name: 'continuum.agents_md', arguments: { project: 'remote' } }));
      const content = (bundle.content as Array<{ text: string }>)[0].text;
      const fresh = await client.callTool({ name: 'continuum.agents_md_fresh', arguments: {
        project: 'remote', hash: createHash('sha256').update(content).digest('hex') } });
      expect(JSON.parse((fresh.content as Array<{ text: string }>)[0].text)).toEqual({ fresh: true });
      expect(await client.callTool({ name: 'continuum.standup', arguments: {} })).toEqual(
        await local.callTool({ name: 'continuum.standup', arguments: {} }));
      await local.close(); await shared.close();
    } finally { await cleanup(); }
  });
  it('rejects alternate credentials and source-policy drift with uniform 404', async () => {
    try {
      const headers = { 'Mcp-Session-Id': transport.sessionId!, Accept: 'application/json, text/event-stream' };
      for (const method of ['POST', 'GET', 'DELETE']) {
        const response = await fetch(url, { method, headers: { ...headers, Authorization: `Bearer ${otherKey}`,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
          ...(method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' }) } : {}) });
        expect(response.status).toBe(404);
      }
      await pool.query("UPDATE service_api_keys SET allowed_source='github-pr' WHERE key_hash=$1", [createHash('sha256').update(key).digest()]);
      const response = await fetch(url, { method: 'DELETE', headers: { ...headers, Authorization: `ApiKey ${key}` } });
      expect(response.status).toBe(404);
    } finally { await cleanup(); }
  });
  it('enforces current memberships after initialization and rejects revoked keys on all methods', async () => {
    try {
      const input = { scope_kind: 'project', scope_name: 'remote', type: 'decision', title: 'Test', body: 'Body' };
      const success = await client.callTool({ name: 'continuum.capture', arguments: input });
      expect(success.isError).not.toBe(true);
      await pool.query("UPDATE scope_memberships SET role='reader' WHERE principal_id=$1 AND scope_id=$2", [principalId, scopeId]);
      const denied = await client.callTool({ name: 'continuum.capture', arguments: input });
      expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).toContain('FORBIDDEN');
      await pool.query('UPDATE service_api_keys SET revoked_at=now() WHERE key_hash=$1', [createHash('sha256').update(key).digest()]);
      for (const method of ['POST', 'GET', 'DELETE']) {
        const response = await fetch(url, { method, headers: { Authorization: `ApiKey ${key}`, 'Mcp-Session-Id': transport.sessionId! } });
        expect(response.status).toBe(401);
      }
    } finally { await cleanup(); }
  });
  it('supports live authenticated GET reconnect and DELETE without historical replay', async () => {
    try {
      const headers = { Authorization: `Bearer ${key}`, 'Mcp-Session-Id': transport.sessionId!, Accept: 'text/event-stream',
        'Mcp-Protocol-Version': '2025-11-25' };
      // The SDK itself opens a GET stream. Close it before exercising raw reconnect.
      await transport.close();
      for (let attempt = 0; attempt < 2; attempt++) {
        const abort = new AbortController();
        const response = await fetch(url, { headers, signal: abort.signal });
        expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/event-stream');
        abort.abort(); await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect((await fetch(url, { headers: { ...headers, 'Last-Event-ID': 'old' } })).status).toBe(400);
      expect((await fetch(url, { method: 'DELETE', headers })).status).toBe(200);
      expect((await fetch(url, { method: 'DELETE', headers })).status).toBe(404);
    } finally { await cleanup(); }
  });
});
const syntheticPrincipal = { id: '11111111-1111-4111-8111-111111111111', externalId: 'synthetic',
  kind: 'service' as const, displayName: 'Synthetic', createdAt: new Date(0) };
async function harness(overrides: Record<string, string> = {}, selectedPool: unknown = {}) {
  const app = express();
  const listener = await new Promise<Server>((resolve) => { const active = app.listen(0, '127.0.0.1', () => resolve(active)); });
  const address = new URL(`http://127.0.0.1:${(listener.address() as { port: number }).port}/mcp`);
  const selected = mcpHttpConfigFromEnv({ CONTINUUM_MCP_HTTP_ENABLED: 'true', CONTINUUM_MCP_PUBLIC_URL: address.href,
    CONTINUUM_MCP_HTTP_LOOPBACK_DEV: 'true', CONTINUUM_MCP_HTTP_PEER_BURST: '100', CONTINUUM_MCP_HTTP_MESSAGE_BURST: '100',
    ...overrides }, 'dev')!;
  const controller = createMcpHttpController(selected, { pool: selectedPool as never, embeddingProvider: null,
    authenticator: { mode: 'dev', authenticate: async () => ({ principal: syntheticPrincipal, credential: 'dev' }) } });
  app.use('/mcp', controller.router);
  return { address, controller, listener, async close() { await controller.stop('test');
    listener.closeAllConnections(); await new Promise<void>((resolve) => listener.close(() => resolve())); } };
}
describe('remote protocol and lifecycle limits', () => {
  it('rejects malformed bodies, negotiation, compression and unsupported methods safely', async () => {
    const active = await harness({ CONTINUUM_MCP_HTTP_BODY_BYTES: '512' });
    try {
      const headers = { Authorization: 'Bearer sentinel-secret', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
      const cases = [
        { body: '{', status: 400 },
        { body: JSON.stringify({ a: 'x'.repeat(600) }), status: 413 },
        { body: '{}', status: 400 },
        { body: JSON.stringify(Array(21).fill({ jsonrpc: '2.0', method: 'ping', id: 1 })), status: 413 },
        { body: '{}', headers: { 'Content-Type': 'application/json-evil' }, status: 415 },
        { body: '{}', headers: { 'Content-Encoding': 'gzip' }, status: 415 },
        { body: '{}', headers: { Accept: 'application/json, text/event-stream;q=0' }, status: 406 },
      ];
      for (const test of cases) {
        const response = await fetch(active.address, { method: 'POST', headers: { ...headers, ...test.headers }, body: test.body });
        expect(response.status).toBe(test.status); expect(await response.text()).not.toContain('sentinel-secret');
      }
      for (const method of ['HEAD', 'OPTIONS', 'PUT']) expect((await fetch(active.address, { method, headers })).status).toBe(405);
      expect((await fetch(`${active.address}?token=sentinel-secret`, { method: 'POST', headers, body: '{}' })).status).toBe(400);
    } finally { await active.close(); }
  });
  it('retains real execution after deadline and shutdown until an abort-ignoring dependency settles', async () => {
    let resolveQuery!: (result: { rows: never[] }) => void;
    const query = new Promise<{ rows: never[] }>((resolve) => { resolveQuery = resolve; });
    const active = await harness({ CONTINUUM_MCP_HTTP_CALLS: '1', CONTINUUM_MCP_HTTP_PRINCIPAL_CALLS: '1',
      CONTINUUM_MCP_HTTP_REQUEST_MS: '100' }, { query: () => query });
    const transport = new StreamableHTTPClientTransport(active.address, { requestInit: { headers: { Authorization: 'Bearer synthetic' } } });
    const client = new Client({ name: 'deadline-test', version: '1' });
    await client.connect(transport);
    const call = client.callTool({ name: 'continuum.list_scopes', arguments: {} }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(active.controller.isHealthy()).toBe(false);
    let drained = false;
    const stopping = active.controller.stop('test').then(() => { drained = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drained).toBe(false);
    resolveQuery({ rows: [] });
    await stopping; await client.close(); await call;
    active.listener.closeAllConnections(); await new Promise<void>((resolve) => active.listener.close(() => resolve()));
  });
  it('rejects duplicate active IDs and preserves cancellation admission at call saturation', async () => {
    let resolveQuery!: (result: { rows: never[] }) => void;
    const query = new Promise<{ rows: never[] }>((resolve) => { resolveQuery = resolve; });
    const active = await harness({ CONTINUUM_MCP_HTTP_CALLS: '1', CONTINUUM_MCP_HTTP_PRINCIPAL_CALLS: '1' }, { query: () => query });
    const transport = new StreamableHTTPClientTransport(active.address, { requestInit: { headers: { Authorization: 'Bearer synthetic' } } });
    const client = new Client({ name: 'active-test', version: '1' }); await client.connect(transport);
    const headers = { Authorization: 'Bearer synthetic', 'Mcp-Session-Id': transport.sessionId!,
      'Mcp-Protocol-Version': '2025-11-25', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    const abort = new AbortController();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'active', method: 'tools/call', params: { name: 'continuum.list_scopes', arguments: {} } });
    const first = fetch(active.address, { method: 'POST', headers, body, signal: abort.signal }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await fetch(active.address, { method: 'POST', headers, body })).status).toBe(409);
    expect((await fetch(active.address, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0',
      method: 'notifications/cancelled', params: { requestId: 'active' } }) })).status).toBe(202);
    resolveQuery({ rows: [] }); abort.abort(); await first; await client.close(); await active.close();
  });
});
