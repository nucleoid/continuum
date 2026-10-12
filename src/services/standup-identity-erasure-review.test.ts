import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { standupProducerFixture } from '../standup/test-helpers.js';
import { createMemory } from '../storage/memories.js';
import { createPrincipal, getPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { offboardPrincipal } from './offboarding.js';

it('erases the reversible external identity link while preserving replacement-generation denial', async () => {
  await standupProducerFixture(async (value) => {
    const original = await createMemory(value.producer, { scopeId: value.scopeId, scopeKind: 'user',
      authorId: value.producerId, type: 'context', title: 'Attributed source', body: 'Private body', source: 'github-pr' });
    const proof = { external_actor_id: '42', repository_id: '100', pull_request_number: '15', branch: 'privacy' };
    expect((await value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded',
      [original.id, proof])).rows[0].recorded).toBe(true);
    const admin = (await getPrincipal(value.owner, value.adminId))!;
    let result = await offboardPrincipal(value.operator, admin, value.actorId,
      { confirmationScopeId: value.scopeId, batchSize: 1000 });
    for (let attempt = 0; !result.complete && attempt < 10; attempt++) result = await offboardPrincipal(value.operator, admin,
      value.actorId, { confirmationScopeId: value.scopeId, batchSize: 1000 });
    expect(result.complete).toBe(true);
    const replacement = await createPrincipal(value.owner, { externalId: `replacement:${value.namespace}`,
      kind: 'user', displayName: 'Replacement user' });
    const project = await createScope(value.owner, { kind: 'project', name: `replacement-${value.namespace}` });
    await addMembership(value.owner, value.producerId, project.id, 'writer');
    await addMembership(value.owner, replacement.id, project.id, 'writer');
    await value.operator.query('SELECT continuum_operator_map_standup_actor($1::uuid,$2::text,$3::text,$4::uuid,$5::text)',
      [value.adminId, value.namespace, '42', replacement.id, 'Reviewed replacement after erasure']);
    const newMemory = await createMemory(value.producer, { scopeId: project.id, scopeKind: 'project',
      authorId: value.producerId, type: 'context', title: 'Replacement activity', body: 'New body', source: 'github-pr' });
    expect((await value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded',
      [newMemory.id, proof])).rows[0].recorded).toBe(false);
    expect((await value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded',
      [newMemory.id, { ...proof, event_time: newMemory.createdAt.toISOString() }])).rows[0].recorded).toBe(true);
    const digest = createHash('sha256').update(`${value.namespace}:42`).digest('hex');
    const retained = (await value.app.query('SELECT mapping_id,external_actor_id FROM actor_principal_mappings WHERE principal_id=$1::uuid',
      [value.actorId])).rows;
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.every((row) => row.external_actor_id !== digest && row.external_actor_id === `erased:${row.mapping_id}`)).toBe(true);
    for (const reader of [value.app, value.operator]) {
      await expect(reader.query('SELECT generation_count FROM standup_identity_generation_counts'))
        .rejects.toMatchObject({ code: '42501' });
    }
    expect((await value.owner.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='standup_identity_generation_counts' ORDER BY ordinal_position`)).rows)
      .toEqual([{ column_name:'authority' }, { column_name:'external_actor_hash' }, { column_name:'generation_count' }]);
  });
}, 180_000);
