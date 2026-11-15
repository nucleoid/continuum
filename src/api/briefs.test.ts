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

      const reads=async () => (await f.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE metadata->>'operation'='brief_read'")).rows[0].n;
      const beforeFailure=await reads();
      await f.owner.query(`CREATE FUNCTION test_brief_read_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.metadata->>'operation'='brief_read' THEN RAISE EXCEPTION 'private synthetic audit failure'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER test_brief_read_audit_failure BEFORE INSERT ON audit_log
          FOR EACH ROW EXECUTE FUNCTION test_brief_read_audit_failure()`);
      try {
        const failed=await request(app).get('/api/v0/briefs').query({ project: f.projectName }).set('Authorization',auth);
        expect(failed.status).toBe(503);expect(failed.body.code).toBe('DEPENDENCY_UNAVAILABLE');
        const failedMcp=await client.callTool({ name: 'continuum.brief',arguments: { project: f.projectName } });
        expect(failedMcp.isError).toBe(true);expect(decode(failedMcp).error.code).toBe('DEPENDENCY_UNAVAILABLE');
        expect(JSON.stringify([failed.body,failedMcp])).not.toMatch(/Source remains source|private synthetic audit failure/);
        expect(await reads()).toBe(beforeFailure);
      } finally {
        await f.owner.query('DROP TRIGGER test_brief_read_audit_failure ON audit_log;DROP FUNCTION test_brief_read_audit_failure()');
      }

      const smallServer=buildMcpServer({ pool: f.app,principal: actor,embeddingProvider: null,readBudgetBytes: 512 });
      const smallClient=new Client({ name: 'brief-bounded-output',version: '1' });
      const [smallA,smallB]=InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([smallServer.connect(smallA),smallClient.connect(smallB)]);
        const tooLarge=await smallClient.callTool({ name: 'continuum.brief',arguments: { project: f.projectName } });
        expect(tooLarge.isError).toBe(true);expect(decode(tooLarge).error.code).toBe('PAYLOAD_TOO_LARGE');
        expect(JSON.stringify(tooLarge)).not.toContain('Source remains source');expect(await reads()).toBe(beforeFailure);
      } finally { await smallClient.close();await smallServer.close(); }

      const key=Math.floor(Math.random()*1_000_000_000)+1,blocker=await f.owner.connect();
      await f.owner.query(`CREATE FUNCTION test_brief_read_cancel_gate() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.metadata->>'operation'='brief_read' THEN PERFORM pg_advisory_xact_lock(${key}::bigint); END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER test_brief_read_cancel_gate BEFORE INSERT ON audit_log
          FOR EACH ROW EXECUTE FUNCTION test_brief_read_cancel_gate()`);
      const controller=new AbortController();let pending: Promise<unknown> | undefined;
      let cancellationReceived!: () => void;
      const cancelledNotification=new Promise<void>(resolve => { cancellationReceived=resolve; });
      const receive=a.onmessage!;
      a.onmessage=(message,extra) => {
        receive(message,extra);
        if ('method' in message && message.method==='notifications/cancelled') cancellationReceived();
      };
      try {
        await blocker.query('SELECT pg_advisory_lock($1::bigint)',[key]);
        pending=client.callTool({ name: 'continuum.brief',arguments: { project: f.projectName } },undefined,
          { signal: controller.signal,timeout: 5000 }).then(() => undefined,error => error);
        let entered=false;
        for (let probe=0;probe<50;probe++) {
          entered=(await blocker.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted
            AND classid=0 AND objid=$1::oid AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS entered`,[key])).rows[0].entered;
          if (entered) break;
          await new Promise(resolve => setTimeout(resolve,10));
        }
        expect(entered,'the real read audit must be in flight before cancellation').toBe(true);
        controller.abort();expect(await pending).toBeInstanceOf(Error);
        await cancelledNotification;
      } finally {
        controller.abort();await blocker.query('SELECT pg_advisory_unlock($1::bigint)',[key]);blocker.release();
        await pending;a.onmessage=receive;
      }
      // This conflicts with the reader's definition SHARE lock and therefore
      // waits for the actual service commit/rollback, not just client abort.
      await f.owner.query('SELECT id FROM brief_definitions WHERE id=$1 FOR UPDATE',[f.definitionId]);
      expect(await reads()).toBe(beforeFailure);
      await f.owner.query('DROP TRIGGER test_brief_read_cancel_gate ON audit_log;DROP FUNCTION test_brief_read_cancel_gate()');
    } finally { await client.close();await server.close(); }
  });
},120000);
