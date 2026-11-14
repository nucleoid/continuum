import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { extractionFixture } from '../extraction/test-helpers.js';
import { getPrincipal } from '../storage/principals.js';
import { createApp } from './server.js';
import { buildMcpServer } from './mcp.js';
import { processExtraction } from '../workers/extraction.js';
import { createPrincipal } from '../storage/principals.js';
import { addMembership } from '../storage/memberships.js';

it('shares authenticated REST/MCP status/read/configure/retry authority and keeps capture success asynchronous', async () => {
  await extractionFixture(async f => {
    const actor = (await getPrincipal(f.app, f.actorId))!, app = createApp(f.app, { logger: { info() {}, error() {} } });
    const created = await request(app).post('/api/v0/capture').set('Authorization', `Bearer ${actor.externalId}`)
      .send({ scope: { kind: 'user', name: (await f.app.query('SELECT name FROM scopes WHERE id=$1', [f.scopeId])).rows[0].name },
        title: 'Original source', body: 'Do not replace source truth.', type: 'decision', source: 'manual' });
    expect(created.status).toBe(201); expect(created.body.extraction.status).toBe('queued');
    expect(await processExtraction(f.worker, randomUUID(), f.profile)).toBe('processed');
    const read = await request(app).get(`/api/v0/memories/${created.body.id}/extraction?assertions=true`).set('Authorization', `Bearer ${actor.externalId}`);
    expect(read.status).toBe(200); expect(read.headers['cache-control']).toBe('private, no-store'); expect(read.body.items[0].data.status).toBe('generated/unverified');
    const server = buildMcpServer({ pool: f.app, principal: actor, embeddingProvider: null });
    const client = new Client({ name: 'extraction-parity', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const reply = await client.callTool({ name: 'continuum.extraction_status', arguments: { memory_id: created.body.id, include_assertions: true } });
      expect(reply.isError).not.toBe(true);
      expect(JSON.parse((reply.content as Array<{ text: string }>)[0].text)).toEqual(read.body);
      const configured = await client.callTool({ name: 'continuum.extraction_configure', arguments: { scope_id: f.scopeId, profile: f.profile.id, sources: ['manual'], enabled: false } });
      expect(configured.isError).not.toBe(true);
      const retry = await client.callTool({ name: 'continuum.extraction_retry', arguments: { memory_id: created.body.id } });
      expect(retry.isError).toBe(true);
    } finally { await client.close(); await server.close(); }
    const reader = await createPrincipal(f.owner, { externalId: randomUUID(), kind: 'user', displayName: 'Reader' });
    await addMembership(f.owner, reader.id, f.scopeId, 'reader');
    expect((await request(app).put(`/api/v0/scopes/${f.scopeId}/extraction`).set('Authorization', `Bearer ${reader.externalId}`)
      .send({ profile: f.profile.id, sources: ['manual'], enabled: true })).status).toBe(403);
    const outsider = await createPrincipal(f.owner, { externalId: randomUUID(), kind: 'user', displayName: 'Other scope' });
    expect((await request(app).get(`/api/v0/memories/${created.body.id}/extraction`).set('Authorization', `Bearer ${outsider.externalId}`)).status).toBe(403);
  });
}, 120_000);

it('atomically captures, attributes and enqueues signed webhook deliveries once across replay', async () => {
  await extractionFixture(async f => {
    const producer = (await getPrincipal(f.app, f.producerId))!, secret = 'synthetic-extraction-hmac';
    const app = createApp(f.app, { embeddingProvider: null, ingestProducerPools: { 'github-branch': f.producer },
      logger: { info() {}, error() {} }, ingestConfig: { plugins: { 'github-branch': { enabled: true,
        principalExternalId: producer.externalId, auth: { kind: 'github-hmac', secret, event: 'create' } } } } });
    const body = JSON.stringify({ ref: 'feature/extraction', ref_type: 'branch', repository: { id: 100, name: 'repo', full_name: 'org/repo', html_url: 'https://sources.example/org/repo' }, sender: { id: 42, login: 'untrusted-label' } });
    const send = () => request(app).post('/api/v0/ingest/github-branch').set('Content-Type', 'application/json')
      .set('X-GitHub-Delivery', randomUUID()).set('X-GitHub-Event', 'create')
      .set('X-Hub-Signature-256', 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')).send(body);
    expect((await send()).status).toBe(202); expect((await send()).status).toBe(200);
    const memory = (await f.owner.query('SELECT id,body FROM memories')).rows[0];
    expect((await f.owner.query('SELECT count(*)::int AS n FROM extraction_runs WHERE memory_id=$1', [memory.id])).rows[0].n).toBe(1);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM memory_activity_attributions WHERE memory_id=$1', [memory.id])).rows[0].n).toBe(1);
    expect(await processExtraction(f.worker, randomUUID(), f.profile)).toBe('processed');
    expect((await f.owner.query('SELECT body FROM memories WHERE id=$1', [memory.id])).rows[0].body).toBe(memory.body);
    await f.owner.query(`CREATE FUNCTION reject_extraction_admission_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.metadata->>'operation'='extraction_admitted' THEN RAISE EXCEPTION 'synthetic required audit rejection'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_extraction_admission_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_extraction_admission_audit()`);
    const another = body.replace('feature/extraction','feature/rejected');
    const rejected = await request(app).post('/api/v0/ingest/github-branch').set('Content-Type', 'application/json')
      .set('X-GitHub-Delivery', randomUUID()).set('X-GitHub-Event', 'create')
      .set('X-Hub-Signature-256', 'sha256=' + createHmac('sha256', secret).update(another).digest('hex')).send(another);
    expect(rejected.status).toBe(500);
    expect(JSON.stringify(rejected.body)).not.toContain('synthetic required audit rejection');
    for (const table of ['memories','extraction_runs','memory_activity_attributions','ingest_deliveries'])
      expect((await f.owner.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(1);
  });
}, 120_000);
