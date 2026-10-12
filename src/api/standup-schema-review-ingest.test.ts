import { createHmac } from 'node:crypto';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { standupProducerFixture as fixture } from '../standup/test-helpers.js';
import { getPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createApp } from './server.js';

const secret = 'review-regression-hmac-not-a-deployment-credential';
const repository = { id: 100, name: 'continuum', full_name: 'org/continuum', html_url: 'https://sources.example/org/continuum' };
const user = { id: 42, login: 'untrusted-actor-label' };
async function signed(app: ReturnType<typeof createApp>, event: unknown, delivery: string, plugin = 'github-pr') {
  const body = JSON.stringify(event);
  return request(app).post(`/api/v0/ingest/${plugin}`).set('Content-Type', 'application/json')
    .set('X-GitHub-Delivery', delivery).set('X-GitHub-Event', plugin === 'github-pr' ? 'pull_request' : 'create')
    .set('X-Hub-Signature-256', 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')).send(body);
}
const pr = (action: string, number: number, createdAt: string, updatedAt: string) => ({ action, repository,
  pull_request: { number, title: 'Source pull request', body: 'Source', html_url: `https://sources.example/org/continuum/pull/${number}`,
    state: 'open', merged: false, user, created_at: createdAt, updated_at: updatedAt,
    head: { ref: `feature/review-${number}`, repo: { id: 100 } }, base: { ref: 'main' } } });

it('attributes supported signed merged PRs after same-principal remapping while rejecting stale and missing source times', async () => {
  await fixture(async (value) => {
    const producer = (await getPrincipal(value.owner, value.producerId))!;
    const project = await createScope(value.owner, { kind: 'project', name: 'continuum' });
    await addMembership(value.owner, value.producerId, project.id, 'writer');
    await addMembership(value.owner, value.actorId, project.id, 'reader');
    const app = createApp(value.app, { embeddingProvider: null, ingestProducerPools: { 'github-pr': value.producer, 'github-branch': value.producer },
      ingestConfig: { plugins: {
        'github-pr': { enabled: true, principalExternalId: producer.externalId, auth: { kind: 'github-hmac', secret, event: 'pull_request' } },
        'github-branch': { enabled: true, principalExternalId: producer.externalId, auth: { kind: 'github-hmac', secret, event: 'create' } },
      } } });
    const oldTime = (await value.owner.query('SELECT clock_timestamp() AS time')).rows[0].time.toISOString();
    await value.operator.query('SELECT continuum_operator_map_standup_actor($1::uuid,$2::text,$3::text,NULL::uuid,$4::text)',
      [value.adminId, value.namespace, '42', 'Reviewed temporary revocation']);
    await value.operator.query('SELECT continuum_operator_map_standup_actor($1::uuid,$2::text,$3::text,$4::uuid,$5::text)',
      [value.adminId, value.namespace, '42', value.actorId, 'Reviewed restored identity']);
    const fresh = (await value.owner.query('SELECT clock_timestamp() AS time')).rows[0].time.toISOString();
    const merged = (number: number, time?: string) => {
      const event = pr('closed', number, oldTime, fresh);
      return { ...event, pull_request: { ...event.pull_request, state: 'closed', merged: true,
        ...(time ? { merged_at: time } : {}) } };
    };
    const current = await signed(app, merged(1, fresh), 'review-current-merge');
    const stale = await signed(app, merged(2, oldTime), 'review-stale-merge');
    const untimed = await signed(app, merged(3), 'review-untimed-merge');
    const missing = await signed(app, { ref: 'missing-time-after-remap', ref_type: 'branch', repository, sender: user },
      'review-missing-time', 'github-branch');
    expect([current.status, stale.status, untimed.status, missing.status]).toEqual([202, 202, 202, 202]);
    expect(current.body.memoryIds).toHaveLength(1);
    expect(stale.body.memoryIds).toHaveLength(1);
    expect(untimed.body.memoryIds).toHaveLength(1);
    expect(missing.body.memoryIds).toHaveLength(1);
    expect((await signed(app, pr('opened', 4, fresh, fresh), 'review-ignored-opened')).status).toBe(204);
    expect((await signed(app, pr('edited', 5, fresh, fresh), 'review-ignored-edited')).status).toBe(204);
    const rows = (await value.owner.query('SELECT memory_id,activity_at FROM memory_activity_attributions ORDER BY memory_id')).rows;
    expect(rows.map((row) => row.memory_id)).toEqual(current.body.memoryIds);
    expect(rows.every((row) => row.activity_at.toISOString() === fresh)).toBe(true);
    expect((await value.owner.query('SELECT generation_count::integer AS n FROM standup_identity_generation_counts')).rows).toEqual([{ n: 2 }]);
  });
}, 180_000);

it.each([250, 500])('captures and attributes a signed %i-character GitHub branch through the bound producer', async (length) => {
  await fixture(async (value) => {
    const producer = (await getPrincipal(value.owner, value.producerId))!;
    const app = createApp(value.app, { embeddingProvider: null, ingestProducerPools: { 'github-branch': value.producer },
      ingestConfig: { plugins: { 'github-branch': { enabled: true, principalExternalId: producer.externalId,
        auth: { kind: 'github-hmac', secret, event: 'create' } } } } });
    const ref = 'b'.repeat(length);
    const captured = await signed(app, { ref, ref_type: 'branch', repository, sender: user }, 'review-long-branch', 'github-branch');
    expect(captured.status).toBe(202);
    expect((await value.owner.query('SELECT memory_id FROM memory_activity_attributions')).rows)
      .toEqual([{ memory_id: captured.body.memoryIds[0] }]);
    const memory = (await value.owner.query('SELECT title,source_ref,metadata FROM memories WHERE id=$1', [captured.body.memoryIds[0]])).rows[0];
    expect(memory.title.length).toBeLessThanOrEqual(500);
    expect(memory.source_ref).toBe(repository.html_url + '/tree/' + ref);
    expect(memory.metadata.ref).toBe(ref);
  });
}, 180_000);

it('captures and attributes a valid 500-character terminal session through the bound producer', async () => {
  await fixture(async (value) => {
    const producer = (await getPrincipal(value.owner, value.producerId))!;
    const app = createApp(value.app, { embeddingProvider: null, ingestProducerPools: { 'terminal-summary': value.producer },
      ingestConfig: { plugins: { 'terminal-summary': { enabled: true, principalExternalId: producer.externalId,
        auth: { kind: 'bearer' }, activityActorExternalId: '42' } } } });
    const captured = await request(app).post('/api/v0/ingest/terminal-summary').set('Idempotency-Key', 'review-long-session')
      .set('Authorization', `Bearer ${producer.externalId}`).send({ actor: 'Untrusted actor', sessionId: 's'.repeat(500), summary: 'Valid source' });
    expect(captured.status).toBe(202);
    expect((await value.owner.query('SELECT memory_id FROM memory_activity_attributions')).rows)
      .toEqual([{ memory_id: captured.body.memoryIds[0] }]);
  }, 'terminal-summary');
}, 180_000);

it('logs only a skipped attribution count after successful capture and emits no replay duplicate', async () => {
  await fixture(async (value) => {
    const producer = (await getPrincipal(value.owner, value.producerId))!;
    const warn = vi.fn();
    const app = createApp(value.app, { embeddingProvider: null, logger: { error: vi.fn(), warn },
      ingestProducerPools: { 'github-branch': value.producer }, ingestConfig: { plugins: { 'github-branch': {
        enabled: true, principalExternalId: producer.externalId, auth: { kind: 'github-hmac', secret, event: 'create' },
      } } } });
    await value.operator.query('SELECT continuum_operator_map_standup_actor($1::uuid,$2::text,$3::text,$4::uuid,$5::text)',
      [value.adminId, value.namespace, '42', value.actorId, 'Replacement generation']);
    const event = { ref: 'secret-looking-branch-label', ref_type: 'branch', repository, sender: user };
    expect((await signed(app, event, 'review-skip-log', 'github-branch')).status).toBe(202);
    expect(warn.mock.calls).toEqual([[{ event: 'standup_attribution_skipped', count: 1 }]]);
    expect((await signed(app, event, 'review-skip-log', 'github-branch')).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
  });
}, 180_000);
