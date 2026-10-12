import { createHmac } from 'node:crypto';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { standupProducerFixture as fixture } from '../standup/test-helpers.js';
import { getPrincipal } from '../storage/principals.js';
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

it('attributes signed PR source timestamps after same-principal revocation and remapping without admitting stale or missing-time openers', async () => {
  await fixture(async (value) => {
    const producer = (await getPrincipal(value.owner, value.producerId))!;
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
    const opened = await signed(app, pr('opened', 1, fresh, oldTime), 'review-opened');
    const updated = await signed(app, pr('edited', 2, oldTime, fresh), 'review-updated');
    const stale = await signed(app, pr('opened', 3, oldTime, fresh), 'review-stale');
    const missing = await signed(app, { ref: 'missing-time-after-remap', ref_type: 'branch', repository, sender: user },
      'review-missing-time', 'github-branch');
    expect([opened.status, updated.status, stale.status, missing.status]).toEqual([202, 202, 202, 202]);
    const rows = (await value.owner.query('SELECT memory_id,activity_at FROM memory_activity_attributions ORDER BY memory_id')).rows;
    expect(rows.map((row) => row.memory_id).sort()).toEqual([...opened.body.memoryIds, ...updated.body.memoryIds].sort());
    expect(rows.every((row) => row.activity_at.toISOString() === fresh)).toBe(true);
    expect((await value.owner.query('SELECT generation_count::integer AS n FROM standup_identity_generation_counts')).rows).toEqual([{ n: 2 }]);
  });
}, 180_000);

it('captures and attributes a signed 500-character GitHub branch through the bound producer', async () => {
  await fixture(async (value) => {
    const producer = (await getPrincipal(value.owner, value.producerId))!;
    const app = createApp(value.app, { embeddingProvider: null, ingestProducerPools: { 'github-branch': value.producer },
      ingestConfig: { plugins: { 'github-branch': { enabled: true, principalExternalId: producer.externalId,
        auth: { kind: 'github-hmac', secret, event: 'create' } } } } });
    const captured = await signed(app, { ref: 'b'.repeat(500), ref_type: 'branch', repository, sender: user }, 'review-long-branch', 'github-branch');
    expect(captured.status).toBe(202);
    expect((await value.owner.query('SELECT memory_id FROM memory_activity_attributions')).rows)
      .toEqual([{ memory_id: captured.body.memoryIds[0] }]);
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
