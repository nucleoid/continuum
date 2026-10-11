import { dropIsolatedTestDatabase } from './test-helpers.js';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { mapOwnedUserScope, repairCoordinationPrivacy } from '../services/offboarding.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';
import { runMigrations } from './migrator.js';
import { createLeaseGeneration, insertReceipt, lockCoordinationAuthorization,
  releaseLeaseGeneration, sampleServerTime } from './coordination.js';

it('clears genuinely recorded0061 privacy UUID cursors before upgraded erasure can complete', async()=>{
  const database='legacy_privacy_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:process.env.CONTINUUM_TEST_DATABASE_URL
    ?? 'postgres://continuum:continuum@localhost:5433/continuum',max:1});
  const directory=await mkdtemp(join(tmpdir(),'continuum-through61-'));
  let pool:pg.Pool|undefined;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(process.env.CONTINUUM_TEST_DATABASE_URL
      ?? 'postgres://continuum:continuum@localhost:5433/continuum');url.pathname='/'+database;
    pool=new pg.Pool({connectionString:url.toString(),max:2});
    for(const file of (await readdir(join(process.cwd(),'migrations')))
      .filter(file=>file.endsWith('.sql')&&file<'0062')) {
      await copyFile(join(process.cwd(),'migrations',file),join(directory,file));
    }
    await runMigrations(pool,directory);
    const actor=await createPrincipal(pool,{externalId:randomUUID(),kind:'user',displayName:'Operator'});
    const subject=await createPrincipal(pool,{externalId:randomUUID(),kind:'user',displayName:'Subject'});
    const org=(await getScopeByRef(pool,{kind:'org',name:''}))!;
    const owned=await createScope(pool,{kind:'user',name:'owned-'+randomUUID()});
    const shared=await createScope(pool,{kind:'project',name:'shared-'+randomUUID()});
    await addMembership(pool,actor.id,org.id,'admin');
    await addMembership(pool,subject.id,owned.id,'writer');
    await addMembership(pool,subject.id,shared.id,'writer');
    await mapOwnedUserScope(pool,actor,subject.id,owned.id);
    const leaseId=randomUUID(), requestId=randomUUID(),runId=randomUUID(),resource='legacy-private-key';
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await lockCoordinationAuthorization(client,subject.id,shared.id)).toBe(true);
      await client.query('INSERT INTO coordination_resources(scope_id,resource) VALUES($1::uuid,$2::text)',[shared.id,resource]);
      const serverTime=await sampleServerTime(client);
      const lease=await createLeaseGeneration(client,{leaseId,scopeId:shared.id,resource,principalId:subject.id,runId,
        ttlSeconds:300,serverTime});
      await insertReceipt(client,{principalId:subject.id,operation:'acquire',requestId,payloadHash:'00'.repeat(32),outcome:'acquired',
        scopeId:shared.id,resource,leaseId,runId,fencingToken:lease.fencingToken,expiresAt:lease.expiresAt,serverTime});
      await releaseLeaseGeneration(client,shared.id,resource,leaseId,await sampleServerTime(client));
      await client.query('COMMIT');
    } finally {await client.query('ROLLBACK').catch(()=>undefined);client.release();}
    await pool.query('UPDATE principals SET disabled_at=clock_timestamp() WHERE id=$1::uuid',[subject.id]);
    let complete=false;
    for(let batch=0;batch<10&&!complete;batch++) {
      // Execute the actually installed published0061 operator capability.
      const result=await pool.query('SELECT continuum_operator_scrub_coordination_principal($1::uuid,$2::uuid,$3::uuid,100) AS privacy',
        [actor.id,subject.id,owned.id]);
      complete=result.rows[0].privacy.complete===true;
    }
    expect(complete).toBe(true);
    expect((await pool.query(`SELECT last_lease_id,last_request_id,completed_at IS NOT NULL AS complete
      FROM coordination_principal_privacy_progress WHERE principal_id=$1::uuid`,[subject.id])).rows)
      .toEqual([{last_lease_id:leaseId,last_request_id:requestId,complete:true}]);
    expect((await pool.query(`SELECT lease.resource FROM coordination_principal_privacy_progress progress
      JOIN coordination_leases lease ON lease.lease_id=progress.last_lease_id
      WHERE progress.principal_id=$1::uuid AND lease.principal_id='00000000-0000-4000-8000-000000000012'`,[subject.id])).rows)
      .toEqual([{resource}]);
    await runMigrations(pool);
    expect((await pool.query(`SELECT last_lease_id,last_request_id
      FROM coordination_principal_privacy_progress WHERE principal_id=$1::uuid`,[subject.id])).rows)
      .toEqual([{last_lease_id:null,last_request_id:null}]);
    expect((await pool.query(`SELECT lease.resource FROM coordination_principal_privacy_progress progress
      JOIN coordination_leases lease ON lease.lease_id=progress.last_lease_id
      WHERE progress.principal_id=$1::uuid`,[subject.id])).rows).toEqual([]);
    let repair=await repairCoordinationPrivacy(pool,actor,subject.id,{confirmationScopeId:owned.id,batchSize:100});
    for(let call=1;call<10&&!repair.complete;call++) {
      repair=await repairCoordinationPrivacy(pool,actor,subject.id,{confirmationScopeId:owned.id,batchSize:100});
    }
    expect(repair.complete).toBe(true);
    expect((await pool.query(`SELECT continuum_coordination_privacy_actual_state_is_erased($1::uuid,$2::uuid) AS erased`,
      [subject.id,owned.id])).rows).toEqual([{erased:true}]);
    expect((await pool.query('SELECT fencing_token::text AS token FROM coordination_resources WHERE scope_id=$1::uuid AND resource=$2::text',
      [shared.id,resource])).rows).toEqual([{token:'1'}]);
  } finally {
    await pool?.end();await dropIsolatedTestDatabase(admin, database);await admin.end();
    await rm(directory,{recursive:true,force:true});
  }
},120_000);
