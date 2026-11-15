import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect,it } from 'vitest';
import { briefFixture,syntheticBrief } from './test-helpers.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { briefForPrincipal,refreshBrief } from '../services/briefs.js';
import { offboardPrincipal } from '../services/offboarding.js';
import { processBrief } from '../workers/briefs.js';
import type { BriefInput,BriefClaim } from './model.js';

it('finishes a bounded multi-page allowance honestly partial without renewing it on each poll',async () => {
  const profile=syntheticBrief(async wire=>{
    const input=JSON.parse(wire).input as BriefInput;
    const claims: BriefClaim[]=input.sections.includes('decisions') ? [{ section: 'decisions',label: 'recorded_intent',
      text: input.referenceData.sources.map(s=>JSON.parse(s.text).body).sort().join('; '),unknown: false,contradiction: false,
      citations: input.referenceData.sources.slice(0,8).map(s=>({ version: s.version,quote: s.text.slice(0,80) })) }] : [];
    const value={ claims };return { value,response: value };
  });
  await briefFixture(async f => {
    const actor=(await getPrincipal(f.app,f.actorId))!;
    for (let i=0;i<64;i++) await createMemory(f.app,{ scopeId: f.projectId,scopeKind: 'project',authorId: actor.id,type: 'decision',title: `Plan ${i}`,body: `Recorded plan ${i}`,source: 'manual' });
    await refreshBrief(f.app,actor,{ project: f.projectName,mode: 'full',dryRun: false,idempotencyKey: 'bounded' });
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('progress');
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    const result=await briefForPrincipal(f.app,actor,f.projectName);
    expect(result.blocks).toHaveLength(1);expect(result.coverage).toBe('partial');expect(result.watermark).toBeNull();
    const run=(await f.owner.query('SELECT observed,watermark,truncated FROM brief_runs')).rows[0];
    expect(run.observed).not.toBeNull();expect(run.watermark.complete).toBe(false);expect(run.truncated).toBe(true);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM brief_run_inputs')).rows[0].n).toBe(63);
    const used=(await f.owner.query('SELECT used FROM pipeline_budget_workflows')).rows[0].used;
    expect(used.candidates).toBeGreaterThanOrEqual(63);expect(used.candidates).toBeLessThanOrEqual(f.profile.budget.limits.candidates);
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('idle');
    expect((await f.owner.query('SELECT count(*)::int AS n FROM pipeline_budget_workflows')).rows[0].n).toBe(1);
  },profile);
},120000);

it('binds explicit event metadata to its exact current version and never revives an old annotation after source change',async () => {
  const inputs: string[]=[];const good=syntheticBrief();
  const profile=syntheticBrief(async (...args) => { inputs.push(args[0]);return good.adapter.invoke(...args); });
  await briefFixture(async f => {
    const actor=(await getPrincipal(f.app,f.actorId))!;
    const memory=await createMemory(f.app,{ scopeId: f.projectId,scopeKind: 'project',authorId: actor.id,type: 'decision',title: 'Event plan',body: 'Date recorded explicitly',source: 'manual' });
    const annotation={ status: 'known',assertion: 'asserted',precision: 'instant',instant: '2030-01-01T00:00:00.000Z' };
    const event=(await f.app.query('SELECT continuum_event_write($1,$2,$3) AS result',[actor.id,memory.id,annotation])).rows[0].result;
    await refreshBrief(f.app,actor,{ project: f.projectName,mode: 'full',dryRun: false,idempotencyKey: 'event' });
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    expect(inputs[0]).toContain(event.version);expect(inputs[0]).toContain('2030-01-01');
    const firstCalls=inputs.length;
    await f.owner.query("UPDATE memories SET body='Updated plan, date unknown' WHERE id=$1",[memory.id]);
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    expect(inputs.slice(firstCalls).length).toBeGreaterThan(0);
    for (const input of inputs.slice(firstCalls)) { expect(input).not.toContain(event.version);expect(input).not.toContain('2030-01-01'); }
  },profile);
},120000);

it('erases all historical/dry-run block bytes and hashes by owned-source lineage and refuses completion across locked run gaps',async () => {
  await briefFixture(async f => {
    const actor=(await getPrincipal(f.app,f.actorId))!,admin=(await getPrincipal(f.app,f.adminId))!;
    const memory=await createMemory(f.app,{ scopeId: f.projectId,scopeKind: 'project',authorId: actor.id,type: 'decision',title: 'Moved source',body: 'OWNED ERASE ME',source: 'manual' });
    for (const [index,dryRun] of [false,false,true].entries()) {
      await refreshBrief(f.app,actor,{ project: f.projectName,mode: 'full',dryRun,idempotencyKey: `history-${index}` });
      expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    }
    await f.owner.query('UPDATE memories SET scope_id=$2 WHERE id=$1',[memory.id,f.scopeId]);
    expect((await briefForPrincipal(f.app,actor,f.projectName)).blocks).toEqual([]);
    const schema=(await f.owner.query('SELECT current_schema() AS name')).rows[0].name;
    const lock=new pg.Client({ connectionString: process.env.CONTINUUM_TEST_DATABASE_URL!,options: `-c search_path=${schema}` });
    await lock.connect();
    try {
      await lock.query('BEGIN');await lock.query('SELECT id FROM brief_runs FOR UPDATE');
      let result=await offboardPrincipal(f.operator,admin,f.actorId,{ confirmationScopeId: f.scopeId,batchSize: 100 });
      expect(result.complete).toBe(false);
      expect((await f.owner.query('SELECT continuum_brief_scope_is_erased($1) AS clean',[f.scopeId])).rows[0].clean).toBe(false);
      await lock.query('ROLLBACK');
      for (let i=0;!result.complete && i<30;i++) result=await offboardPrincipal(f.operator,admin,f.actorId,{ confirmationScopeId: f.scopeId,batchSize: 100 });
      expect(result.complete).toBe(true);
      expect((await f.owner.query('SELECT count(*)::int AS n FROM brief_blocks')).rows[0].n).toBe(0);
      expect((await f.owner.query("SELECT count(*)::int AS n FROM evidence_payloads WHERE payload LIKE '%OWNED ERASE ME%'")).rows[0].n).toBe(0);
      expect((await f.owner.query("SELECT count(*)::int AS n FROM brief_runs WHERE state<>'cancelled'")).rows[0].n).toBe(0);
      expect((await f.owner.query('SELECT continuum_brief_scope_is_erased($1) AS clean',[f.scopeId])).rows[0].clean).toBe(true);
      expect((await offboardPrincipal(f.operator,admin,f.actorId,{ confirmationScopeId: f.scopeId })).alreadyOffboarded).toBe(true);
    } finally { await lock.query('ROLLBACK');await lock.end(); }
  });
},120000);
