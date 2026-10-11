import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireLease, releaseLease } from '../services/coordination.js';
import { disablePrincipal, reactivatePrincipal } from '../services/principal-admin.js';
import { listCoordinationPrivacyRepairPage, mapOwnedUserScope, offboardPrincipal,
  repairCoordinationPrivacy } from '../services/offboarding.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';
import { canMutateScope } from '../scopes/access.js';
import { makeTestPool, resetData } from './test-helpers.js';

describe('coordination-only repair beside an open lifecycle run', () => {
  let pool: pg.Pool;
  beforeEach(async()=>{ pool??=await makeTestPool(); await resetData(pool); },30_000);
  afterAll(async()=>pool?.end());

  it('reports shared privacy completion without closing the access-only offboarding run or inventing owned erasure', async()=>{
    const actor=await createPrincipal(pool,{externalId:randomUUID(),kind:'user',displayName:'Operator'});
    const target=await createPrincipal(pool,{externalId:randomUUID(),kind:'user',displayName:'Target'});
    const org=(await getScopeByRef(pool,{kind:'org',name:''}))!;
    const owned=await createScope(pool,{kind:'user',name:`open-repair-${randomUUID()}`});
    const shared=await createScope(pool,{kind:'project',name:`shared-repair-${randomUUID()}`});
    await addMembership(pool,actor.id,org.id,'admin');
    await addMembership(pool,target.id,owned.id,'writer');
    await addMembership(pool,target.id,shared.id,'writer');
    await mapOwnedUserScope(pool,actor,target.id,owned.id);
    const sharedRun=randomUUID();
    const sharedLease=await acquireLease(pool,target,{scope:`project:${shared.name}`,resource:'prior-history',
      runId:sharedRun,requestId:randomUUID(),ttlSeconds:900});
    if(!sharedLease.acquired) throw new Error('observational setup shared acquisition contended');
    await releaseLease(pool,target,{leaseId:sharedLease.leaseId,runId:sharedRun,requestId:randomUUID()});
    await disablePrincipal(pool,actor,target.id);
    const client=await pool.connect(); let discard=false;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('continuum.client_coordination_privacy_version','4',TRUE)");
      const partial=await client.query(`SELECT continuum_operator_scrub_coordination_principal($1,$2,$3,1) AS privacy`,
        [actor.id,target.id,owned.id]);
      expect(partial.rows[0].privacy.complete).toBe(false);
      await client.query('COMMIT');
    } catch(error) {
      try { await client.query('ROLLBACK'); } catch { discard=true; }
      throw error;
    } finally { client.release(discard); }
    expect((await pool.query('SELECT count(*)::int AS count FROM principal_offboarding_runs WHERE principal_id=$1',[target.id])).rows)
      .toEqual([{count:0}]);
    // This is the allowed ordinary reactivation path before any lifecycle run.
    // If it is refused, the observational setup fails; do not bypass its guard.
    await reactivatePrincipal(pool,actor,target.id);
    // Reactivation does not restore revoked memberships. Grant ordinary
    // writer access while no lifecycle run exists, without bypassing privacy.
    await addMembership(pool,target.id,owned.id,'writer');
    expect(await canMutateScope(pool,target.id,owned.id)).toBe(true);
    const ownedLease=await acquireLease(pool,target,{scope:`user:${owned.name}`,resource:'still-owned',
      runId:randomUUID(),requestId:randomUUID(),ttlSeconds:900});
    expect(ownedLease.acquired).toBe(true);
    const pending=await offboardPrincipal(pool,actor,target.id,{confirmationScopeId:owned.id});
    expect(pending).toMatchObject({complete:false,reason:'owned_live_lease'});
    expect((await pool.query('SELECT count(*)::int AS count FROM coordination_scope_privacy_progress WHERE scope_id=$1',[owned.id])).rows)
      .toEqual([{count:0}]);
    const page=await listCoordinationPrivacyRepairPage(pool,actor,100);
    expect(page.repairs).toContainEqual({principalId:target.id,scopeId:owned.id,state:'disabled_only'});
    let repair=await repairCoordinationPrivacy(pool,actor,target.id,{confirmationScopeId:owned.id,batchSize:50});
    for(let call=1;!repair.complete&&call<10;call+=1) {
      repair=await repairCoordinationPrivacy(pool,actor,target.id,{confirmationScopeId:owned.id,batchSize:50});
    }
    expect(repair).toMatchObject({state:'disabled_only',complete:true});
    expect((await pool.query(`SELECT completed_at IS NULL AS open FROM principal_offboarding_runs WHERE principal_id=$1`,[target.id])).rows)
      .toEqual([{open:true}]);
    expect((await pool.query('SELECT count(*)::int AS count FROM coordination_scope_privacy_progress WHERE scope_id=$1',[owned.id])).rows)
      .toEqual([{count:0}]);
    expect((await pool.query('SELECT count(*)::int AS count FROM coordination_resources WHERE scope_id=$1',[owned.id])).rows)
      .toEqual([{count:1}]);
    const full=await offboardPrincipal(pool,actor,target.id,{confirmationScopeId:owned.id});
    expect(full).toMatchObject({complete:false,reason:'owned_live_lease'});
  },30_000);
});
