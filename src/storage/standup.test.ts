import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { addMembership } from './memberships.js';
import { mapActorIdentity } from './actor-identities.js';
import { createActivityAttribution } from './activity-attributions.js';
import { createMemory } from './memories.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { listOpenStandupThreads } from './standup.js';
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
});
