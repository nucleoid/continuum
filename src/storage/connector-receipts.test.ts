import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { runMigrations } from './migrator.js';

describe('connector durable admission', () => {
  let pool: pg.Pool;
  beforeAll(async () => { pool = await makeTestPool(); }, 30_000);
  beforeEach(async () => { await resetData(pool); });
  afterAll(async () => { await pool?.end(); });
  it('denies an unapproved repository mapping without disclosing its existence', async () => {
    const actor = await createPrincipal(pool, { externalId: randomUUID(), kind: 'user', displayName: 'Synthetic' });
    const scope = await createScope(pool, { kind: 'project', name: randomUUID() });
    await addMembership(pool, actor.id, scope.id, 'writer');
    const result = await pool.query('SELECT continuum_connector_mapping($1,$2) AS value', [actor.id, randomUUID()]);
    expect(result.rows[0].value).toBeNull();
    expect((await pool.query('SELECT continuum_connector_is_ready() AS ready')).rows[0].ready).toBe(true);
  });
  it('refuses readiness when a guarded definer loses its trusted search path', async () => {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER FUNCTION continuum_connector_mapping(uuid,uuid) RESET search_path');
      expect((await client.query('SELECT continuum_connector_is_ready() AS ready')).rows[0].ready).toBe(false);
    } finally {await client.query('ROLLBACK');client.release();}
    expect((await pool.query('SELECT continuum_connector_is_ready() AS ready')).rows[0].ready).toBe(true);
  });
  it('refuses a connector upgrade over drifted predecessor integrity functions', async () => {
    const suffix=randomUUID().replaceAll('-',''),schema=`connector_upgrade_${suffix}`;
    const directory=join(process.cwd(),'.fire-off',schema);
    const owner=new pg.Pool({connectionString:process.env.CONTINUUM_TEST_DATABASE_URL!,max:1,options:`-c search_path=${schema}`});
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await mkdir(directory,{recursive:true});
      for(const name of await readdir(join(process.cwd(),'migrations'))) if(name.endsWith('.sql') && name<'0096')
        await copyFile(join(process.cwd(),'migrations',name),join(directory,name));
      await runMigrations(owner,directory);
      expect((await owner.query('SELECT continuum_event_is_ready() AS ready')).rows[0].ready).toBe(true);
      for(const signature of ['continuum_evidence_payload(uuid,uuid,text)','continuum_extraction_status(uuid,uuid,boolean)']) {
        const definition=(await owner.query('SELECT pg_get_functiondef($1::regprocedure) AS body',[signature])).rows[0].body as string;
        for(const change of ['SECURITY INVOKER','RESET search_path']) {
          await owner.query(`ALTER FUNCTION ${signature} ${change}`);
          if(change==='SECURITY INVOKER') expect((await owner.query('SELECT continuum_event_is_ready() AS ready')).rows[0].ready).toBe(false);
          await expect(runMigrations(owner)).rejects.toThrow(/predecessor integrity/);
          expect((await owner.query("SELECT to_regclass('connector_query_runs') AS relation")).rows[0].relation).toBeNull();
          await owner.query(definition);
        }
      }
      await runMigrations(owner);
      expect((await owner.query('SELECT continuum_connector_is_ready() AS ready')).rows[0].ready).toBe(true);
    } finally {
      await owner.end();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await rm(directory,{recursive:true,force:true});
    }
  },120_000);
});
