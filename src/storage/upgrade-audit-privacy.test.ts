import { dropIsolatedTestDatabase } from './test-helpers.js';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { record } from '../audit/log.js';
import { inspectLease, acquireLease } from '../services/coordination.js';
import { mapOwnedUserScope, repairCoordinationPrivacy } from '../services/offboarding.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';
import { runMigrations } from './migrator.js';
import { createLeaseGeneration, insertReceipt, lockCoordinationAuthorization, releaseLeaseGeneration, sampleServerTime } from './coordination.js';

it('reopens genuine completed80 privacy cursors including inspection-only principals on upgrade', async () => {
  const baseUrl = process.env.CONTINUUM_TEST_DATABASE_URL ?? 'postgres://continuum:continuum@localhost:5433/continuum';
  const database = 'audit_upgrade_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: baseUrl, max: 1 });
  const directory = await mkdtemp(join(tmpdir(), 'continuum-audit-before81-'));
  let pool: pg.Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(baseUrl); url.pathname = '/' + database;
    pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
    for (const file of (await readdir(join(process.cwd(),'migrations'))).filter((file) => file.endsWith('.sql') && file<'0081')) {
      await copyFile(join(process.cwd(),'migrations',file),join(directory,file));
    }
    await runMigrations(pool,directory);
    const operator = await createPrincipal(pool,{externalId:randomUUID(),kind:'user',displayName:'Operator'});
    const holder = await createPrincipal(pool,{externalId:randomUUID(),kind:'user',displayName:'Holder'});
    const inspector = await createPrincipal(pool,{externalId:randomUUID(),kind:'user',displayName:'Inspector'});
    const nextHolder = await createPrincipal(pool,{externalId:randomUUID(),kind:'service',displayName:'Next holder'});
    const org = (await getScopeByRef(pool,{kind:'org',name:''}))!;
    const shared = await createScope(pool,{kind:'project',name:'shared-'+randomUUID()});
    await addMembership(pool,operator.id,org.id,'admin');
    for (const principal of [holder,inspector,nextHolder]) await addMembership(pool,principal.id,shared.id,'writer');
    const subjects = [];
    for (const principal of [holder,inspector]) {
      const owned = await createScope(pool,{kind:'user',name:'owned-'+randomUUID()});
      await addMembership(pool,principal.id,owned.id,'writer');
      await mapOwnedUserScope(pool,operator,principal.id,owned.id);
      subjects.push({principal,owned});
    }
    const keys = ['short-private-key','much-longer-private-resource-key'];
    for (const resource of keys) {
      const client = await pool.connect(); const leaseId=randomUUID(); const runId=randomUUID();
      try {
        await client.query('BEGIN');
        expect(await lockCoordinationAuthorization(client,holder.id,shared.id)).toBe(true);
        await client.query('INSERT INTO coordination_resources(scope_id,resource) VALUES($1::uuid,$2::text)',[shared.id,resource]);
        const serverTime=await sampleServerTime(client);
        const generation=await createLeaseGeneration(client,{leaseId,scopeId:shared.id,resource,principalId:holder.id,runId,ttlSeconds:300,serverTime});
        await insertReceipt(client,{principalId:holder.id,operation:'acquire',requestId:randomUUID(),payloadHash:'00'.repeat(32),outcome:'acquired',
          scopeId:shared.id,resource,leaseId,runId,fencingToken:generation.fencingToken,expiresAt:generation.expiresAt,serverTime});
        // These are the published pre81 row operations and normal audit shape,
        // without current API helpers which require the newer contract schema.
        await record(client,{principalId:holder.id,action:'write',scopeId:shared.id,metadata:{operation:'lock_acquire',outcome:'acquired',
          request_id:randomUUID(),run_id:runId,lease_id:leaseId,fencing_token:generation.fencingToken,resource_bytes:Buffer.byteLength(resource)}});
        await client.query('COMMIT');
        await inspectLease(pool,inspector,{scope:'project:'+shared.name,resource});
        await client.query('BEGIN');
        await releaseLeaseGeneration(client,shared.id,resource,leaseId,await sampleServerTime(client));
        await client.query('COMMIT');
      } finally {await client.query('ROLLBACK').catch(()=>undefined);client.release();}
    }
    const auditIds=(await pool.query(`SELECT id FROM audit_log WHERE principal_id=ANY($1::uuid[])
      AND metadata->>'operation' IN ('lock_acquire','lock_inspect')`,[[holder.id,inspector.id]])).rows.map((row)=>row.id);
    expect(auditIds).toHaveLength(4);
    // Inspection itself creates no usage row. The published80 scrub creates
    // one while serializing its capacity work, even for an inspection-only user.
    expect((await pool.query('SELECT count(*)::int AS count FROM coordination_principal_usage WHERE principal_id=$1::uuid',[inspector.id])).rows)
      .toEqual([{count:0}]);
    for (const subject of subjects) {
      await pool.query('UPDATE principals SET disabled_at=clock_timestamp() WHERE id=$1::uuid',[subject.principal.id]);
      let complete=false;
      for(let batch=0;batch<20&&!complete;batch++) {
        const client=await pool.connect();
        try {
          await client.query('BEGIN');await client.query("SET LOCAL continuum.client_coordination_privacy_version='4'");
          const result=await client.query('SELECT continuum_operator_scrub_coordination_principal($1::uuid,$2::uuid,$3::uuid,100) AS result',
            [operator.id,subject.principal.id,subject.owned.id]);
          complete=result.rows[0].result.complete===true;await client.query('COMMIT');
        } finally {await client.query('ROLLBACK').catch(()=>undefined);client.release();}
      }
      expect(complete).toBe(true);
      expect((await pool.query(`SELECT privacy_version,completed_at IS NOT NULL AS complete,
        audit_cursor_id >= (SELECT max(id) FROM audit_log WHERE principal_id=$1::uuid AND metadata->>'operation' LIKE 'lock_%') AS cursor_past
        FROM coordination_principal_privacy_progress WHERE principal_id=$1::uuid`,[subject.principal.id])).rows)
        .toEqual([{privacy_version:3,complete:true,cursor_past:true}]);
    }
    expect((await pool.query('SELECT count(*)::int AS count FROM coordination_principal_usage WHERE principal_id=$1::uuid',[inspector.id])).rows)
      .toEqual([{count:1}]);
    expect((await pool.query(`SELECT bool_and(metadata ? 'resource_bytes') AS bytes FROM audit_log WHERE id=ANY($1::bigint[])`,[auditIds])).rows)
      .toEqual([{bytes:true}]);
    await runMigrations(pool);
    expect((await pool.query(`SELECT count(*)::int AS count FROM coordination_principal_privacy_progress
      WHERE principal_id=ANY($1::uuid[]) AND completed_at IS NULL AND audit_cursor_id=0`,[[holder.id,inspector.id]])).rows)
      .toEqual([{count:2}]);
    const discovery=(await pool.query('SELECT repairs FROM continuum_operator_list_coordination_privacy_repair_page($1::uuid,NULL,1000)',[operator.id])).rows[0].repairs;
    for (const subject of subjects) {
      expect(discovery).toContainEqual({principal_id:subject.principal.id,scope_id:subject.owned.id,repair_state:'disabled_only'});
      let result=await repairCoordinationPrivacy(pool,operator,subject.principal.id,{confirmationScopeId:subject.owned.id,batchSize:100});
      for(let batch=0;batch<20&&!result.complete;batch++) result=await repairCoordinationPrivacy(pool,operator,subject.principal.id,{confirmationScopeId:subject.owned.id,batchSize:100});
      expect(result.complete).toBe(true);
    }
    expect((await pool.query(`SELECT count(*)::int AS count FROM audit_log WHERE id=ANY($1::bigint[])
      AND metadata ?| ARRAY['fencing_token','resource_bytes']`,[auditIds])).rows).toEqual([{count:0}]);
    expect((await pool.query(`SELECT resource,fencing_token::text AS token FROM coordination_resources WHERE scope_id=$1::uuid ORDER BY resource`,[shared.id])).rows)
      .toEqual([...keys].sort().map((resource)=>({resource,token:'1'})));
    for(const resource of keys) expect(await acquireLease(pool,nextHolder,{scope:'project:'+shared.name,resource,runId:randomUUID(),requestId:randomUUID()}))
      .toMatchObject({acquired:true,fencingToken:'2'});
    await expect(runMigrations(pool)).resolves.toEqual([]);
  } finally {
    await pool?.end();await dropIsolatedTestDatabase(admin, database);await admin.end();
    await rm(directory,{recursive:true,force:true});
  }
},120000);
