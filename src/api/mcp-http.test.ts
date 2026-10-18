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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Server } from 'node:http';
import type pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { createMemory } from '../storage/memories.js';
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';
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
    const fallback = await createPrincipal(pool, { externalId: 'remote-test-breakglass', kind: 'service', displayName: 'Test admin' });
    await addMembership(pool, fallback.id, org.id, 'admin');
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
      const strict = await client.callTool({ name: 'continuum.lock_acquire', arguments: {
        scope: 'project:remote', resource: 'one', run_id: 'run', request_id: 'request', unknown: true } });
      expect(strict.isError).toBe(true); expect(JSON.stringify(strict)).toContain('INVALID_INPUT');
      await local.close(); await shared.close();
    } finally { await cleanup(); }
  });
  it('runs the shipped UAT lease smoke through real SDK clients and isolated PostgreSQL', async () => {
    const { leaseSmoke, decodeResult, connect } = await import('../../scripts/uat-mcp-smoke.mjs');
    const other = await createPrincipal(pool, { externalId: 'uat-other-client', kind: 'service', displayName: 'Synthetic UAT B' });
    await addMembership(pool, other.id, scopeId, 'writer');
    const credential = `ctm_${randomBytes(32).toString('base64url')}`;
    await pool.query('INSERT INTO service_api_keys (id,principal_id,key_hash,prefix,last_four) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), other.id, createHash('sha256').update(credential).digest(), 'ctm_test', credential.slice(-4)]);
    const b = await connect(url, credential);
    try {
      const aCall = async (name: string, args: Record<string, unknown>) => decodeResult(await client.callTool({ name: `continuum.${name}`, arguments: args }));
      const checks = await leaseSmoke(aCall, b.call, 'project:remote', { wait: async (ms: number) => {
        expect(ms).toBeGreaterThan(30000);
        // Only the disposable integration fixture advances elapsed lease time.
        await pool.query(`UPDATE coordination_leases SET acquired_at=clock_timestamp()-interval '2 seconds', expires_at=clock_timestamp()-interval '1 second' WHERE scope_id=$1 AND resource LIKE 'uat:delivery-forge:%' AND released_at IS NULL`, [scopeId]);
      } });
      expect(checks).toEqual({ replay: true, contention: true, masking: true, renew: true, release: true, expiry: true, staleGeneration: true });
    } finally { await b.client.close(); await cleanup(); }
  });
  it.skipIf(process.platform === 'win32')('runs checkpoint and recovery across remote listener and controller recreation', async () => {
    const { runUatSmoke } = await import('../../scripts/uat-mcp-smoke.mjs');
    const directory = mkdtempSync(join(tmpdir(), 'continuum-uat-restart-'));
    const other = await createPrincipal(pool, { externalId: 'restart-other-client', kind: 'service', displayName: 'Synthetic restart B' });
    await addMembership(pool, other.id, scopeId, 'writer');
    const credential = `ctm_${randomBytes(32).toString('base64url')}`;
    await pool.query('INSERT INTO service_api_keys (id,principal_id,key_hash,prefix,last_four) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), other.id, createHash('sha256').update(credential).digest(), 'ctm_test', credential.slice(-4)]);
    const aFile = join(directory, 'a.key'), bFile = join(directory, 'b.key');
    writeFileSync(aFile, key, { mode: 0o600 }); writeFileSync(bFile, credential, { mode: 0o600 });
    const env = { CONTINUUM_UAT_URL: url.href, CONTINUUM_UAT_PROJECT: 'remote', CONTINUUM_UAT_KEY_A_FILE: aFile,
      CONTINUUM_UAT_KEY_B_FILE: bFile, CONTINUUM_UAT_STATE_FILE: join(directory, 'checkpoint.json') };
    try {
      expect(await runUatSmoke(env, 'checkpoint', { allowLoopback: true })).toMatchObject({ ok: true, checkpoint: true });
      await client.close(); await controller.stop('test-restart'); server.closeAllConnections();
      const port = (server.address() as { port: number }).port;
      await new Promise<void>(resolve => server.close(() => resolve()));
      const restarted = express();
      server = await new Promise<Server>(resolve => { const listener = restarted.listen(port, '127.0.0.1', () => resolve(listener)); });
      controller = createMcpHttpController(mcpHttpConfigFromEnv({ CONTINUUM_MCP_HTTP_ENABLED: 'true', CONTINUUM_MCP_PUBLIC_URL: url.href,
        CONTINUUM_MCP_HTTP_LOOPBACK_DEV: 'true', CONTINUUM_MCP_HTTP_PEER_BURST: '100', CONTINUUM_MCP_HTTP_MESSAGE_BURST: '100' }, 'entra')!,
        { pool, embeddingProvider: null, authenticator: createAuthenticator(pool, 'entra', entra), now: () => new Date('2026-10-13T11:00:00Z') });
      restarted.use('/mcp', controller.router);
      expect(await runUatSmoke(env, 'recover', { allowLoopback: true })).toEqual({ ok: true, restartPersistence: true, freshSessions: true });
    } finally {
      await cleanup();
      expect(resolve(directory).startsWith(resolve(tmpdir()) + sep)).toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60000);
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
      const memoryId = JSON.parse((success.content as Array<{ text: string }>)[0].text).id;
      expect((await client.callTool({ name: 'continuum.get_memory', arguments: { memory_id: memoryId } })).isError).not.toBe(true);
      await pool.query('UPDATE scope_memberships SET active=false WHERE principal_id=$1 AND scope_id=$2', [principalId, scopeId]);
      expect(JSON.stringify(await client.callTool({ name: 'continuum.get_memory', arguments: { memory_id: memoryId } }))).toContain('MEMORY_NOT_FOUND');
      await pool.query("UPDATE scope_memberships SET active=false WHERE principal_id=$1 AND scope_id=(SELECT id FROM scopes WHERE kind='org')", [principalId]);
      expect(JSON.stringify(await client.callTool({ name: 'continuum.gaps', arguments: {} }))).toContain('FORBIDDEN');
      await pool.query('UPDATE service_api_keys SET revoked_at=now() WHERE key_hash=$1', [createHash('sha256').update(key).digest()]);
      for (const method of ['POST', 'GET', 'DELETE']) {
        const response = await fetch(url, { method, headers: { Authorization: `ApiKey ${key}`, 'Mcp-Session-Id': transport.sessionId! } });
        expect(response.status).toBe(401);
      }
    } finally { await cleanup(); }
  });
  it('rejects oversized legacy content before browse/generator hydration or mutation with no success audit', async () => {
    try {
      const memory = await createMemory(pool, { scopeId, scopeKind: 'project', type: 'decision', title: 'Oversized legacy',
        body: 'x'.repeat(2 * 1024 * 1024), authorId: principalId, source: 'manual', tags: [] });
      const before = Number((await pool.query('SELECT count(*) AS count FROM audit_log')).rows[0].count);
      const calls = [
        { name: 'continuum.get_memory', arguments: { memory_id: memory.id } },
        { name: 'continuum.list_memories', arguments: { scope: 'project:remote' } },
        { name: 'continuum.recall', arguments: { query: 'Oversized', scopes: ['project:remote'] } },
        { name: 'continuum.decision_history', arguments: { decision_id: memory.id } },
        { name: 'continuum.agents_md', arguments: { project: 'remote' } },
        { name: 'continuum.agents_md_fresh', arguments: { project: 'remote', hash: '0'.repeat(64) } },
        { name: 'continuum.promote', arguments: { memory_id: memory.id, target_scope_kind: 'org', target_scope_name: '' } },
        { name: 'continuum.verify', arguments: { memory_id: memory.id, still_true: true } },
        { name: 'continuum.supersede', arguments: { superseded_id: memory.id, title: 'Small replacement', body: 'Small' } },
      ];
      for (const call of calls) {
        const result = await client.callTool(call);
        expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('PAYLOAD_TOO_LARGE');
      }
      expect(Number((await pool.query('SELECT count(*) AS count FROM audit_log')).rows[0].count)).toBe(before);
      expect((await pool.query('SELECT state,promoted_to_id FROM memories WHERE id=$1', [memory.id])).rows[0])
        .toEqual({ state: 'live', promoted_to_id: null });
      expect(Number((await pool.query('SELECT count(*) AS count FROM memories')).rows[0].count)).toBe(1);
    } finally { await cleanup(); }
  }, 30000);

  it('serves realistic default AGENTS freshness and fifty complete list items over the SDK', async () => {
    try {
      const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
      for (let index = 0; index < 50; index++) await createMemory(pool, { scopeId: index < 20 ? org.id : scopeId,
        scopeKind: index < 20 ? 'org' : 'project', type: 'decision', title: `Reference ${index}`,
        body: 'Ordinary reference text with punctuation. '.repeat(52), source: 'manual', authorId: principalId });
      const listed = await client.callTool({ name: 'continuum.list_memories', arguments: {} });
      expect(listed.isError).not.toBe(true);
      expect(JSON.parse((listed.content as Array<{ text: string }>)[0].text).items).toHaveLength(50);
      const bundle = await client.callTool({ name: 'continuum.agents_md', arguments: { project: 'remote' } });
      expect(bundle.isError).not.toBe(true);
      const markdown = (bundle.content as Array<{ text: string }>)[0].text;
      const fresh = await client.callTool({ name: 'continuum.agents_md_fresh', arguments: { project: 'remote',
        hash: createHash('sha256').update(markdown).digest('hex') } });
      expect(fresh.isError).not.toBe(true);
      expect(JSON.parse((fresh.content as Array<{ text: string }>)[0].text)).toEqual({ fresh: true });
    } finally { await cleanup(); }
  }, 30000);
  it('rejects escaped wire expansion before successful remote browse audits', async () => {
    try {
      const memory = await createMemory(pool, { scopeId, scopeKind: 'project', type: 'decision', title: 'Escaping',
        body: String.fromCharCode(92).repeat(300000), source: 'manual', authorId: principalId });
      const before = Number((await pool.query('SELECT count(*) FROM audit_log')).rows[0].count);
      for (const [name, args] of [['continuum.get_memory', { memory_id: memory.id }], ['continuum.list_memories', {}]] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('PAYLOAD_TOO_LARGE');
      }
      expect(Number((await pool.query('SELECT count(*) FROM audit_log')).rows[0].count)).toBe(before);
    } finally { await cleanup(); }
  });
  it('sheds random service-key database lookups while established proxy sessions still reauthenticate', async () => {
    let keyLookups = 0;
    const observed = new Proxy(pool, { get(target, property) {
      const value = Reflect.get(target, property);
      if (property === 'query') return (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].includes('FROM service_api_keys')) keyLookups++;
        return Reflect.apply(value, target, args);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const app = express();
    const proxyServer = await new Promise<Server>((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const address = new URL(`http://127.0.0.1:${(proxyServer.address() as { port: number }).port}/mcp`);
    const policy = mcpHttpConfigFromEnv({ CONTINUUM_MCP_HTTP_ENABLED: 'true', CONTINUUM_MCP_PUBLIC_URL: address.href.replace('http:', 'https:'),
      CONTINUUM_MCP_TRUSTED_PROXY_CIDRS: '127.0.0.1/32', CONTINUUM_MCP_HTTP_PROXY_BURST: '1', CONTINUUM_MCP_HTTP_PROXY_RATE: '1' }, 'entra')!;
    const remote = createMcpHttpController(policy, { pool: observed, embeddingProvider: null,
      authenticator: createAuthenticator(observed, 'entra', entra) });
    app.use('/mcp', remote.router);
    const proxyClient = new Client({ name: 'real-key-admission', version: '1' });
    const proxyTransport = new StreamableHTTPClientTransport(address, { requestInit: { headers: {
      Authorization: `ApiKey ${key}`, 'X-Forwarded-Proto': 'https' } } });
    try {
      await proxyClient.connect(proxyTransport);
      const randomKey = () => `ctm_${randomBytes(32).toString('base64url')}`;
      const rejected = async () => fetch(address, { headers: { Authorization: `ApiKey ${randomKey()}`, 'X-Forwarded-Proto': 'https' } });
      expect((await rejected()).status).toBe(401);
      const before = keyLookups;
      for (let index = 0; index < 8; index++) expect((await rejected()).status).toBe(429);
      expect(keyLookups).toBe(before);
      expect((await proxyClient.listTools()).tools.length).toBeGreaterThan(10);
      expect(keyLookups).toBe(before + 1);
      await pool.query('UPDATE service_api_keys SET revoked_at=now() WHERE key_hash=$1', [createHash('sha256').update(key).digest()]);
      await expect(proxyClient.listTools()).rejects.toThrow();
      expect(keyLookups).toBe(before + 2);
      const invalidatedLookups = keyLookups;
      await expect(proxyClient.listTools()).rejects.toThrow();
      expect(keyLookups).toBe(invalidatedLookups);
    } finally { await proxyClient.close(); await remote.stop('test'); proxyServer.closeAllConnections();
      await new Promise<void>((resolve) => proxyServer.close(() => resolve())); await cleanup(); }
  });
  it('bounds legacy candidate hydration through actual SDK capture option wiring', async () => {
    const vector = [1, ...Array(767).fill(0)];
    const provider = { id: 'sdk-relation-budget:fixture', dim: 768, embed: async (texts: string[]) => texts.map(() => vector) };
    const legacy = await createMemory(pool, { scopeId, scopeKind: 'project', type: 'decision', title: 'Legacy',
      body: 'legacy-body '.repeat(200000), source: 'manual', authorId: principalId });
    await storeMemoryEmbeddingVector(pool, legacy.id, vector, provider);
    const queries: string[] = [];
    const observed = new Proxy(pool, { get(target, property) {
      const value = Reflect.get(target, property);
      if (property === 'query') return (...args: unknown[]) => { if (typeof args[0] === 'string') queries.push(args[0]); return Reflect.apply(value, target, args); };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const app = express();
    const sdkServer = await new Promise<Server>((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const address = new URL(`http://127.0.0.1:${(sdkServer.address() as { port: number }).port}/mcp`);
    const policy = mcpHttpConfigFromEnv({ CONTINUUM_MCP_HTTP_ENABLED: 'true', CONTINUUM_MCP_PUBLIC_URL: address.href,
      CONTINUUM_MCP_HTTP_LOOPBACK_DEV: 'true' }, 'entra')!;
    const remote = createMcpHttpController(policy, { pool: observed, embeddingProvider: provider,
      authenticator: createAuthenticator(observed, 'entra', entra) });
    app.use('/mcp', remote.router);
    const sdk = new Client({ name: 'sdk-capture-budget', version: '1' });
    try {
      await sdk.connect(new StreamableHTTPClientTransport(address, { requestInit: { headers: { Authorization: `ApiKey ${key}` } } }));
      const result = await sdk.callTool({ name: 'continuum.capture', arguments: { scope_kind: 'project', scope_name: 'remote',
        type: 'decision', title: 'New reference', body: 'New reference', source: 'manual' } });
      expect(result.isError).not.toBe(true);
      const captured = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(captured).toMatchObject({ embedded: true, related: [] });
      expect(JSON.stringify(result)).not.toContain('legacy-body');
      expect(queries.some((sql) => sql.includes('octet_length(m.body)'))).toBe(true);
      expect(queries.some((sql) => /SELECT[^;]*m\.title, m\.body/.test(sql))).toBe(false);
      expect((await pool.query('SELECT md5(body) AS hash,state,metadata FROM memories WHERE id=$1', [legacy.id])).rows[0])
        .toEqual({ hash: createHash('md5').update(legacy.body).digest('hex'), state: 'live', metadata: {} });
      expect((await pool.query('SELECT metadata FROM audit_log WHERE memory_id=$1', [captured.id])).rows[0].metadata)
        .toMatchObject({ embedded: true, relation_error_code: 'RELATION_DETECTION_FAILED' });
      expect((await pool.query('SELECT 1 FROM audit_log WHERE memory_id=$1', [legacy.id])).rowCount).toBe(0);
    } finally { await sdk.close(); await remote.stop('test'); sdkServer.closeAllConnections();
      await new Promise<void>((resolve) => sdkServer.close(() => resolve())); await cleanup(); }
  });
  it('preserves membership lock and commit ordering when revocation overlaps a mutation', async () => {
    let entered!: () => void; let resume!: () => void;
    const enteredWrite = new Promise<void>((resolve) => { entered = resolve; });
    const continueWrite = new Promise<void>((resolve) => { resume = resolve; });
    const originalConnect = pool.connect;
    let paused = false;
    pool.connect = new Proxy(originalConnect, { apply(target, thisArg, args) {
      const work = Reflect.apply(target, thisArg, args);
      if (args.length) return work;
      return (work as Promise<pg.PoolClient>).then((client) => new Proxy(client, { get(target, property) {
        const value = Reflect.get(target, property);
        if (property === 'query') return async (...args: unknown[]) => {
          const result = await Reflect.apply(value, target, args);
          if (!paused && typeof args[0] === 'string' && args[0].includes('FROM scope_memberships') && args[0].includes('FOR UPDATE')) {
            paused = true; entered(); await continueWrite;
          }
          return result;
        };
        return typeof value === 'function' ? value.bind(target) : value;
      } }));
    } });
    try {
      const input = { scope_kind: 'project', scope_name: 'remote', type: 'decision', title: 'Overlap', body: 'Body' };
      const writing = client.callTool({ name: 'continuum.capture', arguments: input });
      await enteredWrite;
      let revoked = false;
      const revoking = pool.query('UPDATE scope_memberships SET active=false WHERE principal_id=$1 AND scope_id=$2',
        [principalId, scopeId]).then(() => { revoked = true; });
      await new Promise((resolve) => setTimeout(resolve, 30)); expect(revoked).toBe(false);
      resume(); expect((await writing).isError).not.toBe(true); await revoking;
      expect(JSON.stringify(await client.callTool({ name: 'continuum.capture', arguments: input }))).toContain('FORBIDDEN');
    } finally { resume(); pool.connect = originalConnect; await cleanup(); }
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
  it('rejects multi-request retention attacks before dispatch while another principal remains usable', async () => {
    const victim = await createPrincipal(pool, { externalId: 'batch-victim', kind: 'service', displayName: 'Batch victim' });
    const credential = `ctm_${randomBytes(32).toString('base64url')}`;
    await pool.query('INSERT INTO service_api_keys(id,principal_id,key_hash,prefix,last_four) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), victim.id, createHash('sha256').update(credential).digest(), 'ctm_test', credential.slice(-4)]);
    const second = new Client({ name: 'batch-victim', version: '1' });
    const secondTransport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `ApiKey ${credential}` } } });
    try {
      await second.connect(secondTransport);
      const session = secondTransport.sessionId;
      const headers = { Authorization: `ApiKey ${key}`, 'Mcp-Session-Id': transport.sessionId!,
        'Mcp-Protocol-Version': '2025-11-25', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
      for (let attempt = 0; attempt < 3; attempt++) {
        const call = `batch-cancel-${attempt}`;
        const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify([
          ...Array.from({ length: 18 }, (_, index) => ({ jsonrpc: '2.0', id: `batch-list-${attempt}-${index}`, method: 'tools/list' })),
          { jsonrpc: '2.0', id: call, method: 'tools/call', params: { name: 'continuum.list_scopes', arguments: {} } },
          { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: call } },
        ]) });
        await response.body?.cancel();
        expect(response.status).toBe(400);
        expect((await second.listTools()).tools.length).toBeGreaterThan(10);
        expect(secondTransport.sessionId).toBe(session);
      }
      expect((await client.listTools()).tools.length).toBeGreaterThan(10);
    } finally { await second.close(); await cleanup(); }
  });});
const syntheticPrincipal = { id: '11111111-1111-4111-8111-111111111111', externalId: 'synthetic',
  kind: 'service' as const, displayName: 'Synthetic', createdAt: new Date(0) };
async function harness(overrides: Record<string, string> = {}, selectedPool: unknown = {}, info?: (event: Record<string, unknown>) => void, proxy = false) {
  const app = express();
  const listener = await new Promise<Server>((resolve) => { const active = app.listen(0, '127.0.0.1', () => resolve(active)); });
  const address = new URL(`http://127.0.0.1:${(listener.address() as { port: number }).port}/mcp`);
  const selected = mcpHttpConfigFromEnv({ CONTINUUM_MCP_HTTP_ENABLED: 'true', CONTINUUM_MCP_PUBLIC_URL: address.href,
    ...(proxy ? { CONTINUUM_MCP_PUBLIC_URL: address.href.replace('http:', 'https:'), CONTINUUM_MCP_TRUSTED_PROXY_CIDRS: '127.0.0.1/32' }
      : { CONTINUUM_MCP_HTTP_LOOPBACK_DEV: 'true', CONTINUUM_MCP_HTTP_PEER_BURST: '100', CONTINUUM_MCP_HTTP_MESSAGE_BURST: '100' }),
    ...overrides }, proxy ? 'entra' : 'dev')!;
  let authenticationChecks = 0;
  const denied = new Set<string>();
  const unavailable = new Set<string>();
  const controller = createMcpHttpController(selected, { pool: selectedPool as never, embeddingProvider: null, info,
    authenticator: { mode: proxy ? 'entra' : 'dev', authenticate: async (_scheme: string, credential: string) => { authenticationChecks++; if (unavailable.has(credential)) throw new Error('Synthetic dependency unavailable'); return denied.has(credential) || credential.startsWith('invalid') ? null : ({ principal: syntheticPrincipal, credential: 'dev' }); } } });
  app.use('/mcp', controller.router);
  return { address, controller, listener, denied, unavailable, get authenticationChecks() { return authenticationChecks; }, async close() { await controller.stop('test');
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
      CONTINUUM_MCP_HTTP_REQUEST_MS: '100', CONTINUUM_MCP_HTTP_UNSETTLED_GRACE_MS: '20' }, { query: () => query });
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
describe('remote expiry and operational safety', () => {
  it('reclaims idle sessions and requires initialize after expiry', async () => {
    const active = await harness({ CONTINUUM_MCP_HTTP_IDLE_MS: '100', CONTINUUM_MCP_HTTP_LIFETIME_MS: '200' });
    const connect = async () => { const transport = new StreamableHTTPClientTransport(active.address,
      { requestInit: { headers: { Authorization: 'Bearer synthetic' } } });
      const client = new Client({ name: 'expiry-test', version: '1' }); await client.connect(transport); return { client, transport }; };
    const first = await connect();
    await new Promise((resolve) => setTimeout(resolve, 230));
    expect((await fetch(active.address, { method: 'DELETE', headers: { Authorization: 'Bearer synthetic',
      'Mcp-Session-Id': first.transport.sessionId!, 'Mcp-Protocol-Version': '2025-11-25' } })).status).toBe(404);
    const second = await connect(); expect(second.transport.sessionId).not.toBe(first.transport.sessionId);
    await first.client.close(); await second.client.close(); await active.close();
  });
  it('never logs arbitrary service errors, credentials, arguments or headers', async () => {
    const logs: Record<string, unknown>[] = [];
    const active = await harness({}, { query: async () => { throw new Error('sentinel-token sentinel-body sentinel-header'); } },
      (entry) => logs.push(entry));
    const transport = new StreamableHTTPClientTransport(active.address, { requestInit: { headers: {
      Authorization: 'Bearer sentinel-token', 'X-Arbitrary': 'sentinel-header' } } });
    const client = new Client({ name: 'log-test', version: '1' }); await client.connect(transport);
    const result = await client.callTool({ name: 'continuum.list_scopes', arguments: { ignored: 'sentinel-body' } });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('INTERNAL');
    await client.close(); await active.close();
    expect(JSON.stringify(logs)).not.toContain('sentinel-'); expect(logs.length).toBeGreaterThan(0);
  });
});
import { request as nodeRequest } from 'node:http';
it('admits several real SDK clients behind one trusted proxy with default aggregate limits', async () => {
  const active = await harness({}, {}, undefined, true);
  const clients: Client[] = [];
  try {
    for (let index = 0; index < 12; index++) expect((await fetch(active.address, { headers: { 'X-Forwarded-Proto': 'https' } })).status).toBe(401);
    for (let index = 0; index < 3; index++) {
      const transport = new StreamableHTTPClientTransport(active.address, { requestInit: { headers: {
        Authorization: 'Bearer synthetic', 'X-Forwarded-Proto': 'https' } } });
      const client = new Client({ name: `proxy-${index}`, version: '1' }); clients.push(client);
      await client.connect(transport); expect((await client.listTools()).tools.length).toBeGreaterThan(10);
    }
  } finally { await Promise.all(clients.map((client) => client.close())); await active.close(); }
});
it('reclaims a timed-out slow body and prevents one principal monopolizing readers', async () => {
  const active = await harness({ CONTINUUM_MCP_HTTP_CALLS: '2', CONTINUUM_MCP_HTTP_PRINCIPAL_CALLS: '1',
    CONTINUUM_MCP_HTTP_BODY_READ_MS: '50', CONTINUUM_MCP_HTTP_REQUEST_MS: '1000' });
  const upload = () => {
    let request!: ReturnType<typeof nodeRequest>;
    const result = new Promise<number>((resolve) => {
      request = nodeRequest(active.address, { method: 'POST', headers: { Authorization: 'Bearer synthetic',
        Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'Content-Length': '1024' } },
        (response) => { response.resume(); resolve(response.statusCode!); });
      request.on('error', () => resolve(0)); request.flushHeaders(); request.write('{');
    }); return { request, result };
  };
  const first = upload(); await new Promise((resolve) => setTimeout(resolve, 15));
  const second = upload(); expect(await second.result).toBe(503); second.request.destroy();
  expect([0, 504]).toContain(await first.result); first.request.destroy();
  const transport = new StreamableHTTPClientTransport(active.address, { requestInit: { headers: { Authorization: 'Bearer synthetic' } } });
  const client = new Client({ name: 'reader-recovery', version: '1' }); await client.connect(transport);
  await client.close(); await active.close();
});

it('never charges valid proxy clients against exhausted invalid-auth failure buckets', async () => {
  const active = await harness({ CONTINUUM_MCP_HTTP_PROXY_BURST: '1', CONTINUUM_MCP_HTTP_PROXY_RATE: '1' }, {}, undefined, true);
  const headers = { Authorization: 'Bearer invalid', 'X-Forwarded-Proto': 'https' };
  expect((await fetch(active.address, { headers })).status).toBe(401);
  expect((await fetch(active.address, { headers })).status).toBe(429);
  const transport = new StreamableHTTPClientTransport(active.address, { requestInit: { headers: {
    Authorization: 'Bearer synthetic', 'X-Forwarded-Proto': 'https' } } });
  const client = new Client({ name: 'valid-proxy', version: '1' }); await client.connect(transport);
  expect((await client.listTools()).tools.length).toBeGreaterThan(10); await client.close(); await active.close();
});
it('atomically reserves the last session slot and releases it on DELETE', async () => {
  const active = await harness({ CONTINUUM_MCP_HTTP_SESSIONS: '1', CONTINUUM_MCP_HTTP_PRINCIPAL_SESSIONS: '1' });
  const transports = [0, 1].map(() => new StreamableHTTPClientTransport(active.address,
    { requestInit: { headers: { Authorization: 'Bearer synthetic' } } }));
  const clients = transports.map((_, index) => new Client({ name: `race-${index}`, version: '1' }));
  const results = await Promise.allSettled(clients.map((client, index) => client.connect(transports[index])));
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const winner = results.findIndex((result) => result.status === 'fulfilled');
  await transports[winner].terminateSession();
  const next = new Client({ name: 'replacement', version: '1' });
  await next.connect(new StreamableHTTPClientTransport(active.address,
    { requestInit: { headers: { Authorization: 'Bearer synthetic' } } }));
  await Promise.all(clients.map((client) => client.close())); await next.close(); await active.close();
});
it('closes oversized output and rejects old session IDs after process-local restart', async () => {
  const active = await harness({ CONTINUUM_MCP_HTTP_OUTPUT_BYTES: '2000' });
  const transport = new StreamableHTTPClientTransport(active.address, { requestInit: { headers: { Authorization: 'Bearer synthetic' } } });
  const client = new Client({ name: 'output-test', version: '1' }); await client.connect(transport);
  const session = transport.sessionId!;
  await expect(client.listTools(undefined, { timeout: 200 })).rejects.toThrow();
  expect((await fetch(active.address, { method: 'DELETE', headers: { Authorization: 'Bearer synthetic',
    'Mcp-Session-Id': session, 'Mcp-Protocol-Version': '2025-11-25' } })).status).toBe(404);
  await client.close(); await active.close();
  const restarted = await harness();
  expect((await fetch(restarted.address, { method: 'DELETE', headers: { Authorization: 'Bearer synthetic',
    'Mcp-Session-Id': session, 'Mcp-Protocol-Version': '2025-11-25' } })).status).toBe(404);
  await restarted.close();
});
it('rejects a session that expires while its admitted POST body is still arriving', async () => {
  const active = await harness({ CONTINUUM_MCP_HTTP_IDLE_MS: '100', CONTINUUM_MCP_HTTP_LIFETIME_MS: '150',
    CONTINUUM_MCP_HTTP_BODY_READ_MS: '500', CONTINUUM_MCP_HTTP_REQUEST_MS: '1000' });
  const transport = new StreamableHTTPClientTransport(active.address, { requestInit: { headers: { Authorization: 'Bearer synthetic' } } });
  const client = new Client({ name: 'expiry-upload', version: '1' }); await client.connect(transport);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' });
  const result = new Promise<number>((resolve) => {
    const upload = nodeRequest(active.address, { method: 'POST', headers: { Authorization: 'Bearer synthetic',
      'Mcp-Session-Id': transport.sessionId!, 'Mcp-Protocol-Version': '2025-11-25',
      Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (response) => { response.resume(); resolve(response.statusCode!); });
    upload.on('error', () => resolve(0)); upload.write(body.slice(0, 10));
    setTimeout(() => upload.end(body.slice(10)), 250);
  });
  expect(await result).toBe(404); await client.close(); await active.close();
});

it('sheds exhausted proxy authentication work while freshly authenticating established clients', async () => {
  const active = await harness({ CONTINUUM_MCP_HTTP_PROXY_BURST: '1', CONTINUUM_MCP_HTTP_PROXY_RATE: '1' }, {}, undefined, true);
  const connect = async (credential: string) => {
    const transport = new StreamableHTTPClientTransport(active.address, { requestInit: { headers: {
      Authorization: `Bearer ${credential}`, 'X-Forwarded-Proto': 'https' } } });
    const client = new Client({ name: 'admission-hint', version: '1' }); await client.connect(transport); return { client, transport };
  };
  const first = await connect('synthetic-a'); const second = await connect('synthetic-b');
  try {
    expect((await fetch(active.address, { headers: { Authorization: 'Bearer invalid', 'X-Forwarded-Proto': 'https' } })).status).toBe(401);
    const before = active.authenticationChecks;
    for (let index = 0; index < 8; index++) expect((await fetch(active.address, { headers: {
      Authorization: `ApiKey invalid-${index}`, 'X-Forwarded-Proto': 'https' } })).status).toBe(429);
    expect(active.authenticationChecks).toBe(before);
    expect((await fetch(active.address, { headers: { Authorization: 'Bearer wrong-credential',
      'Mcp-Session-Id': first.transport.sessionId!, 'X-Forwarded-Proto': 'https' } })).status).toBe(429);
    expect(active.authenticationChecks).toBe(before);
    expect((await first.client.listTools()).tools.length).toBeGreaterThan(10);
    expect((await second.client.listTools()).tools.length).toBeGreaterThan(10);
    expect(active.authenticationChecks).toBeGreaterThan(before);
    const next = await connect('synthetic-new'); await next.client.close();
    active.unavailable.add('synthetic-a');
    await expect(first.client.listTools()).rejects.toThrow();
    active.unavailable.delete('synthetic-a');
    expect((await first.client.listTools()).tools.length).toBeGreaterThan(10);
    active.denied.add('synthetic-a');
    await expect(first.client.listTools()).rejects.toThrow();
    expect((await second.client.listTools()).tools.length).toBeGreaterThan(10);
  } finally { await first.client.close(); await second.client.close(); await active.close(); }
});
it('preserves an SDK session and sibling calls after AbortSignal cancellation', async () => {
  const firstEntered = Promise.withResolvers<void>(); const otherEntered = Promise.withResolvers<void>();
  const firstQuery = Promise.withResolvers<{ rows: never[] }>(); const otherQuery = Promise.withResolvers<{ rows: never[] }>();
  let queries = 0;
  const active = await harness({ CONTINUUM_MCP_HTTP_REQUEST_MS: '150' }, { query: () => {
    if (++queries === 1) { firstEntered.resolve(); return firstQuery.promise; }
    if (queries === 2) { otherEntered.resolve(); return otherQuery.promise; } return Promise.resolve({ rows: [] });
  } });
  const transport = new StreamableHTTPClientTransport(active.address, { requestInit: { headers: { Authorization: 'Bearer synthetic' } } });
  const client = new Client({ name: 'sdk-cancellation', version: '1' }); await client.connect(transport);
  const session = transport.sessionId;
  try {
    const abort = new AbortController();
    const cancelled = client.callTool({ name: 'continuum.list_scopes', arguments: {} }, undefined,
      { signal: abort.signal, timeout: 1000 }).catch((error) => error);
    await firstEntered.promise;
    const sibling = client.callTool({ name: 'continuum.list_scopes', arguments: {} }, undefined, { timeout: 1000 });
    await otherEntered.promise; abort.abort(); await cancelled;
    otherQuery.resolve({ rows: [] }); expect((await sibling).isError).not.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await client.callTool({ name: 'continuum.list_scopes', arguments: {} }, undefined, { timeout: 1000 })).isError).not.toBe(true);
    expect(transport.sessionId).toBe(session);
  } finally { firstQuery.resolve({ rows: [] }); otherQuery.resolve({ rows: [] }); await client.close(); await active.close(); }
});
it('rejects a nonloopback controller composed with a development authenticator', () => {
  const remote = mcpHttpConfigFromEnv({ CONTINUUM_MCP_HTTP_ENABLED: 'true', CONTINUUM_MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    CONTINUUM_MCP_TRUSTED_PROXY_CIDRS: '192.0.2.1/32' }, 'entra')!;
  expect(() => createMcpHttpController(remote, { pool: {} as never, embeddingProvider: null,
    authenticator: { mode: 'dev', authenticate: async () => null } })).toThrow(/entra/);
});

it('bounds reserved initialize authentication after proxy failures exhaust admission', async () => {
  const active = await harness({ CONTINUUM_MCP_HTTP_PROXY_BURST: '1', CONTINUUM_MCP_HTTP_PROXY_RATE: '1',
    CONTINUUM_MCP_HTTP_PROXY_INITIALIZE_BURST: '2', CONTINUUM_MCP_HTTP_PROXY_INITIALIZE_RATE: '1' }, {}, undefined, true);
  try {
    const headers = { Authorization: 'Bearer invalid', 'X-Forwarded-Proto': 'https',
      Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    expect((await fetch(active.address, { headers })).status).toBe(401);
    const before = active.authenticationChecks;
    for (let index = 0; index < 5; index++) expect((await fetch(active.address, { method: 'POST', headers, body: '{}' })).status).toBe(429);
    expect(active.authenticationChecks).toBe(before + 2);
  } finally { await active.close(); }
});
it('caps cancelled SDK tombstones without releasing underlying execution fences', async () => {
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const queries = [Promise.withResolvers<{ rows: never[] }>(), Promise.withResolvers<{ rows: never[] }>()];
  let calls = 0;
  const active = await harness({ CONTINUUM_MCP_HTTP_CANCELLED_IDS: '2' }, { query: () => {
    const index = calls++; entered[index].resolve(); return queries[index].promise;
  } });
  const transport = new StreamableHTTPClientTransport(active.address, { requestInit: { headers: { Authorization: 'Bearer synthetic' } } });
  const client = new Client({ name: 'cancellation-limit', version: '1' }); await client.connect(transport);
  const headers = { Authorization: 'Bearer synthetic', 'Mcp-Session-Id': transport.sessionId!, 'Mcp-Protocol-Version': '2025-11-25',
    Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  try {
    for (let index = 0; index < 2; index++) {
      const call = fetch(active.address, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: `cancel-${index}`,
        method: 'tools/call', params: { name: 'continuum.list_scopes', arguments: {} } }) }).then((response) => response.text()).catch(() => '');
      await entered[index].promise;
      expect((await fetch(active.address, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled',
        params: { requestId: `cancel-${index}` } }) })).status).toBe(202);
      await call;
      if (!index) expect((await fetch(active.address, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 'cancel-0', method: 'ping' }) })).status).toBe(409);
    }
    expect((await fetch(active.address, { method: 'DELETE', headers })).status).toBe(404);
    let drained = false; const stop = active.controller.stop('test').then(() => { drained = true; });
    await new Promise((resolve) => setTimeout(resolve, 20)); expect(drained).toBe(false);
    queries.forEach((query) => query.resolve({ rows: [] })); await stop;
  } finally { queries.forEach((query) => query.resolve({ rows: [] })); await client.close(); await active.close(); }
});

