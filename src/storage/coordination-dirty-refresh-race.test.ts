import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';

describe('coordination dirty refresh deletion contention', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => pool?.end());

  it('retains discovery evidence when an allowed mapping writer races a refresh deleting the old marker', async () => {
    const principal = await createPrincipal(pool, { externalId: 'dirty-race:' + randomUUID(), kind: 'user', displayName: 'Target' });
    const operator = await createPrincipal(pool, { externalId: 'dirty-operator:' + randomUUID(), kind: 'user', displayName: 'Operator' });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, operator.id, org.id, 'admin');
    const oldScope = await createScope(pool, { kind: 'user', name: 'old-' + randomUUID() });
    const newScope = await createScope(pool, { kind: 'user', name: 'new-' + randomUUID() });
    await pool.query(`INSERT INTO principal_user_scopes(principal_id,scope_id,mapped_by,
      acknowledged_principal_ids,acknowledged_evidence_hash) VALUES($1,$2,$1,ARRAY[$1::uuid],repeat('a',64))`,
    [principal.id, oldScope.id]);
    await pool.query(`INSERT INTO coordination_resources(scope_id,resource) VALUES($1,'history')`, [oldScope.id]);
    await pool.query(`INSERT INTO coordination_leases(lease_id,scope_id,resource,principal_id,run_id,
      fencing_token,acquired_at,expires_at,released_at,cleanup_eligible_at)
      VALUES(gen_random_uuid(),$1,'history',$2,gen_random_uuid(),1,
        clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',
        clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 day')`, [oldScope.id, principal.id]);
    await pool.query('UPDATE principals SET disabled_at=clock_timestamp() WHERE id=$1', [principal.id]);
    await pool.query(`INSERT INTO coordination_principal_privacy_progress
      (principal_id,detached_principal_id,privacy_version,completed_at)
      VALUES($1,'00000000-0000-4000-8000-000000000012',3,clock_timestamp())`, [principal.id]);
    expect((await pool.query('SELECT continuum_coordination_privacy_actual_state_is_erased($1,$2) AS erased',
      [principal.id, oldScope.id])).rows).toEqual([{ erased: true }]);
    await pool.query(`INSERT INTO coordination_privacy_dirty_principals(principal_id)
      VALUES($1) ON CONFLICT(principal_id) DO NOTHING`, [principal.id]);
    const refresher = await pool.connect(); const writer = await pool.connect();
    try {
      await refresher.query('BEGIN');
      await refresher.query('SELECT continuum_refresh_coordination_privacy_dirty($1)', [principal.id]);
      expect((await refresher.query('SELECT count(*)::int AS count FROM coordination_privacy_dirty_principals WHERE principal_id=$1',
        [principal.id])).rows).toEqual([{ count: 0 }]);
      await writer.query('BEGIN'); await writer.query("SET LOCAL statement_timeout='3s'");
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      let settled = false;
      const update = writer.query('UPDATE principal_user_scopes SET scope_id=$2 WHERE principal_id=$1',
        [principal.id, newScope.id]).then(
        () => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }),
      ).finally(() => { settled = true; });
      // Old code returns early on NOWAIT; a conservative retry can wait for the
      // deleting transaction. Release it after either outcome, without timings.
      let waiting = false;
      for (let attempt=0; attempt<50 && !settled && !waiting; attempt+=1) {
        waiting = Boolean((await pool.query(`SELECT wait_event_type='Lock' AS waiting
          FROM pg_stat_activity WHERE pid=$1`, [writerPid])).rows[0]?.waiting);
        if (!settled && !waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(settled || waiting).toBe(true);
      expect((await pool.query(`SELECT pg_try_advisory_xact_lock(hashtextextended($1::text,762)) AS unlocked`,
        [principal.id])).rows).toEqual([{ unlocked: true }]);
      await refresher.query('COMMIT');
      const outcome = await update; if (!outcome.ok) throw outcome.error;
      await writer.query('COMMIT');
      expect((await pool.query('SELECT continuum_coordination_privacy_actual_state_is_erased($1,$2) AS erased',
        [principal.id, newScope.id])).rows).toEqual([{ erased: false }]);
      expect((await pool.query('SELECT principal_id::text FROM coordination_privacy_dirty_principals WHERE principal_id=$1',
        [principal.id])).rows).toEqual([{ principal_id: principal.id }]);
      const discovery = await pool.query(`SELECT repairs FROM continuum_operator_list_coordination_privacy_repair_page($1,NULL,1000)`,
        [operator.id]);
      expect(discovery.rows[0].repairs).toContainEqual({
        principal_id: principal.id, scope_id: newScope.id, repair_state: 'disabled_only',
      });
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await refresher.query('ROLLBACK').catch(() => undefined);
      writer.release(); refresher.release();
    }
  }, 30_000);
});
