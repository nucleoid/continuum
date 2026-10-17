import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHttpController } from './mcp-http.js';
import { mcpHttpConfigFromEnv } from './mcp-http-config.js';
import { startRuntime } from './runtime.js';
import { createApp } from './server.js';
const principal = { id: '11111111-1111-4111-8111-111111111111', kind: 'service' as const,
  externalId: 'synthetic', displayName: 'Synthetic', createdAt: new Date(0) };
const auth = { mode: 'dev' as const, authenticate: async () => ({ principal, credential: 'dev' as const }) };
const config = () => mcpHttpConfigFromEnv({ CONTINUUM_MCP_HTTP_ENABLED: 'true', CONTINUUM_MCP_PUBLIC_URL: 'http://localhost:4000/mcp',
  CONTINUUM_MCP_HTTP_LOOPBACK_DEV: 'true', CONTINUUM_MCP_HTTP_PEER_BURST: '100' }, 'dev')!;
describe('remote MCP API/runtime composition', () => {
  it('stays disabled by default and authenticates before the REST JSON parser when mounted', async () => {
    const pool = { query: async () => ({ rows: [] }) } as never;
    const disabled = createApp(pool, { authenticator: auth, logger: { error: () => undefined } });
    expect((await request(disabled).post('/mcp').send({})).status).toBe(404);
    const remote = createMcpHttpController(config(), { pool, embeddingProvider: null,
      authenticator: { mode: 'dev', authenticate: async () => null } });
    const enabled = createApp(pool, { authenticator: auth, mcpHttpController: remote, logger: { error: () => undefined } });
    expect((await request(enabled).post('/mcp').set('Host', 'localhost:4000').set('Authorization', 'Bearer bad')
      .set('Content-Type', 'application/json').send('{')).status).toBe(401);
    await remote.stop('test');
  });
  it('keeps REST ready when the bounded remote pool is normally busy', async () => {
    const remote = createMcpHttpController(config(), { pool: {} as never, embeddingProvider: null, authenticator: auth });
    const pool = { query: async () => ({ rows: [] }) } as never;
    const busyPool = { idleCount: 0, totalCount: 5, options: { max: 5 }, query: vi.fn(() => { throw new Error('Should not queue readiness behind load'); }) };
    const app = createApp(pool, { authenticator: auth, mcpHttpController: remote, mcpHttpPool: busyPool as never,
      logger: { error: () => undefined } });
    expect((await request(app).get('/health/ready')).status).toBe(200);
    expect(busyPool.query).not.toHaveBeenCalled(); await remote.stop('test');
  });
  it.each(['deadline', 'second signal'])('bounds runtime shutdown (%s), closes sockets and pool once despite abort-ignoring work', async (mode) => {
    let settle!: () => void;
    const late = new Promise<{ rows: never[] }>((resolve) => { settle = () => resolve({ rows: [] }); });
    let entered!: () => void;
    const admitted = new Promise<void>((resolve) => { entered = resolve; });
    const policy = config();
    const remote = createMcpHttpController(policy, { pool: { query: () => { entered(); return late; } } as never, embeddingProvider: null, authenticator: auth });
    const app = express(); app.use('/mcp', remote.router);
    const closePool = vi.fn(async () => undefined);
    const handlers = new Map<string, () => void>();
    const process = { on: vi.fn((signal: string, callback: () => void) => { handlers.set(signal, callback); }), off: vi.fn(), exit: vi.fn() };
    const runtime = await startRuntime(app, { port: 0, host: '127.0.0.1', workers: [remote], closePool,
      shutdownTimeoutMs: mode === 'deadline' ? 50 : 1000, process, logger: { info: () => undefined, error: () => undefined } });
    const url = new URL(`http://127.0.0.1:${(runtime.server.address() as { port: number }).port}/mcp`);
    policy.publicUrl = url; policy.authority = url.host;
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer synthetic' } } });
    const client = new Client({ name: 'runtime-test', version: '1' }); await client.connect(transport);
    const call = client.callTool({ name: 'continuum.list_scopes', arguments: {} }).catch(() => undefined);
    await admitted;
    const started = Date.now();
    if (mode === 'second signal') { handlers.get('SIGTERM')!(); handlers.get('SIGINT')!(); }
    expect(await runtime.shutdown('test')).toEqual({ timedOut: true });
    expect(Date.now() - started).toBeLessThan(500); expect(closePool).toHaveBeenCalledOnce();
    expect(runtime.readiness.isReady()).toBe(false);
    settle(); await remote.stop('cleanup'); await client.close(); await call;
    expect(closePool).toHaveBeenCalledOnce();
  });
});
