import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, expect, it } from 'vitest';
import { acquireLease } from '../services/coordination.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { makeTestPool, resetData } from './test-helpers.js';

let pool: pg.Pool;
afterAll(async()=>pool?.end());
it('clears pending repair phases and stale cursors between tests before a genuine acquire',async()=>{
  pool=await makeTestPool();await resetData(pool);
  const previous=await createPrincipal(pool,{externalId:randomUUID(),kind:'service',displayName:'Previous test'});
  const previousScope=await createScope(pool,{kind:'project',name:randomUUID()});
  await addMembership(pool,previous.id,previousScope.id,'writer');
  await acquireLease(pool,previous,{scope:'project:'+previousScope.name,resource:'before-reset',runId:randomUUID(),requestId:randomUUID()});
  try {
    await pool.query(`UPDATE coordination_contract_backfill_state SET phase='usage',
      principal_cursor=$1::uuid,resource_scope_cursor=$2::uuid,resource_key_cursor='before-reset',
      resource_rows_processed=42,scope_cursor=$2::uuid,receipt_principal_cursor=$1::uuid,
      receipt_operation_cursor='acquire',receipt_request_cursor=$3::uuid WHERE singleton`,
      [previous.id,previousScope.id,randomUUID()]);
    for (const table of ['coordination_v4_backfill_state','coordination_v5_backfill_state']) {
      await pool.query(`UPDATE ${table} SET completed=FALSE,last_principal_id=$1::uuid WHERE singleton`,[previous.id]);
    }
    await resetData(pool);
    expect((await pool.query(`SELECT phase,principal_cursor,resource_scope_cursor,resource_key_cursor,
      resource_rows_processed::text,scope_cursor,receipt_principal_cursor,receipt_operation_cursor,receipt_request_cursor
      FROM coordination_contract_backfill_state WHERE singleton`)).rows).toEqual([{phase:'complete',principal_cursor:null,
      resource_scope_cursor:null,resource_key_cursor:null,resource_rows_processed:'0',scope_cursor:null,
      receipt_principal_cursor:null,receipt_operation_cursor:null,receipt_request_cursor:null}]);
    expect((await pool.query(`SELECT completed,last_principal_id FROM coordination_v4_backfill_state
      UNION ALL SELECT completed,last_principal_id FROM coordination_v5_backfill_state`)).rows)
      .toEqual([{completed:true,last_principal_id:null},{completed:true,last_principal_id:null}]);
    expect((await pool.query(`SELECT (SELECT count(*)::int FROM coordination_resources) AS resources,
      (SELECT count(*)::int FROM coordination_leases) AS leases,
      (SELECT count(*)::int FROM coordination_operation_receipts) AS receipts,
      (SELECT count(*)::int FROM principals WHERE id=$1::uuid) AS previous`,[previous.id])).rows)
      .toEqual([{resources:0,leases:0,receipts:0,previous:0}]);
    const next=await createPrincipal(pool,{externalId:randomUUID(),kind:'service',displayName:'Next test'});
    const nextScope=await createScope(pool,{kind:'project',name:randomUUID()});
    await addMembership(pool,next.id,nextScope.id,'writer');
    await expect(acquireLease(pool,next,{scope:'project:'+nextScope.name,resource:'after-reset',runId:randomUUID(),requestId:randomUUID()}))
      .resolves.toMatchObject({acquired:true,fencingToken:'1'});
  } finally {await resetData(pool);}
},60000);
