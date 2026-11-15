import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { briefFixture,syntheticBrief } from '../briefs/test-helpers.js';
import type { BriefInput,BriefClaim } from '../briefs/model.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { briefForPrincipal,refreshBrief } from '../services/briefs.js';
import { processBrief } from './briefs.js';

type Fixture=Parameters<Parameters<typeof briefFixture>[0]>[0];
const source=(f: Fixture,body: string,type: 'decision'|'fact'='decision') => createMemory(f.app,{
  scopeId: f.projectId,scopeKind: 'project',authorId: f.actorId,type,title: body,body,source: 'manual',
});
const enqueue=async (f: Fixture,key: string) => refreshBrief(f.app,(await getPrincipal(f.app,f.actorId))!,{
  project: f.projectName,mode: 'full',dryRun: false,idempotencyKey: key,
});
const identity=async (f: Fixture,run: string) => (await f.owner.query(
  'SELECT id,workflow_id,attempt_id,budget_owner,budget_generation,deadline_at FROM brief_runs WHERE id=$1',[run])).rows[0];

it('advances beyond a32-input page under one allowance and restarts for a lower-ID commit without skipping it',async () => {
  const seen=new Set<string>();
  const profile=syntheticBrief(async wire => {
    const input=JSON.parse(wire).input as BriefInput;
    for (const s of input.referenceData.sources) seen.add(JSON.parse(s.text).body);
    const claims: BriefClaim[]=input.sections.includes('decisions') ? [{ section: 'decisions',label: 'recorded_intent',
      text: input.referenceData.sources.map(s=>JSON.parse(s.text).body).sort().join('; '),unknown: false,contradiction: false,
      citations: input.referenceData.sources.slice(0,8).map(s=>({ version: s.version,quote: s.text.slice(0,80) })) }] : [];
    const value={ claims };return { value,response: value };
  });
  await briefFixture(async f => {
    for (let i=0;i<33;i++) await source(f,`PAGE-${i}`);
    const queued=await enqueue(f,'one-original-allowance');
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('progress');
    expect(seen.size).toBe(0);
    const original=await identity(f,queued.runId);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM brief_run_inputs WHERE run_id=$1',[queued.runId])).rows[0].n).toBe(32);
    const later=await source(f,'DELAYED-LOWER-ID');
    await f.owner.query("UPDATE memories SET id='00000000-0000-4000-8000-000000000099' WHERE id=$1",[later.id]);
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('progress');
    expect(await identity(f,queued.runId)).toEqual(original);
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    expect(await identity(f,queued.runId)).toEqual(original);
    expect(seen.size).toBe(34);expect(seen.has('DELAYED-LOWER-ID')).toBe(true);
    const run=(await f.owner.query('SELECT state,inventory_done,inventory_restarts,watermark,truncated FROM brief_runs WHERE id=$1',[queued.runId])).rows[0];
    expect(run).toMatchObject({ state: 'complete',inventory_done: true,inventory_restarts: 1,truncated: false });
    expect(run.watermark.complete).toBe(true);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM pipeline_budget_workflows')).rows[0].n).toBe(1);
    expect((await briefForPrincipal(f.app,(await getPrincipal(f.app,f.actorId))!,f.projectName)).coverage).toBe('complete');
  },profile);
},120000);