it('sheds unavailable authentication for unknown proxy callers while preserving established hints', async () => {
  const active = await harness({ CONTINUUM_MCP_HTTP_PROXY_BURST: '1', CONTINUUM_MCP_HTTP_PROXY_RATE: '1' }, {}, undefined, true);
  const transport = new StreamableHTTPClientTransport(active.address, { requestInit: { headers: {
    Authorization: 'Bearer established', 'X-Forwarded-Proto': 'https' } } });
  const client = new Client({ name: 'availability-admission', version: '1' }); await client.connect(transport);
  try {
    active.unavailable.add('unknown');
    const headers = { Authorization: 'Bearer unknown', 'X-Forwarded-Proto': 'https' };
    expect((await fetch(active.address, { headers })).status).toBe(503);
    const before = active.authenticationChecks;
    for (let index = 0; index < 3; index++) expect((await fetch(active.address, { headers })).status).toBe(429);
    expect(active.authenticationChecks).toBe(before);
    expect((await client.listTools()).tools.length).toBeGreaterThan(10);
  } finally { await client.close(); await active.close(); }
});

it('rejects multiple requests but accepts one request and bounded notification batches', async () => {
  let queries = 0;
  const active = await harness({}, { query: async () => { queries++; return { rows: [] }; } });
  const client = new Client({ name: 'batch-boundary', version: '1' });
  const transport = new StreamableHTTPClientTransport(active.address, { requestInit: { headers: { Authorization: 'Bearer synthetic' } } });
  await client.connect(transport);
  const headers = { Authorization: 'Bearer synthetic', 'Mcp-Session-Id': transport.sessionId!, 'Mcp-Protocol-Version': '2025-11-25',
    Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  try {
    const rejected = await fetch(active.address, { method: 'POST', headers, body: JSON.stringify([
      { jsonrpc: '2.0', id: 'list', method: 'tools/list' },
      { jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'continuum.list_scopes', arguments: {} } },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call' } },
    ]) });
    expect(rejected.status).toBe(400); await rejected.body?.cancel(); expect(queries).toBe(0);
    const notifications = await fetch(active.address, { method: 'POST', headers, body: JSON.stringify([
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'absent-first' } },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'absent-second' } },
    ]) });
    expect(notifications.status).toBe(202);
    const single = await fetch(active.address, { method: 'POST', headers, body: JSON.stringify([
      { jsonrpc: '2.0', id: 'ping', method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'absent-third' } },
    ]) });
    expect(single.status).toBe(200); expect(await single.text()).toContain('ping');
    expect((await client.listTools()).tools.length).toBeGreaterThan(10);
  } finally { await client.close(); await active.close(); }
});
