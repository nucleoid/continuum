import { createHash,randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { expect,it } from 'vitest';
import { briefFixture,syntheticBrief } from '../briefs/test-helpers.js';
import type { BriefInput,BriefClaim,BriefBlock } from '../briefs/model.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { briefForPrincipal,refreshBrief } from '../services/briefs.js';
import { processBrief } from '../workers/briefs.js';
import { registerEvidence } from '../services/evidence.js';
import { EvidencePayloadRegistry } from '../evidence/model.js';
import { scoreClaims,type Claim } from './test-helpers.js';

it('measures persisted synthetic claim alignment, precision, budgets and full/delta ablations without model qualification',async () => {
  const bytes=await readFile(resolve('evals/project-briefs-v1.json')),spec=JSON.parse(bytes.toString());
  const rows: Record<string,unknown>[]=[],failures={ spendMicros: 0,convergenceFailures: 0 };
  let previous: unknown;let expected: Claim[]=[];let calls=0;
  const profile=syntheticBrief(async wire => {
    calls++;const input=JSON.parse(wire).input as BriefInput;
    const entries=input.referenceData.sources.map(s=>({ source: s,body: JSON.parse(s.text).body as string | undefined }));
    const claims: BriefClaim[]=[];
    for (const { source,body } of entries) {
      if (body?.startsWith('INTENT:') && input.sections.includes('decisions')) claims.push({ section: 'decisions',label: 'recorded_intent',text: body,unknown: false,contradiction: false,citations: [{ version: source.version,quote: source.text.slice(0,100) }] });
      if (body?.startsWith('UNKNOWN:') && input.sections.includes('implementation')) claims.push({ section: 'implementation',label: 'inference',text: body,unknown: true,contradiction: false,citations: [{ version: source.version,quote: source.text.slice(0,100) }] });
    }
    const conflicts=entries.filter(e=>e.body?.startsWith('CONFLICT:'));
    if (conflicts.length===2 && input.sections.includes('unknowns')) claims.push({ section: 'unknowns',label: 'inference',text: 'Supported accounts conflict',unknown: false,contradiction: true,
      citations: conflicts.map(e=>({ version: e.source.version,quote: e.source.text.slice(0,100) })) });
    const value={ claims };return { value,response: value };
  });
  const judgments=new Map([['INTENT:Keep fixed expiry','intent'],['UNKNOWN:Implementation proof','unknown'],['Supported accounts conflict','conflict']]);
  await briefFixture(async f => {
    const actor=(await getPrincipal(f.app,f.actorId))!,sources: Array<{ id: string;version: string }>=[];
    for (const body of ['INTENT:Keep fixed expiry','UNKNOWN:Implementation proof','CONFLICT:Use UTC','CONFLICT:Use local time']) {
      const memory=await createMemory(f.app,{ scopeId: f.projectId,scopeKind: 'project',authorId: actor.id,type: 'decision',title: 'Synthetic evaluation',body,source: 'manual' });
      const version=(await f.app.query('SELECT continuum_evidence_source($1,$2) AS id',[actor.id,memory.id])).rows[0].id;
      sources.push({ id: memory.id,version });
    }
    expected=[{ id: 'intent',label: 'recorded-intent',unknown: false,contradiction: null,evidence: [{ id: sources[0].id,version: sources[0].version }] },
      { id: 'unknown',label: 'inference',unknown: true,contradiction: null,evidence: [{ id: sources[1].id,version: sources[1].version }] },
      { id: 'conflict',label: 'inference',unknown: false,contradiction: 'conflict',evidence: sources.slice(2).map(s=>({ id: s.id,version: s.version })) }];
    for (const variant of spec.variants as string[]) {
      if (variant==='duplicate-extraction') {
        const owners=new EvidencePayloadRegistry();owners.register('extracted-assertion',()=>true);
        await registerEvidence(f.app,actor.id,{ nodeId: randomUUID(),expectedCurrent: null,scopeId: f.projectId,kind: 'extracted-assertion',
          parents: [{ versionId: sources[0].version,kind: 'source' }],identity: { transform: 'synthetic',model: 'synthetic',prompt: 'synthetic',schema: 'synthetic' },
          payload: '{"assertion":{"text":"Duplicate source family, not independent proof"}}' },owners);
      }
      for (const mode of spec.modes as Array<'full'|'delta'>) {
        const timings: number[]=[],accounting: unknown[]=[];let metrics: ReturnType<typeof scoreClaims> | undefined;
        for (let sample=0;sample<spec.samples;sample++) {
          const started=performance.now(),before=calls;
          await refreshBrief(f.app,actor,{ project: f.projectName,mode,dryRun: false,idempotencyKey: `${variant}-${mode}-${sample}` });
          expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
          const result=await briefForPrincipal(f.app,actor,f.projectName);timings.push(performance.now()-started);
          const blocks=result.blocks as BriefBlock[];
          const actual: Claim[]=blocks.map((block,index)=>({ id: judgments.get(block.text) ?? `unexpected-${index}`,
            label: block.label.replaceAll('_','-') as Claim['label'],unknown: block.unknown,contradiction: block.contradiction ? 'conflict' : null,
            evidence: block.citations.map(c=>({ id: sources.find(s=>s.version===c.version)?.id ?? 'unexpected',version: c.version })) }));
          metrics=scoreClaims(actual,expected);
          for (const key of ['alignment','labelAccuracy','unknownPrecision','contradictionPrecision','falseUnknowns','falseContradictions'] as const) expect(metrics[key]).toBe(spec.gates[key]);
          if (previous!==undefined && JSON.stringify(previous)!==JSON.stringify(blocks)) failures.convergenceFailures++;
          previous=blocks;
          const durable=(await f.owner.query('SELECT w.used,w.active,w.deadline_at,j.attempt_id,j.workflow_id FROM brief_runs j JOIN pipeline_budget_workflows w ON w.id=j.workflow_id ORDER BY j.created_at DESC LIMIT 1')).rows[0];
          expect(durable.active).toBe(0);expect(durable.used.calls).toBe(calls-before);failures.spendMicros+=durable.used.spendMicros;
          accounting.push(durable);
        }
        timings.sort((a,b)=>a-b);rows.push({ variant,mode,metrics,samples: timings.length,p50Ms: timings[2],p95Ms: timings[4],accounting });
      }
    }
  },profile);
  expect(failures).toEqual({ spendMicros: 0,convergenceFailures: 0 });
  const requested=process.env.CONTINUUM_BRIEF_EVAL_REPORT;
  if (requested) {
    const path=resolve(requested);if (dirname(path)!==resolve('.fire-off') || !path.endsWith('.json')) throw new Error('Brief report must be new task-local JSON');
    const head=execFileSync('git',['rev-parse','HEAD'],{ encoding: 'utf8' }).trim();
    if (execFileSync('git',['status','--porcelain'],{ encoding: 'utf8' }).trim() || process.env.CONTINUUM_EVAL_SOURCE_SHA!==head) throw new Error('Brief report requires clean exact source identity');
    await writeFile(path,JSON.stringify({ version: spec.version,fixtureSha256: createHash('sha256').update(bytes).digest('hex'),head,rows,failures,
      profile: profile.version,model: profile.adapter.model,prompt: spec.prompt,schema: spec.schema,qualification: spec.qualification,
      realModelQualified: false,pairedPerformanceQualified: false,normalizedStorageQualified: false,connectorQualification: 'absent, implementation unknown' },null,2)+'\n',{ flag: 'wx' });
  }
},120000);
