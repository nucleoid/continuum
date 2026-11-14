import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { createMemory } from './memories.js';
import { captureMemory } from '../services/capture.js';
import { recallForPrincipal } from '../services/recall.js';
import { supersedeForPrincipal } from '../services/supersede.js';
import { promoteMemoryWithAudit } from './promote.js';
import { readEventAnnotations, writeEventAnnotation } from './temporal.js';
import { parseEventAnnotation, parseEventWindow } from '../temporal/model.js';
import { storeMemoryEmbeddingVector } from './embeddings.js';
import { hydrateRecallCandidates } from './recall.js';

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
    await storeMemoryEmbeddingVector(pool,good.memory.id,Array.from({length:768},(_,i)=>Number(i===1)),provider);
    for(let i=0;i<12;i++) {
      const decoy=await f.capture(annotation('2025-01-01T00:00:00Z'),'Signal signal signal');
      await storeMemoryEmbeddingVector(pool,decoy.memory.id,Array.from({length:768},(_,i)=>Number(i===0)),provider);
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
    expect((await recallForPrincipal(pool,null,f.actor,{query:'signal',eventFilter:{...filter,includeUnknown:true}})).results).toEqual([]);
    expect((await readEventAnnotations(pool,f.actor.id,[good.memory.id])).get(good.memory.id)).toBeNull();
    await writeEventAnnotation(pool,f.actor.id,good.memory.id,annotation());
    expect((await recallForPrincipal(pool,null,f.actor,{query:'signal',eventFilter:filter})).results).toHaveLength(1);
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
});
