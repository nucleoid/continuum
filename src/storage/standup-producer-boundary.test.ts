import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { quoteStandupIdentifier as quote, standupProducerFixture as fixture } from '../standup/test-helpers.js';
import { createPrincipal, getPrincipal } from './principals.js';
import { getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';
import { createMemory } from './memories.js';
import { offboardPrincipal } from '../services/offboarding.js';


it('binds activity and closure authority to the actual producer LOGIN, not known mappings or caller metadata', async () => {
  await fixture(async (value) => {
    const memory = await createMemory(value.producer, { scopeId: value.scopeId, scopeKind: 'user',
      authorId: value.producerId, type: 'context', title: 'Started branch', body: 'Trusted source text', source: 'github-branch' });
    const proof = { external_actor_id: '42', repository_id: '100', branch: 'feature/standup', actor: 'Forged Label', authority: 'attacker' };
    await expect(value.app.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb)', [memory.id, proof]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(value.app.query('SELECT continuum_operator_map_standup_actor($1::uuid,$2::text,$3::text,$4::uuid,$5::text)',
      [value.adminId, value.namespace, '43', value.actorId, 'Known administrator UUID']))
      .rejects.toMatchObject({ code: '42501' });
    await expect(value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded', [memory.id, proof]))
      .resolves.toMatchObject({ rows: [{ recorded: true }] });
    const attribution = (await value.owner.query('SELECT * FROM memory_activity_attributions WHERE memory_id=$1::uuid', [memory.id])).rows[0];
    expect(attribution.actor_label).toBe('Actual Actor');
    expect(attribution.mapping_authority).toBe(value.namespace);
    expect(attribution.actor_principal_id).toBe(value.actorId);
    expect(attribution.trust_expires_at.toISOString()).toBe(memory.expiresAt!.toISOString());
    await expect(value.app.query(`INSERT INTO memory_activity_attributions(memory_id,actor_principal_id,thread_owner_principal_id,
      mapping_id,mapping_authority,actor_label,thread_key,activity_at)
      VALUES($1,$2,$2,$3,$4,'Forged Label','arbitrary',clock_timestamp())`,
    [memory.id, value.actorId, attribution.mapping_id, value.namespace])).rejects.toMatchObject({ code: '42501' });
    await expect(value.producer.query(`INSERT INTO standup_thread_closures(source_memory_id,actor_principal_id,mapping_id,thread_key,closed_at)
      VALUES($1,$2,$3,'unrelated-thread',clock_timestamp())`, [memory.id, value.actorId, attribution.mapping_id]))
      .rejects.toMatchObject({ code: '42501' });
    // OP target verification must retain the complete catalog contract.
    await value.owner.query(`GRANT DELETE ON standup_thread_closures TO ${quote(value.producerRole)}`);
    try {
      await expect(value.operator.query('SELECT continuum_operator_bind_standup_producer($1::uuid,$2::name,$3::uuid,$4::text,$5::text)',
        [value.adminId, value.producerRole, value.producerId, value.namespace, 'github']))
        .rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await value.owner.query(`REVOKE DELETE ON standup_thread_closures FROM ${quote(value.producerRole)}`);
    }
    await value.app.query("SELECT set_config('continuum.standup_producer','on',FALSE)");
    await expect(value.app.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb)', [memory.id, proof]))
      .rejects.toMatchObject({ code: '42501' });
  });
}, 180_000);

