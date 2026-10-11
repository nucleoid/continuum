import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from './migrator.js';

it('prevents implicit-catalog variadic FORMAT takeover during actual published0055 migration',async()=>{
  const baseUrl=process.env.CONTINUUM_TEST_DATABASE_URL??'postgres://continuum:continuum@localhost:5433/continuum';
  const suffix=randomUUID().replaceAll('-','');const schema='format_app_'+suffix;
  const hostile='format_later_'+suffix;const attacker='format_owner_'+suffix;
  const admin=new pg.Pool({connectionString:baseUrl,max:1});
  const directory=await mkdtemp(join(tmpdir(),'continuum-format-before55-'));
  let owner:pg.Pool|undefined;let migration:pg.Pool|undefined;
  try{
    await admin.query(`CREATE ROLE "${attacker}" NOLOGIN; CREATE SCHEMA "${schema}";
      CREATE SCHEMA "${hostile}" AUTHORIZATION "${attacker}"`);
    for(const file of(await readdir(join(process.cwd(),'migrations'))).filter((file)=>file.endsWith('.sql')&&file<'0055')){
      await copyFile(join(process.cwd(),'migrations',file),join(directory,file));
    }
    owner=new pg.Pool({connectionString:baseUrl,max:1,options:`-c search_path=${schema}`});
    await runMigrations(owner,directory);
    const migrationRole=String((await admin.query('SELECT current_user AS role')).rows[0].role).replaceAll('"','""');
    const creator=await admin.connect();
    try{
      await creator.query(`SET ROLE "${attacker}"`);
      await creator.query(`CREATE SEQUENCE "${hostile}".calls`);
      // 0055's hardening DO supplies schema TEXT, pg_proc.proname NAME,
      // identity arguments TEXT, and another schema TEXT to variadic FORMAT.
      for(const signature of['text,text','text,text,text','text,text,name,text','text,text,name,text,text']){
        await creator.query(`CREATE FUNCTION "${hostile}".format(${signature}) RETURNS text
          LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN
          PERFORM pg_catalog.nextval('"${hostile}".calls');
          RAISE EXCEPTION 'hostile migration FORMAT overload executed'; END $$`);
      }
      await creator.query(`GRANT USAGE ON SCHEMA "${hostile}" TO "${migrationRole}";
        GRANT USAGE ON SEQUENCE "${hostile}".calls TO "${migrationRole}"`);
    }finally{await creator.query('RESET ROLE');creator.release();}
    await copyFile(join(process.cwd(),'migrations/0055_coordination_review_remediation.sql'),
      join(directory,'0055_coordination_review_remediation.sql'));
    migration=new pg.Pool({connectionString:baseUrl,max:1,options:`-c search_path=${schema},${hostile}`});
    expect((await migration.query('SELECT current_schemas(FALSE)::text[] AS path')).rows)
      .toEqual([{path:[schema,hostile]}]);
    const outcome=await runMigrations(migration,directory)
      .then((result)=>({ok:true as const,result}),(error:unknown)=>({ok:false as const,error}));
    expect((await admin.query(`SELECT is_called FROM "${hostile}".calls`)).rows).toEqual([{is_called:false}]);
    if(!outcome.ok){
      expect(String(outcome.error)).toMatch(/search_path|application schema|trusted|unsafe/i);
      expect((await owner.query(`SELECT count(*)::int AS count FROM _continuum_migrations
        WHERE name='0055_coordination_review_remediation.sql'`)).rows).toEqual([{count:0}]);
    }else{
      expect(outcome.result).toContainEqual(expect.objectContaining({name:'0055_coordination_review_remediation.sql'}));
      expect((await owner.query(`SELECT count(*)::int AS count FROM _continuum_migrations
        WHERE name='0055_coordination_review_remediation.sql'`)).rows).toEqual([{count:1}]);
      expect((await owner.query(`SELECT proconfig @> ARRAY[$1::text] AS pinned FROM pg_catalog.pg_proc
        WHERE oid=$2::regprocedure`,['search_path=pg_catalog, '+schema+', pg_temp',
        schema+'.continuum_operator_set_coordination_scope_quota(uuid,uuid,integer)'])).rows)
        .toEqual([{pinned:true}]);
    }
  }finally{
    await migration?.end();await owner?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; DROP SCHEMA IF EXISTS "${hostile}" CASCADE;
      DROP OWNED BY "${attacker}"; DROP ROLE IF EXISTS "${attacker}"`);await admin.end();
    await rm(directory,{recursive:true,force:true});
  }
},120000);
