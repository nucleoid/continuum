import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { addMembership } from './memberships.js';
import { mapActorIdentity, replaceActorIdentity } from './actor-identities.js';
import { createActivityAttribution } from './activity-attributions.js';
import { createMemory } from './memories.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { listOpenStandupThreads, listStandupActivity } from './standup.js';
import { makeTestPool, resetData } from './test-helpers.js';

describe('standup trusted activity storage', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });
  afterAll(async () => pool?.end());

  async function seed() {
    const actor = await createPrincipal(pool, {
      externalId: 'entra:standup-storage', kind: 'user', displayName: 'Standup Storage',
    });
    const service = await createPrincipal(pool, {
      externalId: 'service:standup-storage', kind: 'service', displayName: 'Capture service',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const openerScope = await createScope(pool, { kind: 'project', name: 'opener' });
    const closerScope = await createScope(pool, { kind: 'project', name: 'closer' });
    await addMembership(pool, actor.id, org.id, 'admin');
    await addMembership(pool, actor.id, openerScope.id, 'reader');
    await addMembership(pool, actor.id, closerScope.id, 'reader');
    await mapActorIdentity(pool, {
      authority: 'terminal-summary', externalActorId: 'actor-1',
      principalId: actor.id, mappedByPrincipalId: actor.id,
    });
    const mapping = await pool.query<{ mapping_id: string }>(
      `SELECT mapping_id FROM actor_principal_mappings
        WHERE authority = 'terminal-summary' AND external_actor_id = 'actor-1'`,
    );
    return { actor, service, openerScope, closerScope, mappingId: mapping.rows[0]!.mapping_id };
  }

  it('keeps a source-time closure after closer access is revoked and late opener delivery', async () => {
    const { actor, service, openerScope, closerScope, mappingId } = await seed();
    const closure = await createMemory(pool, {
      scopeId: closerScope.id, scopeKind: closerScope.kind, type: 'context',
      title: 'Merged', body: 'content', authorId: service.id, source: 'github-pr', metadata: {},
    });
    await createActivityAttribution(pool, {
      memoryId: closure.id, actorPrincipalId: actor.id, mappingId,
      mappingAuthority: 'terminal-summary', actorLabel: actor.displayName,
      threadKey: 'pr:1', closesThreadKeys: ['branch:late'],
      activityAt: new Date('2026-10-04T12:00:00Z'),
    });
    await pool.query(
      'DELETE FROM scope_memberships WHERE principal_id = $1 AND scope_id = $2',
      [actor.id, closerScope.id],
    );
    const opener = await createMemory(pool, {
      scopeId: openerScope.id, scopeKind: openerScope.kind, type: 'context',
      title: 'Started branch', body: 'content', authorId: service.id,
      source: 'github-branch', metadata: {},
    });
    await createActivityAttribution(pool, {
      memoryId: opener.id, actorPrincipalId: actor.id, mappingId,
      mappingAuthority: 'terminal-summary', actorLabel: actor.displayName,
      threadKey: 'branch:late', closesThreadKeys: [],
      activityAt: new Date('2026-10-03T12:00:00Z'),
    });

    const open = await listOpenStandupThreads(
      pool, actor.id, new Date('2026-10-05T00:00:00Z'),
      new Date('2026-09-01T00:00:00Z'), new Date('2026-10-05T12:00:00Z'), 20,
    );
    expect(open).toEqual([]);
  });

  it('has usable indexes for the shipped actor/time and closure predicates', async () => {
    await pool.query('SET enable_seqscan = off');
    const actorPlan = await pool.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (FORMAT JSON)
       SELECT memory_id FROM memory_activity_attributions
        WHERE actor_principal_id = '11111111-1111-4111-8111-111111111111'::uuid
          AND activity_at >= '2026-10-01Z'::timestamptz
          AND activity_at < '2026-10-06Z'::timestamptz`,
    );
    const closurePlan = await pool.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (FORMAT JSON)
       SELECT source_memory_id FROM standup_thread_closures
        WHERE actor_principal_id = '11111111-1111-4111-8111-111111111111'::uuid
          AND thread_key = 'branch:1'
          AND closed_at >= '2026-10-01Z'::timestamptz`,
    );
    await pool.query('RESET enable_seqscan');
    const rendered = JSON.stringify([actorPlan.rows, closurePlan.rows]);
    expect(rendered).toContain('memory_activity_actor_time_idx');
    expect(rendered).toContain('standup_thread_closures_lookup_idx');
  });

  it('retains legitimate pre-revocation activity across a mapping replacement', async () => {
    const { actor, service, openerScope, mappingId } = await seed();
    const memory = await createMemory(pool, {
      scopeId: openerScope.id, scopeKind: openerScope.kind, type: 'context',
      title: 'Legitimate history', body: 'content', authorId: service.id,
      source: 'terminal-summary', metadata: {},
    });
    await createActivityAttribution(pool, {
      memoryId: memory.id, actorPrincipalId: actor.id, mappingId,
      mappingAuthority: 'terminal-summary', actorLabel: actor.displayName,
      threadKey: 'thread:history', closesThreadKeys: [], activityAt: new Date(),
    });
    await replaceActorIdentity(pool, {
      authority: 'terminal-summary', externalActorId: 'actor-1',
      principalId: actor.id, mappedByPrincipalId: actor.id,
      reason: 'Rotate a compromised producer credential',
    });
    const activity = await listStandupActivity(
      pool, actor.id, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000), 20, 0,
    );
    expect(activity.map((item) => item.id)).toContain(memory.id);
    const history = await pool.query(
      `SELECT revocation_reason FROM actor_principal_mappings
        WHERE mapping_id = $1`, [mappingId],
    );
    expect(history.rows[0]?.revocation_reason).toBe('Rotate a compromised producer credential');
  });

  it('does not let a prior mapping generation close a replacement generation thread', async () => {
    const { actor, service, openerScope, mappingId } = await seed();
    const oldClosure = await createMemory(pool, {
      scopeId: openerScope.id, scopeKind: openerScope.kind, type: 'context',
      title: 'Old closure', body: 'content', authorId: service.id,
      source: 'terminal-summary', metadata: {},
    });
    await createActivityAttribution(pool, {
      memoryId: oldClosure.id, actorPrincipalId: actor.id, mappingId,
      mappingAuthority: 'terminal-summary', actorLabel: actor.displayName,
      threadKey: 'thread:old-closure', closesThreadKeys: ['thread:rotated'],
      activityAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
    });
    await replaceActorIdentity(pool, {
      authority: 'terminal-summary', externalActorId: 'actor-1',
      principalId: actor.id, mappedByPrincipalId: actor.id,
      reason: 'Separate trust generations',
    });
    const replacement = await pool.query<{ mapping_id: string }>(
      `SELECT mapping_id FROM actor_principal_mappings
        WHERE authority = 'terminal-summary' AND external_actor_id = 'actor-1'
          AND revoked_at IS NULL`,
    );
    const openMemory = await createMemory(pool, {
      scopeId: openerScope.id, scopeKind: openerScope.kind, type: 'context',
      title: 'Rotated thread', body: 'content', authorId: service.id,
      source: 'terminal-summary', metadata: {},
    });
    await createActivityAttribution(pool, {
      memoryId: openMemory.id, actorPrincipalId: actor.id,
      mappingId: replacement.rows[0]!.mapping_id,
      mappingAuthority: 'terminal-summary', actorLabel: actor.displayName,
      threadKey: 'thread:rotated', closesThreadKeys: [],
      activityAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });
    const open = await listOpenStandupThreads(
      pool, actor.id, new Date(Date.now() - 24 * 60 * 60 * 1000),
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), new Date(Date.now() + 60_000), 20,
    );
    expect(open.map((item) => item.id)).toContain(openMemory.id);
  });

  it('enforces trust expiry in readers and at the database update boundary', async () => {
    const { actor, service, openerScope, mappingId } = await seed();
    const memory = await createMemory(pool, {
      scopeId: openerScope.id, scopeKind: openerScope.kind, type: 'context',
      title: 'Expired trust', body: 'content', authorId: service.id,
      source: 'terminal-summary', metadata: {},
    });
    const ceiling = new Date(Date.now() - 1_000);
    await createActivityAttribution(pool, {
      memoryId: memory.id, actorPrincipalId: actor.id, mappingId,
      mappingAuthority: 'terminal-summary', actorLabel: actor.displayName,
      threadKey: 'thread:expired', closesThreadKeys: [], activityAt: new Date(),
      trustExpiresAt: ceiling,
    });
    await pool.query('UPDATE memories SET expires_at = NULL WHERE id = $1', [memory.id]);
    const stored = await pool.query<{ expires_at: Date }>(
      'SELECT expires_at FROM memories WHERE id = $1', [memory.id],
    );
    expect(stored.rows[0]!.expires_at.toISOString()).toBe(ceiling.toISOString());
    const activity = await listStandupActivity(
      pool, actor.id, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000), 20, 0,
    );
    expect(activity.map((item) => item.id)).not.toContain(memory.id);
  });

  it('stores trusted receipt time and clamps producer backdating', async () => {
    const { actor, service, openerScope, mappingId } = await seed();
    const memory = await createMemory(pool, {
      scopeId: openerScope.id, scopeKind: openerScope.kind, type: 'context',
      title: 'Backdated event', body: 'content', authorId: service.id,
      source: 'terminal-summary', metadata: {},
    });
    await createActivityAttribution(pool, {
      memoryId: memory.id, actorPrincipalId: actor.id, mappingId,
      mappingAuthority: 'terminal-summary', actorLabel: actor.displayName,
      threadKey: 'thread:backdated', closesThreadKeys: [],
      activityAt: new Date('2000-01-01T00:00:00Z'),
    });
    const row = await pool.query<{ activity_at: Date; received_at: Date }>(
      'SELECT activity_at, received_at FROM memory_activity_attributions WHERE memory_id = $1',
      [memory.id],
    );
    expect(row.rows[0]!.activity_at.getTime())
      .toBeGreaterThanOrEqual(row.rows[0]!.received_at.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(row.rows[0]!.activity_at.getTime()).toBeLessThanOrEqual(row.rows[0]!.received_at.getTime());
  });

  it('blocks legacy promotion from permanently dropping trusted attribution', async () => {
    const { actor, service, openerScope, closerScope, mappingId } = await seed();
    const source = await createMemory(pool, {
      scopeId: openerScope.id, scopeKind: openerScope.kind, type: 'context',
      title: 'Attributed source', body: 'content', authorId: service.id,
      source: 'terminal-summary', metadata: {},
    });
    await createActivityAttribution(pool, {
      memoryId: source.id, actorPrincipalId: actor.id, mappingId,
      mappingAuthority: 'terminal-summary', actorLabel: actor.displayName,
      threadKey: 'thread:promotion', closesThreadKeys: [], activityAt: new Date(),
    });
    const legacyDestination = await createMemory(pool, {
      scopeId: closerScope.id, scopeKind: closerScope.kind, type: 'context',
      title: 'Legacy unattributed copy', body: 'content', authorId: service.id,
      source: 'promote:terminal-summary', metadata: { promoted_from: source.id },
    });
    await expect(pool.query(
      `UPDATE memories SET state = 'promoted', promoted_to_id = $2 WHERE id = $1`,
      [source.id, legacyDestination.id],
    )).rejects.toThrow(/trusted attribution/i);
  });
});
