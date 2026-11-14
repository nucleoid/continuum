import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { createMemory } from './memories.js';
import { readFileSync } from 'node:fs';

describe('immutable evidence and synchronous eligibility', () => {
  let pool: pg.Pool;
  beforeAll(async () => { pool = await makeTestPool(); }, 30_000);
  beforeEach(async () => { await resetData(pool); });
  afterAll(async () => { await pool?.end(); });
  async function fixture() {
    const actor = await createPrincipal(pool, { externalId: randomUUID(), kind: 'user', displayName: 'Evidence synthetic' });
    const scope = await createScope(pool, { kind: 'project', name: randomUUID() });
    await addMembership(pool, actor.id, scope.id, 'writer');
    const memory = await createMemory(pool, { scopeId: scope.id, scopeKind: scope.kind, authorId: actor.id,
      type: 'fact', title: 'Original', body: 'Canonical source', source: 'manual' });
    const source = (await pool.query('SELECT continuum_evidence_source($1,$2) AS id', [actor.id, memory.id])).rows[0].id as string;
    return { actor, scope, memory, source };
  }
  async function derive(f: Awaited<ReturnType<typeof fixture>>, parents = [f.source], node = randomUUID(), expected: string | null = null) {
    return (await pool.query('SELECT continuum_evidence_register($1,$2,$3,$4,$5,$6,$7,$8) AS id',
      [f.actor.id, node, expected, f.scope.id, 'derived-observation', JSON.stringify(parents.map(versionId => ({ versionId, kind: 'derivation' }))),
        { transform: 'synthetic-v1', model: 'none', prompt: 'none', schema: 'v1' }, 'Derived private prose'])).rows[0].id as string;
  }
  const eligible = async (actor: string, version: string) =>
    (await pool.query('SELECT continuum_evidence_eligible($1,$2,NULL) AS allowed', [actor, version])).rows[0].allowed;
  it('invalidates an entire diamond at source commit before any materialization', async () => {
    const f = await fixture(), left = await derive(f), right = await derive(f), tip = await derive(f, [left, right]);
    expect(await eligible(f.actor.id, tip)).toBe(true);
    expect((await pool.query('SELECT count(*)::int AS n FROM evidence_closure WHERE version_id=$1', [tip])).rows[0].n).toBe(4);
    await pool.query("UPDATE memories SET body='Changed by an older direct writer' WHERE id=$1", [f.memory.id]);
    expect(await eligible(f.actor.id, tip)).toBe(false);
    expect((await pool.query('SELECT state FROM evidence_state WHERE version_id=$1', [tip])).rows[0].state).toBe('active');
    await expect(derive(f, [tip])).rejects.toThrow(/unavailable/);
    expect((await pool.query('SELECT payload FROM evidence_payloads WHERE version_id=$1', [f.source])).rows[0].payload).toContain('Canonical source');
  });
  it('ignores operational metadata, creates immutable substantive versions and never renews the captured expiry', async () => {
    const f = await fixture(), derivative = await derive(f);
    await pool.query("UPDATE memories SET metadata=metadata||'{\"related\":[]}'::jsonb,updated_at=clock_timestamp() WHERE id=$1", [f.memory.id]);
    expect(await eligible(f.actor.id, derivative)).toBe(true);
    const old = (await pool.query('SELECT expires_at FROM evidence_versions WHERE id=$1', [f.source])).rows[0].expires_at;
    await pool.query("UPDATE memories SET expires_at=expires_at+interval '30 days' WHERE id=$1", [f.memory.id]);
    expect(await eligible(f.actor.id, derivative)).toBe(false);
    const fresh = (await pool.query('SELECT continuum_evidence_source($1,$2) AS id', [f.actor.id, f.memory.id])).rows[0].id;
    expect(fresh).not.toBe(f.source);
    expect((await pool.query('SELECT expires_at FROM evidence_versions WHERE id=$1', [fresh])).rows[0].expires_at).toEqual(old);
    await expect(pool.query("UPDATE evidence_versions SET kind='cache' WHERE id=$1", [f.source])).rejects.toThrow(/immutable/);
  });
  it('denies clock expiry, current membership loss and corrupt missing closure without hydrating', async () => {
    const f = await fixture(), derivative = await derive(f);
    await pool.query('UPDATE scope_memberships SET active=FALSE WHERE principal_id=$1 AND scope_id=$2', [f.actor.id, f.scope.id]);
    expect(await eligible(f.actor.id, derivative)).toBe(false);
    await addMembership(pool, f.actor.id, f.scope.id, 'writer');
    await pool.query('DELETE FROM evidence_closure WHERE version_id=$1 AND root_id=$2', [derivative, f.memory.id]);
    expect(await eligible(f.actor.id, derivative)).toBe(false);
    const other = await fixture(), timed = await derive(other);
    await pool.query("UPDATE memories SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [other.memory.id]);
    expect(await eligible(other.actor.id, timed)).toBe(false);
  });
  it('bounds parents and depth and fences current pointer compare-and-swap', async () => {
    const f = await fixture(), node = randomUUID(), first = await derive(f, [f.source], node);
    await expect(derive(f, [f.source], node)).rejects.toThrow(/current/);
    const next = await derive(f, [f.source], node, first);
    expect(await eligible(f.actor.id, first)).toBe(false);
    expect(await eligible(f.actor.id, next)).toBe(true);
    await expect(derive(f, Array(65).fill(f.source))).rejects.toThrow(/bounds/);
    await expect(derive(f, [f.source, f.source])).rejects.toThrow(/duplicate/);
    let parent = f.source;
    for (let depth = 1; depth <= 16; depth++) parent = await derive(f, [parent]);
    await expect(derive(f, [parent])).rejects.toThrow(/bounds/);
    await expect(derive(f, [next], node, next)).rejects.toThrow(/cycle/);
  });
  it('preserves original expiry and source authority through canonical direct-writer promotion', async () => {
    const f = await fixture();
    await pool.query("UPDATE memories SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1", [f.memory.id]);
    const destinationScope = await createScope(pool, { kind: 'project', name: randomUUID() });
    await addMembership(pool, f.actor.id, destinationScope.id, 'writer');
    const destination = await createMemory(pool, { scopeId: destinationScope.id, scopeKind: 'project', authorId: f.actor.id,
      type: 'fact', title: f.memory.title, body: f.memory.body, source: 'promote:manual', metadata: { promoted_from: f.memory.id } });
    await pool.query("UPDATE memories SET state='promoted',promoted_to_id=$2 WHERE id=$1", [f.memory.id,destination.id]);
    const version = (await pool.query('SELECT continuum_evidence_source($1,$2) AS id', [f.actor.id,destination.id])).rows[0].id;
    const ceiling = (await pool.query('SELECT expires_at FROM memories WHERE id=$1', [f.memory.id])).rows[0].expires_at;
    expect((await pool.query('SELECT expires_at FROM evidence_versions WHERE id=$1', [version])).rows[0].expires_at).toEqual(ceiling);
    expect(await eligible(f.actor.id,version)).toBe(true);
    const parent=(await pool.query('SELECT parent_id FROM evidence_edges WHERE version_id=$1',[version])).rows[0].parent_id;
    expect(await eligible(f.actor.id,parent)).toBe(true);
    expect((await pool.query(`SELECT root_id,generation FROM evidence_closure WHERE version_id=$1
      EXCEPT SELECT root_id,generation FROM evidence_closure WHERE version_id=$2`,[parent,version])).rows).toEqual([]);
    await pool.query('DELETE FROM scope_memberships WHERE principal_id=$1 AND scope_id=$2', [f.actor.id,f.scope.id]);
    expect(await eligible(f.actor.id,version)).toBe(false);
    const fake = await createMemory(pool, { scopeId: destinationScope.id, scopeKind: 'project', authorId: f.actor.id,
      type: 'fact', title: f.memory.title, body: f.memory.body, source: 'promote:manual', metadata: { promoted_from: f.memory.id } });
    await expect(pool.query('SELECT continuum_evidence_source($1,$2)', [f.actor.id,fake.id])).rejects.toThrow(/lineage/);
  });
  it('admits exactly 256 roots and rejects a larger closure before publishing', async () => {
    const f=await fixture();
    await pool.query(`INSERT INTO memories(id,scope_id,author_id,type,title,body,source)
      SELECT gen_random_uuid(),$1,$2,'decision','Bounded source','Body','manual' FROM generate_series(1,251)`,[f.scope.id,f.actor.id]);
    const sources=(await pool.query('SELECT continuum_evidence_source($1,id) AS id FROM memories WHERE scope_id=$2 ORDER BY id',[f.actor.id,f.scope.id])).rows.map(r=>r.id as string);
    const groups:string[]=[];
    for(let i=0;i<3;i++) groups.push(await derive(f,sources.slice(i*63,(i+1)*63)));
    const partial=await derive(f,sources.slice(189,251));
    const maximum=await derive(f,[...groups,partial]);
    expect((await pool.query('SELECT root_count FROM evidence_versions WHERE id=$1',[maximum])).rows[0].root_count).toBe(256);
    const full=await derive(f,sources.slice(189));
    const rejected=randomUUID();
    await expect(derive(f,[...groups,full],rejected)).rejects.toThrow(/bounds/);
    expect((await pool.query('SELECT count(*)::int AS n FROM evidence_roots WHERE id=$1',[rejected])).rows[0].n).toBe(0);
  },30000);
  it('keeps trusted promotion ancestry through later child edits and never snapshots stale upstream authority',async()=>{
    const f=await fixture();
    const copy=await createMemory(pool,{scopeId:f.scope.id,scopeKind:'project',authorId:f.actor.id,type:'fact',title:f.memory.title,
      body:f.memory.body,source:'promote:manual',metadata:{promoted_from:f.memory.id}});
    await pool.query("UPDATE memories SET state='promoted',promoted_to_id=$2 WHERE id=$1",[f.memory.id,copy.id]);
    const parent=(await pool.query('SELECT current_version FROM evidence_roots WHERE id=$1',[f.memory.id])).rows[0].current_version;
    await pool.query("UPDATE memories SET body='A later approved source edit' WHERE id=$1",[copy.id]);
    expect(await eligible(f.actor.id,parent)).toBe(true);
    const before=(await pool.query('SELECT count(*)::int AS n FROM evidence_versions WHERE root_id=$1',[copy.id])).rows[0].n;
    // Owner fault injection models a current upstream fence without granting
    // that private-table authority to ordinary runtime roles.
    await pool.query("UPDATE evidence_roots SET generation=generation+1,external_state='deny' WHERE id=$1",[f.memory.id]);
    await pool.query("UPDATE memories SET body='Cannot become a new admitted evidence version' WHERE id=$1",[copy.id]);
    expect((await pool.query('SELECT count(*)::int AS n FROM evidence_versions WHERE root_id=$1',[copy.id])).rows[0].n).toBe(before);
    await expect(pool.query('SELECT continuum_evidence_source($1,$2)',[f.actor.id,copy.id])).rejects.toThrow(/unavailable/);
  });
  it('linearizes registration against source writes and rolls source changes back with failed required guard audits', async () => {
    const f=await fixture(),held=await pool.connect(),writer=await pool.connect();
    try{
      await held.query('BEGIN');
      await held.query('SELECT continuum_evidence_register($1,$2,NULL,$3,$4,$5,$6,$7)',[f.actor.id,randomUUID(),f.scope.id,'cache',
        JSON.stringify([{versionId:f.source,kind:'copy'}]),{transform:'v1',model:'none',prompt:'none',schema:'v1'},'Bounded copy']);
      await writer.query("SET lock_timeout='100ms'");
      await expect(writer.query("UPDATE memories SET body='Racing change' WHERE id=$1",[f.memory.id])).rejects.toMatchObject({code:'55P03'});
      await held.query('COMMIT');
      await pool.query(`CREATE FUNCTION reject_evidence_guard_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.metadata->>'operation'='evidence_source_fenced' THEN RAISE EXCEPTION 'synthetic required audit failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_evidence_guard_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_evidence_guard_audit()`);
      try{
        await expect(writer.query("UPDATE memories SET body='Unaudited change' WHERE id=$1",[f.memory.id])).rejects.toThrow(/required audit/);
        expect((await pool.query('SELECT body FROM memories WHERE id=$1',[f.memory.id])).rows[0].body).toBe('Canonical source');
        expect(await eligible(f.actor.id,f.source)).toBe(true);
      }finally{await pool.query('DROP TRIGGER reject_evidence_guard_audit ON audit_log; DROP FUNCTION reject_evidence_guard_audit()');}
    }finally{await held.query('ROLLBACK');held.release();writer.release();}
  });
  it('denies missing external validity and non-finite source expiry in SQL as well as pure policy',async()=>{
    const f=await fixture();
    await expect(pool.query("UPDATE evidence_roots SET external_state='allow',checked_at=clock_timestamp(),valid_until=NULL WHERE id=$1",[f.memory.id])).rejects.toThrow();
    const memory=await createMemory(pool,{scopeId:f.scope.id,scopeKind:'project',authorId:f.actor.id,type:'fact',title:'Invalid expiry',body:'Body',source:'manual'});
    await pool.query("UPDATE memories SET expires_at='infinity'::timestamptz WHERE id=$1",[memory.id]);
    await expect(pool.query('SELECT continuum_evidence_source($1,$2)',[f.actor.id,memory.id])).rejects.toThrow();
  });
  const lifecycleCases=JSON.parse(readFileSync(new URL('../../evals/evidence-lifecycle-v1.json',import.meta.url),'utf8')) as Array<{id:string;mutation:string;payload:string}>;
  it.each(lifecycleCases)('separate lifecycle fixture $id denies disclosure/publication',async item=>{
    const f=await fixture(),version=await derive(f);
    if(item.mutation==='delete') await pool.query('DELETE FROM memories WHERE id=$1',[f.memory.id]);
    else if(item.mutation==='revoke') await pool.query("UPDATE memories SET state='stale' WHERE id=$1",[f.memory.id]);
    else {
      await expect(pool.query('SELECT continuum_evidence_register($1,$2,NULL,$3,$4,$5,$6,$7)',[f.actor.id,randomUUID(),f.scope.id,'unsupported-wording',
        JSON.stringify([{versionId:f.source,kind:'source'}]),{transform:'v1',model:'none',prompt:'none',schema:'v1'},item.payload])).rejects.toThrow(/kind/);
      return;
    }
    expect(await eligible(f.actor.id,version)).toBe(false);
    expect((await pool.query('SELECT continuum_evidence_payload($1,$2,NULL) AS payload',[f.actor.id,version])).rows[0].payload).toBeNull();
  });
});
