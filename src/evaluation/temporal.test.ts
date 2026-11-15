import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { expect, it } from 'vitest';
import { withEvaluationFixture, seededOrder, scoreRetrieval, latencyPolicy, sha256 } from './test-helpers.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { writeEventAnnotation } from '../storage/temporal.js';
import { parseEventAnnotation, parseEventWindow } from '../temporal/model.js';
import { recallForPrincipal } from '../services/recall.js';
import { supersedeForPrincipal } from '../services/supersede.js';

it('measures event filters separately from hint ranking and unknown-date false exclusion', async () => {
  const bytes=await readFile('evals/event-time-v1.json'),spec=JSON.parse(bytes.toString());
  const git=(...args:string[])=>execFileSync('git',['-C',process.cwd(),...args],{encoding:'utf8',timeout:5000}).trim();
  const head=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}'),cleanStart=!git('status','--porcelain');
  const observations:Array<Record<string,any>>=[];
  const started=performance.now();let setupMs=0,workMs=0,postgresVersion='';
  await withEvaluationFixture(process.env.CONTINUUM_TEST_DATABASE_URL ?? 'postgres://continuum:continuum@localhost:5433/continuum',async({owner,app,actor})=>{
    postgresVersion=(await owner.query("SELECT current_setting('server_version_num') AS version")).rows[0].version;
    const worlds=[];
    for(const item of spec.cases) {
      const scope=await createScope(owner,{kind:'project',name:`event-eval-${item.id}`});await addMembership(owner,actor.id,scope.id,'writer');
      const primary=await createMemory(app,{scopeId:scope.id,scopeKind:'project',authorId:actor.id,type:'decision',title:'Temporal signal',body:'Temporal signal primary source',source:'manual'});
      if(item.event) await writeEventAnnotation(app,actor.id,primary.id,parseEventAnnotation(item.event));
      if(item.ingestedAt) await owner.query('UPDATE memories SET created_at=$2 WHERE id=$1',[primary.id,item.ingestedAt]);
      if(item.archived) await supersedeForPrincipal(app,null,actor,{supersededId:primary.id,title:'Successor decision',body:'Current independently supplied wording'});
      const decoy=await createMemory(app,{scopeId:scope.id,scopeKind:'project',authorId:actor.id,type:'decision',title:'Temporal signal decoy',body:'Temporal signal historical source',source:'manual'});
      await writeEventAnnotation(app,actor.id,decoy.id,parseEventAnnotation({status:'known',assertion:'asserted',precision:'instant',instant:'2025-01-01T00:00:00Z'}));
      worlds.push({id:item.id,item,scope,primary,decoy});
    }
    setupMs=performance.now()-started;expect(setupMs).toBeLessThan(spec.setupDeadlineMs);
    const workStarted=performance.now();
    for(let repetition=0;repetition<=latencyPolicy.repetitions;repetition++) {
      for(const world of seededOrder(worlds,spec.seed+repetition)) for(const {id:mode} of seededOrder((spec.modes as string[]).map(id=>({id})),spec.seed+repetition)) {
        const {item,scope,primary,decoy}=world;
        const window=parseEventWindow({at:item.at ?? '2026-02-01T00:00:00Z',includeUnknown:mode==='include-unknown'});
        const before=performance.now();
        const result=await recallForPrincipal(app,null,actor,{query:'temporal signal',scopes:[`project:${scope.name}`],limit:spec.finalLimit,
          ...(mode==='hard'||mode==='include-unknown'?{eventFilter:window}:{}),...(mode==='hint'?{eventWindow:window}:{})});
        const latencyMs=performance.now()-before,ids=result.results.map(r=>r.memory.id);
        const expected=mode==='hard'?(item.knownMatch?[primary.id]:[]):mode==='include-unknown'?(item.archived?[]:[primary.id]):item.archived?[decoy.id]:[primary.id,decoy.id];
        expect(new Set(ids)).toEqual(new Set(expected));
        const relevant=item.archived?[]:[{id:'primary',version:'1',grade:3,family:'primary'}];
        const metrics=scoreRetrieval(ids.map(id=>({id:id===primary.id?'primary':'decoy',version:'1'})),relevant);
        observations.push({id:item.id,mode,repetition,warmup:repetition===0,latencyMs,metrics,
          falseExclusions:Number(!item.archived&&!ids.includes(primary.id)),securityFailures:Number(item.archived===true&&ids.includes(primary.id)),
          bytes:Buffer.byteLength(JSON.stringify(result.results)),calls:0,spendMicros:0});
        expect(observations.at(-1)!.bytes).toBeLessThanOrEqual(65536);
      }
    }
    workMs=performance.now()-workStarted;expect(workMs).toBeLessThan(spec.workDeadlineMs);
  });
  const median=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const rows=spec.cases.flatMap((item:any)=>spec.modes.map((mode:string)=>{
    const measured=observations.filter(o=>o.id===item.id&&o.mode===mode&&!o.warmup);
    expect(measured).toHaveLength(latencyPolicy.repetitions);
    return {id:item.id,mode,latencyMs:median(measured.map(o=>o.latencyMs)),metrics:measured[0].metrics,
      falseExclusions:measured[0].falseExclusions,securityFailures:measured[0].securityFailures};
  }));
  const summaries=spec.modes.map((mode:string)=>{
    const selected=rows.filter((row:any)=>row.mode===mode),times=selected.map((row:any)=>row.latencyMs).sort((a:number,b:number)=>a-b);
    return {mode,queries:selected.length,p50Ms:median(times),p95Ms:times[Math.ceil(times.length*.95)-1],
      falseExclusions:selected.reduce((n:number,row:any)=>n+row.falseExclusions,0),
      meanNdcg:selected.reduce((n:number,row:any)=>n+(row.metrics.ndcg??0),0)/selected.length};
  });
  const report={version:spec.version,head,tree,sourceHead:process.env.CONTINUUM_EVAL_SOURCE_SHA ?? null,headEnd:git('rev-parse','HEAD'),cleanStart,cleanEnd:!git('status','--porcelain'),
    fixtureSha256:sha256(bytes),seed:spec.seed,latencyPolicy,setupMs,workMs,observations,rows,summaries,
    runtime:{node:process.version,platform:process.platform,arch:process.arch,postgresVersion},
    synthesisQuality:'not_supported',realModelQualified:false,pairedPerformanceQualified:false,normalizedStorageQualified:false,
    executionOrderSha256:sha256(JSON.stringify(observations.map(o=>[o.id,o.mode,o.repetition]))),qualification:spec.qualification};
  expect(report.headEnd).toBe(head);expect(observations.every(o=>o.securityFailures===0)).toBe(true);
  const serialized=JSON.stringify(report)+'\n';expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(spec.maximumArtifactBytes);
  const requested=process.env.CONTINUUM_TEMPORAL_EVAL_REPORT;
  if(requested) {
    const output=resolve(requested);
    if(dirname(output)!==resolve('.fire-off')||!output.endsWith('.json')||!cleanStart||!report.cleanEnd||report.sourceHead!==head) throw new Error('Temporal report requires clean exact task source and fresh task-local output');
    await writeFile(output,serialized,{flag:'wx'});
  }
},300000);
