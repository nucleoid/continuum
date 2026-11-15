import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { expect, it } from 'vitest';
import { briefFixture } from '../briefs/test-helpers.js';
import { briefDescriptor } from '../briefs/provider.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { verifyMemoryWithAudit } from '../storage/promote.js';
import { briefForPrincipal, briefHistoryForPrincipal, refreshBrief } from '../services/briefs.js';
import { processBrief } from './briefs.js';

type Outcome<T> = { value: T; error?: never } | { value?: never; error: { code?: string; message: string } };
async function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  try { return { value: await promise }; }
  catch (error) { return { error: { code: (error as { code?: string }).code, message: (error as Error).message } }; }
}

it('history and an ordinary claim complete without opposing memory row lock order', async () => {
  await briefFixture(async f => {
    const actor = (await getPrincipal(f.app, f.actorId))!;
    const low = await createMemory(f.app, { id: '00000000-0000-4000-8000-000000000101',
      scopeId: f.projectId, scopeKind: 'project', authorId: actor.id, type: 'decision',
      title: 'Older decision', body: 'LOW-OLDER-DECISION', source: 'manual' });
    await refreshBrief(f.app, actor, { project: f.projectName, mode: 'full', dryRun: false, idempotencyKey: 'history-low' });
    expect(await processBrief(f.worker, randomUUID(), f.profile)).toBe('processed');
    const older = await briefForPrincipal(f.app, actor, f.projectName);
    expect(older.blocks).toHaveLength(1);
    await verifyMemoryWithAudit(f.app, actor.id, low.id, false);
    const high = await createMemory(f.app, { id: 'ffffffff-ffff-4fff-bfff-fffffffffff2',
      scopeId: f.projectId, scopeKind: 'project', authorId: actor.id, type: 'fact',
      title: 'Newer fact', body: 'HIGH-NEWER-FACT', source: 'manual' });
    await refreshBrief(f.app, actor, { project: f.projectName, mode: 'full', dryRun: false, idempotencyKey: 'history-high' });
    expect(await processBrief(f.worker, randomUUID(), f.profile)).toBe('processed');
    const newer = await briefForPrincipal(f.app, actor, f.projectName);
    expect(newer.blocks).toHaveLength(1);
    expect(JSON.stringify(newer.blocks)).toContain('HIGH-NEWER-FACT');
    expect(JSON.stringify(newer.blocks)).not.toContain('LOW-OLDER-DECISION');
    // Supported positive verification makes low eligible for the new inventory,
    // while its historical version stays denied. Even denied history blocks take
    // their source locks before the eligibility check. No root/state is faked.
    await verifyMemoryWithAudit(f.app, actor.id, low.id, true);
    const before = await briefHistoryForPrincipal(f.app, actor, f.definitionId, { limit: 2 });
    expect((before.items as Record<string, unknown>[]).map(item => item.version)).toEqual([newer.version, older.version]);
    const queued = await refreshBrief(f.app, actor,
      { project: f.projectName, mode: 'full', dryRun: false, idempotencyKey: 'history-concurrent' });
    const gate = Math.floor(Math.random() * 1_000_000_000) + 1;
    await f.owner.query(`CREATE FUNCTION parent_history_claim_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.run_id='${queued.runId}'::uuid AND NEW.root_id='${low.id}'::uuid THEN
          PERFORM pg_advisory_xact_lock(${gate}::bigint);
        END IF;
        RETURN NEW;
      END $$;
      REVOKE ALL ON FUNCTION parent_history_claim_gate() FROM PUBLIC;
      CREATE TRIGGER parent_history_claim_gate AFTER INSERT ON brief_run_inputs
        FOR EACH ROW EXECUTE FUNCTION parent_history_claim_gate()`);
    const readerPid = (await f.app.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const observer = await f.owner.connect();
    let worker: pg.PoolClient | undefined;
    let claiming: Promise<Outcome<Record<string, unknown>>> | undefined;
    let reading: Promise<Outcome<Record<string, unknown>>> | undefined;
    let claimed: Outcome<Record<string, unknown>> | undefined, history: Outcome<Record<string, unknown>> | undefined;
    let highLocked = false;
    try {
      await observer.query('SELECT pg_advisory_lock($1::bigint)', [gate]);
      worker = await f.worker.connect();
      const session = (await worker.query('SELECT pg_backend_pid() AS pid,session_user AS login')).rows[0];
      expect(session.login).toBe(f.workerRole);
      claiming = settle(worker.query('SELECT continuum_brief_claim($1,$2,$3) AS result',
        [f.profile.id, randomUUID(), briefDescriptor(f.profile)]).then(result => result.rows[0].result));
      let entered = false;
      for (let i = 0; i < 60; i++) {
        entered = (await observer.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
          AND NOT granted AND classid=0 AND objid=$1::oid AND objsubid=1 AND pid=$2
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS value`, [gate, session.pid])).rows[0].value;
        if (entered) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(entered, 'claim must hold low source UPDATE before its next source').toBe(true);
      reading = settle(briefHistoryForPrincipal(f.app, actor, f.definitionId, { limit: 2 }));
      let blocked = false;
      for (let i = 0; i < 60; i++) {
        blocked = (await observer.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS value', [session.pid, readerPid])).rows[0].value;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked, 'real history operation must reach its low-source lock behind the claim').toBe(true);
      // Prove the earlier history item already retained a high-source lock. This
      // lock-only owner probe uses NOWAIT and always rolls back; no fake writes.
      await observer.query('BEGIN');
      try { await observer.query('SELECT id FROM memories WHERE id=$1 FOR UPDATE NOWAIT', [high.id]); }
      catch (error) {
        if ((error as { code?: string }).code !== '55P03') throw error;
        highLocked = true;
      } finally { await observer.query('ROLLBACK'); }
      // Baseline: highLocked=true proves the opposing row order. A repair may
      // legitimately lock the whole history union in low/high order, leaving
      // highLocked=false while it waits for low. Release the claim in either
      // case so that a corrected implementation can complete both operations.
    } finally {
      await observer.query('SELECT pg_advisory_unlock($1::bigint)', [gate]);
      [claimed, history] = await Promise.all([claiming, reading]);
      worker?.release(); observer.release();
    }
    const detail = highLocked ? 'history held high while waiting for low' : 'history serialized before high';
    expect(claimed?.error, `claim may not lose: ${detail}`).toBeUndefined();
    expect(history?.error, `ordinary history may not lose: ${detail}`).toBeUndefined();
    expect(claimed?.value).toMatchObject({ outcome: 'claimed' });
    expect(history?.value).toEqual(before);
  });
}, 120_000);
