import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from './mcp.js';
import { testReranking } from '../reranking/test-helpers.js';
import type pg from 'pg';
import type { Principal } from '../types.js';
import { createApp } from './server.js';
import { EmbeddingRegistry, ScopeEmbeddingRouter } from '../embeddings/router.js';

it.each(['pricing', 'credentials', 'tokens', 'caps', 'spend', 'calls'] as const)('rejects known %s incompatibility with the reranking profile', mode => {
  const t = testReranking(() => 1);
  const makeProvider = (index: number) => {
    const adapter = { ...t.adapter, id: `profile-embed-${index}`, local: false, responseBodyBytes: 65_536, outputTokens: 0, completionTokens: 0,
      serialize: (texts: string[], caps: unknown) => ({ texts, caps }),
      invoke: vi.fn(async () => { const value = [Array(768).fill(0)]; return { value, response: value }; }) };
    if (mode === 'pricing') adapter.price = { ...adapter.price!, id: 'another-schedule' };
    if (mode === 'credentials') adapter.credentials = 'missing';
    if (mode === 'tokens') adapter.tokens = undefined;
    if (mode === 'caps') adapter.enforceableCaps = false;
    if (mode === 'spend') adapter.price = { ...adapter.price!, inputMicros: 1 };
    return { id: adapter.id, dim: 768, local: false, pipelineAdapter: adapter, embed: vi.fn(async () => [Array(768).fill(0)]) };
  };
  const entries = Array.from({ length: mode === 'calls' ? 4 : 1 }, (_, i) => [`p${i}`, makeProvider(i)] as const);
  const routing = new ScopeEmbeddingRouter(new EmbeddingRegistry(entries), { default: 'p0' });
  const principal: Principal = { id: '00000000-0000-4000-8000-000000000123', externalId: 'profile-test',
    kind: 'user', displayName: 'Reader', createdAt: new Date(0) };
  expect(() => createApp({} as pg.Pool, { embeddingProvider: routing, reranking: t.config() })).toThrow('Reranking requires budget-compatible embedding providers');
  expect(() => buildMcpServer({ pool: {} as pg.Pool, principal, embeddingProvider: routing, reranking: t.config() })).toThrow('Reranking requires budget-compatible embedding providers');
  for (const [, provider] of entries) expect(provider.embed).not.toHaveBeenCalled();
});

it.each(['direct', 'routed'] as const)('refuses incompatible %s embedding composition before REST or MCP can silently lose semantic recall', async mode => {
  const provider = { id: 'stock-local', dim: 768, local: true, embed: vi.fn(async () => [Array(768).fill(0)]) };
  const routing = mode === 'direct' ? provider
    : new ScopeEmbeddingRouter(new EmbeddingRegistry([['stock', provider]]), { default: 'stock' });
  const pool = {} as pg.Pool;
  const principal: Principal = { id: '00000000-0000-4000-8000-000000000123', externalId: 'composition-test',
    kind: 'user', displayName: 'Reader', createdAt: new Date(0) };
  const reranking = testReranking(() => 1).config();
  expect(() => createApp(pool, { embeddingProvider: routing, reranking })).toThrow('Reranking requires budget-compatible embedding providers');
  expect(() => buildMcpServer({ pool, principal, embeddingProvider: routing, reranking })).toThrow('Reranking requires budget-compatible embedding providers');
  // Existing unconfigured callers still accept stock providers.
  expect(() => createApp(pool, { embeddingProvider: routing })).not.toThrow();
  const server = buildMcpServer({ pool, principal, embeddingProvider: routing });
  await server.close();
  expect(provider.embed).not.toHaveBeenCalled();
});

const observed = vi.hoisted(() => ({ charged: 0 }));
vi.mock('../services/recall.js', () => ({
  // Isolate the transport's exact byte admission from database/service accounting.
  recallForPrincipal: vi.fn(async (_pool, _routing, _actor, _input, _audit, _logger, enrichment, budget) => {
    const result = { results: [{ memory: { id: '00000000-0000-4000-8000-000000000021', scopeId: 'scope',
      type: 'decision', title: 'Reference', sourceRef: null, createdAt: new Date(0) },
      score: .01, rerankScore: 2, excerpt: 'Reference data', bodyTruncated: false }],
      accessible: new Map([['scope', { label: 'project:example' }]]),
      diagnostics: { vector: 'disabled', groups: [], reranking: { status: 'used' } } };
    const before = budget.snapshot().used.outputBytes;
    enrichment.validateResult(result);
    observed.charged = budget.snapshot().used.outputBytes - before;
    return result;
  }),
}));

it('charges the actual complete MCP JSON-RPC response frame before successful service delivery', async () => {
  const principal: Principal = { id: '00000000-0000-4000-8000-000000000123', externalId: 'transport-test',
    kind: 'user', displayName: 'Reader', createdAt: new Date(0) };
  const server = buildMcpServer({ pool: {} as pg.Pool, principal, embeddingProvider: null,
    reranking: testReranking(() => 1).config(), readBudgetBytes: 65_536 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const sent: unknown[] = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async message => { sent.push(message); await send(message); };
  const client = new Client({ name: 'reranking-budget', version: '1' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'continuum.recall', arguments: { query: 'reference' } });
    expect(result.isError).not.toBe(true);
    const frame = sent.findLast((message: any) => message.result?.content) as object;
    expect(frame).toBeDefined();
    expect(observed.charged).toBe(Buffer.byteLength(JSON.stringify(frame)));
  } finally { await client.close(); await server.close(); }
});
