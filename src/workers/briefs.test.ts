import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect,it } from 'vitest';
import { briefFixture,syntheticBrief } from '../briefs/test-helpers.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { briefForPrincipal,refreshBrief } from '../services/briefs.js';
import { processBrief,BriefWorker } from './briefs.js';
import { BriefRegistry } from '../briefs/provider.js';

type Fixture=Parameters<Parameters<typeof briefFixture>[0]>[0];
const capture=(f: Fixture,body='Original recorded plan') => createMemory(f.app,{ scopeId: f.projectId,scopeKind: 'project',authorId: f.actorId,type: 'decision',title: 'Plan',body,source: 'manual' });
const request=async (f: Fixture,key=randomUUID()) => refreshBrief(f.app,(await getPrincipal(f.app,f.actorId))!,{ project: f.projectName,mode: 'full',dryRun: false,idempotencyKey: key });

it.each(['source','membership','configuration','audit'] as const)('rejects stale %s apply atomically after settled generation',async boundary => {
  const good=syntheticBrief();let change: () => Promise<unknown>;
  const profile=syntheticBrief(async (...args) => { const output=await good.adapter.invoke(...args);await change();return output; });
  await briefFixture(async f => {
    const memory=await capture(f);await request(f);
    change=() => boundary==='source' ? f.owner.query("UPDATE memories SET body='Replacement plan' WHERE id=$1",[memory.id])
      : boundary==='membership' ? f.owner.query('UPDATE scope_memberships SET active=FALSE WHERE principal_id=$1 AND scope_id=$2',[f.producerId,f.projectId])
      : boundary==='configuration' ? f.app.query('SELECT continuum_brief_configure($1,$2,$3,FALSE)',[f.actorId,f.projectId,f.profile.id])
      : f.owner.query(`CREATE FUNCTION reject_brief_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.metadata->>'operation'='brief_version_applied' THEN RAISE EXCEPTION 'synthetic audit rejection'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER reject_brief_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_brief_audit()`);
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('unavailable');
    expect((await f.owner.query('SELECT count(*)::int AS n FROM brief_versions')).rows[0].n).toBe(0);
    expect((await f.owner.query('SELECT head FROM brief_definitions')).rows[0].head).toBeNull();
    expect((await f.owner.query('SELECT used FROM pipeline_budget_workflows')).rows[0].used.calls).toBe(1);
  },profile);
},120000);

it('retains original ambiguous attempt maxima across timeout, replay, restart and late settlement',async () => {
  let finish!: () => void;const blocked=new Promise<void>(resolve => { finish=resolve; });let calls=0;
  const good=syntheticBrief();const profile=syntheticBrief(async (...args) => { calls++;await blocked;return good.adapter.invoke(...args); });
  profile.adapter.timeoutMs=1000;
  await briefFixture(async f => {
    await capture(f);const before=await request(f,'original');
    const pending: Promise<unknown>[]=[];
    expect(await processBrief(f.worker,randomUUID(),f.profile,{ onWork: work=>pending.push(work) })).toBe('unavailable');
    expect(calls).toBe(1);
    const original=(await f.owner.query('SELECT workflow_id,attempt_id,budget_owner,budget_generation,deadline_at FROM brief_runs')).rows[0];
    expect((await f.owner.query('SELECT active,used FROM pipeline_budget_workflows')).rows[0]).toMatchObject({ active: 1,used: { calls: 1 } });
    expect((await request(f,'original')).runId).toBe(before.runId);
    const restarted=new BriefWorker(f.worker,f.registry);await restarted.poll();await restarted.stop();
    expect(calls).toBe(1);
    expect((await f.owner.query('SELECT workflow_id,attempt_id,budget_owner,budget_generation,deadline_at FROM brief_runs')).rows[0]).toEqual(original);
    finish();
    await Promise.allSettled(pending);
    expect((await f.owner.query('SELECT active,used FROM pipeline_budget_workflows')).rows[0]).toMatchObject({ active: 0,used: { calls: 1 } });
    expect((await f.owner.query('SELECT count(*)::int AS n FROM brief_versions')).rows[0].n).toBe(0);
  },profile);
},120000);

it('uses one logical claim and never overwrites a later head from a queued stale request',async () => {
  await briefFixture(async f => {
    await capture(f);await request(f,'first');await request(f,'second');
    const outcomes=await Promise.all([processBrief(f.worker,randomUUID(),f.profile),processBrief(f.worker,randomUUID(),f.profile)]);
    expect(outcomes.filter(v=>v==='processed')).toHaveLength(1);
    const head=(await f.owner.query('SELECT head FROM brief_definitions')).rows[0].head;
    await processBrief(f.worker,randomUUID(),f.profile);
    expect((await f.owner.query('SELECT head FROM brief_definitions')).rows[0].head).toBe(head);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM brief_versions')).rows[0].n).toBe(1);
  });
},120000);

it('automatically discovers a delayed lower-sequence commit and repairs under a new immutable run',async () => {
  await briefFixture(async f => {
    const actor=(await getPrincipal(f.app,f.actorId))!;
    const low=await f.owner.connect();
    const schema=(await low.query('SELECT current_schema() AS name')).rows[0].name;
    const high=new pg.Client({ connectionString: process.env.CONTINUUM_TEST_DATABASE_URL!,options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=1000` });
    // Scope generations are committed row state, independent of this sequence's allocation order.
    try {
      await low.query('CREATE SEQUENCE synthetic_commit_order');await low.query('BEGIN');
      await high.connect();
      expect((await low.query('SELECT nextval(\'synthetic_commit_order\') AS id')).rows[0].id).toBe('1');
      expect((await high.query('SELECT nextval(\'synthetic_commit_order\') AS id')).rows[0].id).toBe('2');
      await capture(f,'Higher allocated evidence commits first');await request(f);
      expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
      const before=await briefForPrincipal(f.app,actor,f.projectName);
      await createMemory(low,{ scopeId: f.projectId,scopeKind: 'project',authorId: f.actorId,type: 'decision',title: 'Delayed source',body: 'Lower allocated evidence commits later',source: 'manual' });
      await low.query('COMMIT');
      expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
      const after=await briefForPrincipal(f.app,actor,f.projectName);
      expect(after.blocks).toHaveLength(2);expect(after.version).not.toBe(before.version);expect(after.fresh).toBe(true);
    } finally { await low.query('ROLLBACK');low.release();await high.end(); }
  });
},120000);

it('does not claim work for an unavailable profile or an empty stock registry',async () => {
  const profile=syntheticBrief();profile.adapter.credentials='missing';
  await briefFixture(async f => {
    await capture(f);await request(f);
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('idle');
    const worker=new BriefWorker(f.worker,new BriefRegistry());await worker.start();await worker.poll();await worker.stop();
    expect((await f.owner.query('SELECT state,deadline_at FROM brief_runs')).rows[0]).toEqual({ state: 'queued',deadline_at: null });
    expect((await f.owner.query('SELECT count(*)::int AS n FROM pipeline_budget_workflows')).rows[0].n).toBe(0);
  },profile);
},120000);
