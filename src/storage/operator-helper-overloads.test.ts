import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { mapOwnedUserScope, offboardPrincipal } from '../services/offboarding.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';
import { makeTestPool, resetData } from './test-helpers.js';

it('selects the approved UUID get-run helper instead of a later hostile text overload', async()=>{
  const owner=await makeTestPool();await resetData(owner);
  const suffix=randomUUID().replaceAll('-','');const role='operator_overload_'+suffix;
  const attacker='later_owner_'+suffix;const schema='operator_later_'+suffix;
  let connection:pg.Pool|undefined;
  try {
    await owner.query(`CREATE ROLE "${role}" NOLOGIN; CREATE ROLE "${attacker}" NOLOGIN;
      GRANT "${role}" TO CURRENT_USER WITH ADMIN OPTION, SET FALSE, INHERIT FALSE;
      CREATE SCHEMA "${schema}" AUTHORIZATION "${attacker}"`);
    const actor=await createPrincipal(owner,{externalId:randomUUID(),kind:'user',displayName:'Operator'});
    const target=await createPrincipal(owner,{externalId:randomUUID(),kind:'user',displayName:'Target'});
    const org=(await getScopeByRef(owner,{kind:'org',name:''}))!;
    const owned=await createScope(owner,{kind:'user',name:'owned-'+randomUUID()});
    await addMembership(owner,actor.id,org.id,'admin');await addMembership(owner,target.id,owned.id,'writer');
    await mapOwnedUserScope(owner,actor,target.id,owned.id);
    for (const filename of ['grant-application-role.sql','grant-operator-role.sql']) {
      let script=(await readFile(join(process.cwd(),'scripts',filename),'utf8')).split(/\r?\n/)
        .filter((line)=>!line.trimStart().startsWith('\\')).join('\n')
        .replaceAll(':"continuum_schema"','"public"').replaceAll(":'continuum_schema'","'public'");
      for (const [name,value] of Object.entries({continuum_app_role:role,continuum_operator_role:role,continuum_principal_id:actor.id})) {
        script=script.replaceAll(':"'+name+'"','"'+value+'"').replaceAll(":'"+name+"'","'"+value+"'");
      }
      await owner.query(script);
    }
    const creator=await owner.connect();
    try {
      await creator.query(`SET ROLE "${attacker}"`);
      await creator.query(`CREATE SEQUENCE "${schema}".invocations;
        CREATE FUNCTION "${schema}".continuum_operator_get_offboarding_run(text,text)
        RETURNS SETOF public.principal_offboarding_runs LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN
          PERFORM nextval('"${schema}".invocations'); RETURN; END $$;
        GRANT USAGE ON SCHEMA "${schema}" TO "${role}";
        GRANT USAGE ON SEQUENCE "${schema}".invocations TO "${role}"`);
    } finally {await creator.query('RESET ROLE');creator.release();}
    connection=new pg.Pool({...(owner as unknown as {options:pg.PoolConfig}).options,
      max:1,options:`-c search_path=public,${schema} -c role=${role}`});
    // Calling this approved path uses a real DB-bound least-privilege operator.
    // The diagnostic survives any rollback caused by the hostile empty result.
    const outcome=await offboardPrincipal(connection,actor,target.id,{confirmationScopeId:owned.id,batchSize:100})
      .then((result)=>({ok:true as const,result}),(error:unknown)=>({ok:false as const,error}));
    expect((await owner.query(`SELECT is_called FROM "${schema}".invocations`)).rows).toEqual([{is_called:false}]);
    if(!outcome.ok)throw outcome.error;
    let result=outcome.result;
    for(let batch=0;batch<20&&!result.complete;batch++)result=await offboardPrincipal(connection,actor,target.id,{confirmationScopeId:owned.id,batchSize:100});
    expect(result.complete).toBe(true);
    expect((await owner.query('SELECT disabled_at IS NOT NULL AS disabled,offboarded_at IS NOT NULL AS erased FROM principals WHERE id=$1::uuid',[target.id])).rows)
      .toEqual([{disabled:true,erased:true}]);
    expect((await owner.query(`SELECT count(*)::int AS active FROM scope_memberships WHERE principal_id=$1::uuid AND active`,[target.id])).rows)
      .toEqual([{active:0}]);
  } finally {
    await connection?.end();
    await owner.query('DELETE FROM continuum_pgvector_role_profiles WHERE database_role_oid=(SELECT oid FROM pg_roles WHERE rolname=$1)',[role]);
    await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; DROP OWNED BY "${role}","${attacker}";
      REVOKE "${role}" FROM CURRENT_USER; DROP ROLE IF EXISTS "${role}"; DROP ROLE IF EXISTS "${attacker}"`);
    await owner.end();
  }
},60000);
