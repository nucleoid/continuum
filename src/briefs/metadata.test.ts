import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { briefFixture,syntheticBrief } from './test-helpers.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { registerEvidence } from '../services/evidence.js';
import { EvidencePayloadRegistry } from '../evidence/model.js';
import { briefForPrincipal,refreshBrief } from '../services/briefs.js';
import { processBrief } from '../workers/briefs.js';

it('keeps excluded private evidence out of visible freshness, watermarks, history and automatic synthesis',async () => {
  let calls=0;const good=syntheticBrief();const profile=syntheticBrief(async (...args)=>{ calls++;return good.adapter.invoke(...args); });
  await briefFixture(async f => {
    const actor=(await getPrincipal(f.app,f.actorId))!;
    await createMemory(f.app,{ scopeId: f.projectId,scopeKind: 'project',authorId: actor.id,type: 'decision',title: 'Shared',body: 'Shared recorded source',source: 'manual' });
    await refreshBrief(f.app,actor,{ project: f.projectName,mode: 'full',dryRun: false,idempotencyKey: 'shared' });
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    const initialCalls=calls;expect(initialCalls).toBeGreaterThan(0);
    const before=await briefForPrincipal(f.app,actor,f.projectName);
    const privateSource=await createMemory(f.app,{ scopeId: f.scopeId,scopeKind: 'user',authorId: actor.id,type: 'decision',title: 'Private',body: 'HIDDEN MUST NOT AFFECT METADATA',source: 'manual' });
    const source=(await f.app.query('SELECT continuum_evidence_source($1,$2) AS id',[actor.id,privateSource.id])).rows[0].id;
    const owners=new EvidencePayloadRegistry();owners.register('extracted-assertion',()=>true);
    await registerEvidence(f.app,actor.id,{ nodeId: randomUUID(),expectedCurrent: null,scopeId: f.projectId,kind: 'extracted-assertion',
      parents: [{ versionId: source,kind: 'source' }],identity: { transform: 'synthetic',model: 'synthetic',prompt: 'synthetic',schema: 'synthetic' },
      payload: '{"assertion":{"text":"Private derivative in a shared scope"}}' },owners);
    expect(await briefForPrincipal(f.app,actor,f.projectName)).toEqual(before);
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    expect(await briefForPrincipal(f.app,actor,f.projectName)).toEqual(before);
    expect(calls).toBe(initialCalls);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM brief_versions')).rows[0].n).toBe(1);
  },profile);
},120000);
