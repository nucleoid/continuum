import { dropIsolatedTestDatabase } from './test-helpers.js';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { runMigrations } from './migrator.js';
import { createLeaseGeneration, lockCoordinationAuthorization,
  releaseLeaseGeneration, sampleServerTime } from './coordination.js';

it('bounds0062 no-progress retries for a legitimately skipped legacy noncurrent lease',async()=>{
  const database='cleanup_no_progress_'+randomUUID().replaceAll('-','');
  const baseUrl=process.env.CONTINUUM_TEST_DATABASE_URL??'postgres://continuum:continuum@localhost:5433/continuum';
  const admin=new pg.Pool({connectionString:baseUrl,max:1});
  const directory=await mkdtemp(join(tmpdir(),'continuum-cleanup-parked-'));
  let pool:pg.Pool|undefined,holder:pg.PoolClient|undefined;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(baseUrl);url.pathname='/'+database;
    pool=new pg.Pool({connectionString:url.toString(),max:2});
    const files=(await readdir(join(process.cwd(),'migrations'))).filter(file=>file.endsWith('.sql'));
    const append=async(prefix:string)=>{
      for(const file of files.filter(file=>file.startsWith(prefix))) {
        await copyFile(join(process.cwd(),'migrations',file),join(directory,file));
      }
    };
    for(const file of files.filter(file=>file<'0059')) {
      await copyFile(join(process.cwd(),'migrations',file),join(directory,file));
    }
    await runMigrations(pool,directory);
    const principal=await createPrincipal(pool,{externalId:randomUUID(),kind:'service',displayName:'Legacy holder'});
    const scope=await createScope(pool,{kind:'project',name:'legacy-'+randomUUID()});
    await addMembership(pool,principal.id,scope.id,'writer');
    const leaseId=randomUUID(),resource='legacy-released-key';
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await lockCoordinationAuthorization(client,principal.id,scope.id)).toBe(true);
      await client.query('INSERT INTO coordination_resources(scope_id,resource) VALUES($1::uuid,$2::text)',[scope.id,resource]);
      const serverTime=await sampleServerTime(client);
      await createLeaseGeneration(client,{leaseId,scopeId:scope.id,resource,principalId:principal.id,
        runId:randomUUID(),ttlSeconds:300,serverTime});
      await releaseLeaseGeneration(client,scope.id,resource,leaseId,await sampleServerTime(client));
      await client.query('COMMIT');
    } finally {await client.query('ROLLBACK').catch(()=>undefined);client.release();}
    await append('0059');await runMigrations(pool,directory);
    // Legitimate interrupted online prefix: install the exact published60
    // indexes before holding the old row, so index build waiting is not the test.
    await pool.query(`CREATE INDEX coordination_leases_cleanup_ready_idx ON coordination_leases(cleanup_eligible_at,lease_id)
      WHERE cleanup_eligible_at IS NOT NULL;
      CREATE INDEX coordination_leases_principal_cleanup_idx ON coordination_leases(principal_id,cleanup_eligible_at,lease_id)
      WHERE cleanup_eligible_at IS NOT NULL`);
    holder=await pool.connect();await holder.query('BEGIN');
    await holder.query('SELECT lease_id FROM coordination_leases WHERE lease_id=$1::uuid FOR UPDATE',[leaseId]);
    await append('0060');await runMigrations(pool,directory);
    expect((await pool.query(`SELECT lease.cleanup_eligible_at IS NULL AS pending,progress.completed_at IS NOT NULL AS claimed_complete
      FROM coordination_leases lease CROSS JOIN coordination_migration_progress progress
      WHERE lease.lease_id=$1::uuid AND progress.name='issue7-cleanup-eligibility'`,[leaseId])).rows)
      .toEqual([{pending:true,claimed_complete:true}]);
    await holder.query('ROLLBACK');holder.release();holder=undefined;
    await append('0061');await runMigrations(pool,directory);
    expect((await pool.query('SELECT cleanup_eligible_at IS NULL AS pending FROM coordination_leases WHERE lease_id=$1::uuid',[leaseId])).rows)
      .toEqual([{pending:true}]);
    await pool.query(`CREATE INDEX coordination_leases_cleanup_pending_idx ON coordination_leases(lease_id)
      WHERE cleanup_eligible_at IS NULL`);
    holder=await pool.connect();await holder.query('BEGIN');
    await holder.query('SELECT lease_id FROM coordination_leases WHERE lease_id=$1::uuid FOR UPDATE',[leaseId]);
    await append('0062');
    let actualCleanupCalls=0;
    const observedPool={connect:async()=>{
      const checkedOut=await pool!.connect();
      return {
        query:async(query:string,values?:unknown[])=>{
          const result=await checkedOut.query(query,values);
          if(query.includes('SELECT continuum_backfill_coordination_cleanup(')) {
            actualCleanupCalls++;
            if(actualCleanupCalls>=50&&result.rows[0]?.completed===false) {
              throw Object.assign(new Error('real cleanup watchdog: 50 successful no-progress SQL calls'),{code:'TEST_NO_PROGRESS'});
            }
          }
          return result;
        },
        release:(error?:Error|boolean)=>checkedOut.release(error),
      };
    }} as unknown as pg.Pool;
    // The watchdog bounds only the test. Product code must terminate through
    // its lock budget, not a limit on legitimate successful data batches.
    await expect(runMigrations(observedPool,directory)).rejects.toMatchObject({cause:{code:'55P03'}});
    expect(actualCleanupCalls).toBeLessThan(50);
    expect((await pool.query("SELECT name FROM _continuum_migrations WHERE name LIKE '0062%'" )).rows).toEqual([]);
    await holder.query('ROLLBACK');holder.release();holder=undefined;
    await expect(runMigrations(pool,directory)).resolves.toHaveLength(1);
    expect((await pool.query('SELECT cleanup_eligible_at IS NOT NULL AS marked FROM coordination_leases WHERE lease_id=$1::uuid',[leaseId])).rows)
      .toEqual([{marked:true}]);
  } finally {
    if(holder){await holder.query('ROLLBACK').catch(()=>undefined);holder.release();}
    await pool?.end();await dropIsolatedTestDatabase(admin, database);await admin.end();
    await rm(directory,{recursive:true,force:true});
  }
},120_000);
