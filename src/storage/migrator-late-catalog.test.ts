import { dropIsolatedTestDatabase } from './test-helpers.js';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from './migrator.js';

it('pins ordinary migration DDL to its trusted application schema and restores an explicitly late catalog caller path',async()=>{
  const suffix=randomUUID().replaceAll('-',''),database='late_catalog_'+suffix,attacker='late_attacker_'+suffix;
  const baseUrl=process.env.CONTINUUM_TEST_DATABASE_URL??'postgres://continuum:continuum@localhost:5433/continuum';
  const admin=new pg.Pool({connectionString:baseUrl,max:1});
  const directory=await mkdtemp(join(tmpdir(),'continuum-through54-'));
  let pool:pg.Pool|undefined;
  try {
    await admin.query(`CREATE ROLE "${attacker}" NOLOGIN`);
    await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(baseUrl);url.pathname='/'+database;
    pool=new pg.Pool({connectionString:url.toString(),max:1,options:'-c search_path=application_data'});
    await pool.query('CREATE SCHEMA application_data');
    for(const file of (await readdir(join(process.cwd(),'migrations')))
      .filter(file=>file.endsWith('.sql')&&file<'0055')) {
      await copyFile(join(process.cwd(),'migrations',file),join(directory,file));
    }
    await runMigrations(pool,directory);
    await pool.query(`CREATE SCHEMA later_hostile AUTHORIZATION "${attacker}";
      CREATE SEQUENCE later_hostile.intercept_probe;
      ALTER SEQUENCE later_hostile.intercept_probe OWNER TO "${attacker}";
      CREATE FUNCTION later_hostile.replace(text,text,text) RETURNS text LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_catalog.nextval('later_hostile.intercept_probe'::pg_catalog.regclass);
        RAISE EXCEPTION 'late migration catalog interceptor executed';
      END;
      $$;
      ALTER FUNCTION later_hostile.replace(text,text,text) OWNER TO "${attacker}";
      SET search_path=application_data,later_hostile,pg_catalog`);
    // The first application namespace remains legitimate. The explicit later
    // catalog entry suppresses PostgreSQL's ordinary implicit-first catalog.
    expect((await pool.query('SELECT pg_catalog.current_schema() AS schema')).rows)
      .toEqual([{schema:'application_data'}]);
    await expect(runMigrations(pool)).resolves.toBeDefined();
    expect((await pool.query('SELECT is_called FROM later_hostile.intercept_probe')).rows)
      .toEqual([{is_called:false}]);
    expect((await pool.query(`SELECT name FROM application_data._continuum_migrations WHERE name LIKE '0055%'`)).rows)
      .toEqual([{name:'0055_coordination_review_remediation.sql'}]);
    expect((await pool.query('SHOW search_path')).rows)
      .toEqual([{search_path:'application_data, later_hostile, pg_catalog'}]);
    expect((await pool.query(`SELECT variant FROM application_data._continuum_migration_execution
      WHERE migration_name='0055_coordination_review_remediation.sql' AND phase='file' AND state='completed'`)).rows)
      .toEqual([{variant:'canonical-lf-lock1s-statement30s-v2-app-path-v1'}]);
    await pool.query('SET search_path=application_data');
    await expect(runMigrations(pool)).resolves.toBeDefined();
    expect((await pool.query('SELECT is_called FROM later_hostile.intercept_probe')).rows)
      .toEqual([{is_called:false}]);
  } finally {
    await pool?.end();await dropIsolatedTestDatabase(admin, database);
    await admin.query(`DROP ROLE IF EXISTS "${attacker}"`);await admin.end();
    await rm(directory,{recursive:true,force:true});
  }
},120_000);
