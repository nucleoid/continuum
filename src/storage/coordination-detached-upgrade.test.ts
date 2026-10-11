import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from './migrator.js';

const databaseUrl = process.env.CONTINUUM_TEST_DATABASE_URL ?? 'postgres://continuum:continuum@localhost:5433/continuum';
const detached = '00000000-0000-4000-8000-000000000012';

it('refuses pre81 detached credential drift and retries after owner repair without losing anonymous history', async () => {
  const database = 'sink_upgrade_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const directory = await mkdtemp(join(tmpdir(), 'continuum-sink-pre81-'));
  let pool: pg.Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl); url.pathname = '/' + database;
    pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
    for (const file of (await readdir(join(process.cwd(), 'migrations')))
      .filter((file) => file.endsWith('.sql') && file < '0081')) {
      await copyFile(join(process.cwd(), 'migrations', file), join(directory, file));
    }
    await runMigrations(pool, directory);
    const scope = randomUUID(); const lease = randomUUID(); const request = randomUUID(); const key = randomUUID();
    await pool.query(`INSERT INTO scopes(id,kind,name) VALUES($1,'project','anonymous-history')`, [scope]);
    await pool.query(`INSERT INTO coordination_resources(scope_id,resource,fencing_token) VALUES($1,'erased-history',9)`, [scope]);
    await pool.query(`INSERT INTO coordination_leases(lease_id,scope_id,resource,principal_id,run_id,fencing_token,
      acquired_at,expires_at,released_at,cleanup_eligible_at)
      VALUES($1,$2,'erased-history',$3,'00000000-0000-4000-8000-000000000000',9,
        clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',
        clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 day')`, [lease,scope,detached]);
    await pool.query(`INSERT INTO coordination_operation_receipts(principal_id,operation,request_id,payload_hash,
      outcome,scope_id,resource,lease_id,run_id,fencing_token,expires_at,server_time,retain_until)
      SELECT $1,'acquire',$2,decode(repeat('00',32),'hex'),'acquired',scope_id,resource,lease_id,run_id,
        fencing_token,expires_at,acquired_at,clock_timestamp()+interval '1 day'
      FROM coordination_leases WHERE lease_id=$3`, [detached,request,lease]);
    const before = (await pool.query(`SELECT lease_id,principal_id,run_id,fencing_token FROM coordination_leases WHERE lease_id=$1`, [lease])).rows;
    await pool.query(`INSERT INTO service_api_keys(id,principal_id,key_hash,prefix,last_four)
      VALUES($1,$2,sha256(convert_to($1::text,'UTF8')),'ctm_drift','test')`, [key,detached]);
    await expect(runMigrations(pool)).rejects.toThrow(/detached[\s\S]*(repair|remov|credential|key)/i);
    expect((await pool.query(`SELECT count(*)::int AS count FROM _continuum_migrations WHERE name='0081_coordination_public_contract.sql'`)).rows)
      .toEqual([{ count: 0 }]);
    expect((await pool.query(`SELECT to_regprocedure('continuum_coordination_contract_is_ready()') IS NULL AS absent`)).rows)
      .toEqual([{ absent: true }]);
    // Repair only this deliberately introduced credential. Anonymous history
    // must survive fail-closed migration and its idempotent retry unchanged.
    await pool.query('DELETE FROM service_api_keys WHERE id=$1 AND principal_id=$2', [key,detached]);
    await runMigrations(pool); await expect(runMigrations(pool)).resolves.toEqual([]);
    expect((await pool.query(`SELECT lease_id,principal_id,run_id,fencing_token FROM coordination_leases WHERE lease_id=$1`, [lease])).rows).toEqual(before);
    expect((await pool.query(`SELECT principal_id::text,fencing_token::text FROM coordination_operation_receipts WHERE request_id=$1`, [request])).rows)
      .toEqual([{ principal_id: detached, fencing_token: '9' }]);
    expect((await pool.query(`SELECT disabled_at IS NOT NULL AS disabled FROM principals WHERE id=$1`, [detached])).rows)
      .toEqual([{ disabled: true }]);
  } finally {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
