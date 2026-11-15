import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { standupConsumerFixture as standupProducerFixture } from '../standup/test-helpers.js';
import { createMemory } from '../storage/memories.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { getPrincipal } from '../storage/principals.js';
import { readEventAnnotations, writeEventAnnotation } from '../storage/temporal.js';
import { parseEventAnnotation } from '../temporal/model.js';
import { requireEventTimeReady } from '../storage/provider-lifecycle.js';
import { prepareAgentsMdForPrincipal } from './agents-md.js';
import { offboardPrincipal } from './offboarding.js';

it('keeps manual annotation history and queued copies erasable under actual APP/OP authority', async () => {
  await standupProducerFixture(async f => {
    const source=await createMemory(f.app,{scopeId:f.scopeId,scopeKind:'user',authorId:f.actorId,type:'decision',title:'Owned source',body:'Original source wording',source:'manual'});
    const event=parseEventAnnotation({status:'ambiguous',original:'Private temporal wording',candidates:[{notation:'Private candidate date'}]});
    const first=await writeEventAnnotation(f.app,f.actorId,source.id,event);
    const second=await writeEventAnnotation(f.app,f.actorId,source.id,parseEventAnnotation({status:'unknown',original:'Corrected private notation'}));
    const project=await createScope(f.owner,{kind:'project',name:randomUUID()});
    await addMembership(f.owner,f.actorId,project.id,'writer');
    const copy=(await f.app.query('SELECT continuum_evidence_register($1,$2,NULL,$3,$4,$5,$6,$7) AS id',
      [f.actorId,randomUUID(),project.id,'queued-payload',JSON.stringify([{versionId:second.version,kind:'copy'}]),
        {transform:'event-copy-v1',model:'none',prompt:'none',schema:'v1'},'Queued private date candidate'])).rows[0].id;
    await requireEventTimeReady(f.app);
    await expect(f.app.query('SELECT * FROM memory_event_annotations')).rejects.toMatchObject({code:'42501'});
    await expect(f.app.query('SELECT * FROM memory_event_current')).rejects.toMatchObject({code:'42501'});
    const admin=(await getPrincipal(f.owner,f.adminId))!;
    const locker=await f.owner.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT version_id FROM evidence_payloads WHERE version_id=$1 FOR UPDATE',[first.version]);
      const incomplete=await offboardPrincipal(f.operator,admin,f.actorId,{confirmationScopeId:f.scopeId,batchSize:1});
      expect(incomplete.complete).toBe(false);
      expect((await locker.query('SELECT continuum_evidence_scope_is_erased($1) AS erased',[f.scopeId])).rows[0].erased).toBe(false);
    } finally { await locker.query('ROLLBACK');locker.release(); }
    let result=await offboardPrincipal(f.operator,admin,f.actorId,{confirmationScopeId:f.scopeId,batchSize:1});
    for(let i=0;!result.complete&&i<40;i++) result=await offboardPrincipal(f.operator,admin,f.actorId,{confirmationScopeId:f.scopeId,batchSize:1});
    expect(result.complete).toBe(true);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM evidence_payloads WHERE version_id=ANY($1::uuid[])',[[first.version,second.version,copy]])).rows[0].n).toBe(0);
    expect((await f.owner.query("SELECT count(*)::int AS n FROM evidence_state WHERE version_id=ANY($1::uuid[]) AND state<>'erased'",[[first.version,second.version,copy]])).rows[0].n).toBe(0);
    expect((await readEventAnnotations(f.app,f.actorId,[source.id])).get(source.id)).toBeNull();
  });
},120000);

it('excludes annotations and corrections from exact generator bytes, hashes and ETags', async () => {
  await standupProducerFixture(async f => {
    const project=await createScope(f.owner,{kind:'project',name:randomUUID()});await addMembership(f.owner,f.actorId,project.id,'writer');
    const source=await createMemory(f.app,{scopeId:project.id,scopeKind:'project',authorId:f.actorId,type:'decision',title:'Visible reference',body:'Escaped <reference> wording',source:'manual'});
    const actor=(await getPrincipal(f.owner,f.actorId))!;
    const before=await prepareAgentsMdForPrincipal(f.app,actor,{project:project.name});
    for(const event of [{status:'unknown',original:'Hidden event notation'}, {status:'ambiguous',candidates:[{notation:'Hidden candidate'}]}]) {
      await writeEventAnnotation(f.app,f.actorId,source.id,parseEventAnnotation(event));
      const after=await prepareAgentsMdForPrincipal(f.app,actor,{project:project.name});
      expect(after.markdown).toBe(before.markdown);expect(after.hash).toBe(before.hash);expect(after.etag).toBe(before.etag);
      expect(after.markdown).not.toContain('Hidden');
    }
    await f.owner.query('ALTER TABLE memory_event_annotations DISABLE TRIGGER memory_event_annotation_immutable');
    await expect(requireEventTimeReady(f.app)).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});
    await f.owner.query('ALTER TABLE memory_event_annotations ENABLE TRIGGER memory_event_annotation_immutable');
  });
},120000);
