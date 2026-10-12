import { createHmac } from 'node:crypto';
import request from 'supertest';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { standupProducerFixture } from '../standup/test-helpers.js';
import { getPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { addMembership, removeMembership } from '../storage/memberships.js';
import { createApp } from './server.js';
import { buildMcpServer } from './mcp.js';

const secret = 'standup-test-hmac-not-a-deployment-credential';
const repository = { id: 100, name: 'continuum', full_name: 'org/continuum', html_url: 'https://sources.example/org/continuum' };
const branch = { ref: 'feature/standup', ref_type: 'branch', repository, sender: { id: 42, login: 'forged-display-label' } };

async function signed(app: ReturnType<typeof createApp>, plugin: 'github-pr' | 'github-branch', event: unknown, delivery: string) {
  const body = JSON.stringify(event);
  return request(app).post(`/api/v0/ingest/${plugin}`)
    .set('Content-Type', 'application/json').set('X-GitHub-Delivery', delivery)
    .set('X-GitHub-Event', plugin === 'github-pr' ? 'pull_request' : 'create')
    .set('X-Hub-Signature-256', 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')).send(body);
}

it('captures signed numeric GitHub activity through its bound pool and shares nonempty REST/MCP digest semantics', async () => {
  await standupProducerFixture(async (value) => {
    const actor = (await getPrincipal(value.owner, value.actorId))!;
    const producer = (await getPrincipal(value.owner, value.producerId))!;
    const app = createApp(value.app, { embeddingProvider: null, ingestProducerPools: { 'github-branch': value.producer },
      ingestConfig: { plugins: { 'github-branch': { enabled: true, principalExternalId: producer.externalId,
        auth: { kind: 'github-hmac', secret, event: 'create' } } } } });
    const rejected = await request(app).post('/api/v0/ingest/github-branch').send(branch);
    expect(rejected.status).toBe(401);
    const captured = await signed(app, 'github-branch', branch, 'standup-branch-one');
    expect(captured.status).toBe(202);
    const memory = (await value.owner.query('SELECT id,scope_id FROM memories WHERE source=$1::text', ['github-branch'])).rows[0];
    expect(memory.scope_id).toBe(value.scopeId);
    const response = await request(app).get('/api/v0/standup').query({ since: '24h' })
      .set('Authorization', `Bearer ${actor.externalId}`);
    expect(response.status).toBe(200);
    expect(response.body.activity).toHaveLength(1);
    expect(response.body.activity[0]).toMatchObject({ id: memory.id, actor: 'Actual Actor', source: 'github-branch' });
    expect(JSON.stringify(response.body)).not.toContain('forged-display-label');
    const server = buildMcpServer({ pool: value.app, principal: actor, embeddingProvider: null });
    const client = new Client({ name: 'standup-nonempty-parity', version: '0.0.1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: 'continuum.standup', arguments: { since: '24h' } });
      expect(result.isError).not.toBe(true);
      const text = result.content.map((item) => item.type === 'text' ? item.text : '').join('');
      expect(text).toContain(memory.id.replaceAll('-', '\\-'));
      expect(text).toContain('source: github');
      expect(text).not.toContain('forged-display-label');
    } finally { await client.close(); await server.close(); }
    expect((await value.owner.query(`SELECT metadata->>'transport' AS transport FROM audit_log WHERE principal_id=$1::uuid
      AND memory_id IS NULL AND metadata->>'view'='standup' ORDER BY id`, [actor.id])).rows)
      .toEqual([{ transport: 'rest' }, { transport: 'mcp' }]);
  });
}, 180_000);

it('keeps a branch closed after delayed ingestion, closing-memory archival and closing-scope membership loss', async () => {
  await standupProducerFixture(async (value) => {
    const actor = (await getPrincipal(value.owner, value.actorId))!;
    const producer = (await getPrincipal(value.owner, value.producerId))!;
    const project = await createScope(value.owner, { kind: 'project', name: 'continuum' });
    await addMembership(value.owner, value.actorId, project.id, 'writer');
    await addMembership(value.owner, value.producerId, project.id, 'writer');
    const mergedAt = (await value.owner.query('SELECT clock_timestamp() AS time')).rows[0].time.toISOString();
    const now = new Date(Date.now() + 3 * 86_400_000);
    const app = createApp(value.app, { embeddingProvider: null, clock: () => now.getTime(),
      ingestProducerPools: { 'github-pr': value.producer, 'github-branch': value.producer }, ingestConfig: { plugins: {
        'github-pr': { enabled: true, principalExternalId: producer.externalId, auth: { kind: 'github-hmac', secret, event: 'pull_request' } },
        'github-branch': { enabled: true, principalExternalId: producer.externalId, auth: { kind: 'github-hmac', secret, event: 'create' } },
      } } });
    const merged = { action: 'closed', repository, pull_request: { number: 14, title: 'Merged standup work',
      body: 'Source', html_url: 'https://sources.example/org/continuum/pull/14', state: 'closed', merged: true,
      merged_at: mergedAt, user: branch.sender, head: { ref: branch.ref, repo: { id: repository.id } }, base: { ref: 'main' } } };
    expect((await signed(app, 'github-pr', merged, 'standup-merged-first')).status).toBe(202);
    expect((await signed(app, 'github-branch', branch, 'standup-delayed-opener')).status).toBe(202);
    const read = () => request(app).get('/api/v0/standup').query({ since: '24h', openThreadDays: 1 })
      .set('Authorization', `Bearer ${actor.externalId}`);
    expect((await signed(app, 'github-branch', { ...branch, ref: 'feature/open-control' }, 'standup-open-control')).status).toBe(202);
    const before = await read();
    expect(before.status).toBe(200);
    expect(before.body.openThreads).toHaveLength(1);
    expect(before.body.openThreads[0].title).toContain('feature/open-control');
    const closing = (await value.owner.query("SELECT id FROM memories WHERE source='github-pr'")).rows[0].id;
    await value.app.query("UPDATE memories SET state='archived' WHERE id=$1::uuid", [closing]);
    await removeMembership(value.owner, value.actorId, project.id);
    const after = await read();
    expect(after.status).toBe(200);
    expect(after.body.openThreads).toHaveLength(1);
    expect(after.body.openThreads[0].title).toContain('feature/open-control');
    expect((await value.owner.query('SELECT count(*)::integer AS total FROM standup_thread_closures WHERE source_memory_id=$1::uuid', [closing])).rows)
      .toEqual([{ total: 2 }]);
  });
}, 180_000);


it.each(['deploy-event', 'terminal-summary'] as const)('attributes authenticated %s from configured stable actor identity rather than payload labels', async (plugin) => {
  await standupProducerFixture(async (value) => {
    const actor = (await getPrincipal(value.owner, value.actorId))!;
    const producer = (await getPrincipal(value.owner, value.producerId))!;
    if (plugin === 'deploy-event') {
      const project = await createScope(value.owner, { kind: 'project', name: 'deploy-project' });
      await addMembership(value.owner, value.producerId, project.id, 'writer');
      await addMembership(value.owner, value.actorId, project.id, 'reader');
    }
    const finishedAt = (await value.owner.query('SELECT clock_timestamp() AS time')).rows[0].time.toISOString();
    const payload = plugin === 'deploy-event' ? { project: 'deploy-project', environment: 'test', version: '1', status: 'success',
      actor: 'Forged payload actor', finishedAt }
      : { actor: 'Forged payload actor', sessionId: 'stable-session', summary: 'Completed source session', finishedAt };
    const app = createApp(value.app, { embeddingProvider: null, ingestProducerPools: { [plugin]: value.producer },
      ingestConfig: { plugins: { [plugin]: { enabled: true, principalExternalId: producer.externalId,
        auth: { kind: 'bearer' }, activityActorExternalId: '42' } } } });
    expect((await request(app).post(`/api/v0/ingest/${plugin}`).set('Idempotency-Key', 'standup-source').send(payload)).status).toBe(401);
    const response = await request(app).post(`/api/v0/ingest/${plugin}`).set('Idempotency-Key', 'standup-source')
      .set('Authorization', `Bearer ${producer.externalId}`).send(payload);
    expect(response.status).toBe(202);
    const digest = await request(app).get('/api/v0/standup').query({ since: '24h' })
      .set('Authorization', `Bearer ${actor.externalId}`);
    expect(digest.status).toBe(200);
    expect(digest.body.activity).toHaveLength(1);
    expect(digest.body.activity[0]).toMatchObject({ actor: 'Actual Actor', source: plugin });
    expect(JSON.stringify(digest.body)).not.toContain('Forged payload actor');
    expect((await value.owner.query('SELECT count(*)::integer AS total FROM standup_thread_closures')).rows).toEqual([{ total: 1 }]);
  }, plugin);
}, 180_000);


it('preserves nondecaying terminal decisions as recent activity without inventing open threads or a finite TTL', async () => {
  await standupProducerFixture(async (value) => {
    const actor = (await getPrincipal(value.owner, value.actorId))!;
    const producer = (await getPrincipal(value.owner, value.producerId))!;
    const finishedAt = (await value.owner.query('SELECT pg_catalog.clock_timestamp() AS time')).rows[0].time.toISOString();
    const app = createApp(value.app, { embeddingProvider: null, ingestProducerPools: { 'terminal-summary': value.producer },
      ingestConfig: { plugins: { 'terminal-summary': { enabled: true, principalExternalId: producer.externalId,
        auth: { kind:'bearer' }, activityActorExternalId:'42' } } } });
    const captured = await request(app).post('/api/v0/ingest/terminal-summary').set('Idempotency-Key','terminal-decision')
      .set('Authorization',`Bearer ${producer.externalId}`).send({ actor:'Untrusted payload label', sessionId:'decision-session',
        summary:'Finished work', decisions:['Keep the reviewed interface'], finishedAt });
    expect(captured.status).toBe(202);
    const rows = (await value.app.query(`SELECT memory.type,memory.expires_at,attribution.trust_expires_at
      FROM memories memory JOIN memory_activity_attributions attribution ON attribution.memory_id=memory.id
      WHERE memory.source='terminal-summary' ORDER BY memory.type`)).rows;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.type==='decision')).toMatchObject({ expires_at:null, trust_expires_at:null });
    expect(rows.find((row) => row.type==='context').expires_at).toEqual(expect.any(Date));
    const digest = await request(app).get('/api/v0/standup').query({ since:'24h' })
      .set('Authorization',`Bearer ${actor.externalId}`);
    expect(digest.status).toBe(200);
    expect(digest.body.activity).toHaveLength(2);
    expect(digest.body.activity.map((item: { type:string }) => item.type).sort()).toEqual(['context','decision']);
    expect(digest.body.openThreads).toHaveLength(0);
    expect(JSON.stringify(digest.body)).not.toContain('Untrusted payload label');
  }, 'terminal-summary');
}, 180_000);
