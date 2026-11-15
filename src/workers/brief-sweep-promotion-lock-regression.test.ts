import pg from 'pg';
import { expect, it } from 'vitest';
import { briefFixture } from '../briefs/test-helpers.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { getScopeByRef } from '../storage/scopes.js';
import { promoteMemoryWithAudit, type PromoteResult } from '../storage/promote.js';
import { sweepLifecycleBatch, type SweepBatchResult } from '../lifecycle/sweep.js';
import { LIFECYCLE_PRINCIPAL_ID } from '../lifecycle/principal.js';

type Outcome<T> = { value: T; error?: never } | { value?: never; error: { code?: string; message: string } };
async function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  try { return { value: await promise }; }
  catch (error) { return { error: { code: (error as { code?: string }).code, message: (error as Error).message } }; }
}

it('a real reverse-scope expiry batch and distinct canonical promotion both commit', async () => {
  await briefFixture(async f => {
    const org = (await getScopeByRef(f.owner, { kind: 'org', name: '' }))!;
    const project = (await getScopeByRef(f.owner, { kind: 'project', name: f.projectName }))!;
    const [low, high] = [org, project].sort((left, right) => left.id < right.id ? -1 : 1);
    await addMembership(f.owner, f.actorId, org.id, 'writer');
    await addMembership(f.owner, f.adminId, project.id, 'writer');
    const early = await createMemory(f.app, { scopeId: high.id, scopeKind: high.kind, authorId: f.actorId,
      type: 'fact', title: 'High scope expires first', body: 'EXPIRED-HIGH', source: 'manual' });
    const later = await createMemory(f.app, { scopeId: low.id, scopeKind: low.kind, authorId: f.actorId,
      type: 'fact', title: 'Low scope expires second', body: 'EXPIRED-LOW', source: 'manual' });
    const now = new Date();
    // Actual expiry facts, using the same approved direct expiry update as the
    // existing lifecycle fixtures. No fabricated root, epoch, ACL or provenance.
    await f.app.query('UPDATE memories SET expires_at=$2 WHERE id=$1', [early.id, new Date(now.getTime() - 4000)]);
    await f.app.query('UPDATE memories SET expires_at=$2 WHERE id=$1', [later.id, new Date(now.getTime() - 2000)]);
    const source = await createMemory(f.app, { scopeId: low.id, scopeKind: low.kind, authorId: f.adminId,
      type: 'decision', title: 'Separate promotion source', body: 'UNEXPIRED-PROMOTION', source: 'manual' });
    expect(new Set([early.id, later.id, source.id]).size).toBe(3);
    expect((await f.owner.query('SELECT scope_id FROM brief_scope_epochs ORDER BY scope_id')).rows.map(row => row.scope_id))
      .toEqual([low.id, high.id]);
    const gate = Math.floor(Math.random() * 1_000_000_000) + 1, entered = gate + 1;
    await f.owner.query(`CREATE FUNCTION parent_sweep_epoch_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id='${early.id}'::uuid AND OLD.state='live' AND NEW.state='stale' THEN
          PERFORM pg_advisory_xact_lock(${entered}::bigint);
          -- Nonblocking gate acquisition preserves lock_timeout=1000ms for all
          -- real row waits. The unchanged 5000ms statement timeout bounds this
          -- test-only pause; an observed granted marker proves entry.
          WHILE NOT pg_try_advisory_xact_lock_shared(${gate}::bigint) LOOP
            PERFORM pg_sleep(0.005);
          END LOOP;
        END IF;
        RETURN NULL;
      END $$;
      REVOKE ALL ON FUNCTION parent_sweep_epoch_gate() FROM PUBLIC;
      CREATE TRIGGER zz_parent_sweep_epoch_gate AFTER UPDATE ON memories
        FOR EACH ROW EXECUTE FUNCTION parent_sweep_epoch_gate()`);
    const sweepPool = new pg.Pool({ ...f.operator.options, max: 1 });
    const promotionPool = new pg.Pool({ ...f.app.options, max: 1 });
    let observer: pg.PoolClient | undefined;
    let sweeping: Promise<Outcome<SweepBatchResult>> | undefined;
    let promoting: Promise<Outcome<PromoteResult>> | undefined;
    let swept: Outcome<SweepBatchResult> | undefined, promoted: Outcome<PromoteResult> | undefined;
    try {
      const expectedOperator = (await f.operator.query('SELECT session_user AS login')).rows[0].login;
      const expectedApp = (await f.app.query('SELECT session_user AS login')).rows[0].login;
      const sweepSession = (await sweepPool.query('SELECT pg_backend_pid() AS pid,session_user AS login')).rows[0];
      const promotionSession = (await promotionPool.query('SELECT pg_backend_pid() AS pid,session_user AS login')).rows[0];
      expect(sweepSession.login).toBe(expectedOperator); expect(promotionSession.login).toBe(expectedApp);
      expect(sweepSession.pid).not.toBe(promotionSession.pid);
      observer = await f.owner.connect();
      await observer.query('SELECT pg_advisory_lock($1::bigint)', [gate]);
      sweeping = settle(sweepLifecycleBatch(sweepPool, { now, batchSize: 2 }));
      let atGate = false;
      const entryDeadline = performance.now() + 1000;
      while (performance.now() < entryDeadline) {
        atGate = (await observer.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
          AND granted AND classid=0 AND objid=$1::oid AND objsubid=1 AND pid=$2
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS value`, [entered, sweepSession.pid])).rows[0].value;
        if (atGate) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(atGate, 'sweep must lock its batch and finish high-scope transition first').toBe(true);
      promoting = settle(promoteMemoryWithAudit(promotionPool, f.adminId, source.id, { kind: high.kind, name: high.name }));
      let blocked = false;
      const rowWaitDeadline = performance.now() + 500;
      while (performance.now() < rowWaitDeadline) {
        blocked = (await observer.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS value',
          [sweepSession.pid, promotionSession.pid])).rows[0].value;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(blocked, 'promotion must encounter the actual enrolled-scope epoch held by sweep').toBe(true);
      // Baseline: sweep holds high, promotion holds low and waits high. With an
      // ordered batch prelock, sweep already holds both and promotion waits low.
      // Release either interleaving; correct serialization must let both commit.
    } finally {
      if (observer) await observer.query('SELECT pg_advisory_unlock($1::bigint)', [gate]);
      [swept, promoted] = await Promise.all([sweeping, promoting]);
      observer?.release();
      await Promise.all([sweepPool.end(), promotionPool.end()]);
    }
    expect(swept?.error, 'lifecycle batch must not lose to a promotion on different memory rows').toBeUndefined();
    expect(promoted?.error, 'promotion must not lose to the cross-scope lifecycle batch').toBeUndefined();
    expect(swept?.value).toMatchObject({ selected: 2, transitioned: 2, counts: { 'stale:fact': 2 } });
    expect(promoted?.value?.source).toMatchObject({ id: source.id, state: 'promoted' });
    expect(promoted?.value?.destination).toMatchObject({ scopeId: high.id, body: source.body });
    expect((await f.app.query('SELECT id,state FROM memories WHERE id=ANY($1::uuid[]) ORDER BY id', [[early.id, later.id]])).rows)
      .toEqual([early.id, later.id].sort().map(id => ({ id, state: 'stale' })));
    expect((await f.app.query(`SELECT count(*)::int AS n FROM audit_log WHERE principal_id=$1 AND action='verify'
      AND memory_id=ANY($2::uuid[]) AND metadata->>'source'='lifecycle'`, [LIFECYCLE_PRINCIPAL_ID, [early.id, later.id]])).rows[0].n).toBe(2);
    expect((await f.app.query("SELECT count(*)::int AS n FROM audit_log WHERE principal_id=$1 AND action='promote' AND memory_id=$2",
      [f.adminId, source.id])).rows[0].n).toBe(1);
  });
}, 120_000);
