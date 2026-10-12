import { createHmac } from 'node:crypto';
import request from 'supertest';
import { expect, it } from 'vitest';
import { standupProducerFixture } from '../standup/test-helpers.js';
import { getPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createApp } from './server.js';

const secret = 'standup-fork-fixture-hmac';
const repository = { id: 100, name: 'continuum', full_name: 'base/continuum', html_url: 'https://sources.example/base/continuum' };
for (const headRepository of [200, null]) {
  it(`does not close a base branch from a merged PR with ${headRepository === null ? 'unknown' : 'fork'} head repository`, async () => {
    await standupProducerFixture(async (value) => {
      const actor = (await getPrincipal(value.owner, value.actorId))!;
      const producer = (await getPrincipal(value.owner, value.producerId))!;
      const project = await createScope(value.owner, { kind: 'project', name: 'continuum' });
      await addMembership(value.owner, value.actorId, project.id, 'reader');
      await addMembership(value.owner, value.producerId, project.id, 'writer');
      const app = createApp(value.app, { embeddingProvider: null, clock: () => Date.now() + 3 * 86_400_000,
        ingestProducerPools: { 'github-pr': value.producer, 'github-branch': value.producer }, ingestConfig: { plugins: {
          'github-pr': { enabled: true, principalExternalId: producer.externalId, auth: { kind: 'github-hmac', secret, event: 'pull_request' } },
          'github-branch': { enabled: true, principalExternalId: producer.externalId, auth: { kind: 'github-hmac', secret, event: 'create' } },
        } } });
      async function signed(plugin: 'github-pr' | 'github-branch', payload: unknown, delivery: string) {
        const body = JSON.stringify(payload);
        return request(app).post(`/api/v0/ingest/${plugin}`).set('Content-Type','application/json')
          .set('X-GitHub-Delivery',delivery).set('X-GitHub-Event',plugin === 'github-pr' ? 'pull_request' : 'create')
          .set('X-Hub-Signature-256','sha256=' + createHmac('sha256',secret).update(body).digest('hex')).send(body);
      }
      const sender = { id: 42, login: 'display-name' };
      expect((await signed('github-branch', { repository, sender, ref: 'same-name', ref_type: 'branch' }, 'base-opener')).status).toBe(202);
      const read = () => request(app).get('/api/v0/standup').query({ since:'24h', openThreadDays:1 })
        .set('Authorization',`Bearer ${actor.externalId}`);
      expect((await read()).body.openThreads).toHaveLength(1);
      const time = (await value.owner.query('SELECT pg_catalog.clock_timestamp() AS time')).rows[0].time.toISOString();
      expect((await signed('github-pr', { action:'closed', repository, pull_request: { number:14,
        title:'Merged fork work', body:'Source', html_url:'https://sources.example/base/continuum/pull/14',
        state:'closed', merged:true, merged_at:time, user:sender,
        head:{ ref:'same-name', ...(headRepository === null ? {} : { repo:{ ...repository,id:headRepository,full_name:'fork/continuum' } }) },
        base:{ ref:'main' } } }, 'merged-other-head')).status).toBe(202);
      const after = await read();
      expect(after.status).toBe(200);
      expect(after.body.openThreads).toHaveLength(1);
      expect(after.body.openThreads[0].title).toContain('same-name');
    });
  }, 180_000);
}
