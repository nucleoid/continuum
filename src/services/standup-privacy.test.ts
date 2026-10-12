import { expect, it } from 'vitest';
import { standupProducerFixture } from '../standup/test-helpers.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { offboardPrincipal } from './offboarding.js';

async function attributed(value: Parameters<Parameters<typeof standupProducerFixture>[0]>[0]) {
  const memory = await createMemory(value.producer, { scopeId: value.scopeId, scopeKind: 'user', authorId: value.producerId,
    type: 'context', title: 'Private attributed activity', body: 'Private source body', source: 'github-pr' });
  await expect(value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded', [memory.id,
    { external_actor_id: '42', repository_id: '100', head_repository_id: '100', pull_request_number: '14', branch: 'feature/privacy', merged: true }]))
    .resolves.toMatchObject({ rows: [{ recorded: true }] });
  return memory;
}

it('includes approved standup erasure in physical completion and protects its canonical audit evidence', async () => {
  await standupProducerFixture(async (value) => {
    const memory = await attributed(value);
    const admin = (await getPrincipal(value.owner, value.adminId))!;
    const closures = (await value.owner.query('SELECT * FROM standup_thread_closures ORDER BY thread_key')).rows;
    await expect(value.app.query("UPDATE memory_activity_attributions SET actor_label='Forged' WHERE memory_id=$1::uuid", [memory.id]))
      .rejects.toMatchObject({ code: '42501' });
    let result = await offboardPrincipal(value.operator, admin, value.actorId,
      { confirmationScopeId: value.scopeId, batchSize: 1 });
    for (let attempt = 0; !result.complete && attempt < 30; attempt++) {
      result = await offboardPrincipal(value.operator, admin, value.actorId,
        { confirmationScopeId: value.scopeId, batchSize: 1 });
    }
    expect(result.complete).toBe(true);
    expect((await value.owner.query('SELECT actor_label FROM memory_activity_attributions WHERE memory_id=$1::uuid', [memory.id])).rows)
      .toEqual([{ actor_label: '[erased]' }]);
    expect((await value.owner.query(`SELECT revoked_at IS NOT NULL AS revoked,revocation_reason FROM actor_principal_mappings
      WHERE principal_id=$1::uuid`, [value.actorId])).rows).toEqual([{ revoked: true, revocation_reason: '[erased]' }]);
    expect((await value.owner.query('SELECT * FROM standup_thread_closures ORDER BY thread_key')).rows).toEqual(closures);
    const evidence = (await value.owner.query(`SELECT id,principal_id,scope_id,metadata FROM audit_log
      WHERE metadata->>'operation'='principal_standup_privacy_repaired' ORDER BY id LIMIT 1`)).rows[0];
    expect(evidence.metadata.rows_processed).toBeGreaterThan(0);
    await expect(value.app.query(`INSERT INTO audit_log(principal_id,action,scope_id,metadata)
      VALUES($1::uuid,'archive',$2::uuid,$3::jsonb)`, [evidence.principal_id, evidence.scope_id, evidence.metadata]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(value.operator.query(`INSERT INTO audit_log(principal_id,action,scope_id,metadata)
      VALUES($1::uuid,'archive',$2::uuid,$3::jsonb)`, [evidence.principal_id, evidence.scope_id, evidence.metadata]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(value.operator.query("UPDATE audit_log SET metadata='{}'::jsonb WHERE id=$1::bigint", [evidence.id]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(value.owner.query("UPDATE audit_log SET metadata='{}'::jsonb WHERE id=$1::bigint", [evidence.id]))
      .rejects.toMatchObject({ code: 'P0001', message: 'preserved offboarding audit evidence is immutable' });
  });
}, 180_000);

it('keeps completion incomplete while an attributed row is locked and resumes after normal release', async () => {
  await standupProducerFixture(async (value) => {
    const memory = await attributed(value);
    const admin = (await getPrincipal(value.owner, value.adminId))!;
    const holder = await value.owner.connect();
    let released = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT memory_id FROM memory_activity_attributions WHERE memory_id=$1::uuid FOR UPDATE', [memory.id]);
      const blocked = await offboardPrincipal(value.operator, admin, value.actorId,
        { confirmationScopeId: value.scopeId, batchSize: 1000 });
      expect(blocked.complete).toBe(false);
      expect((await value.app.query('SELECT actor_label FROM memory_activity_attributions WHERE memory_id=$1::uuid', [memory.id])).rows)
        .toEqual([{ actor_label: 'Actual Actor' }]);
      await holder.query('ROLLBACK'); holder.release(); released = true;
      let result = await offboardPrincipal(value.operator, admin, value.actorId,
        { confirmationScopeId: value.scopeId, batchSize: 1000 });
      for (let attempt = 0; !result.complete && attempt < 10; attempt++) result = await offboardPrincipal(value.operator, admin, value.actorId,
        { confirmationScopeId: value.scopeId, batchSize: 1000 });
      expect(result.complete).toBe(true);
      expect((await value.app.query('SELECT actor_label FROM memory_activity_attributions WHERE memory_id=$1::uuid', [memory.id])).rows)
        .toEqual([{ actor_label: '[erased]' }]);
    } finally {
      if (!released) { await holder.query('ROLLBACK'); holder.release(); }
    }
  });
}, 180_000);
