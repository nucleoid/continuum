import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { expect, it } from 'vitest';
import { createPrincipal } from './principals.js';
import { makeTestPool, resetData } from './test-helpers.js';

it('plans the installed seven-key privacy audit probe with its matching partial index under a generic plan',async()=>{
  const pool=await makeTestPool();await resetData(pool);
  let client:pg.PoolClient|undefined;
  try {
    const clean=await createPrincipal(pool,{externalId:randomUUID(),kind:'user',displayName:'Clean history'});
    const dirty=await createPrincipal(pool,{externalId:randomUUID(),kind:'user',displayName:'Legacy numeric audit'});
    await pool.query(`INSERT INTO audit_log(principal_id,action,metadata)
      SELECT $1::uuid,'read',jsonb_build_object('operation','lock_inspect','outcome','available','transport','rest')
      FROM generate_series(1,50000)`,[clean.id]);
    await pool.query(`INSERT INTO audit_log(principal_id,action,metadata)
      VALUES($1::uuid,'read',jsonb_build_object('operation','lock_inspect','resource_bytes',37))`,[dirty.id]);
    const source=String((await pool.query(`SELECT prosrc FROM pg_catalog.pg_proc
      WHERE oid='continuum_coordination_privacy_actual_state_is_erased(uuid,uuid)'::regprocedure`)).rows[0].prosrc);
    const probe=source.match(/NOT EXISTS \(\s*(SELECT 1 FROM audit_log audit[\s\S]*?)\)\s*AND NOT EXISTS/);
    if(!probe)throw new Error('installed authoritative privacy audit probe was not found');
    const sql=probe[1].replace(/\btarget_principal_id\b/g,'$1::uuid');
    client=await pool.connect();
    await client.query('BEGIN');await client.query("SET LOCAL plan_cache_mode='force_generic_plan'");
    await client.query('ANALYZE audit_log');
    await client.query('PREPARE coordination_installed_privacy_probe(uuid) AS SELECT EXISTS ('+sql+') AS dirty');
    for(const [principal,expected]of[[clean,false],[dirty,true]]as const){
      const result=await client.query(`EXECUTE coordination_installed_privacy_probe('${principal.id}'::uuid)`);
      expect(result.rows).toEqual([{dirty:expected}]);
      const plan=await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
        EXECUTE coordination_installed_privacy_probe('${principal.id}'::uuid)`);
      const nodes:Record<string,unknown>[]=[];
      const walk=(value:unknown):void=>{
        if(!value||typeof value!=='object')return;
        if(Array.isArray(value)){value.forEach(walk);return;}
        const node=value as Record<string,unknown>;nodes.push(node);Object.values(node).forEach(walk);
      };
      walk(plan.rows[0]['QUERY PLAN']);
      expect(nodes.map((node)=>node['Index Name']).filter(Boolean))
        .toContain('audit_log_coordination_privacy_linkable_v7_idx');
    }
    await client.query('DEALLOCATE coordination_installed_privacy_probe');await client.query('COMMIT');
  }finally{
    if(client){await client.query('ROLLBACK').catch(()=>undefined);client.release();}
    await pool.end();
  }
},120000);
