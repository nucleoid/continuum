import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { createMemory } from './memories.js';
import { captureMemory } from '../services/capture.js';
import { recallForPrincipal } from '../services/recall.js';
import { supersedeForPrincipal } from '../services/supersede.js';
import { promoteMemoryWithAudit, verifyMemory } from './promote.js';
import { readEventAnnotations, writeEventAnnotation } from './temporal.js';
import { parseEventAnnotation, parseEventWindow } from '../temporal/model.js';
import { seedEmbeddingVectorForTest } from '../embeddings/test-helpers.js';
import { hydrateRecallCandidates, recall } from './recall.js';
import { recallAuthorityMetadata } from './recall-authority.js';
import * as temporalStorage from './temporal.js';
import { listMemoriesForPrincipal } from '../services/memories.js';
import { Budget, starterProfile } from '../pipeline/budget.js';
import { MEMORY_READ_BUDGET_BYTES_SQL } from './memory-reads.js';
import { testReranking } from '../reranking/test-helpers.js';
import { RetrievalEnricherRegistry } from '../extensions/retrieval.js';

const annotation = (instant = '2026-02-01T00:00:00Z') => parseEventAnnotation({ status:'known', assertion:'asserted', precision:'instant', instant });
const filter = parseEventWindow({ from:'2026-02-01T00:00:00Z', to:'2026-03-01T00:00:00Z' });
describe('event annotations and candidate admission', () => {
  let pool: pg.Pool;
  beforeAll(async () => { pool = await makeTestPool(); },30000);
  beforeEach(async () => { await resetData(pool); });
  afterAll(async () => { await pool?.end(); });
  async function world() {
    const actor = await createPrincipal(pool,{externalId:randomUUID(),kind:'user',displayName:'Temporal writer'});
    const scope = await createScope(pool,{kind:'project',name:randomUUID()});
    await addMembership(pool,actor.id,scope.id,'writer');
    const capture = (eventAnnotation = annotation(), title = 'Signal') => captureMemory(pool,null,actor,{scope:{kind:scope.kind,name:scope.name},type:'decision',title,body:'Signal source wording unchanged',source:'manual',eventAnnotation});
    return {actor,scope,capture};
  }
  it('atomically persists exact source provenance, immutable corrections and original source bytes', async () => {
    const f = await world(), result = await f.capture();
    expect(result.memory.event?.annotation).toMatchObject({status:'known',instant:'2026-02-01T00:00:00.000Z'});
    const old = result.memory.event!;
    const next = await writeEventAnnotation(pool,f.actor.id,result.memory.id,annotation('2026-03-01T00:00:00Z'));
    expect(next.version).not.toBe(old.version); expect(next.sourceVersion).toBe(old.sourceVersion);
    expect((await pool.query('SELECT body,expires_at FROM memories WHERE id=$1',[result.memory.id])).rows[0]).toEqual({body:result.memory.body,expires_at:null});
    expect((await pool.query('SELECT previous_version FROM evidence_versions WHERE id=$1',[next.version])).rows[0].previous_version).toBe(old.version);
    expect((await pool.query('SELECT payload FROM evidence_payloads WHERE version_id=$1',[old.version])).rows[0].payload).toContain('2026-02-01');
    await expect(pool.query('UPDATE memory_event_annotations SET source_version=$2 WHERE version_id=$1',[next.version,old.sourceVersion])).rejects.toMatchObject({code:'23514'});
  });
  it('rolls memory, source, annotation and required audits back together', async () => {
    const f = await world();
    await pool.query(`CREATE FUNCTION fail_temporal_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.metadata->>'operation'='event_annotation_written' THEN RAISE EXCEPTION 'required audit rejected'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_temporal_test_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_temporal_test_audit()`);
    try { await expect(f.capture()).rejects.toThrow(); }
    finally { await pool.query('DROP TRIGGER fail_temporal_test_audit ON audit_log; DROP FUNCTION fail_temporal_test_audit()'); }
    for (const table of ['memories','evidence_payloads','memory_event_annotations','memory_event_current']) expect((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
  });
  it('filters before both lexical/vector limits and retains the predicate on provider fallback', async () => {
    const f = await world();
    const provider = {id:'temporal-local',dim:768,local:true,embed:async()=>[Array.from({length:768},(_,i)=>Number(i===0))]};
    const good = await f.capture();
    await seedEmbeddingVectorForTest(pool,pool,good.memory.id,Array.from({length:768},(_,i)=>Number(i===1)),provider);
    for(let i=0;i<12;i++) {
      const decoy=await f.capture(annotation('2025-01-01T00:00:00Z'),'Signal signal signal');
      await seedEmbeddingVectorForTest(pool,pool,decoy.memory.id,Array.from({length:768},(_,i)=>Number(i===0)),provider);
    }
    for(const embedding of [null,provider,{...provider,embed:async():Promise<number[][]>=>{throw new Error('unavailable');}}]) {
      const result=await recallForPrincipal(pool,embedding,f.actor,{query:'signal',eventFilter:filter,limit:1});
      expect(result.results.map(r=>r.memory.id)).toEqual([good.memory.id]);
    }
  });
  it('rechecks source mutation during hydration and final serving', async () => {
    const f = await world(), good = await f.capture();
    await pool.query("UPDATE memories SET body='Changed source signal' WHERE id=$1",[good.memory.id]);
    expect(await hydrateRecallCandidates(pool,[good.memory.id],'signal',new Map(),[f.scope.id],undefined,undefined,undefined,false,filter,f.actor.id)).toEqual([]);
    const unknown=await recallForPrincipal(pool,null,f.actor,{query:'signal',eventFilter:{...filter,includeUnknown:true}});
    expect(unknown.results.map(r=>r.memory.id)).toEqual([good.memory.id]);
    expect((await readEventAnnotations(pool,f.actor.id,[good.memory.id])).get(good.memory.id)).toEqual({annotation:{status:'unknown'},version:null,sourceVersion:null});
    await writeEventAnnotation(pool,f.actor.id,good.memory.id,annotation());
    expect((await recallForPrincipal(pool,null,f.actor,{query:'signal',eventFilter:filter})).results).toHaveLength(1);
  });
  it('keeps verified sources visible as unknown without reviving old annotation authority', async () => {
    const f=await world(), good=await f.capture();
    await verifyMemory(pool,f.actor.id,good.memory.id,false);
    await verifyMemory(pool,f.actor.id,good.memory.id,true);
    expect((await recallForPrincipal(pool,null,f.actor,{query:'signal'})).results.map(r=>r.memory.id)).toEqual([good.memory.id]);
    for(const input of [{eventWindow:filter},{eventFilter:{...filter,includeUnknown:true}}]) {
      const result=await recallForPrincipal(pool,null,f.actor,{query:'signal',...input});
      expect(result.results.map(r=>r.memory.id)).toEqual([good.memory.id]);
      expect(result.results[0].memory.event).toEqual({annotation:{status:'unknown'},version:null,sourceVersion:null});
    }
    expect((await listMemoriesForPrincipal(pool,f.actor,{eventFilter:{...filter,includeUnknown:true}})).items.map(r=>r.memory.id)).toEqual([good.memory.id]);
    expect((await recall(pool,{actor:f.actor.id,query:'signal',scopeIds:[f.scope.id],limit:10,eventWindow:filter})).results.map(r=>r.memory.id)).toEqual([good.memory.id]);
    expect((await recallForPrincipal(pool,null,f.actor,{query:'signal',eventFilter:filter})).results).toEqual([]);
    await pool.query('DELETE FROM scope_memberships WHERE principal_id=$1 AND scope_id=$2',[f.actor.id,f.scope.id]);
    expect((await recallForPrincipal(pool,null,f.actor,{query:'signal',eventWindow:filter})).results).toEqual([]);
  });
  it('does not charge optional temporal reads to ordinary reranked recall', async () => {
    const f=await world();
    for(let i=0;i<2;i++) await createMemory(pool,{scopeId:f.scope.id,scopeKind:'project',authorId:f.actor.id,type:'decision',title:'Signal',body:'Signal source',source:'manual'});
    const bytes=Number((await pool.query(`SELECT sum(${MEMORY_READ_BUDGET_BYTES_SQL})::bigint AS bytes FROM memories m WHERE scope_id=$1`,[f.scope.id])).rows[0].bytes)+1024;
    const t=testReranking(()=>1),config=t.config(),budget=new Budget(config.profile);
    budget.consume({hydratedBytes:budget.available('hydratedBytes')-bytes-512});
    const result=await recallForPrincipal(pool,null,f.actor,{query:'signal',limit:2},{},undefined,undefined,budget,config);
    expect(result.results).toHaveLength(2);expect(t.adapter.invoke).toHaveBeenCalledOnce();
    expect(budget.available('hydratedBytes')).toBe(512);
  });
  it('admits temporal delivery before spending a reranker call', async () => {
    const f=await world();await f.capture();await f.capture();
    const bytes=Number((await pool.query(`SELECT sum(${MEMORY_READ_BUDGET_BYTES_SQL})::bigint AS bytes FROM memories m WHERE scope_id=$1`,[f.scope.id])).rows[0].bytes)+1024;
    const t=testReranking(()=>1),config=t.config(),budget=new Budget(config.profile);
    budget.consume({hydratedBytes:budget.available('hydratedBytes')-bytes-512});
    await expect(recallForPrincipal(pool,null,f.actor,{query:'signal',limit:2,eventWindow:filter},{},undefined,undefined,budget,config)).rejects.toThrow();
    expect(t.adapter.invoke).not.toHaveBeenCalled();
  });
  it('selects hinted candidates before hydrating a bounded final page', async () => {
    const f=await world();
    for(let i=0;i<50;i++) await createMemory(pool,{scopeId:f.scope.id,scopeKind:'project',authorId:f.actor.id,type:'decision',title:'Signal',body:'Signal '+ 'x'.repeat(24000),source:'manual'});
    const options={registry:new RetrievalEnricherRegistry(),options:{},readBudgetBytes:1024*1024};
    expect((await recallForPrincipal(pool,null,f.actor,{query:'signal',limit:10},{},undefined,options)).results).toHaveLength(10);
    expect((await recallForPrincipal(pool,null,f.actor,{query:'signal',limit:10,eventWindow:filter},{},undefined,options)).results).toHaveLength(10);
    expect((await recall(pool,{actor:f.actor.id,query:'signal',scopeIds:[f.scope.id],limit:10,eventWindow:filter,readBudgetBytes:1024*1024})).results).toHaveLength(10);
  });
  it('uses the hint to select the overlapping member of a relevance tie', async () => {
    const f=await world(),first=await f.capture(),second=await f.capture();
    const sorted=[first.memory.id,second.memory.id].sort(),target=sorted[1];
    await writeEventAnnotation(pool,f.actor.id,sorted[0],annotation('2025-01-01T00:00:00Z'));
    const provider={id:'temporal-tie',dim:768,local:true,embed:async()=>[Array.from({length:768},(_,i)=>Number(i===0))]};
    for(const id of sorted) await seedEmbeddingVectorForTest(pool,pool,id,Array.from({length:768},(_,i)=>Number(i===(id===target?0:1))),provider);
    const result=await recallForPrincipal(pool,provider,f.actor,{query:'signal',limit:1,eventWindow:filter});
    expect(result.results.map(r=>r.memory.id)).toEqual([target]);
  });
  it('returns a bounded dependency failure on temporal authority lock contention', async () => {
    const f=await world(),good=await f.capture(),held=await pool.connect();
    try {
      await held.query('BEGIN');await held.query('SELECT id FROM memories WHERE id=$1 FOR UPDATE',[good.memory.id]);
      await expect(recallForPrincipal(pool,null,f.actor,{query:'signal',eventWindow:filter})).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});
    } finally {await held.query('ROLLBACK');held.release();}
  });
  it('does not infer successor time and never revives a superseded decision', async () => {
    const f=await world(), predecessor=await f.capture(annotation('2099-01-01T00:00:00Z'));
    const successor=await supersedeForPrincipal(pool,null,f.actor,{supersededId:predecessor.memory.id,title:'Signal successor',body:'Signal current decision'});
    const result=await recallForPrincipal(pool,null,f.actor,{query:'signal',eventFilter:parseEventWindow({at:'2099-01-01T00:00:00Z',includeUnknown:true})});
    expect(result.results.map(r=>r.memory.id)).toEqual([successor.successor.id]);
    expect(result.results[0].memory.event?.annotation.status).toBe('unknown');
  });
  it('copies only canonical promotion evidence and keeps inherited source authority', async () => {
    const f=await world(), original=await f.capture();
    const target=await createScope(pool,{kind:'project',name:randomUUID()}); await addMembership(pool,f.actor.id,target.id,'writer');
    const result=await promoteMemoryWithAudit(pool,f.actor.id,original.memory.id,{kind:'project',name:target.name});
    expect(result.destination.event?.annotation).toEqual(original.memory.event!.annotation);
    expect(result.destination.event?.sourceVersion).not.toBe(original.memory.event!.sourceVersion);
    await pool.query('DELETE FROM scope_memberships WHERE principal_id=$1 AND scope_id=$2',[f.actor.id,f.scope.id]);
    expect((await recallForPrincipal(pool,null,f.actor,{query:'signal',eventFilter:filter})).results).toEqual([]);
  });
  it('keeps future events within lifecycle expiry and rejects unknown authority', async () => {
    const f=await world(), good=await f.capture(annotation('2099-01-01T00:00:00Z'));
    await pool.query("UPDATE memories SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[good.memory.id]);
    expect((await recallForPrincipal(pool,null,f.actor,{query:'signal',eventFilter:parseEventWindow({at:'2099-01-01T00:00:00Z'})})).results).toEqual([]);
  });
  it('retains the final limit for direct low-level hint callers', async () => {
    const f=await world();await f.capture();await f.capture(annotation('2025-01-01T00:00:00Z'));
    const result=await recall(pool,{actor:f.actor.id,query:'signal',scopeIds:[f.scope.id],limit:1,eventWindow:filter});
    expect(result.results).toHaveLength(1);
  });
  it('labels explicitly included historical unknowns for direct recall callers', async () => {
    const f=await world();
    const memory=await createMemory(pool,{scopeId:f.scope.id,scopeKind:'project',authorId:f.actor.id,type:'decision',title:'Signal',body:'Signal historical source',source:'manual'});
    const result=await recall(pool,{actor:f.actor.id,query:'signal',scopeIds:[f.scope.id],limit:10,eventFilter:{...filter,includeUnknown:true}});
    expect(result.results.find(r=>r.memory.id===memory.id)?.memory.event?.annotation.status).toBe('unknown');
  });
  it('rechecks hard filters during metadata admission before optional reranking', async () => {
    const f=await world(), old=await f.capture(annotation('2025-01-01T00:00:00Z'));
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await recallAuthorityMetadata(client,f.actor.id,[old.memory.id],[f.scope.id],filter)).toEqual([]);
    } finally {await client.query('ROLLBACK');client.release();}
  });
  it('removes a newly nonmatching annotation before browse delivery and audits', async () => {
    const f=await world(), good=await f.capture();
    const original=temporalStorage.readEventAnnotations;
    const spy=vi.spyOn(temporalStorage,'readEventAnnotations').mockImplementationOnce(async(...args)=>{
      await writeEventAnnotation(pool,f.actor.id,good.memory.id,annotation('2025-01-01T00:00:00Z'));
      return original(...args);
    });
    try {
      expect((await listMemoriesForPrincipal(pool,f.actor,{scope:`project:${f.scope.name}`,eventFilter:filter})).items).toEqual([]);
    } finally {spy.mockRestore();}
  });
  it('suppresses delivery when the shared budget is cancelled during final commit', async () => {
    const f=await world();await f.capture();const budget=new Budget(starterProfile);
    const wrapped=new Proxy(pool,{get(target,key){
      if(key==='connect') return async()=>{
        const client=await target.connect();
        return new Proxy(client,{get(connection,property){
          if(property==='query') return async(...args:unknown[])=>{
            const result=await Reflect.apply(connection.query,connection,args);
            if(args[0]==='COMMIT') budget.cancel();return result;
          };
          const value=Reflect.get(connection,property,connection);return typeof value==='function'?value.bind(connection):value;
        }});
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(recallForPrincipal(wrapped,null,f.actor,{query:'signal'}, {},undefined,undefined,budget))
      .rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read' AND query='signal'")).rows[0].n).toBeGreaterThan(0);
  });
});
