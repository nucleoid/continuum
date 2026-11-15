import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { briefFixture,syntheticBrief } from './test-helpers.js';
import { createMemory } from '../storage/memories.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { getPrincipal } from '../storage/principals.js';
import { briefForPrincipal,briefHistoryForPrincipal,refreshBrief } from '../services/briefs.js';
import { processBrief } from '../workers/briefs.js';
import { briefDescriptor } from './provider.js';
import { registerEvidence } from '../services/evidence.js';
import { EvidencePayloadRegistry } from '../evidence/model.js';
import { materializeEvidence } from '../workers/evidence.js';

it('intersects the explicit project audience before processing, excluding privileged user/team/assertion inputs',async () => {
  let texts: string[]=[];const good=syntheticBrief();
  const profile=syntheticBrief(async (serialized,caps) => { texts=JSON.parse(serialized).input.referenceData.sources.map((s: { text: string })=>s.text);return good.adapter.invoke(serialized,caps); });
  await briefFixture(async f => {
    const actor=(await getPrincipal(f.app,f.actorId))!;
    const team=await createScope(f.owner,{ kind: 'team',name: `private-${randomUUID()}` });
    for (const who of [actor.id,f.producerId]) { await addMembership(f.owner,who,team.id,'writer');await addMembership(f.owner,who,f.scopeId,'writer'); }
    const privateSource=await createMemory(f.app,{ scopeId: f.scopeId,scopeKind: 'user',authorId: actor.id,type: 'decision',title: 'Personal',body: 'PERSONAL EXCLUDED',source: 'manual' });
    await createMemory(f.app,{ scopeId: team.id,scopeKind: 'team',authorId: actor.id,type: 'decision',title: 'Team only',body: 'TEAM EXCLUDED',source: 'manual' });
    await createMemory(f.app,{ scopeId: f.projectId,scopeKind: 'project',authorId: actor.id,type: 'decision',title: 'Shared',body: 'PROJECT ALLOWED',source: 'manual' });
    const sourceVersion=(await f.app.query('SELECT continuum_evidence_source($1,$2) AS id',[actor.id,privateSource.id])).rows[0].id;
    const owners=new EvidencePayloadRegistry();owners.register('extracted-assertion',()=>true);
    await registerEvidence(f.app,actor.id,{ nodeId: randomUUID(),expectedCurrent: null,scopeId: f.projectId,kind: 'extracted-assertion',parents: [{ versionId: sourceVersion,kind: 'source' }],
      identity: { transform: 'synthetic',model: 'synthetic',prompt: 'synthetic',schema: 'synthetic' },payload: '{"assertion":{"text":"PERSONAL ASSERTION EXCLUDED"}}' },owners);
    await refreshBrief(f.app,actor,{ project: f.projectName,mode: 'full',dryRun: false,idempotencyKey: 'audience' });
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    expect(texts.join()).toContain('PROJECT ALLOWED');expect(texts.join()).not.toContain('EXCLUDED');
    expect(JSON.stringify(await briefForPrincipal(f.app,actor,f.projectName))).not.toContain('EXCLUDED');
  },profile);
},120000);

it('does not accept role switching, UUIDs, custom GUCs, APP or extraction authority as a worker LOGIN',async () => {
  await briefFixture(async f => {
    await expect(f.app.query('SELECT continuum_brief_claim($1,$2,$3)',[f.profile.id,randomUUID(),briefDescriptor(f.profile)])).rejects.toMatchObject({ code: '42501' });
    const owner=await f.owner.connect();
    try {
      await owner.query('BEGIN');await owner.query(`SET LOCAL ROLE "${f.workerRole}"`);
      await owner.query("SELECT set_config('continuum.worker_principal',$1,TRUE)",[f.producerId]);
      await expect(owner.query('SELECT continuum_brief_claim($1,$2,$3)',[f.profile.id,randomUUID(),briefDescriptor(f.profile)])).rejects.toMatchObject({ code: '42501' });
    } finally { await owner.query('ROLLBACK');owner.release(); }
    await expect(f.worker.query('SELECT body FROM memories')).rejects.toMatchObject({ code: '42501' });
    await expect(f.worker.query('SELECT continuum_extraction_claim($1,$2,$3)',[f.profile.id,randomUUID(),briefDescriptor(f.profile)])).rejects.toMatchObject({ code: '42501' });
  });
},120000);

it('suppresses output and rolls back read success audits when final wire validation or cancellation fails',async () => {
  await briefFixture(async f => {
    const actor=(await getPrincipal(f.app,f.actorId))!;
    const before=(await f.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE metadata->>'operation'='brief_read'")).rows[0].n;
    await expect(briefForPrincipal(f.app,actor,f.projectName,{ validateResult: () => { throw new Error('synthetic wire rejection'); } })).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    const controller=new AbortController();controller.abort();
    await expect(briefForPrincipal(f.app,actor,f.projectName,{ signal: controller.signal })).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect((await f.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE metadata->>'operation'='brief_read'")).rows[0].n).toBe(before);
  });
},120000);

it('fences current/history on expiry without a sweeper and erases block hashes with managed payloads',async () => {
  await briefFixture(async f => {
    const actor=(await getPrincipal(f.app,f.actorId))!;
    const memory=await createMemory(f.app,{ scopeId: f.projectId,scopeKind: 'project',authorId: actor.id,type: 'decision',title: 'Ephemeral',body: 'ERASABLE WORDS',source: 'manual' });
    await f.owner.query("UPDATE memories SET expires_at=clock_timestamp()+interval '3 seconds' WHERE id=$1",[memory.id]);
    await refreshBrief(f.app,actor,{ project: f.projectName,mode: 'full',dryRun: false,idempotencyKey: 'expiry' });
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    expect((await briefForPrincipal(f.app,actor,f.projectName)).blocks).toHaveLength(1);
    await f.owner.query('SELECT pg_sleep(3)');
    expect((await briefForPrincipal(f.app,actor,f.projectName)).blocks).toEqual([]);
    expect(JSON.stringify(await briefHistoryForPrincipal(f.app,actor,f.definitionId))).not.toContain('ERASABLE WORDS');
    await f.owner.query('DELETE FROM memories WHERE id=$1',[memory.id]);
    for (let i=0;i<10;i++) await materializeEvidence(f.app,{ owner: randomUUID(),pageSize: 100,deadlineMs: 1000 });
    expect((await f.owner.query('SELECT count(*)::int AS n FROM brief_blocks')).rows[0].n).toBe(0);
    expect((await f.owner.query("SELECT count(*)::int AS n FROM evidence_payloads WHERE payload LIKE '%ERASABLE WORDS%'")).rows[0].n).toBe(0);
  });
},120000);
