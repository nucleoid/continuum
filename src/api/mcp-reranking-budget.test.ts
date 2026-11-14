import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from './mcp.js';
import { testReranking } from '../reranking/test-helpers.js';
import type pg from 'pg';
import type { Principal } from '../types.js';

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
