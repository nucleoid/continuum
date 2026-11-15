import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { briefFixture,syntheticBrief } from './test-helpers.js';
import type { BriefInput } from './model.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { briefForPrincipal,briefHistoryForPrincipal,refreshBrief } from '../services/briefs.js';
import { processBrief } from '../workers/briefs.js';

it('inherits every disclosed input even when an untrusted model omits one citation',async () => {
  const profile=syntheticBrief(async wire=>{
    const input=JSON.parse(wire).input as BriefInput;
    if (!input.sections.includes('decisions')) { const value={ claims: [] };return { value,response: value }; }
    const cited=input.referenceData.sources.find(s=>JSON.parse(s.text).body==='Cited source A')!;
    // Syntax/citation validation is not a natural-language alignment judge.
    // The uncited input must still restrict the entire generated block.
    const value={ claims: [{ section: 'decisions' as const,label: 'recorded_intent' as const,text: 'UNCITED SENSITIVE SOURCE B',
      unknown: false,contradiction: false,citations: [{ version: cited.version,quote: cited.text.slice(0,100) }] }] };
    return { value,response: value };
  });
  // An undeclared isolation contract keeps the conservative whole-input call
  // and dependencies, even though the fixture implementation itself is local.
  profile.isolation=undefined;
  await briefFixture(async f=>{
    const actor=(await getPrincipal(f.app,f.actorId))!;
    for (const body of ['Cited source A','UNCITED SENSITIVE SOURCE B']) await createMemory(f.app,{ scopeId: f.projectId,scopeKind: 'project',authorId: actor.id,type: body==='Cited source A' ? 'decision' : 'fact',title: body,body,source: 'manual' });
    await refreshBrief(f.app,actor,{ project: f.projectName,mode: 'full',dryRun: false,idempotencyKey: 'all-inputs' });
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    expect(JSON.stringify(await briefForPrincipal(f.app,actor,f.projectName))).toContain('UNCITED SENSITIVE SOURCE B');
    const root=(await f.owner.query("SELECT r.id FROM evidence_roots r JOIN memories m ON m.id=r.source_memory_id WHERE m.body='UNCITED SENSITIVE SOURCE B'")).rows[0].id;
    await f.operator.query("SELECT continuum_operator_evidence_policy($1,$2,'any','deny',NULL,NULL)",[f.adminId,root]);
    expect(JSON.stringify(await briefForPrincipal(f.app,actor,f.projectName))).not.toContain('UNCITED SENSITIVE SOURCE B');
    expect(JSON.stringify(await briefHistoryForPrincipal(f.app,actor,f.definitionId))).not.toContain('UNCITED SENSITIVE SOURCE B');
  },profile);
},120000);
