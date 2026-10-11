import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { acquireLease, renewLease, releaseLease } from '../services/coordination.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { makeTestPool, resetData } from './test-helpers.js';
import { reconcilePgvectorProviderGrants, requireCoordinationContractReady } from './provider-lifecycle.js';

async function fixture(kind:'hash'|'interval'|'clock',run:(owner:pg.Pool,application:pg.Pool,schema:string,principal:Awaited<ReturnType<typeof createPrincipal>>,scope:Awaited<ReturnType<typeof createScope>>)=>Promise<void>){
  const owner=await makeTestPool();await resetData(owner);
  const suffix=randomUUID().replaceAll('-','');const app='builtin_app_'+suffix;
  const attacker='builtin_owner_'+suffix;const schema='builtin_later_'+suffix;
  let application:pg.Pool|undefined;
  try {
    await owner.query(`CREATE ROLE "${app}" NOLOGIN; CREATE ROLE "${attacker}" NOLOGIN;
      CREATE SCHEMA "${schema}" AUTHORIZATION "${attacker}"`);
    const principal=await createPrincipal(owner,{externalId:randomUUID(),kind:'service',displayName:'Application'});
    const scope=await createScope(owner,{kind:'project',name:suffix});
    await addMembership(owner,principal.id,scope.id,'writer');
    const script=(await readFile(join(process.cwd(),'scripts/grant-application-role.sql'),'utf8')).split(/\r?\n/)
      .filter((line)=>!line.trimStart().startsWith('\\')).join('\n')
      .replaceAll(':"continuum_schema"','"public"').replaceAll(":'continuum_schema'","'public'")
      .replaceAll(':"continuum_app_role"',`"${app}"`).replaceAll(":'continuum_app_role'",`'${app}'`);
    await owner.query(script);
    const creator=await owner.connect();
    try {
      await creator.query(`SET ROLE "${attacker}"`);
      await creator.query(`CREATE SEQUENCE "${schema}".calls`);
      const body=kind==='hash'
        ? `CREATE FUNCTION "${schema}".hashtextextended(text,integer) RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN PERFORM pg_catalog.nextval('"${schema}".calls'); RETURN 13; END $$`
        : kind==='interval'
          ? `CREATE FUNCTION "${schema}".make_interval(secs text) RETURNS interval LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN PERFORM pg_catalog.nextval('"${schema}".calls'); RETURN interval '1 year'; END $$`
          : `CREATE FUNCTION "${schema}".clock_timestamp() RETURNS timestamptz LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN PERFORM pg_catalog.nextval('"${schema}".calls'); RETURN '2000-01-01T00:00:00Z'::timestamptz; END $$`;
      await creator.query(body);
      await creator.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${app}";
        GRANT USAGE ON SEQUENCE "${schema}".calls TO "${app}"`);
    }finally{await creator.query('RESET ROLE');creator.release();}
    application=new pg.Pool({...(owner as unknown as {options:pg.PoolConfig}).options,max:1,
      options:`-c search_path=public,${schema}${kind==='clock'?',pg_catalog':''} -c role=${app}`});
    await run(owner,application,schema,principal,scope);
  }finally{
    await application?.end();
    await owner.query('DELETE FROM continuum_pgvector_role_profiles WHERE database_role_oid=(SELECT oid FROM pg_roles WHERE rolname=$1)',[app]);
    await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; DROP OWNED BY "${app}","${attacker}";
      DROP ROLE IF EXISTS "${app}"; DROP ROLE IF EXISTS "${attacker}"`);
    await owner.end();
  }
}

it.each(['hash','interval'] as const)('uses real catalog %s semantics against a later differently-typed overload',async(kind)=>{
  await fixture(kind,async(owner,application,schema,principal,scope)=>{
    // Library gates deliberately retain their documented unanchored mode; the
    // direct service SQL must still select catalog primitives, not invoker code.
    await reconcilePgvectorProviderGrants(application);
    await requireCoordinationContractReady(application);
    const runId=randomUUID();
    const result=await acquireLease(application,principal,{scope:'project:'+scope.name,resource:'builtin',runId,requestId:randomUUID(),ttlSeconds:30});
    expect(result.acquired).toBe(true);if(!result.acquired)throw new Error('expected acquisition');
    expect(new Date(result.expiresAt).getTime()-new Date(result.serverTime).getTime()).toBe(30_000);
    const renewal=await renewLease(application,principal,{leaseId:result.leaseId,runId,requestId:randomUUID(),ttlSeconds:60});
    expect(new Date(renewal.expiresAt).getTime()-new Date(renewal.serverTime).getTime()).toBe(60_000);
    await releaseLease(application,principal,{leaseId:result.leaseId,runId,requestId:randomUUID()});
    expect((await owner.query(`SELECT is_called FROM "${schema}".calls`)).rows).toEqual([{is_called:false}]);
  });
},60_000);

it('rejects an anchored path with explicit catalog after a hostile zero-argument shadow',async()=>{
  await fixture('clock',async(owner,application,schema)=>{
    expect((await application.query("SELECT clock_timestamp()='2000-01-01T00:00:00Z'::timestamptz AS shadowed")).rows)
      .toEqual([{shadowed:true}]);
    await owner.query(`ALTER SEQUENCE "${schema}".calls RESTART WITH 1`);
    await expect(reconcilePgvectorProviderGrants(application,{expectedSchema:'public'})).rejects.toThrow(/runtime application schema.*trust/i);
    await expect(requireCoordinationContractReady(application,{expectedSchema:'public'})).rejects.toThrow(/runtime application schema.*trust/i);
    expect((await owner.query(`SELECT is_called FROM "${schema}".calls`)).rows).toEqual([{is_called:false}]);
  });
},60_000);
