import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { acquireLease } from '../services/coordination.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';
import { makeTestPool, resetData } from './test-helpers.js';
import { reconcilePgvectorProviderGrants, requireCoordinationContractReady } from './provider-lifecycle.js';

it.each([false,true])('uses tenant UUID coordination helpers with a later hostile schema, reclaimed=%s', async (reclaimed) => {
  const owner = await makeTestPool(); await resetData(owner);
  const suffix = randomUUID().replaceAll('-', ''); const schema = 'later_' + suffix;
  const attacker = 'overload_owner_' + suffix; const app = 'overload_app_' + suffix;
  let application: pg.Pool | undefined;
  try {
    await owner.query(`CREATE ROLE "${attacker}" NOLOGIN; CREATE ROLE "${app}" NOLOGIN;
      CREATE SCHEMA "${schema}" AUTHORIZATION "${attacker}"`);
    const principal = await createPrincipal(owner, { externalId: randomUUID(), kind: 'service', displayName: 'Application' });
    const scope = await createScope(owner, { kind: 'project', name: suffix });
    await addMembership(owner, principal.id, scope.id, 'writer');
    await owner.query(`INSERT INTO coordination_resources(scope_id,resource,fencing_token) VALUES($1,'target',899)`, [scope.id]);
    const input = { scope: 'project:' + scope.name, resource: 'target', runId: randomUUID(), requestId: randomUUID(), ttlSeconds: 300 };
    const first = await acquireLease(owner, principal, input);
    expect(first).toMatchObject({ acquired: true, fencingToken: '900' });
    if (!first.acquired) throw new Error('expected initial lease');
    if (reclaimed) {
      const actor = await createPrincipal(owner, { externalId: randomUUID(), kind: 'user', displayName: 'Operator' });
      const org = (await getScopeByRef(owner, { kind: 'org', name: '' }))!;
      await addMembership(owner, actor.id, org.id, 'admin');
      await owner.query(`UPDATE coordination_leases SET acquired_at=clock_timestamp()-interval '3 days',
        expires_at=clock_timestamp()-interval '2 days',released_at=clock_timestamp()-interval '2 days'
        WHERE lease_id=$1`, [first.leaseId]);
      await owner.query(`UPDATE coordination_operation_receipts SET server_time=clock_timestamp()-interval '3 days',
        retain_until=clock_timestamp()-interval '1 day' WHERE principal_id=$1`, [principal.id]);
      await owner.query('SELECT continuum_operator_reclaim_coordination_resource($1::uuid,$2::uuid,$3::text)',
        [actor.id,scope.id,'target']);
    }
    const grants = (await readFile(join(process.cwd(),'scripts/grant-application-role.sql'),'utf8'))
      .split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\')).join('\n')
      .replaceAll(':"continuum_schema"','"public"').replaceAll(":'continuum_schema'","'public'")
      .replaceAll(':"continuum_app_role"',`"${app}"`).replaceAll(":'continuum_app_role'",`'${app}'`);
    await owner.query(grants);
    const creator = await owner.connect();
    try {
      await creator.query(`SET ROLE "${attacker}"`);
      for (const label of ['cleanup','usage','rate','floor']) await creator.query(`CREATE SEQUENCE "${schema}".${label}_calls`);
      await creator.query(`CREATE FUNCTION "${schema}".continuum_coordination_cleanup_expired_receipts(text)
        RETURNS integer LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN PERFORM nextval('"${schema}".cleanup_calls'); RETURN 0; END $$;
        CREATE FUNCTION "${schema}".continuum_coordination_lock_principal_usage(text)
        RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN PERFORM nextval('"${schema}".usage_calls'); RETURN; END $$;
        CREATE FUNCTION "${schema}".continuum_coordination_reserve_resource_creation(text)
        RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN PERFORM nextval('"${schema}".rate_calls'); RETURN TRUE; END $$;
        CREATE FUNCTION "${schema}".continuum_coordination_scope_fencing_floor(text)
        RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN PERFORM nextval('"${schema}".floor_calls'); RETURN 0; END $$;
        GRANT USAGE ON SCHEMA "${schema}" TO "${app}";
        GRANT USAGE ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${app}"`);
    } finally { await creator.query('RESET ROLE'); creator.release(); }
    application = new pg.Pool({ ...(owner as unknown as { options: pg.PoolConfig }).options,
      max:1,options:`-c search_path=public,${schema} -c role=${app}` });
    await expect(reconcilePgvectorProviderGrants(application,{expectedSchema:'public'}))
      .rejects.toThrow(/runtime application schema.*trust/i);
    await expect(requireCoordinationContractReady(application,{expectedSchema:'public'}))
      .rejects.toThrow(/runtime application schema.*trust/i);
    // Direct library callers retain their caller-trusted path compatibility.
    // Keep the independent typed UUID SQL proof under those real app privileges.
    await reconcilePgvectorProviderGrants(application);
    await requireCoordinationContractReady(application);
    expect((await application.query('SELECT continuum_coordination_scope_fencing_floor($1::uuid)::text AS floor',[scope.id])).rows)
      .toEqual([{floor:reclaimed?'900':'0'}]);
    expect((await application.query('SELECT continuum_coordination_scope_fencing_floor($1)::text AS floor',[scope.id])).rows)
      .toEqual([{floor:'0'}]);
    await owner.query(`ALTER SEQUENCE "${schema}".floor_calls RESTART WITH 1`);
    const result = await acquireLease(application,principal,{...input,runId:randomUUID(),requestId:randomUUID()})
      .then((value) => ({ok:true as const,value}),(error:unknown) => ({ok:false as const,error}));
    // Sequences expose invocation even if an overloaded call causes rollback.
    const calls = await owner.query(`SELECT (SELECT is_called FROM "${schema}".cleanup_calls) AS cleanup,
      (SELECT is_called FROM "${schema}".usage_calls) AS usage,
      (SELECT is_called FROM "${schema}".rate_calls) AS rate,
      (SELECT is_called FROM "${schema}".floor_calls) AS floor`);
    expect(calls.rows).toEqual([{cleanup:false,usage:false,rate:false,floor:false}]);
    if (!result.ok) throw result.error;
    if (reclaimed) {
      expect(result.value.acquired).toBe(true);
      if (result.value.acquired) expect(BigInt(result.value.fencingToken)).toBeGreaterThan(BigInt(first.fencingToken));
    } else expect(result.value).toMatchObject({acquired:false,reason:'LOCK_HELD'});
  } finally {
    await application?.end();
    await owner.query(`DELETE FROM continuum_pgvector_role_profiles WHERE database_role_oid=(SELECT oid FROM pg_roles WHERE rolname=$1)`,[app]);
    await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; DROP OWNED BY "${app}","${attacker}";
      DROP ROLE IF EXISTS "${app}"; DROP ROLE IF EXISTS "${attacker}"`);
    await owner.end();
  }
},60000);