it('retains unchanged section bytes through a changed-input delta with independently bounded provider disclosure',async () => {
  let purposeCalls=0;const good=syntheticBrief();
  const profile=syntheticBrief(async (wire,caps) => {
    const input=JSON.parse(wire).input as BriefInput;
    if (input.sections.includes('purpose')) {
      purposeCalls++;expect(input.referenceData.sources.every(s=>JSON.parse(s.text).type!=='decision')).toBe(true);
    }
    if (input.sections.includes('decisions')) expect(input.referenceData.sources.every(s=>JSON.parse(s.text).type==='decision')).toBe(true);
    const result=await good.adapter.invoke(wire,caps);
    if (input.sections.includes('purpose')) {
      for (const claim of result.value.claims) claim.text+=` (render ${purposeCalls})`;
      result.response=result.value;
    }
    return result;
  });
  await briefFixture(async f => {
    const actor=(await getPrincipal(f.app,f.actorId))!;
    await source(f,'Stable scope statement','fact');
    const decision=await source(f,'Original decision');
    await enqueue(f,'initial');expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    const before=await briefForPrincipal(f.app,actor,f.projectName);
    const untouched=before.blocks.find(b=>b.section==='purpose');expect(untouched).toBeDefined();
    await f.owner.query("UPDATE memories SET body='Replacement decision' WHERE id=$1",[decision.id]);
    const invalidated=await briefForPrincipal(f.app,actor,f.projectName);
    expect(invalidated.blocks.find(b=>b.section==='purpose')).toEqual(untouched);
    expect(JSON.stringify(invalidated.blocks)).not.toContain('Original decision');
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    const after=await briefForPrincipal(f.app,actor,f.projectName);
    expect(after.blocks.find(b=>b.section==='purpose')).toEqual(untouched);expect(purposeCalls).toBe(1);
    expect(JSON.stringify(after.blocks)).toContain('Replacement decision');
    // The unchanged purpose block is supported only by its actual group inputs.
    const roots=(await f.owner.query(`SELECT m.type FROM brief_blocks b JOIN evidence_closure c ON c.version_id=b.evidence_version
      JOIN evidence_roots r ON r.id=c.root_id JOIN memories m ON m.id=r.source_memory_id
      WHERE b.version_id=$1 AND b.section='purpose'`,[after.version])).rows;
    expect(roots.map(r=>r.type)).toEqual(['fact']);
  },profile);
},120000);

it('recovers a settled automatic provider failure after durable backoff without replacing original identities or allowance',async () => {
  let failing=false;let calls=0;const good=syntheticBrief();
  const profile=syntheticBrief(async (...args) => {
    calls++;if (failing) { failing=false;throw new Error('synthetic settled outage'); }
    return good.adapter.invoke(...args);
  });
  await briefFixture(async f => {
    const memory=await source(f,'Initial decision');
    await enqueue(f,'initial');expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    await f.owner.query("UPDATE memories SET body='Recovered decision' WHERE id=$1",[memory.id]);failing=true;
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('unavailable');
    const row=(await f.owner.query("SELECT id,next_attempt_at,clock_timestamp() AS at FROM brief_runs WHERE automatic")).rows[0];
    const original=await identity(f,row.id),afterFailure=calls;
    expect((await f.owner.query('SELECT state,failures FROM brief_runs WHERE id=$1',[row.id])).rows[0]).toEqual({ state: 'queued',failures: 1 });
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('idle');expect(calls).toBe(afterFailure);
    const remaining=Math.max(0,new Date(row.next_attempt_at).getTime()-new Date(row.at).getTime());
    expect(remaining).toBeGreaterThan(0);expect(remaining).toBeLessThanOrEqual(1000);
    await new Promise(resolve=>setTimeout(resolve,remaining+25));
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    expect(await identity(f,row.id)).toEqual(original);
    const accounting=(await f.owner.query('SELECT w.used,w.active,w.cancelled FROM pipeline_budget_workflows w JOIN brief_runs j ON j.workflow_id=w.id WHERE j.id=$1',[row.id])).rows[0];
    expect(accounting).toMatchObject({ active: 0,cancelled: false,used: { calls: 3,retries: 2 } });
    const attempts=(await f.owner.query(`SELECT a.attempt_id,p.state,p.reserved,p.settlement FROM brief_run_attempts a
      JOIN pipeline_budget_attempts p ON p.workflow_id=$2 AND p.attempt_id=a.attempt_id WHERE a.run_id=$1 ORDER BY a.ordinal`,[row.id,original.workflow_id])).rows;
    expect(attempts).toHaveLength(3);expect(attempts[0].attempt_id).toBe(original.attempt_id);
    expect(attempts.every(a=>a.state==='settled')).toBe(true);
    expect(attempts[0].settlement).toEqual({ provenance: 'unknown' });
    expect(accounting.used.outputTokens).toBe(attempts.reduce((n,a)=>n+a.reserved.outputTokens,0));
    expect(JSON.stringify((await briefForPrincipal(f.app,(await getPrincipal(f.app,f.actorId))!,f.projectName)).blocks)).toContain('Recovered decision');
  },profile);
},120000);
