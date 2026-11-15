import { randomUUID } from 'node:crypto';
import { copyFile,mkdir,readdir,rm } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { expect,it } from 'vitest';
import { runMigrations } from './migrator.js';
import { requireBriefsReady } from './provider-lifecycle.js';
import { standupProducerFixture } from '../standup/test-helpers.js';

it('refuses predecessor body/SQL NULL path/PUBLIC drift without attesting or partially installing brief guards',async () => {
  const suffix=randomUUID().replaceAll('-','').slice(0,12),schema=`brief_upgrade_${suffix}`;
  const directory=join(process.cwd(),'.fire-off',`brief-upgrade-${suffix}`);
  const maintenance=new pg.Pool({ connectionString: process.env.CONTINUUM_TEST_DATABASE_URL!,max: 1 });
  const owner=new pg.Pool({ connectionString: process.env.CONTINUUM_TEST_DATABASE_URL!,max: 1,options: `-c search_path=${schema}` });
  try {
    await maintenance.query(`CREATE SCHEMA "${schema}"`);await mkdir(directory,{ recursive: true });
    for (const name of await readdir(join(process.cwd(),'migrations'))) if (name.endsWith('.sql') && name<'0097') await copyFile(join(process.cwd(),'migrations',name),join(directory,name));
    await runMigrations(owner,directory);
    const signature='continuum_connector_is_ready()';
    const original=(await owner.query('SELECT pg_get_functiondef($1::regprocedure) AS definition',[signature])).rows[0].definition;
    const pins=(await owner.query('SELECT * FROM connector_contract_functions ORDER BY signature')).rows;
    const mutations=[
      `CREATE OR REPLACE FUNCTION continuum_connector_is_ready() RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT TRUE $$`,
      'ALTER FUNCTION continuum_connector_is_ready() RESET ALL',
      'GRANT EXECUTE ON FUNCTION continuum_connector_is_ready() TO PUBLIC',
    ];
    for (const mutation of mutations) {
      await owner.query(mutation);
      await expect(runMigrations(owner)).rejects.toThrow(/brief predecessor integrity unavailable/);
      expect((await owner.query("SELECT to_regclass('brief_definitions') AS installed")).rows[0].installed).toBeNull();
      expect((await owner.query('SELECT * FROM connector_contract_functions ORDER BY signature')).rows).toEqual(pins);
      await owner.query(original);await owner.query('REVOKE ALL ON FUNCTION continuum_connector_is_ready() FROM PUBLIC');
    }
    await runMigrations(owner);expect((await owner.query('SELECT continuum_brief_is_ready() AS ready')).rows[0].ready).toBe(true);
    await owner.query('ALTER FUNCTION continuum_brief_audience(uuid,uuid,uuid,text) RESET ALL');
    await expect(requireBriefsReady(owner,{ expectedSchema: schema })).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  } finally {
    await owner.end();await maintenance.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await maintenance.end();await rm(directory,{ recursive: true,force: true });
  }
},120000);

it('gives APP serving but no raw/worker/operator brief capabilities and catches disabled guards',async () => {
  await standupProducerFixture(async f => {
    const role=(await f.app.query('SELECT session_user AS role')).rows[0].role;
    expect((await f.owner.query(`SELECT has_table_privilege($1,'brief_blocks','SELECT,INSERT,UPDATE,DELETE') AS raw,
      has_function_privilege($1,'continuum_brief_read(uuid,text)','EXECUTE') AS serving,
      has_function_privilege($1,'continuum_brief_claim(text,uuid,jsonb)','EXECUTE') AS worker,
      has_function_privilege($1,'continuum_operator_install_brief_profile(uuid,jsonb,boolean)','EXECUTE') AS operator`,[role])).rows[0])
      .toEqual({ raw: false,serving: true,worker: false,operator: false });
    await requireBriefsReady(f.app);
    await f.owner.query('ALTER TABLE evidence_payloads DISABLE TRIGGER brief_payload_erased');
    await expect(requireBriefsReady(f.app)).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });
},120000);