it('excludes source events predating a replacement mapping without rewriting the old attribution', async () => {
  await fixture(async (value) => {
    const first = await createMemory(value.producer, { scopeId: value.scopeId, scopeKind: 'user',
      authorId: value.producerId, type: 'context', title: 'First generation', body: 'Source', source: 'github-branch' });
    const proof = { external_actor_id: '42', repository_id: '100', branch: 'feature/generation' };
    await value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb)', [first.id, proof]);
    const original = (await value.owner.query('SELECT * FROM memory_activity_attributions WHERE memory_id=$1::uuid', [first.id])).rows;
    const oldTime = (await value.owner.query('SELECT clock_timestamp() AS time')).rows[0].time.toISOString();
    await value.operator.query('SELECT continuum_operator_map_standup_actor($1::uuid,$2::text,$3::text,$4::uuid,$5::text)',
      [value.adminId, value.namespace, '42', value.actorId, 'Audited replacement generation']);
    const late = await createMemory(value.producer, { scopeId: value.scopeId, scopeKind: 'user',
      authorId: value.producerId, type: 'context', title: 'Delayed old opener', body: 'Source', source: 'github-branch' });
    await expect(value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded',
      [late.id, { ...proof, event_time: oldTime }])).resolves.toMatchObject({ rows: [{ recorded: false }] });
    await expect(value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded',
      [late.id, proof])).resolves.toMatchObject({ rows: [{ recorded: false }] });
    expect((await value.owner.query('SELECT * FROM memory_activity_attributions WHERE memory_id=$1::uuid', [first.id])).rows)
      .toEqual(original);
    expect((await value.owner.query('SELECT count(*)::integer AS total FROM memory_activity_attributions WHERE memory_id=$1::uuid', [late.id])).rows)
      .toEqual([{ total: 0 }]);
  });
}, 180_000);


