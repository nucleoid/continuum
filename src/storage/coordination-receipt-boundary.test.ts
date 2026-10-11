import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { expect, it } from 'vitest';
import { acquireLease } from '../services/coordination.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { makeTestPool, resetData } from './test-helpers.js';

it('returns a truthful outcome when a retained receipt expires between locked deletion and lookup',async()=>{
  const pool=await makeTestPool();await resetData(pool);
  let client:pg.PoolClient|undefined;let returned=false;
  try {
    const principal=await createPrincipal(pool,{externalId:randomUUID(),kind:'service',displayName:'Boundary'});
    const scope=await createScope(pool,{kind:'project',name:randomUUID()});
    await addMembership(pool,principal.id,scope.id,'writer');
    const input={scope:'project:'+scope.name,resource:'boundary',runId:randomUUID(),requestId:randomUUID(),ttlSeconds:300};
    const first=await acquireLease(pool,principal,input);if(!first.acquired)throw new Error('expected initial lease');
    // An original acquisition receipt can reach its 24h boundary while renewal
    // has kept the same generation alive. These owner fixture updates model it.
    await pool.query(`INSERT INTO coordination_operation_receipts
      (principal_id,operation,request_id,payload_hash,outcome,scope_id,resource,expires_at,server_time,retry_after_seconds,retain_until)
      SELECT $1::uuid,'acquire',gen_random_uuid(),sha256(convert_to(g::text,'UTF8')),'contended',$2::uuid,'boundary',
        clock_timestamp()-interval '2 days',clock_timestamp()-interval '3 days',1,clock_timestamp()-interval '1 day'
      FROM generate_series(1,100) g`,[principal.id,scope.id]);
    await pool.query(`UPDATE coordination_leases SET acquired_at=clock_timestamp()-interval '24 hours',
      expires_at=clock_timestamp()+interval '5 minutes' WHERE lease_id=$1::uuid`,[first.leaseId]);
    const deadline=(await pool.query(`UPDATE coordination_operation_receipts SET
      retain_until=clock_timestamp()+interval '5 seconds',
      server_time=clock_timestamp()+interval '5 seconds'-interval '24 hours',
      expires_at=clock_timestamp()-interval '24 hours'+interval '5 minutes'
      WHERE principal_id=$1::uuid AND operation='acquire' AND request_id=$2::uuid RETURNING retain_until`,
      [principal.id,input.requestId])).rows[0].retain_until;
    client=await pool.connect();const realClient=client;
    let boundaryObserved=false;
    const query=async(sql:string,parameters?:unknown[])=>{
      const result=await realClient.query(sql,parameters);
      if(sql.includes('DELETE FROM coordination_operation_receipts')&&sql.includes('RETURNING operation')){
        expect(result.rowCount).toBe(0);
        expect((await pool.query('SELECT clock_timestamp()<$1::timestamptz AS before',[deadline])).rows)
          .toEqual([{before:true}]);
        // Wait on the actual server retention deadline, not an arbitrary delay.
        const timer=await pool.connect();
        try{
          await timer.query("SET statement_timeout='7s'");
          await timer.query('SELECT pg_catalog.pg_sleep_until($1::timestamptz)',[deadline]);
          expect((await timer.query('SELECT clock_timestamp()>=$1::timestamptz AS expired',[deadline])).rows)
            .toEqual([{expired:true}]);
        }finally{await timer.query('RESET statement_timeout');timer.release();}
        boundaryObserved=true;
      }
      return result;
    };
    const transport={connect:async()=>({query,release:()=>{returned=true;realClient.release();}})} as unknown as pg.Pool;
    const result=await acquireLease(transport,principal,input)
      .then((value)=>({ok:true as const,value}),(error:unknown)=>({ok:false as const,error}));
    expect(boundaryObserved).toBe(true);
    // Bounded cleanup consumes the 100 older expired receipts. The specific
    // receipt surviving its locked decision must not become a duplicate insert.
    if(!result.ok)throw result.error;
    expect(result.value).toMatchObject({acquired:true,leaseId:first.leaseId,fencingToken:first.fencingToken});
    expect((await pool.query(`SELECT count(*)::int AS count FROM coordination_operation_receipts
      WHERE principal_id=$1::uuid AND operation='acquire' AND request_id=$2::uuid`,[principal.id,input.requestId])).rows)
      .toEqual([{count:1}]);
  }finally{if(client&&!returned)client.release();await pool.end();}
},30000);
