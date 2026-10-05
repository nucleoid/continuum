import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { createApp } from '../server.js';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope, getScopeByRef } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';
import { mapActorIdentity } from '../../storage/actor-identities.js';
import { EmbeddingRegistry, ScopeEmbeddingRouter } from '../../embeddings/router.js';

const requestId = 'ingest-request-id';
const githubSecret = 'github-test-secret';

describe('webhook ingestion transport', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => { await pool?.end(); });

  async function seedService(externalId = 'service:github-pr') {
    const principal = await createPrincipal(pool, { externalId, kind: 'service', displayName: externalId });
    const project = await createScope(pool, { kind: 'project', name: 'booking-engine' });
    await addMembership(pool, principal.id, project.id, 'writer');
    return { principal, project };
  }

  function app(config: Record<string, unknown>) {
    return createApp(pool, {
      requestIdFactory: () => requestId,
      logger: { info() {}, error() {} },
      ingestConfig: config,
    });
  }

  function githubConfig(principalExternalId = 'service:github-pr') {
    return { plugins: { 'github-pr': {
      enabled: true,
      auth: { kind: 'github-hmac', secret: githubSecret, event: 'pull_request' },
      principalExternalId,
    } } };
  }

  function mergedPr() {
    return {
      action: 'closed',
      pull_request: {
        number: 42, title: 'Ship secure ingestion', body: 'Webhook capture is wired.',
        html_url: 'https://github.com/nucleoid/continuum/pull/42', state: 'closed', merged: true,
        merged_at: '2026-10-04T00:00:00Z', merged_by: { id: 1002, login: 'maintainer' },
        user: { id: 1001, login: 'author' }, base: { ref: 'master' }, head: { ref: 'feature/ingest' },
      },
      repository: { id: 13579, full_name: 'nucleoid/booking-engine', name: 'booking-engine' },
    };
  }

  function sign(body: string): string {
    return `sha256=${createHmac('sha256', githubSecret).update(body).digest('hex')}`;
  }

  it('verifies exact GitHub bytes, captures with the configured service principal, and replays durably', async () => {
    const { principal } = await seedService();
    const raw = JSON.stringify(mergedPr());
    const target = app(githubConfig());
    const headers = {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': sign(raw),
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': 'delivery-1',
    };

    const first = await request(target).post('/api/v0/ingest/github-pr').set(headers).send(raw);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ replayed: false, memoryIds: [expect.any(String)] });
    expect(first.headers['x-request-id']).toBe(requestId);

    const replay = await request(target).post('/api/v0/ingest/github-pr').set(headers).send(raw);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ replayed: true, memoryIds: first.body.memoryIds });

    const changedHeaderReplay = await request(target).post('/api/v0/ingest/github-pr')
      .set({ ...headers, 'X-GitHub-Delivery': 'delivery-2' }).send(raw);
    expect(changedHeaderReplay.status).toBe(200);
    expect(changedHeaderReplay.body).toEqual({ replayed: true, memoryIds: first.body.memoryIds });

    const { rows } = await pool.query(
      `SELECT m.author_id, m.source, a.metadata FROM memories m JOIN audit_log a ON a.memory_id = m.id`,
    );
    expect(rows).toEqual([expect.objectContaining({
      author_id: principal.id,
      source: 'github-pr',
      metadata: expect.objectContaining({ source: 'github-pr', transport: 'ingest' }),
    })]);
  });

  it('fails closed for missing, malformed, wrong GitHub signatures and event headers', async () => {
    await seedService();
    const raw = JSON.stringify(mergedPr());
    const target = app(githubConfig());
    const cases = [
      [{}, 401],
      [{ 'X-Hub-Signature-256': 'sha256=xyz', 'X-GitHub-Event': 'pull_request' }, 401],
      [{ 'X-Hub-Signature-256': sign(`${raw} `), 'X-GitHub-Event': 'pull_request' }, 401],
      [{ 'X-Hub-Signature-256': sign(raw), 'X-GitHub-Event': 'push' }, 400],
    ] as const;
    for (const [extraHeaders, status] of cases) {
      const response = await request(target)
        .post('/api/v0/ingest/github-pr')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Delivery', 'delivery-invalid')
        .set(extraHeaders)
        .send(raw);
      expect(response.status).toBe(status);
      expect(response.body.requestId).toBe(requestId);
    }
    expect((await pool.query('SELECT id FROM memories')).rows).toEqual([]);
  });

  it('returns 204 for a valid ignored event and records the delivery once', async () => {
    await seedService();
    const payload = mergedPr();
    payload.pull_request.merged = false;
    const raw = JSON.stringify(payload);
    const response = await request(app(githubConfig()))
      .post('/api/v0/ingest/github-pr')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(raw))
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', 'delivery-ignored')
      .send(raw);
    expect(response.status).toBe(204);
    expect((await pool.query('SELECT memory_ids FROM ingest_deliveries')).rows)
      .toEqual([{ memory_ids: [] }]);
  });

  it('unwraps ADO service-hook envelopes authenticated with configured Basic credentials', async () => {
    const { principal } = await seedService('service:ado');
    const target = app({ plugins: { 'ado-workitem': {
      enabled: true,
      auth: { kind: 'ado-basic', username: 'hook-user', password: 'hook-password' },
      principalExternalId: principal.externalId,
    } } });
    const response = await request(target)
      .post('/api/v0/ingest/ado-workitem')
      .auth('hook-user', 'hook-password')
      .send({
        id: 'ado-event-1', eventType: 'workitem.updated',
        resource: { id: 7, fields: {
          'System.Title': 'Wire the webhook', 'System.State': 'Closed',
          'System.WorkItemType': 'Task', 'System.AreaPath': 'booking-engine\\platform',
        } },
      });
    expect(response.status).toBe(202);
    expect(response.body.memoryIds).toHaveLength(1);
  });

  it('bounds production actor identities and requires boolean terminal closure policy', async () => {
    const { principal } = await seedService('service:schema-bounds');
    const target = app({ plugins: {
      'deploy-event': {
        enabled: true, auth: { kind: 'bearer' }, principalExternalId: principal.externalId,
      },
      'terminal-summary': {
        enabled: true, auth: { kind: 'bearer' }, principalExternalId: principal.externalId,
      },
    } });
    await request(target).post('/api/v0/ingest/deploy-event')
      .set('Authorization', `Bearer ${principal.externalId}`)
      .set('Idempotency-Key', 'deploy-oversized-actor')
      .send({
        project: 'booking-engine', environment: 'prod', version: 'v1', status: 'success',
        actorExternalId: 'x'.repeat(501),
      }).expect(400);
    await request(target).post('/api/v0/ingest/terminal-summary')
      .set('Authorization', `Bearer ${principal.externalId}`)
      .set('Idempotency-Key', 'terminal-invalid-policy')
      .send({
        actor: 'actor', actorExternalId: 'subject', sessionId: 'session', summary: 'summary',
        keepThreadOpen: 'yes',
      }).expect(400);
    expect((await pool.query('SELECT id FROM memories')).rows).toEqual([]);
  });

  it('requires the configured bearer service principal and explicit writer membership', async () => {
    const allowed = await seedService('service:deploy');
    const other = await createPrincipal(pool, {
      externalId: 'service:other', kind: 'service', displayName: 'Other',
    });
    const target = app({ plugins: { 'deploy-event': {
      enabled: true, auth: { kind: 'bearer' }, principalExternalId: allowed.principal.externalId,
    } } });
    const payload = { project: 'booking-engine', environment: 'prod', version: 'v1', status: 'success' };
    const wrongPrincipal = await request(target)
      .post('/api/v0/ingest/deploy-event')
      .set('Authorization', `Bearer ${other.externalId}`)
      .set('Idempotency-Key', 'deploy-1').send(payload);
    expect(wrongPrincipal.status).toBe(403);

    await pool.query('DELETE FROM scope_memberships WHERE principal_id = $1', [allowed.principal.id]);
    const noWriter = await request(target)
      .post('/api/v0/ingest/deploy-event')
      .set('Authorization', `Bearer ${allowed.principal.externalId}`)
      .set('Idempotency-Key', 'deploy-2').send(payload);
    expect(noWriter.status).toBe(403);
    expect((await pool.query('SELECT id FROM memories')).rows).toEqual([]);
  });

  it('resolves aliases and captures multi-record terminal events atomically', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'service:terminal', kind: 'service', displayName: 'Terminal hook',
    });
    const user = await createPrincipal(pool, {
      externalId: 'entra:user:cass', kind: 'user', displayName: 'Cass',
    });
    const userScope = await createScope(pool, { kind: 'user', name: user.externalId });
    await addMembership(pool, principal.id, userScope.id, 'writer');
    await pool.query(
      `INSERT INTO principal_aliases (provider, alias_kind, external_actor, principal_id)
       VALUES ('terminal', 'subject', 'cass-exampleorg', $1)`,
      [user.id],
    );
    const target = app({ plugins: { 'terminal-summary': {
      enabled: true, auth: { kind: 'bearer' }, principalExternalId: principal.externalId,
    } } });
    const response = await request(target)
      .post('/api/v0/ingest/terminal-summary')
      .set('Authorization', `Bearer ${principal.externalId}`)
      .set('Idempotency-Key', 'terminal-1')
      .send({ actor: 'cass-exampleorg', sessionId: 'session-123', summary: 'Implemented the endpoint.',
        decisions: ['Require explicit aliases.', 'Fail closed.'] });
    expect(response.status).toBe(202);
    expect(response.body.memoryIds).toHaveLength(3);
    expect((await pool.query('SELECT id FROM memories')).rows).toHaveLength(3);
    expect((await pool.query('SELECT id FROM audit_log')).rows).toHaveLength(3);
  });

  it('persists mapped terminal and deploy webhooks through the standup digest', async () => {
    const terminalService = await createPrincipal(pool, {
      externalId: 'service:e2e-terminal', kind: 'service', displayName: 'Terminal hook',
    });
    const deployService = await createPrincipal(pool, {
      externalId: 'service:e2e-deploy', kind: 'service', displayName: 'Deploy hook',
    });
    const actor = await createPrincipal(pool, {
      externalId: 'entra:e2e-actor', kind: 'user', displayName: 'Actual Actor',
    });
    const admin = await createPrincipal(pool, {
      externalId: 'entra:e2e-admin', kind: 'user', displayName: 'Identity Admin',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const userScope = await createScope(pool, { kind: 'user', name: actor.externalId }, actor.id);
    const project = await createScope(pool, { kind: 'project', name: 'booking-engine' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    await addMembership(pool, actor.id, userScope.id, 'reader');
    await addMembership(pool, actor.id, project.id, 'reader');
    await addMembership(pool, terminalService.id, userScope.id, 'writer');
    await addMembership(pool, deployService.id, project.id, 'writer');
    await pool.query(
      `INSERT INTO principal_aliases (provider, alias_kind, external_actor, principal_id)
       VALUES ('terminal', 'subject', 'terminal-subject-77', $1)`,
      [actor.id],
    );
    await mapActorIdentity(pool, {
      authority: 'terminal-summary', externalActorId: 'terminal-subject-77',
      principalId: actor.id, mappedByPrincipalId: admin.id,
    });
    await mapActorIdentity(pool, {
      authority: 'deploy-event', externalActorId: 'deploy-subject-77',
      principalId: actor.id, mappedByPrincipalId: admin.id,
    });
    const target = app({ plugins: {
      'terminal-summary': {
        enabled: true, auth: { kind: 'bearer' },
        principalExternalId: terminalService.externalId,
        actorExternalId: 'terminal-subject-77',
      },
      'deploy-event': {
        enabled: true, auth: { kind: 'bearer' },
        principalExternalId: deployService.externalId,
        actorExternalId: 'deploy-subject-77',
      },
    } });

    await request(target).post('/api/v0/ingest/terminal-summary')
      .set('Authorization', `Bearer ${terminalService.externalId}`)
      .set('Idempotency-Key', 'terminal-e2e-1')
      .send({
        actor: 'caller-controlled-label', actorExternalId: 'terminal-subject-77',
        sessionId: 'session-e2e-1', summary: 'Implemented standup ingestion.',
        keepThreadOpen: true,
      }).expect(202);
    await request(target).post('/api/v0/ingest/deploy-event')
      .set('Authorization', `Bearer ${deployService.externalId}`)
      .set('Idempotency-Key', 'deploy-e2e-1')
      .send({
        project: 'booking-engine', environment: 'prod', version: 'v68', status: 'success',
        actor: 'caller-controlled-label', actorExternalId: 'deploy-subject-77',
      }).expect(202);

    const digest = await request(target).get('/api/v0/standup?since=24h')
      .set('Authorization', `Bearer ${actor.externalId}`);
    expect(digest.status).toBe(200);
    expect(digest.body.activity.map((item: { title: string }) => item.title).sort()).toEqual([
      'Session session- summary',
      'v68 deployed on prod',
    ]);
    // Current-window activity is not backlog, and the deploy's self-closing fact
    // must never appear as a permanent open thread.
    expect(digest.body.openThreads).toEqual([]);
    const persistedTrust = await pool.query(
      `SELECT attribution.memory_id, attribution.activity_at
         FROM memory_activity_attributions attribution
         JOIN memories memory ON memory.id = attribution.memory_id
        WHERE memory.source IN ('terminal-summary', 'deploy-event')`,
    );
    expect(persistedTrust.rows).toHaveLength(2);
    const { rows } = await pool.query(
      `SELECT source, metadata->'closes_thread_keys' AS closes
         FROM memories ORDER BY source`,
    );
    expect(rows).toEqual([
      { source: 'deploy-event', closes: ['deploy-event:deploy:booking-engine:prod:v68'] },
      { source: 'terminal-summary', closes: [] },
    ]);
  });

  it('requires terminal actor aliases and service-principal ACLs for scope overrides', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'service:terminal-override', kind: 'service', displayName: 'Terminal hook',
    });
    const user = await createPrincipal(pool, {
      externalId: 'entra:user:cass', kind: 'user', displayName: 'Cass',
    });
    const allowed = await createScope(pool, { kind: 'team', name: 'payments' });
    await createScope(pool, { kind: 'team', name: 'security' });
    await addMembership(pool, principal.id, allowed.id, 'writer');
    const target = app({ plugins: { 'terminal-summary': {
      enabled: true, auth: { kind: 'bearer' }, principalExternalId: principal.externalId,
    } } });
    const send = (actor: string, scopeOverride: { kind: 'team'; name: string }, key: string) =>
      request(target).post('/api/v0/ingest/terminal-summary')
        .set('Authorization', `Bearer ${principal.externalId}`)
        .set('Idempotency-Key', key)
        .send({ actor, sessionId: key, summary: 'Scoped work.', scopeOverride });

    await send('unmapped-actor', { kind: 'team', name: 'payments' }, 'override-unmapped')
      .expect(400);
    await pool.query(
      `INSERT INTO principal_aliases (provider, alias_kind, external_actor, principal_id)
       VALUES ('terminal', 'subject', 'cass-exampleorg', $1)`,
      [user.id],
    );
    await send('cass-exampleorg', { kind: 'team', name: 'security' }, 'override-forbidden')
      .expect(403);
    await send('cass-exampleorg', { kind: 'team', name: 'payments' }, 'override-allowed')
      .expect(202);
    expect((await pool.query('SELECT id FROM memories')).rows).toHaveLength(1);
  });

  it('serializes concurrent redelivery to one memory set', async () => {
    await seedService();
    const raw = JSON.stringify(mergedPr());
    const target = app(githubConfig());
    const send = () => request(target).post('/api/v0/ingest/github-pr')
      .set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw))
      .set('X-GitHub-Event', 'pull_request').set('X-GitHub-Delivery', 'delivery-concurrent')
      .send(raw);
    const responses = await Promise.all([send(), send()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
    expect(responses[0].body.memoryIds).toEqual(responses[1].body.memoryIds);
    expect((await pool.query('SELECT id FROM memories')).rows).toHaveLength(1);
  });

  it('rejects a missing actor alias instead of creating a raw user scope', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'service:branch', kind: 'service', displayName: 'Branch hook',
    });
    const raw = JSON.stringify({
      ref: 'feature/secure', ref_type: 'branch', master_branch: 'master',
      repository: { id: 24680, full_name: 'nucleoid/continuum', name: 'continuum',
        html_url: 'https://github.com/nucleoid/continuum' },
      sender: { id: 40404, login: 'unmapped-user' },
    });
    const target = app({ plugins: { 'github-branch': {
      enabled: true, auth: { kind: 'github-hmac', secret: githubSecret, event: 'create' },
      principalExternalId: principal.externalId,
    } } });
    const response = await request(target).post('/api/v0/ingest/github-branch')
      .set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw))
      .set('X-GitHub-Event', 'create').set('X-GitHub-Delivery', 'branch-1').send(raw);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'INVALID_INPUT', requestId });
    expect((await pool.query('SELECT id FROM memories')).rows).toEqual([]);
  });

  it('rejects legacy GitHub login aliases and accepts explicit numeric-id aliases', async () => {
    const service = await createPrincipal(pool, {
      externalId: 'service:branch-rollout', kind: 'service', displayName: 'Branch hook',
    });
    const user = await createPrincipal(pool, {
      externalId: 'entra:branch-rollout', kind: 'user', displayName: 'Branch User',
    });
    const admin = await createPrincipal(pool, {
      externalId: 'entra:branch-admin', kind: 'user', displayName: 'Identity Admin',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const userScope = await createScope(pool, { kind: 'user', name: user.externalId }, user.id);
    await addMembership(pool, admin.id, org!.id, 'admin');
    await addMembership(pool, service.id, userScope.id, 'writer');
    await pool.query(
      `INSERT INTO principal_aliases (provider, alias_kind, external_actor, principal_id)
       VALUES ('github', 'login', 'legacy-login', $1)`,
      [user.id],
    );
    const target = app({ plugins: { 'github-branch': {
      enabled: true, auth: { kind: 'github-hmac', secret: githubSecret, event: 'create' },
      principalExternalId: service.externalId,
    } } });
    const send = async (ref: string) => {
      const raw = JSON.stringify({
        ref, ref_type: 'branch', master_branch: 'master',
        repository: { id: 24680, full_name: 'nucleoid/continuum', name: 'continuum',
          html_url: 'https://github.com/nucleoid/continuum' },
        sender: { id: 7654321, login: 'legacy-login' },
      });
      return request(target).post('/api/v0/ingest/github-branch')
        .set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw))
        .set('X-GitHub-Event', 'create').set('X-GitHub-Delivery', ref).send(raw);
    };

    await send('legacy-alias-capture').then((response) => expect(response.status).toBe(400));
    let rows = (await pool.query('SELECT metadata FROM memories')).rows;
    expect(rows).toEqual([]);
    await pool.query(
      `INSERT INTO principal_aliases (provider, alias_kind, external_actor, principal_id)
       VALUES ('github', 'id', '7654321', $1)`,
      [user.id],
    );
    await mapActorIdentity(pool, {
      authority: 'github', externalActorId: '7654321', principalId: user.id,
      mappedByPrincipalId: admin.id,
    });
    await send('numeric-alias-capture').then((response) => expect(response.status).toBe(202));
    rows = (await pool.query('SELECT metadata FROM memories ORDER BY created_at, id')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({
      actor: 'Branch User', actor_principal_id: user.id,
      thread_key: 'github:repo:24680:branch:numeric-alias-capture',
    });
  });

  it('attributes GitHub actors through the producer namespace and immutable numeric ID', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'service:branch-id', kind: 'service', displayName: 'Branch hook',
    });
    const user = await createPrincipal(pool, {
      externalId: 'entra:user:cass', kind: 'user', displayName: 'Cass',
    });
    const userScope = await createScope(pool, { kind: 'user', name: user.externalId });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, user.id, org!.id, 'admin');
    await addMembership(pool, principal.id, userScope.id, 'writer');
    await pool.query(
      `INSERT INTO principal_aliases (provider, alias_kind, external_actor, principal_id)
       VALUES ('github', 'id', '12345', $1)`,
      [user.id],
    );
    await mapActorIdentity(pool, {
      authority: 'github', externalActorId: '12345',
      principalId: user.id, mappedByPrincipalId: user.id,
    });
    const target = app({ plugins: { 'github-branch': {
      enabled: true, auth: { kind: 'github-hmac', secret: githubSecret, event: 'create' },
      principalExternalId: principal.externalId,
    } } });
    const send = async (login: string) => {
      const raw = JSON.stringify({
        ref: `feature/${login}`, ref_type: 'branch', master_branch: 'master',
        repository: { id: 24680, full_name: 'nucleoid/continuum', name: 'continuum',
          html_url: 'https://github.com/nucleoid/continuum' },
        sender: { id: 12345, login },
      });
      return request(target).post('/api/v0/ingest/github-branch')
        .set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw))
        .set('X-GitHub-Event', 'create').set('X-GitHub-Delivery', `branch-${login}`).send(raw);
    };

    await send('old-login').then((response) => expect(response.status).toBe(202));
    await send('renamed-login').then((response) => expect(response.status).toBe(202));
    const { rows } = await pool.query('SELECT metadata FROM memories ORDER BY created_at, id');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.metadata.actor)).toEqual(['Cass', 'Cass']);
    expect(rows.map((row) => row.metadata.actor_principal_id)).toEqual([user.id, user.id]);
    expect(rows.map((row) => row.metadata.thread_key).sort()).toEqual([
      'github:repo:24680:branch:feature/old-login',
      'github:repo:24680:branch:feature/renamed-login',
    ].sort());
  });

  it('keeps capture and audit when post-commit embedding fails', async () => {
    await seedService('service:deploy-embedding');
    const target = createApp(pool, {
      requestIdFactory: () => requestId,
      logger: { info() {}, error() {} },
      embeddingProvider: { id: 'test:failing', dim: 768,
        async embed() { throw new Error('private-provider-secret'); } },
      ingestConfig: { plugins: { 'deploy-event': {
        enabled: true, auth: { kind: 'bearer' }, principalExternalId: 'service:deploy-embedding',
      } } },
    });
    const response = await request(target).post('/api/v0/ingest/deploy-event')
      .set('Authorization', 'Bearer service:deploy-embedding')
      .set('Idempotency-Key', 'deploy-embedding-1')
      .send({ project: 'booking-engine', environment: 'prod', version: 'v2', status: 'success' });
    expect(response.status).toBe(202);
    const { rows } = await pool.query('SELECT metadata::text AS metadata FROM audit_log');
    expect(rows[0].metadata).toContain('EMBEDDING_FAILED');
    expect(rows[0].metadata).not.toContain('private-provider-secret');
    expect((await pool.query('SELECT id FROM memories')).rows).toHaveLength(1);
  });

  it('stores post-commit embeddings and appends derived provenance without mutating capture audit', async () => {
    await seedService('service:deploy-vector');
    const target = createApp(pool, {
      requestIdFactory: () => requestId,
      logger: { info() {}, error() {} },
      embeddingProvider: { id: 'test:vector', dim: 768,
        async embed() { return [Array.from({ length: 768 }, () => 0.01)]; } },
      ingestConfig: { plugins: { 'deploy-event': {
        enabled: true, auth: { kind: 'bearer' }, principalExternalId: 'service:deploy-vector',
      } } },
    });
    const response = await request(target).post('/api/v0/ingest/deploy-event')
      .set('Authorization', 'Bearer service:deploy-vector')
      .set('Idempotency-Key', 'deploy-vector-1')
      .send({ project: 'booking-engine', environment: 'prod', version: 'v3', status: 'success' });
    expect(response.status).toBe(202);
    expect((await pool.query('SELECT memory_id FROM memory_embeddings')).rows).toHaveLength(1);
    expect((await pool.query('SELECT metadata FROM audit_log ORDER BY id')).rows).toEqual([
      { metadata: expect.objectContaining({
        embedded: false, embedding_error_code: 'EMBEDDING_FAILED', transport: 'ingest',
      }) },
      { metadata: expect.objectContaining({
        record_kind: 'embedding', embedded: true,
        embedding: { provider: 'test:vector', dim: 768, status: 'succeeded' },
      }) },
    ]);
  });

  it('routes webhook embeddings by target scope and preserves provider provenance', async () => {
    await seedService('service:deploy-routed');
    const defaultEmbed = vi.fn(async () => [Array.from({ length: 768 }, () => 0.02)]);
    const projectEmbed = vi.fn(async () => [Array.from({ length: 768 }, () => 0.01)]);
    const registry = new EmbeddingRegistry([
      ['default', { id: 'test:default', dim: 768, embed: defaultEmbed }],
      ['private', { id: 'test:private', dim: 768, embed: projectEmbed }],
    ]);
    const routing = new ScopeEmbeddingRouter(registry, {
      default: 'default',
      rules: [{ match: { kind: 'project', name: 'booking-engine' }, provider: 'private' }],
    });
    const target = createApp(pool, {
      embeddingProvider: routing,
      ingestConfig: { plugins: { 'deploy-event': {
        enabled: true, auth: { kind: 'bearer' }, principalExternalId: 'service:deploy-routed',
      } } },
    });

    await request(target).post('/api/v0/ingest/deploy-event')
      .set('Authorization', 'Bearer service:deploy-routed')
      .set('Idempotency-Key', 'deploy-routed-1')
      .send({ project: 'booking-engine', environment: 'prod', version: 'v4', status: 'success' })
      .expect(202);

    expect(projectEmbed).toHaveBeenCalledOnce();
    expect(defaultEmbed).not.toHaveBeenCalled();
    const { rows } = await pool.query(
      `SELECT metadata FROM audit_log WHERE metadata->>'record_kind' = 'embedding'`,
    );
    expect(rows[0].metadata).toMatchObject({
      embedded: true,
      embedding: { provider: 'test:private', dim: 768, status: 'succeeded' },
    });
  });

  it('normalizes provider timestamps to UTC and rejects malformed timestamps', async () => {
    await seedService('service:deploy-time');
    const target = app({ plugins: { 'deploy-event': {
      enabled: true, auth: { kind: 'bearer' }, principalExternalId: 'service:deploy-time',
    } } });
    const authorized = (key: string) => request(target).post('/api/v0/ingest/deploy-event')
      .set('Authorization', 'Bearer service:deploy-time')
      .set('Idempotency-Key', key);

    await authorized('deploy-time-valid').send({
      project: 'booking-engine', environment: 'prod', version: 'v5', status: 'success',
      startedAt: '2026-10-05T15:00:00+13:00', finishedAt: '2026-10-05T15:05:00+13:00',
    }).expect(202);
    const stored = await pool.query('SELECT metadata FROM memories');
    expect(stored.rows[0].metadata).toMatchObject({
      startedAt: '2026-10-05T02:00:00.000Z',
      finishedAt: '2026-10-05T02:05:00.000Z',
    });

    const invalid = await authorized('deploy-time-invalid').send({
      project: 'booking-engine', environment: 'prod', version: 'v6', status: 'success',
      startedAt: 'not-a-timestamp',
    });
    expect(invalid.status).toBe(400);
    expect((await pool.query('SELECT id FROM memories')).rows).toHaveLength(1);
  });

  it('allows a failed delivery to retry without poisoning idempotency or duplicating side effects', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'service:deploy-retry', kind: 'service', displayName: 'Retry hook',
    });
    const project = await createScope(pool, { kind: 'project', name: 'booking-engine' });
    const target = app({ plugins: { 'deploy-event': {
      enabled: true, auth: { kind: 'bearer' }, principalExternalId: principal.externalId,
    } } });
    const send = () => request(target).post('/api/v0/ingest/deploy-event')
      .set('Authorization', `Bearer ${principal.externalId}`)
      .set('Idempotency-Key', 'deploy-retry-1')
      .send({ project: 'booking-engine', environment: 'prod', version: 'v7', status: 'success' });

    await send().expect(403);
    expect((await pool.query('SELECT plugin_id FROM ingest_deliveries')).rows).toEqual([]);
    await addMembership(pool, principal.id, project.id, 'writer');
    const success = await send().expect(202);
    const replay = await send().expect(200);
    expect(replay.body.memoryIds).toEqual(success.body.memoryIds);
    expect((await pool.query('SELECT id FROM memories')).rows).toHaveLength(1);
    expect((await pool.query('SELECT id FROM audit_log')).rows).toHaveLength(1);
  });

  it('fails closed when an idempotency key is reused for a different payload', async () => {
    await seedService('service:deploy-conflict');
    const target = app({ plugins: { 'deploy-event': {
      enabled: true, auth: { kind: 'bearer' }, principalExternalId: 'service:deploy-conflict',
    } } });
    const send = (version: string) => request(target).post('/api/v0/ingest/deploy-event')
      .set('Authorization', 'Bearer service:deploy-conflict')
      .set('Idempotency-Key', 'deploy-conflict-1')
      .send({ project: 'booking-engine', environment: 'prod', version, status: 'success' });

    await send('v1').expect(202);
    const conflict = await send('v2').expect(409);
    expect(conflict.body).toMatchObject({
      code: 'CONFLICT',
      error: 'Idempotency key was reused with a different payload',
      requestId,
    });
    expect((await pool.query('SELECT title FROM memories')).rows)
      .toEqual([{ title: 'v1 deployed on prod' }]);
  });

  it('enforces the shared 1 MiB JSON limit before authentication', async () => {
    const response = await request(app(githubConfig())).post('/api/v0/ingest/github-pr')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ body: 'x'.repeat(1024 * 1024 + 1) }));
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', requestId });
  });

  it('rejects disabled and unknown plugins before authentication or database mutation', async () => {
    const target = app({ plugins: {} });
    for (const id of ['github-pr', 'not-a-plugin']) {
      const response = await request(target).post(`/api/v0/ingest/${id}`).send({});
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'NOT_FOUND', requestId });
    }
  });
});
