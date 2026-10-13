import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAuthenticator } from './auth.js';
import { createMcpHttpController } from './mcp-http.js';
import { mcpHttpConfigFromEnv } from './mcp-http-config.js';
const tokens = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const outages = vi.hoisted(() => new Set<string>());
const failures = vi.hoisted(() => new Map<string, string>());
const verifications = vi.hoisted(() => ({ calls: 0 }));
vi.mock('jose', () => ({ createRemoteJWKSet: vi.fn(() => ({})), jwtVerify: vi.fn(async (token: string) => {
  verifications.calls++;
  if (failures.has(token)) throw Object.assign(new Error('Invalid token'), { code: failures.get(token) });
  if (outages.has(token)) throw new Error('Synthetic JWKS unavailable');
  const payload = tokens.get(token);
  if (!payload || Number(payload.exp) * 1000 <= Date.now()) throw Object.assign(new Error('Invalid token'),
    { code: payload ? 'ERR_JWT_EXPIRED' : 'ERR_JWS_INVALID' });
  return { payload, protectedHeader: { alg: 'RS256', typ: 'JWT' } };
}) }));
describe('remote mocked Entra verifier lifecycle', () => {
  let server: Server | undefined;
  let controller: ReturnType<typeof createMcpHttpController> | undefined;
  const clients: Client[] = [];
  afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close()));
    await controller?.stop('test'); server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); tokens.clear(); outages.clear(); failures.clear(); verifications.calls = 0; });
  it('requires a new session for refreshed JWT and caps stream/session expiry', async () => {
    const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const oid = '11111111-1111-4111-8111-111111111111';
    const clientId = '44444444-4444-4444-8444-444444444444';
    const oldExpiry = (Date.now() + 500) / 1000;
    const claims = { oid, name: oid, tid: tenant, ver: '2.0', idtyp: 'app', azp: clientId,
      roles: ['serve'], exp: oldExpiry };
    tokens.set('original-jwt', claims); tokens.set('refreshed-jwt', { ...claims, exp: (Date.now() + 5000) / 1000 });
    tokens.set('wrong-client-jwt', { ...claims, azp: '55555555-5555-4555-8555-555555555555' });
    const pool = { query: async () => ({ rows: [{ id: oid, external_id: oid, kind: 'service', display_name: oid, created_at: new Date(0) }] }) } as never;
    const app = express();
    server = await new Promise<Server>((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const url = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
    const config = mcpHttpConfigFromEnv({ CONTINUUM_MCP_HTTP_ENABLED: 'true', CONTINUUM_MCP_PUBLIC_URL: url.href,
      CONTINUUM_MCP_HTTP_LOOPBACK_DEV: 'true', CONTINUUM_MCP_HTTP_PEER_BURST: '100' }, 'entra')!;
    const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
    controller = createMcpHttpController(config, { pool, embeddingProvider: null, authenticator: createAuthenticator(pool, 'entra', {
      tenant, audience: 'api', userScope: 'read', serviceAppRole: 'serve', allowedClientIds: [clientId],
      fetcher: async () => new Response(JSON.stringify({ issuer, jwks_uri: `https://login.microsoftonline.com/${tenant}/discovery/keys` }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }),
    }) });
    app.use('/mcp', controller.router);
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer original-jwt' } } });
    const client = new Client({ name: 'entra-test', version: '1' }); clients.push(client); await client.connect(transport);
    const headers = { 'Mcp-Session-Id': transport.sessionId!, 'Mcp-Protocol-Version': '2025-11-25', Accept: 'text/event-stream' };
    expect((await fetch(url, { headers: { ...headers, Authorization: 'Bearer refreshed-jwt' } })).status).toBe(404);
    expect((await fetch(url, { headers: { ...headers, Authorization: 'Bearer wrong-client-jwt' } })).status).toBe(401);
    await transport.close(); await new Promise((resolve) => setTimeout(resolve, 20));
    const response = await fetch(url, { headers: { ...headers, Authorization: 'Bearer original-jwt' } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let closed = false;
    const reading = (async () => { try { while (!(await reader.read()).done) {} } catch {} closed = true; })();
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, oldExpiry * 1000 - Date.now() + 120)));
    expect(closed).toBe(true); await reading;
    for (const method of ['POST', 'GET', 'DELETE']) expect((await fetch(url, { method,
      headers: { ...headers, Authorization: 'Bearer original-jwt' } })).status).toBe(401);
    expect((await fetch(url, { method: 'DELETE', headers: { ...headers, Authorization: 'Bearer refreshed-jwt' } })).status).toBe(404);
  });
  it('preserves a verified session across JWKS outages while legacy authentication keeps its behavior', async () => {
    const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const oid = '11111111-1111-4111-8111-111111111111';
    const clientId = '44444444-4444-4444-8444-444444444444';
    tokens.set('stable-jwt', { oid, name: oid, tid: tenant, ver: '2.0', idtyp: 'app', azp: clientId,
      roles: ['serve'], exp: (Date.now() + 5000) / 1000 });
    const pool = { query: async () => ({ rows: [{ id: oid, external_id: oid, kind: 'service', display_name: oid, created_at: new Date(0) }] }) } as never;
    const app = express(); server = await new Promise<Server>((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const url = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
    const config = mcpHttpConfigFromEnv({ CONTINUUM_MCP_HTTP_ENABLED: 'true', CONTINUUM_MCP_PUBLIC_URL: url.href.replace('http:', 'https:'),
      CONTINUUM_MCP_TRUSTED_PROXY_CIDRS: '127.0.0.1/32', CONTINUUM_MCP_HTTP_PROXY_BURST: '1', CONTINUUM_MCP_HTTP_PROXY_RATE: '1' }, 'entra')!;
    const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
    const auth = createAuthenticator(pool, 'entra', { tenant, audience: 'api', userScope: 'read', serviceAppRole: 'serve', allowedClientIds: [clientId],
      fetcher: async () => new Response(JSON.stringify({ issuer, jwks_uri: `https://login.microsoftonline.com/${tenant}/discovery/keys` }), { status: 200 }) });
    controller = createMcpHttpController(config, { pool, embeddingProvider: null, authenticator: auth }); app.use('/mcp', controller.router);
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer stable-jwt', 'X-Forwarded-Proto': 'https' } } });
    const client = new Client({ name: 'jwks-recovery', version: '1' }); clients.push(client); await client.connect(transport);
    const session = transport.sessionId!; outages.add('stable-jwt');
    expect(await auth.authenticate('Bearer', 'stable-jwt')).toBeNull();
    const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer stable-jwt', 'X-Forwarded-Proto': 'https', 'Mcp-Session-Id': session,
      'Mcp-Protocol-Version': '2025-11-25', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'ping' }) });
    expect(response.status).toBe(503);
    outages.delete('stable-jwt');
    expect((await client.listTools()).tools.length).toBeGreaterThan(10); expect(transport.sessionId).toBe(session);
    failures.set('stable-jwt', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED');
    const post = () => fetch(url, { method: 'POST', headers: { Authorization: 'Bearer stable-jwt', 'X-Forwarded-Proto': 'https',
      'Mcp-Session-Id': session, 'Mcp-Protocol-Version': '2025-11-25', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 901, method: 'ping' }) });
    expect((await post()).status).toBe(401);
    const before = verifications.calls; expect((await post()).status).toBe(429); expect(verifications.calls).toBe(before);
  });

});
