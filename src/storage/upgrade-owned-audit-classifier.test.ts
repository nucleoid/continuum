import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { record } from '../audit/log.js';
import { offboardPrincipal } from '../services/offboarding.js';
import { mapOwnedUserScope, offboardPrincipal as legacyOffboardPrincipal } from '../services/legacy-offboarding/test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';
import { runMigrations } from './migrator.js';
import { createLeaseGeneration, insertReceipt, lockCoordinationAuthorization,
  releaseLeaseGeneration, sampleServerTime } from './coordination.js';

it.each(['open','completed'] as const)(
  'upgrades a genuine %s pre81 run with another holder lock audit already passed by its owned-scope cursor',async(state)=>{
    const database='owned_audit_upgrade_'+randomUUID().replaceAll('-','');
    const baseUrl=process.env.CONTINUUM_TEST_DATABASE_URL??'postgres://continuum:continuum@localhost:5433/continuum';
    const admin=new pg.Pool({connectionString:baseUrl,max:1});
    const directory=await mkdtemp(join(tmpdir(),'continuum-owned-audit-before81-'));
    let pool:pg.Pool|undefined;
    try {
      await admin.query(`CREATE DATABASE "${database}"`);
      const url=new URL(baseUrl);url.pathname='/'+database;
      pool=new pg.Pool({connectionString:url.toString(),max:2});
      for(const file of (await readdir(join(process.cwd(),'migrations')))
        .filter(file=>file.endsWith('.sql')&&file<'0081')) {
        await copyFile(join(process.cwd(),'migrations',file),join(directory,file));
      }
      await runMigrations(pool,directory);
      const actor=await createPrincipal(pool,{externalId:randomUUID(),kind:'user',displayName:'Operator'});
      const subject=await createPrincipal(pool,{externalId:randomUUID(),kind:'user',displayName:'Subject'});
      const holder=await createPrincipal(pool,{externalId:randomUUID(),kind:'service',displayName:'Delegate'});
      const org=(await getScopeByRef(pool,{kind:'org',name:''}))!;
      const owned=await createScope(pool,{kind:'user',name:'owned-'+randomUUID()});
      await addMembership(pool,actor.id,org.id,'admin');
      await addMembership(pool,subject.id,owned.id,'writer');
      await addMembership(pool,holder.id,owned.id,'writer');
      await mapOwnedUserScope(pool,actor,subject.id,owned.id,true);
      const client=await pool.connect();let lockAuditId:string;
      try {
        await client.query('BEGIN');
        expect(await lockCoordinationAuthorization(client,holder.id,owned.id)).toBe(true);
        const resource='delegated-private-key',leaseId=randomUUID(),runId=randomUUID();
        await client.query('INSERT INTO coordination_resources(scope_id,resource) VALUES($1::uuid,$2::text)',[owned.id,resource]);
        const serverTime=await sampleServerTime(client);
        const lease=await createLeaseGeneration(client,{leaseId,scopeId:owned.id,resource,principalId:holder.id,runId,ttlSeconds:300,serverTime});
        await insertReceipt(client,{principalId:holder.id,operation:'acquire',requestId:randomUUID(),payloadHash:'00'.repeat(32),outcome:'acquired',
          scopeId:owned.id,resource,leaseId,runId,fencingToken:lease.fencingToken,expiresAt:lease.expiresAt,serverTime});
        await record(client,{principalId:holder.id,action:'write',scopeId:owned.id,metadata:{operation:'lock_acquire',outcome:'acquired',
          request_id:randomUUID(),run_id:runId,lease_id:leaseId,fencing_token:lease.fencingToken,resource_bytes:Buffer.byteLength(resource)}});
        lockAuditId=(await client.query(`SELECT max(id)::text AS id FROM audit_log WHERE principal_id=$1::uuid
          AND scope_id=$2::uuid AND metadata->>'operation'='lock_acquire'`,[holder.id,owned.id])).rows[0].id;
        await releaseLeaseGeneration(client,owned.id,resource,leaseId,await sampleServerTime(client));
        // Later normal audit work keeps the first one-row scope page incomplete.
        for(let row=0;row<4;row++) await record(client,{principalId:holder.id,action:'read',scopeId:owned.id,
          query:'ordinary delegate recall '+row,metadata:{source:'recall'}});
        await client.query('COMMIT');
      } finally {await client.query('ROLLBACK').catch(()=>undefined);client.release();}
      let result=await legacyOffboardPrincipal(pool,actor,subject.id,{confirmationScopeId:owned.id,batchSize:1});
      let run=(await pool.query('SELECT * FROM principal_offboarding_runs WHERE principal_id=$1::uuid',[subject.id])).rows[0];
      for(let batch=0;batch<30&&BigInt(run.audit_scope_cursor)<BigInt(lockAuditId!);batch++) {
        result=await legacyOffboardPrincipal(pool,actor,subject.id,{confirmationScopeId:owned.id,batchSize:1});
        run=(await pool.query('SELECT * FROM principal_offboarding_runs WHERE principal_id=$1::uuid',[subject.id])).rows[0];
      }
      expect(BigInt(run.audit_scope_cursor)).toBeGreaterThanOrEqual(BigInt(lockAuditId!));
      if(state==='completed') {
        for(let batch=0;batch<30&&!result.complete;batch++) {
          result=await legacyOffboardPrincipal(pool,actor,subject.id,{confirmationScopeId:owned.id,batchSize:100});
        }
        expect(result.complete).toBe(true);
      } else expect(result.complete).toBe(false);
      const before=(await pool.query('SELECT * FROM principal_offboarding_runs WHERE principal_id=$1::uuid',[subject.id])).rows[0];
      expect(before.completed_at!==null).toBe(state==='completed');
      expect((await pool.query(`SELECT metadata ? 'fencing_token' AS token,metadata ? 'resource_bytes' AS bytes,
        metadata=continuum_offboarding_expected_audit_metadata(metadata) AS canonical FROM audit_log WHERE id=$1::bigint`,[lockAuditId!])).rows)
        .toEqual([{token:true,bytes:true,canonical:true}]);
      await runMigrations(pool);
      expect((await pool.query(`SELECT metadata ? 'fencing_token' AS token,metadata ? 'resource_bytes' AS bytes,
        metadata=continuum_offboarding_expected_audit_metadata(metadata) AS canonical FROM audit_log WHERE id=$1::bigint`,[lockAuditId!])).rows)
        .toEqual([{token:false,bytes:false,canonical:true}]);
      let current=await offboardPrincipal(pool,actor,subject.id,{confirmationScopeId:owned.id,batchSize:100});
      for(let batch=0;batch<30&&!current.complete;batch++) current=await offboardPrincipal(pool,actor,subject.id,{confirmationScopeId:owned.id,batchSize:100});
      expect(current.complete).toBe(true);
      expect((await pool.query(`SELECT run_id FROM principal_offboarding_runs WHERE principal_id=$1::uuid`,[subject.id])).rows)
        .toEqual([{run_id:before.run_id}]);
      expect((await pool.query(`SELECT continuum_offboarding_lifecycle_state_is_erased($1::uuid) AS erased`,[before.run_id])).rows)
        .toEqual([{erased:true}]);
    } finally {
      await pool?.end();await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);await admin.end();
      await rm(directory,{recursive:true,force:true});
    }
  },180_000,
);
