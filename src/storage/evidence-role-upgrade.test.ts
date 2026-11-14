import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from './migrator.js';
import { createPrincipal } from './principals.js';
import { getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';
import { requireEvidenceReady } from './provider-lifecycle.js';

it('upgrades real APP/OP/SYNC profiles without raw payload grants and refuses trusted-body drift at startup', async () => {
  const suffix=randomUUID().replaceAll('-','').slice(0,12),schema=`evidence_upgrade_${suffix}`;
  const roles=['app','op','sync'].map(k=>`evidence_${k}_${suffix}`),password=randomUUID();
  const url=process.env.CONTINUUM_TEST_DATABASE_URL!;
  const maintenance=new pg.Pool({connectionString:url,max:1});
  const owner=new pg.Pool({connectionString:url,max:1,options:`-c search_path=${schema}`});
  const directory=join(process.cwd(),'.fire-off',`evidence-upgrade-${suffix}`),sessions:pg.Pool[]=[];
  const created:string[]=[];
  try {
    await maintenance.query(`CREATE SCHEMA "${schema}"`);
    await mkdir(directory,{recursive:true});
    for(const name of await readdir(join(process.cwd(),'migrations'))) if(name.endsWith('.sql') && name<'0093') await copyFile(join(process.cwd(),'migrations',name),join(directory,name));
    await runMigrations(owner,directory);
    const admin=await createPrincipal(owner,{externalId:randomUUID(),kind:'user',displayName:'Upgrade admin'});
    const service=await createPrincipal(owner,{externalId:randomUUID(),kind:'service',displayName:'Upgrade sync'});
    const org=(await getScopeByRef(owner,{kind:'org',name:''}))!;
    await addMembership(owner,admin.id,org.id,'admin');
    const grant=(file:string,variables:Record<string,string>)=>execFileSync('psql',[url,'-X','-v','ON_ERROR_STOP=1','-v',`continuum_schema=${schema}`,
      ...Object.entries(variables).flatMap(([k,v])=>['-v',`${k}=${v}`]),'-f',join(process.cwd(),'scripts',file)],{timeout:30000,stdio:'pipe'});
    for(const role of roles){ await maintenance.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);created.push(role); }
    grant('grant-application-role.sql',{continuum_app_role:roles[0]});
    grant('grant-application-role.sql',{continuum_app_role:roles[1]});
    grant('grant-operator-role.sql',{continuum_operator_role:roles[1],continuum_principal_id:admin.id});
    grant('grant-sync-role.sql',{continuum_sync_role:roles[2],continuum_principal_id:service.id});
    // An independent, already reviewed extension is preserved by name-based
    // capability-list edits. This does not assume another draft migration merged.
    await owner.query(`CREATE FUNCTION independent_operator_extension() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      REVOKE ALL ON FUNCTION independent_operator_extension() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION independent_operator_extension() TO "${roles[1]}"`);
    for(const signature of ['continuum_assert_application_role_allowlist(name,boolean)','continuum_assert_standup_application_role_allowlist(name,boolean)']){
      const definition=(await owner.query('SELECT pg_get_functiondef($1::regprocedure) AS body',[`${schema}.${signature}`])).rows[0].body as string;
      await owner.query(definition.replace("('continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)')","('continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)'),('independent_operator_extension()')"));
    }
    await runMigrations(owner);
    expect((await owner.query('SELECT count(*)::int AS n FROM evidence_versions')).rows[0].n).toBe(0);
    for(const [index,role] of roles.entries()){
      const connection=new URL(url);connection.username=role;connection.password=password;
      const session=new pg.Pool({connectionString:connection.toString(),max:1,options:`-c search_path=${schema}`});sessions.push(session);
      expect((await session.query('SELECT session_user AS actual')).rows[0].actual).toBe(role);
      expect((await owner.query(`SELECT has_table_privilege($1,'evidence_payloads','SELECT,INSERT,UPDATE,DELETE') AS payload,
        has_function_privilege($1,'continuum_evidence_envelope(uuid,uuid)','EXECUTE') AS serving,
        has_function_privilege($1,'continuum_operator_scrub_evidence_scope(uuid,uuid,uuid,integer)','EXECUTE') AS erasure`,[role])).rows[0])
        .toEqual({payload:false,serving:index!==2,erasure:index===1});
      if(index!==2) await requireEvidenceReady(session,{expectedSchema:schema});
      else await expect(requireEvidenceReady(session,{expectedSchema:schema})).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});
      await expect(session.query('SELECT payload FROM evidence_payloads')).rejects.toMatchObject({code:'42501'});
    }
    expect((await owner.query("SELECT has_function_privilege($1,'independent_operator_extension()','EXECUTE') AS preserved",[roles[1]])).rows[0].preserved).toBe(true);
    await owner.query(`CREATE OR REPLACE FUNCTION continuum_evidence_eligible(actor UUID,version UUID,locality TEXT) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$ BEGIN RETURN TRUE; END $$`);
    await expect(requireEvidenceReady(sessions[0],{expectedSchema:schema})).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});
  }finally{
    await Promise.all(sessions.map(p=>p.end()));await owner.end();
    await maintenance.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    for(const role of created.reverse()){await maintenance.query(`DROP OWNED BY "${role}"`);await maintenance.query(`DROP ROLE "${role}"`);}
    await maintenance.end();await rm(directory,{recursive:true,force:true});
  }
},120000);