it('does not let a first mapping claim an older unattributed memory through receipt fallback', async () => {
  await fixture(async (value) => {
    const old = await createMemory(value.producer, { scopeId: value.scopeId, scopeKind: 'user',
      authorId: value.producerId, type: 'context', title: 'Before initial mapping', body: 'Old source', source: 'github-branch' });
    await value.operator.query('SELECT continuum_operator_map_standup_actor($1::uuid,$2::text,$3::text,$4::uuid,$5::text)',
      [value.adminId, value.namespace, '43', value.actorId, 'First reviewed mapping']);
    const mapping = (await value.owner.query(`SELECT created_at FROM actor_principal_mappings
      WHERE authority=$1::text AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [value.namespace])).rows[0];
    expect(old.createdAt.getTime()).toBeLessThanOrEqual(mapping.created_at.getTime());
    const proof = { external_actor_id: '43', repository_id: '100', branch: 'feature/predating' };
    // Explicit old time is already excluded; omitted time must not bypass the same generation fence.
    await expect(value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded',
      [old.id, { ...proof, event_time: old.createdAt.toISOString() }])).resolves.toMatchObject({ rows: [{ recorded: false }] });
    await expect(value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded',
      [old.id, proof])).resolves.toMatchObject({ rows: [{ recorded: false }] });
    expect((await value.owner.query('SELECT count(*)::integer AS total FROM memory_activity_attributions WHERE memory_id=$1::uuid', [old.id])).rows)
      .toEqual([{ total: 0 }]);
    const current = await createMemory(value.producer, { scopeId: value.scopeId, scopeKind: 'user',
      authorId: value.producerId, type: 'context', title: 'After initial mapping', body: 'Current source', source: 'github-branch' });
    await expect(value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded',
      [current.id, proof])).resolves.toMatchObject({ rows: [{ recorded: true }] });
  });
}, 180_000);


it.each([
  ['source', 'terminal-summary'],
  ['source_ref', 'https://caller.example/forged-citation'],
  ['title', 'Caller forged trusted activity'],
] as const)('ordinary APP cannot rewrite attributed memory %s provenance', async (column, replacement) => {
  await fixture(async (value) => {
    const memory = await createMemory(value.producer, { scopeId: value.scopeId, scopeKind: 'user',
      authorId: value.producerId, type: 'context', title: 'Original producer activity', body: 'Original source',
      source: 'github-branch', sourceRef: 'https://sources.example/original' });
    await expect(value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded',
      [memory.id, { external_actor_id: '42', repository_id: '100', branch: 'feature/source-proof' }]))
      .resolves.toMatchObject({ rows: [{ recorded: true }] });
    const original = (await value.owner.query(`SELECT source,source_ref,title FROM memories WHERE id=$1::uuid`, [memory.id])).rows;
    await expect(value.app.query(`UPDATE memories SET ${column}=$2::text WHERE id=$1::uuid`, [memory.id, replacement]))
      .rejects.toMatchObject({ code: '23514' });
    expect((await value.owner.query(`SELECT source,source_ref,title FROM memories WHERE id=$1::uuid`, [memory.id])).rows)
      .toEqual(original);
  });
}, 180_000);


it.each(['future', 'infinity'] as const)('receipt fallback rejects %s memory creation time before trusting activity', async (kind) => {
  await fixture(async (value) => {
    const memory = await createMemory(value.producer, { scopeId: value.scopeId, scopeKind: 'user',
      authorId: value.producerId, type: 'context', title: 'Invalid source time', body: 'Source', source: 'github-branch' });
    const invalidTime = kind === 'infinity' ? 'infinity'
      : (await value.owner.query("SELECT (clock_timestamp()+interval '1 day')::text AS time")).rows[0].time;
    await value.producer.query('UPDATE memories SET created_at=$2::timestamptz WHERE id=$1::uuid', [memory.id, invalidTime]);
    const proof = { external_actor_id: '42', repository_id: '100', branch: 'feature/future' };
    await expect(value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded',
      [memory.id, { ...proof, event_time: invalidTime }])).resolves.toMatchObject({ rows: [{ recorded: false }] });
    await expect(value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded',
      [memory.id, proof])).resolves.toMatchObject({ rows: [{ recorded: false }] });
    expect((await value.owner.query('SELECT count(*)::integer AS total FROM memory_activity_attributions WHERE memory_id=$1::uuid', [memory.id])).rows)
      .toEqual([{ total: 0 }]);
  });
}, 180_000);


it('allows the latest authorized operator takeover to erase attributed owned memories while ordinary APP remains denied', async () => {
  await fixture(async (value) => {
    const adminA = (await getPrincipal(value.owner, value.adminId))!;
    const adminB = await createPrincipal(value.owner, { externalId: `takeover:${randomUUID()}`, kind: 'user', displayName: 'Takeover administrator' });
    const org = (await getScopeByRef(value.owner, { kind: 'org', name: '' }))!;
    await addMembership(value.owner, adminB.id, org.id, 'admin');
    const operatorB = await value.addOperator(adminB.id);
    for (let index = 0; index < 2; index++) {
      const memory = await createMemory(value.producer, { scopeId: value.scopeId, scopeKind: 'user',
        authorId: value.producerId, type: 'context', title: `Attributed takeover ${index}`, body: 'Source', source: 'github-branch' });
      await value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb)',
        [memory.id, { external_actor_id: '42', repository_id: '100', branch: `feature/takeover-${index}` }]);
    }
    const first = await offboardPrincipal(value.operator, adminA, value.actorId,
      { dryRun: false, confirmationScopeId: value.scopeId, batchSize: 1 });
    expect(first.complete).toBe(false);
    const remaining = (await value.owner.query(`SELECT id FROM memories WHERE scope_id=$1::uuid AND state<>'archived' ORDER BY id`, [value.scopeId])).rows;
    expect(remaining.length).toBeGreaterThan(0);
    await expect(value.app.query(`UPDATE memories SET type='context',title='[erased]',body='[erased]',metadata='{}'::jsonb,
      tags='{}'::text[],source='erased',source_ref=NULL,state='archived',expires_at=NULL,last_verified=NULL,supersedes_id=NULL,promoted_to_id=NULL
      WHERE id=$1::uuid`, [remaining[0].id])).rejects.toBeDefined();
    await offboardPrincipal(operatorB, adminB, value.actorId,
      { dryRun: false, confirmationScopeId: value.scopeId, batchSize: 1000 });
    expect((await value.owner.query(`SELECT count(*)::integer AS total FROM memories WHERE scope_id=$1::uuid
      AND (state<>'archived' OR title<>'[erased]' OR body<>'[erased]')`, [value.scopeId])).rows).toEqual([{ total: 0 }]);
    expect((await value.owner.query(`SELECT to_actor FROM principal_offboarding_takeover_events
      WHERE principal_id=$1::uuid ORDER BY id DESC LIMIT 1`, [value.actorId])).rows).toEqual([{ to_actor: adminB.id }]);
  });
}, 180_000);
