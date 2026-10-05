import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { mapActorIdentity } from '../storage/actor-identities.js';
import { capturePluginEvent } from './plugin-capture.js';
import { standupForPrincipal } from './standup.js';
import type { GitHubPrEvent } from '../capture/plugins/github-pr.js';
import { CaptureRegistry } from '../capture/plugin.js';

describe('plugin capture to standup attribution', () => {
  let pool: pg.Pool;
  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });
  afterAll(async () => pool?.end());

  function mergedPr(number: number, id: number, login: string): GitHubPrEvent {
    return {
      action: 'closed',
      pull_request: {
        number, title: `Ship ${number}`, html_url: `https://github.test/org/continuum/pull/${number}`,
        state: 'closed', merged: true, user: { id, login }, base: { ref: 'master' },
        head: { ref: `feature/${number}` }, merged_by: { login: 'release-bot' },
      },
      repository: { full_name: 'org/continuum', name: 'continuum' },
    };
  }

  it('maps a GitHub author by trusted external identity and ships actual-actor activity', async () => {
    const service = await createPrincipal(pool, {
      externalId: 'svc:github-webhook', kind: 'service', displayName: 'GitHub webhook',
    });
    const actor = await createPrincipal(pool, {
      externalId: 'entra:opaque-user-id', kind: 'user', displayName: 'Renamable Display Name',
    });
    const project = await createScope(pool, { kind: 'project', name: 'continuum' });
    const mapper = await createPrincipal(pool, {
      externalId: 'entra:identity-admin', kind: 'user', displayName: 'Identity Admin',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, mapper.id, org!.id, 'admin');
    await addMembership(pool, service.id, project.id, 'writer');
    await addMembership(pool, actor.id, project.id, 'reader');
    await mapActorIdentity(pool, {
      authority: 'github', externalActorId: '10123', principalId: actor.id,
      mappedByPrincipalId: mapper.id,
    });

    const [captured] = await capturePluginEvent(
      pool, null, service, 'github-pr', mergedPr(68, 10123, 'octocat-renamed'),
    );
    expect(captured.memory.metadata).toMatchObject({
      actor: 'octocat-renamed', actor_principal_id: actor.id,
      thread_owner_principal_id: actor.id,
    });
    const standup = await standupForPrincipal(pool, actor, { sinceHours: 24 }, {
      now: new Date(Date.now() + 1_000),
    });
    expect(standup.activity.map((memory) => memory.id)).toEqual([captured.memory.id]);
  });

  it('stores an unmapped GitHub PR safely but fails closed for standup eligibility', async () => {
    const service = await createPrincipal(pool, {
      externalId: 'svc:github-webhook', kind: 'service', displayName: 'GitHub webhook',
    });
    const viewer = await createPrincipal(pool, {
      externalId: 'entra:viewer', kind: 'user', displayName: 'Same As Login',
    });
    const project = await createScope(pool, { kind: 'project', name: 'continuum' });
    await addMembership(pool, service.id, project.id, 'writer');
    await addMembership(pool, viewer.id, project.id, 'reader');

    const [captured] = await capturePluginEvent(
      pool, null, service, 'github-pr', mergedPr(69, 555, 'Same As Login'),
    );
    expect(captured.memory.metadata).not.toHaveProperty('actor_principal_id');
    const standup = await standupForPrincipal(pool, viewer, { sinceHours: 24 }, {
      now: new Date(Date.now() + 1_000),
    });
    expect(standup.activity).toEqual([]);
  });

  it('attributes deploys only from explicit mapped identities and safely stores null actors', async () => {
    const service = await createPrincipal(pool, {
      externalId: 'svc:deploy-ingestion', kind: 'service', displayName: 'Deploy ingestion',
    });
    const actor = await createPrincipal(pool, {
      externalId: 'entra:deployer', kind: 'user', displayName: 'Deployer',
    });
    const mapper = await createPrincipal(pool, {
      externalId: 'entra:deploy-identity-admin', kind: 'user', displayName: 'Identity Admin',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const project = await createScope(pool, { kind: 'project', name: 'continuum' });
    await addMembership(pool, mapper.id, org!.id, 'admin');
    await addMembership(pool, service.id, project.id, 'writer');
    await addMembership(pool, actor.id, project.id, 'reader');
    await mapActorIdentity(pool, {
      authority: `deploy-event.${service.id}`, externalActorId: 'aad-42', principalId: actor.id,
      mappedByPrincipalId: mapper.id,
    });

    const [mapped] = await capturePluginEvent(pool, null, service, 'deploy-event', {
      project: 'continuum', environment: 'prod', version: 'v1', status: 'success',
      actor: 'Deploy User', actorAuthority: 'forged-authority', actorExternalId: 'aad-42',
      threadKey: 'github-pr:other/repo#1', closesThreadKeys: ['github-pr:other/repo#2'],
    });
    const [withoutActor] = await capturePluginEvent(pool, null, service, 'deploy-event', {
      project: 'continuum', environment: 'prod', version: 'v2', status: 'success',
    });
    const otherService = await createPrincipal(pool, {
      externalId: 'svc:other-deploy-ingestion', kind: 'service', displayName: 'Other deploy ingestion',
    });
    await addMembership(pool, otherService.id, project.id, 'writer');
    const [otherProducer] = await capturePluginEvent(pool, null, otherService, 'deploy-event', {
      project: 'continuum', environment: 'prod', version: 'v3', status: 'success',
      actor: 'Deploy User', actorAuthority: 'forged-authority', actorExternalId: 'aad-42',
    });
    expect(mapped.memory.metadata).toMatchObject({
      actor_principal_id: actor.id, thread_owner_principal_id: actor.id,
      thread_key: `deploy-event.${service.id}:deploy:continuum:prod:v1`,
      closes_thread_keys: [],
    });
    expect(withoutActor.memory.metadata).not.toHaveProperty('actor');
    expect(withoutActor.memory.metadata).not.toHaveProperty('actor_principal_id');
    expect(otherProducer.memory.metadata).not.toHaveProperty('actor_principal_id');

    const standup = await standupForPrincipal(pool, actor, { sinceHours: 24 }, {
      now: new Date(Date.now() + 1_000),
    });
    expect(standup.activity.map((memory) => memory.id)).toEqual([mapped.memory.id]);
  });

  it('does not let terminal payloads bypass mapping with a principal UUID', async () => {
    const service = await createPrincipal(pool, {
      externalId: 'svc:terminal-ingestion', kind: 'service', displayName: 'Terminal ingestion',
    });
    const victim = await createPrincipal(pool, {
      externalId: 'entra:terminal-victim', kind: 'user', displayName: 'Terminal victim',
    });
    const scope = await createScope(pool, { kind: 'user', name: 'terminal-victim' }, victim.id);
    await addMembership(pool, service.id, scope.id, 'writer');
    await addMembership(pool, victim.id, scope.id, 'reader');

    const [captured] = await capturePluginEvent(pool, null, service, 'terminal-summary', {
      actor: 'terminal-victim', actorPrincipalId: victim.id,
      sessionId: '6ccfbaa8-c912-4f3a-91b0-664d77a8c1aa',
      summary: 'Caller claims this belongs to the victim.',
    }, { resolveUserScope: () => 'terminal-victim' });

    expect(captured.memory.metadata).not.toHaveProperty('actor_principal_id');
    expect(captured.memory.metadata).not.toHaveProperty('thread_owner_principal_id');
    expect(captured.memory.metadata).not.toHaveProperty('closes_thread_keys');
    const standup = await standupForPrincipal(pool, victim, { sinceHours: 24 }, {
      now: new Date(Date.now() + 1_000),
    });
    expect(standup.activity).toEqual([]);
  });

  it('attributes a terminal summary only through its mapped immutable identity', async () => {
    const service = await createPrincipal(pool, {
      externalId: 'svc:mapped-terminal', kind: 'service', displayName: 'Terminal ingestion',
    });
    const actor = await createPrincipal(pool, {
      externalId: 'entra:mapped-terminal', kind: 'user', displayName: 'Terminal actor',
    });
    const admin = await createPrincipal(pool, {
      externalId: 'entra:terminal-admin', kind: 'user', displayName: 'Terminal admin',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const scope = await createScope(pool, { kind: 'user', name: 'mapped-terminal' }, actor.id);
    await addMembership(pool, admin.id, org!.id, 'admin');
    await addMembership(pool, service.id, scope.id, 'writer');
    await addMembership(pool, actor.id, scope.id, 'reader');
    await mapActorIdentity(pool, {
      authority: `terminal-summary.${service.id}`, externalActorId: 'subject-42', principalId: actor.id,
      mappedByPrincipalId: admin.id,
    });

    const [captured] = await capturePluginEvent(pool, null, service, 'terminal-summary', {
      actor: 'renamable-terminal-label', actorAuthority: 'terminal', actorExternalId: 'subject-42',
      sessionId: '7ccfbaa8-c912-4f3a-91b0-664d77a8c1bb', summary: 'Mapped session summary.',
      threadKey: 'github-pr:other/repo#1', closesThreadKeys: ['github-pr:other/repo#2'],
    }, { resolveUserScope: () => 'mapped-terminal' });

    expect(captured.memory.metadata).toMatchObject({
      actor: 'renamable-terminal-label', actor_principal_id: actor.id,
      thread_owner_principal_id: actor.id,
      thread_key: `terminal-summary.${service.id}:terminal-session:7ccfbaa8-c912-4f3a-91b0-664d77a8c1bb`,
      closes_thread_keys: [
        `terminal-summary.${service.id}:terminal-session:7ccfbaa8-c912-4f3a-91b0-664d77a8c1bb`,
      ],
    });
  });

  it('overwrites principal UUIDs emitted by a plugin with the mapped actual actor', async () => {
    const service = await createPrincipal(pool, {
      externalId: 'svc:custom-plugin', kind: 'service', displayName: 'Custom plugin',
    });
    const actor = await createPrincipal(pool, {
      externalId: 'entra:custom-actor', kind: 'user', displayName: 'Mapped actor',
    });
    const victim = await createPrincipal(pool, {
      externalId: 'entra:custom-victim', kind: 'user', displayName: 'Victim',
    });
    const admin = await createPrincipal(pool, {
      externalId: 'entra:custom-admin', kind: 'user', displayName: 'Admin',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const project = await createScope(pool, { kind: 'project', name: 'custom-plugin' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    await addMembership(pool, service.id, project.id, 'writer');
    await mapActorIdentity(pool, {
      authority: 'custom', externalActorId: 'immutable-7', principalId: actor.id,
      mappedByPrincipalId: admin.id,
    });
    const registry = new CaptureRegistry();
    registry.register({
      id: 'forging-plugin',
      actorIdentity: () => ({ authority: 'custom', externalId: 'immutable-7' }),
      transform: () => [{
        scope: { kind: 'project', name: 'custom-plugin' }, type: 'context',
        title: 'Forged plugin output', body: 'Sanitize attribution.', source: 'manual',
        metadata: {
          actor: 'mapped-label', actor_principal_id: victim.id,
          thread_owner_principal_id: victim.id, thread_key: 'custom:7',
          closes_thread_keys: ['victim:thread'],
        },
      }],
    });

    const [captured] = await capturePluginEvent(
      pool, null, service, 'forging-plugin', {}, { registry },
    );
    expect(captured.memory.metadata).toMatchObject({
      actor_principal_id: actor.id, thread_owner_principal_id: actor.id,
      closes_thread_keys: ['victim:thread'],
    });
    expect(captured.memory.metadata.actor_principal_id).not.toBe(victim.id);
  });
});
