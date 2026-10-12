import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { expect, it } from 'vitest';
import { standupProducerFixture as fixture } from '../standup/test-helpers.js';
import { createPrincipal, getPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { createMemory } from './memories.js';
import { STANDUP_ACTIVITY_SQL, OPEN_STANDUP_THREADS_SQL } from './standup.js';
import { mapOwnedUserScope } from '../services/offboarding.js';

const NOISE_ROWS = 2_048;
const SEED_BATCH = 128;
function nodes(plan: Record<string, unknown>): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  const visit = (node: Record<string, unknown>) => {
    output.push(node);
    for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) visit(child);
  };
  visit(plan);
  return output;
}
async function explain(pool: pg.Pool, sql: string, parameters: unknown[]) {
  const response = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, parameters);
  return response.rows[0]['QUERY PLAN'][0].Plan as Record<string, unknown>;
}
function expectSelectivePlan(plan: Record<string, unknown>, index: string, relation: string, actorId?: string) {
  const visited = nodes(plan);
  const indexes = visited.map((node) => node['Index Name']).filter(Boolean);
  const evidence = JSON.stringify(plan, null, 2);
  if (index === 'memory_activity_attributions_actor_time_idx' && !indexes.includes(index)) {
    // Actual default-planner evidence also seeks the actor's mapping first,
    // then its mapping/time range. Neither path scans unrelated attributions.
    expect(indexes, evidence).toContain('actor_principal_mappings_principal_idx');
    expect(indexes, evidence).toContain('memory_activity_attributions_mapping_thread_idx');
    const mapping = visited.find((node) => node['Index Name'] === 'actor_principal_mappings_principal_idx')!;
    const attribution = visited.find((node) => node['Index Name'] === 'memory_activity_attributions_mapping_thread_idx')!;
    expect(actorId, evidence).toBeTruthy();
    expect(String(mapping['Index Cond']), evidence).toContain('principal_id');
    expect(String(mapping['Index Cond']), evidence).toContain(actorId!);
    expect(String(attribution['Index Cond']), evidence).toMatch(/mapping_id\s*=\s*mapping\.mapping_id/);
    expect(String(attribution['Index Cond']), evidence).toContain('activity_at');
    expect(String(attribution['Index Cond']), evidence).toMatch(/>=/);
    expect(String(attribution['Index Cond']), evidence).toMatch(/</);
  } else expect(indexes, evidence).toContain(index);
  expect(visited.filter((node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === relation)).toEqual([]);
  const examined = visited.filter((node) => node['Relation Name'] === relation)
    .reduce((total, node) => total + (Number(node['Actual Rows'] ?? 0)
      + Number(node['Rows Removed by Filter'] ?? 0)) * Number(node['Actual Loops'] ?? 1), 0);
  expect(examined).toBeLessThanOrEqual(32);
  expect(Number(plan['Shared Hit Blocks'] ?? 0) + Number(plan['Shared Read Blocks'] ?? 0)).toBeLessThanOrEqual(256);
}

it('keeps actual standup activity open-thread and installed privacy selectors index-driven among legitimate unrelated activity', async () => {
  await fixture(async (value) => {
    const other = await createPrincipal(value.owner, { externalId: `plan-other:${randomUUID()}`,
      kind: 'user', displayName: 'Unrelated plan actor' });
    const otherScope = await createScope(value.owner, { kind: 'user', name: `plan-other-${randomUUID()}` });
    await addMembership(value.owner, other.id, otherScope.id, 'writer');
    await addMembership(value.owner, value.producerId, otherScope.id, 'writer');
    const administrator = (await getPrincipal(value.owner, value.adminId))!;
    await mapOwnedUserScope(value.operator, administrator, other.id, otherScope.id, true);

    // Genuine OP mappings and actual producer LOGIN attribution populate both
    // sides of the selective joins. No raw mapping/attribution INSERT, trigger
    // disablement, invented progress or planner coercion supplies the noise.
    for (let offset = 0; offset < NOISE_ROWS; offset += SEED_BATCH) {
      expect((await value.operator.query(`SELECT count(mapping)::int AS count FROM (
        SELECT continuum_operator_map_standup_actor($1::uuid,$2::text,(900000+item)::text,$3::uuid,
          'Synthetic plan evidence') AS mapping FROM generate_series($4::integer,$5::integer) item
      ) mapped`, [value.adminId,value.namespace,other.id,offset,offset+SEED_BATCH-1])).rows[0].count).toBe(SEED_BATCH);
      const inserted = await value.producer.query<{ id: string; source_ref: string }>(`INSERT INTO memories
        (id,scope_id,type,title,body,author_id,source,source_ref,expires_at)
        SELECT pg_catalog.gen_random_uuid(),$1::uuid,'context','Synthetic plan activity','Bounded source text',$2::uuid,
          'github-branch','plan:'||(900000+item)::text,statement_timestamp()+interval '14 days'
        FROM generate_series($3::integer,$4::integer) item RETURNING id,source_ref`,
        [otherScope.id,value.producerId,offset,offset+SEED_BATCH-1]);
      expect(inserted.rows).toHaveLength(SEED_BATCH);
      const ids = inserted.rows.map((row) => row.id);
      const actors = inserted.rows.map((row) => row.source_ref.slice('plan:'.length));
      expect((await value.producer.query(`SELECT count(*)::int AS count
        FROM unnest($1::uuid[],$2::text[]) item(memory_id,actor_id)
        WHERE continuum_record_standup_activity(item.memory_id,jsonb_build_object(
          'external_actor_id',item.actor_id,'repository_id','100','branch','plan-noise-'||item.memory_id::text))`,
        [ids,actors])).rows[0].count).toBe(SEED_BATCH);
    }
    const targetIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const memory = await createMemory(value.producer, { scopeId: value.scopeId, scopeKind: 'user',
        authorId: value.producerId, type: 'context', title: `Plan target ${index}`, body: 'Trusted target source', source: 'github-branch' });
      expect((await value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded',
        [memory.id,{ external_actor_id: '42', repository_id: '100', branch: `plan-target-${index}` }])).rows[0].recorded).toBe(true);
      targetIds.push(memory.id);
    }
    expect((await value.app.query(`SELECT count(*)::int AS count FROM memory_activity_attributions
      WHERE actor_principal_id=$1::uuid`, [other.id])).rows[0].count).toBe(NOISE_ROWS);
    for (const relation of ['principals','scope_memberships','principal_user_scopes','scopes','memories',
      'actor_principal_mappings','memory_activity_attributions','standup_thread_closures']) {
      // Statistics are legitimate fixture state, not a forced access method.
      await value.owner.query(`ANALYZE ${relation}`);
    }
    const clock = (await value.owner.query(`SELECT statement_timestamp()-interval '1 day' AS start_at,
      statement_timestamp()+interval '1 second' AS end_at`)).rows[0];
    const activityParameters = [value.actorId,clock.start_at,clock.end_at,50,0];
    const openParameters = [value.actorId,clock.end_at,clock.start_at,clock.end_at,50];
    expect((await value.app.query(STANDUP_ACTIVITY_SQL,activityParameters)).rows.map((row) => row.id).sort()).toEqual([...targetIds].sort());
    expect((await value.app.query(OPEN_STANDUP_THREADS_SQL,openParameters)).rows.map((row) => row.id).sort()).toEqual([...targetIds].sort());
    for (const [sql, parameters] of [[STANDUP_ACTIVITY_SQL,activityParameters],[OPEN_STANDUP_THREADS_SQL,openParameters]] as const) {
      expectSelectivePlan(await explain(value.app,sql,parameters),
        'memory_activity_attributions_actor_time_idx','memory_activity_attributions',value.actorId);
    }

    const source = String((await value.owner.query(`SELECT prosrc FROM pg_catalog.pg_proc
      WHERE oid='continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)'::regprocedure`)).rows[0].prosrc);
    const actorSelector = source.match(/SELECT memory_id FROM memory_activity_attributions WHERE actor_principal_id=target_principal_id AND actor_label<>'\[erased\]' ORDER BY memory_id LIMIT batch_limit/);
    const mappingSelector = source.match(/SELECT mapping_id FROM actor_principal_mappings WHERE principal_id=target_principal_id\s+AND \([\s\S]*?\) ORDER BY mapping_id LIMIT batch_limit FOR UPDATE SKIP LOCKED/);
    if (!actorSelector || !mappingSelector) throw new Error('Installed privacy selectors changed; recheck actual definer query rather than substitute a fake plan');
    expect(mappingSelector[0]).toContain("external_actor_id IS DISTINCT FROM 'erased:'||mapping_id::text");
    // These are the actual installed definer's candidate SQL bodies. Planning
    // under its trusted owner is not an ordinary-role erasure authority proof;
    // OP authorization and physical cleanup are separate integration controls.
    const bind = (sql: string) => sql.replaceAll('target_principal_id','$1::uuid').replaceAll('batch_limit','$2::integer');
    const actorPlan = await explain(value.owner,bind(actorSelector[0]),[value.actorId,10]);
    expect(Number(actorPlan['Actual Rows'])).toBe(3);
    expectSelectivePlan(actorPlan,'standup_attribution_privacy_actor_idx','memory_activity_attributions');
    const mappingPlan = await explain(value.owner,bind(mappingSelector[0]),[value.actorId,10]);
    expect(Number(mappingPlan['Actual Rows'])).toBe(1);
    expectSelectivePlan(mappingPlan,'actor_principal_mappings_principal_idx','actor_principal_mappings');
  });
}, 180_000);
