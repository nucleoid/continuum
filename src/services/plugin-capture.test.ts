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

describe('plugin capture to standup attribution', () => {
  let pool: pg.Pool;
  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });
  afterAll(async () => pool?.end());

  function mergedPr(number: number, login: string): GitHubPrEvent {
    return {
      action: 'closed',
      pull_request: {
        number, title: `Ship ${number}`, html_url: `https://github.test/org/continuum/pull/${number}`,
        state: 'closed', merged: true, user: { login }, base: { ref: 'master' },
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
      authority: 'github', externalActorId: 'octocat-123', principalId: actor.id,
      mappedByPrincipalId: mapper.id,
    });

    const [captured] = await capturePluginEvent(
      pool, null, service, 'github-pr', mergedPr(68, 'octocat-123'),
    );
    expect(captured.memory.metadata).toMatchObject({
      actor: 'octocat-123', actor_principal_id: actor.id,
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
      pool, null, service, 'github-pr', mergedPr(69, 'Same As Login'),
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
      authority: 'azure-devops', externalActorId: 'aad-42', principalId: actor.id,
      mappedByPrincipalId: mapper.id,
    });

    const [mapped] = await capturePluginEvent(pool, null, service, 'deploy-event', {
      project: 'continuum', environment: 'prod', version: 'v1', status: 'success',
      actor: 'Deploy User', actorAuthority: 'azure-devops', actorExternalId: 'aad-42',
    });
    const [withoutActor] = await capturePluginEvent(pool, null, service, 'deploy-event', {
      project: 'continuum', environment: 'prod', version: 'v2', status: 'success',
    });
    expect(mapped.memory.metadata).toMatchObject({
      actor_principal_id: actor.id, thread_owner_principal_id: actor.id,
    });
    expect(withoutActor.memory.metadata).not.toHaveProperty('actor');
    expect(withoutActor.memory.metadata).not.toHaveProperty('actor_principal_id');

    const standup = await standupForPrincipal(pool, actor, { sinceHours: 24 }, {
      now: new Date(Date.now() + 1_000),
    });
    expect(standup.activity.map((memory) => memory.id)).toEqual([mapped.memory.id]);
  });
});
