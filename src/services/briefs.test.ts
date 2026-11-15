import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { briefFixture } from '../briefs/test-helpers.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal,createPrincipal } from '../storage/principals.js';
import { addMembership } from '../storage/memberships.js';
import { briefForPrincipal,briefHistoryForPrincipal,refreshBrief } from './briefs.js';
import { processBrief } from '../workers/briefs.js';
import { prepareAgentsMdForPrincipal } from './agents-md.js';

it('publishes immutable source-cited briefs, converges full/delta, preserves AGENTS bytes and keeps dry runs off the head',async () => {
  await briefFixture(async f => {
    const actor=(await getPrincipal(f.app,f.actorId))!;
    await createMemory(f.app,{ scopeId: f.projectId,scopeKind: 'project',authorId: actor.id,type: 'decision',title: 'Recorded plan',body: 'Use PostgreSQL.',source: 'manual' });
    const before=await prepareAgentsMdForPrincipal(f.app,actor,{ project: f.projectName });
    const request={ project: f.projectName,mode: 'full',dryRun: false,idempotencyKey: 'first' };
    const queued=await refreshBrief(f.app,actor,request);
    expect(await refreshBrief(f.app,actor,request)).toEqual(queued);
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    const first=await briefForPrincipal(f.app,actor,f.projectName);
    expect(first).toMatchObject({ status: 'available',fresh: true,coverage: 'complete',implementation: 'unknown' });
    expect(first.blocks).toHaveLength(1);
    const completed=await refreshBrief(f.app,actor,request);
    expect(completed.runId).toBe(queued.runId);expect(completed.status).toBe('complete');
    await refreshBrief(f.app,actor,{ ...request,mode: 'delta',idempotencyKey: 'delta' });
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    const delta=await briefForPrincipal(f.app,actor,f.projectName);expect(delta.blocks).toEqual(first.blocks);
    await refreshBrief(f.app,actor,{ ...request,dryRun: true,idempotencyKey: 'preview' });
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    expect((await briefForPrincipal(f.app,actor,f.projectName)).version).toBe(delta.version);
    const preview=await refreshBrief(f.app,actor,{ ...request,dryRun: true,idempotencyKey: 'preview' });
    expect(preview).toMatchObject({ status: 'complete',dryRun: true,result: { blocks: first.blocks } });
    const history=await briefHistoryForPrincipal(f.app,actor,f.definitionId,{ limit: 1 });
    expect(history.items).toHaveLength(1);expect(history.nextCursor).toEqual(expect.any(String));
    const second=await briefHistoryForPrincipal(f.app,actor,f.definitionId,{ limit: 1,cursor: history.nextCursor as string });
    expect(second.items).toHaveLength(1);expect(second.nextCursor).toBeNull();
    const after=await prepareAgentsMdForPrincipal(f.app,actor,{ project: f.projectName });
    expect(after.markdown).toBe(before.markdown);expect(after.etag).toBe(before.etag);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM memories')).rows[0].n).toBe(1);
  });
},120000);

it('withholds entire current/history/dry-run blocks after policy changes and denies revoked readers',async () => {
  await briefFixture(async f => {
    const actor=(await getPrincipal(f.app,f.actorId))!;
    const memory=await createMemory(f.app,{ scopeId: f.projectId,scopeKind: 'project',authorId: actor.id,type: 'decision',title: 'Sensitive plan',body: 'PRIVATE BRIEF WORDS',source: 'manual' });
    const request={ project: f.projectName,mode: 'full',dryRun: false,idempotencyKey: 'published' };
    await refreshBrief(f.app,actor,request);expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    await refreshBrief(f.app,actor,{ ...request,dryRun: true,idempotencyKey: 'preview' });expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    const root=(await f.owner.query('SELECT id FROM evidence_roots WHERE source_memory_id=$1',[memory.id])).rows[0].id;
    await f.operator.query("SELECT continuum_operator_evidence_policy($1,$2,'any','deny',NULL,NULL)",[f.adminId,root]);
    for (const result of [await briefForPrincipal(f.app,actor,f.projectName),await briefHistoryForPrincipal(f.app,actor,f.definitionId),
      await refreshBrief(f.app,actor,{ ...request,dryRun: true,idempotencyKey: 'preview' })]) {
      expect(JSON.stringify(result)).not.toContain('PRIVATE BRIEF WORDS');expect(JSON.stringify(result)).not.toContain(root);
    }
    const reader=await createPrincipal(f.owner,{ externalId: randomUUID(),kind: 'user',displayName: 'Brief reader' });
    await addMembership(f.owner,reader.id,f.projectId,'reader');expect((await briefForPrincipal(f.app,reader,f.projectName)).blocks).toEqual([]);
    await expect(refreshBrief(f.app,reader,request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await f.owner.query('UPDATE scope_memberships SET active=FALSE WHERE principal_id=$1',[reader.id]);
    await expect(briefForPrincipal(f.app,reader,f.projectName)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
},120000);
