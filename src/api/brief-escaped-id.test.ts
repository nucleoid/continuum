import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RequestIdSchema } from '@modelcontextprotocol/sdk/types.js';
import { briefFixture } from '../briefs/test-helpers.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { refreshBrief } from '../services/briefs.js';
import { processBrief } from '../workers/briefs.js';
import { buildMcpServer } from './mcp.js';

it('bounds the actual JSON-RPC escaped request ID before the brief read audit commits', async () => {
  await briefFixture(async f => {
    const actor = (await getPrincipal(f.app, f.actorId))!;
    await createMemory(f.app, { scopeId: f.projectId, scopeKind: 'project', authorId: f.actorId,
      type: 'decision', title: 'Escaped identifier', body: 'Keep this source private until admission.', source: 'manual' });
    await refreshBrief(f.app, actor, { project: f.projectName, mode: 'full', dryRun: false, idempotencyKey: randomUUID() });
    expect(await processBrief(f.worker, randomUUID(), f.profile)).toBe('processed');
    const wideServer = buildMcpServer({ pool: f.app, principal: actor, embeddingProvider: null, readBudgetBytes: 1048576 });
    const wideClient = new Client({ name: 'brief-wire-reference', version: '1' });
    const [wideA, wideB] = InMemoryTransport.createLinkedPair();
    let resultBytes = 0;
    try {
      await Promise.all([wideServer.connect(wideA), wideClient.connect(wideB)]);
      const result = await wideClient.callTool({ name: 'continuum.brief', arguments: { project: f.projectName } });
      expect(result.isError).not.toBe(true);
      resultBytes = Buffer.byteLength(JSON.stringify(result)); //Compact budgeted projection, not unbounded pretty JSON.
    } finally { await wideClient.close(); await wideServer.close(); }
    const requestId = '\0'.repeat(128);
    expect(Buffer.byteLength(requestId)).toBe(128); //Actual mcp-http.ts admission ceiling.
    expect(RequestIdSchema.safeParse(requestId).success).toBe(true); //Installed SDK accepts controls in strings.
    expect(Buffer.byteLength(JSON.stringify(requestId))).toBe(770);
    const limit = resultBytes + 512 + 32; //Original result+fixed allowance fits; actual escaped envelope does not.
    const server = buildMcpServer({ pool: f.app, principal: actor, embeddingProvider: null, readBudgetBytes: limit });
    const client = new Client({ name: 'brief-escaped-envelope', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const reads = async () => (await f.owner.query(`SELECT count(*)::int AS n FROM audit_log
      WHERE metadata->>'operation'='brief_read'`)).rows[0].n;
    try {
      await Promise.all([server.connect(a), client.connect(b)]);
      const before = await reads(); const receive = b.onmessage;
      const response = new Promise<{ result: unknown; jsonrpc: '2.0'; id: string | number }>(resolve => {
        b.onmessage = (message, extra) => {
          if ('id' in message && message.id === requestId && 'result' in message) resolve(message);
          else receive?.(message, extra);
        };
      });
      await b.send({ jsonrpc: '2.0', id: requestId, method: 'tools/call',
        params: { name: 'continuum.brief', arguments: { project: f.projectName } } });
      const frame = await response;
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(limit);
      const result = frame.result as { isError?: boolean; content: { type: string; text: string }[] };
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(await reads()).toBe(before);
    } finally { await client.close(); await server.close(); }
  });
}, 120000);
