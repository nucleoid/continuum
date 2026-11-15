import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { expect,it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { briefFixture } from '../briefs/test-helpers.js';
import { getPrincipal } from '../storage/principals.js';
import { createMemory } from '../storage/memories.js';
import { createApp } from './server.js';
import { buildMcpServer } from './mcp.js';
import { processBrief } from '../workers/briefs.js';

it('shares bounded current/history/full/delta/dry-run services with explicit REST/MCP field contracts',async () => {
  await briefFixture(async f => {
    const actor=(await getPrincipal(f.app,f.actorId))!,app=createApp(f.app,{ logger: { info() {},error() {} } });
    await createMemory(f.app,{ scopeId: f.projectId,scopeKind: 'project',authorId: actor.id,type: 'decision',title: 'Plan',body: 'Source remains source.',source: 'manual' });
    const auth=`Bearer ${actor.externalId}`;
    const server=buildMcpServer({ pool: f.app,principal: actor,embeddingProvider: null });
    const client=new Client({ name: 'brief-parity',version: '1' });const [a,b]=InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(a),client.connect(b)]);
      const decode=(value: unknown) => JSON.parse((value as { content: Array<{ text: string }> }).content[0].text);
      const full=await request(app).post('/api/v0/briefs/refresh').set('Authorization',auth)
        .send({ project: f.projectName,mode: 'full',dryRun: false,idempotencyKey: 'full' });
      expect(full.status).toBe(200);expect(full.body.status).toBe('queued');
      const same=decode(await client.callTool({ name: 'continuum.refresh_brief',arguments: { project: f.projectName,mode: 'full',dry_run: false,idempotency_key: 'full' } }));
      expect(same.run_id).toBe(full.body.runId);expect(same.dry_run).toBe(false);
      expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
      const read=await request(app).get('/api/v0/briefs').query({ project: f.projectName }).set('Authorization',auth);
      expect(read.status).toBe(200);expect(read.headers['cache-control']).toBe('private, no-store');
      const mcp=decode(await client.callTool({ name: 'continuum.brief',arguments: { project: f.projectName } }));
      expect(mcp.blocks).toEqual(read.body.blocks);expect(mcp.definition_id).toBe(read.body.definitionId);expect(mcp.scope_id).toBe(read.body.scopeId);
      const history=await request(app).get(`/api/v0/briefs/${f.definitionId}/versions`).query({ limit: 1 }).set('Authorization',auth);
      const mcpHistory=decode(await client.callTool({ name: 'continuum.brief_history',arguments: { brief_id: f.definitionId,limit: 1 } }));
      expect(mcpHistory.items[0].blocks).toEqual(history.body.items[0].blocks);expect(mcpHistory.next_cursor).toBeNull();
      const dry=decode(await client.callTool({ name: 'continuum.refresh_brief',arguments: { project: f.projectName,mode: 'delta',dry_run: true,idempotency_key: 'dry' } }));
      expect(dry.status).toBe('queued');expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
      const preview=decode(await client.callTool({ name: 'continuum.refresh_brief',arguments: { project: f.projectName,mode: 'delta',dry_run: true,idempotency_key: 'dry' } }));
      expect(preview.diff).toMatchObject({ status: 'available',added: [],removed: [] });
      expect((await request(app).get('/api/v0/briefs').query({ project: f.projectName }).set('Authorization',auth)).body.version).toBe(read.body.version);
      expect((await request(app).get('/api/v0/briefs').query({ project: f.projectName,sourceIds: 'forged' }).set('Authorization',auth)).status).toBe(400);
      expect((await request(app).get(`/api/v0/briefs/${f.definitionId}/versions`).query({ limit: 11 }).set('Authorization',auth)).status).toBe(400);
      const absentHistory=await request(app).get(`/api/v0/briefs/${randomUUID()}/versions`).set('Authorization',auth);
      const absentProject=await request(app).get('/api/v0/briefs').query({ project: `absent-${randomUUID()}` }).set('Authorization',auth);
      expect(absentHistory.status).toBe(403);expect(absentProject.status).toBe(absentHistory.status);
      expect(absentProject.body.code).toBe(absentHistory.body.code);
      expect((await request(app).post('/api/v0/briefs/refresh').set('Authorization',auth)
        .send({ project: f.projectName,mode: 'full',dryRun: false,idempotencyKey: 'bad',evidence: ['forged'] })).status).toBe(400);
    } finally { await client.close();await server.close(); }
  });
},120000);
