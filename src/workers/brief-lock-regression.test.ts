import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { expect, it } from 'vitest';
import { briefFixture } from '../briefs/test-helpers.js';
import { briefDescriptor } from '../briefs/provider.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { refreshBrief } from '../services/briefs.js';

const key = () => Math.floor(Math.random() * 1_000_000_000) + 1;
type Result = { result?: unknown; code?: string; message?: string };
const settle = async (operation: Promise<pg.QueryResult>): Promise<Result> => {
  try { return { result: (await operation).rows[0]?.result }; }
  catch (error) { return { code: (error as { code?: string }).code, message: (error as Error).message }; }
};
async function waitGate(observer: pg.PoolClient, gate: number, pids: number[]) {
  for (let i = 0; i < 75; i++) {
    const rows = (await observer.query<{ pid: number }>(`SELECT pid FROM pg_locks
      WHERE locktype='advisory' AND granted AND classid=0 AND objid=$1::oid
        AND objsubid=1 AND pid=ANY($2::int[])
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`, [gate + 3, pids])).rows;
    if (pids.every(pid => rows.some(row => row.pid === pid))) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Owned advisory gate ${gate} was not reached by all expected sessions`);
}
async function pid(client: pg.PoolClient, login?: string): Promise<number> {
  const row = (await client.query('SELECT pg_backend_pid() AS pid,session_user AS login')).rows[0];
  if (login) expect(row.login).toBe(login);
  return row.pid;
}
// Owner-only trigger pauses after the run records its initial observed frontier.
// At the baseline head this is after the early epoch SHARE and before source I/O.
async function installClaimGate(owner: pg.Pool, runIds: string[], gate: number) {
  await owner.query(`CREATE FUNCTION parent_lock_claim_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id=ANY(ARRAY[${runIds.map(id => `'${id}'::uuid`).join(',')}])
        AND OLD.observed IS NULL AND NEW.observed IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock_shared(${gate + 3}::bigint);
        WHILE NOT pg_try_advisory_xact_lock_shared(${gate}::bigint) LOOP PERFORM pg_sleep(0.005); END LOOP;
      END IF;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION parent_lock_claim_gate() FROM PUBLIC;
    CREATE TRIGGER parent_lock_claim_gate AFTER UPDATE ON brief_runs
      FOR EACH ROW EXECUTE FUNCTION parent_lock_claim_gate()`);
}

it('two bound project workers can adopt one org source without epoch upgrade failure', async () => {
  await briefFixture(async f => {
    const actor = (await getPrincipal(f.app, f.actorId))!;
    const org = (await getScopeByRef(f.owner, { kind: 'org', name: '' }))!;
    await addMembership(f.owner, actor.id, org.id, 'writer');
    const project2 = await createScope(f.owner, { kind: 'project', name: `second-${randomUUID()}` });
    await addMembership(f.owner, actor.id, project2.id, 'admin');
    await addMembership(f.owner, f.producerId, project2.id, 'writer');
    // Same checked LOGIN, two actual connections, two explicit approved bindings.
    await f.operator.query('SELECT continuum_operator_bind_brief_worker($1,$2,$3,$4,$5,TRUE)',
      [f.adminId, f.workerRole, f.producerId, project2.id, f.profile.id]);
    await f.app.query('SELECT continuum_brief_configure($1,$2,$3,TRUE)', [actor.id, project2.id, f.profile.id]);
    const source = await createMemory(f.app, { scopeId: org.id, scopeKind: 'org', authorId: actor.id,
      type: 'decision', title: 'Shared lazy input', body: 'SHARED-LAZY-INPUT', source: 'manual' });
    expect((await f.owner.query('SELECT count(*)::int AS n FROM evidence_roots WHERE source_memory_id=$1', [source.id])).rows[0].n).toBe(0);
    const queued = [];
    for (const project of [f.projectName, project2.name]) queued.push(await refreshBrief(f.app, actor,
      { project, mode: 'full', dryRun: false, idempotencyKey: randomUUID() }));
    const gate = key();
    await installClaimGate(f.owner, queued.map(run => run.runId), gate);
    const observer = await f.owner.connect();
    const clients: pg.PoolClient[] = [];
    const pending: Promise<Result>[] = [];
    let results: Result[] = [];
    try {
      await observer.query('SELECT pg_advisory_lock($1::bigint)', [gate]);
      clients.push(await f.worker.connect(), await f.worker.connect());
      const pids = await Promise.all(clients.map(client => pid(client, f.workerRole)));
      for (const client of clients) pending.push(settle(client.query(
        'SELECT continuum_brief_claim($1,$2,$3) AS result', [f.profile.id, randomUUID(), briefDescriptor(f.profile)])));
      await waitGate(observer, gate, pids);
      // pg_locks proves both sessions reached the selected interleaving. Do not
      // depend on a particular deadlock victim or require timeout overrides.
    } finally {
      await observer.query('SELECT pg_advisory_unlock($1::bigint)', [gate]);
      results = await Promise.all(pending);
      for (const client of clients) client.release();
      observer.release();
    }
    expect(results, 'neither project may lose its claim to 40P01/55P03').toEqual([
      { result: expect.objectContaining({ outcome: 'claimed' }) },
      { result: expect.objectContaining({ outcome: 'claimed' }) },
    ]);
    const inputs = (await f.owner.query(`SELECT run_id,root_id FROM brief_run_inputs
      WHERE run_id=ANY($1::uuid[]) AND root_id=$2`, [queued.map(run => run.runId), source.id])).rows;
    expect(inputs).toHaveLength(2);
  });
}, 120_000);

it('an org APP writer and a source-adopting claim do not invert memory and epoch locks', async () => {
  await briefFixture(async f => {
    const actor = (await getPrincipal(f.app, f.actorId))!;
    const org = (await getScopeByRef(f.owner, { kind: 'org', name: '' }))!;
    await addMembership(f.owner, actor.id, org.id, 'writer');
    const source = await createMemory(f.app, { scopeId: org.id, scopeKind: 'org', authorId: actor.id,
      type: 'decision', title: 'Concurrent APP input', body: 'BEFORE-WRITE', source: 'manual' });
    const queued = await refreshBrief(f.app, actor,
      { project: f.projectName, mode: 'full', dryRun: false, idempotencyKey: randomUUID() });
    const claimGate = key(), writerGate = claimGate + 1;
    await installClaimGate(f.owner, [queued.runId], claimGate);
    // A legitimate APP body update obtains the real memory row lock, then pauses
    // before normal AFTER triggers touch the epoch. No root/counter is fabricated.
    await f.owner.query(`CREATE FUNCTION parent_lock_writer_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id='${source.id}'::uuid THEN
          PERFORM pg_advisory_xact_lock_shared(${writerGate + 3}::bigint);
          WHILE NOT pg_try_advisory_xact_lock(${writerGate}::bigint) LOOP PERFORM pg_sleep(0.005); END LOOP;
        END IF;
        RETURN NEW;
      END $$;
      REVOKE ALL ON FUNCTION parent_lock_writer_gate() FROM PUBLIC;
      CREATE TRIGGER parent_lock_writer_gate BEFORE UPDATE ON memories
        FOR EACH ROW EXECUTE FUNCTION parent_lock_writer_gate()`);
    const observer = await f.owner.connect();
    let writer: pg.PoolClient | undefined, worker: pg.PoolClient | undefined;
    let writing: Promise<Result> | undefined, claiming: Promise<Result> | undefined;
    let results: Result[] = [];
    try {
      await observer.query('SELECT pg_advisory_lock($1::bigint),pg_advisory_lock($2::bigint)', [claimGate, writerGate]);
      writer = await f.app.connect(); worker = await f.worker.connect();
      const writerPid = await pid(writer), workerPid = await pid(worker, f.workerRole);
      writing = settle(writer.query('UPDATE memories SET body=$2 WHERE id=$1 RETURNING id AS result', [source.id, 'AFTER-WRITE']));
      await waitGate(observer, writerGate, [writerPid]);
      claiming = settle(worker.query('SELECT continuum_brief_claim($1,$2,$3) AS result',
        [f.profile.id, randomUUID(), briefDescriptor(f.profile)]));
      await waitGate(observer, claimGate, [workerPid]);
      await observer.query('SELECT pg_advisory_unlock($1::bigint)', [claimGate]);
      let blocked = false;
      for (let i = 0; i < 50; i++) {
        blocked = (await observer.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked', [writerPid, workerPid])).rows[0].blocked;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked, 'claim must be waiting on the actual APP memory row lock').toBe(true);
    } finally {
      await observer.query('SELECT pg_advisory_unlock($1::bigint),pg_advisory_unlock($2::bigint)', [claimGate, writerGate]);
      results = await Promise.all([writing, claiming].filter((value): value is Promise<Result> => value !== undefined));
      writer?.release(); worker?.release(); observer.release();
    }
    expect(results[0], 'ordinary APP mutation must commit').toEqual({ result: source.id });
    expect(results[1]?.code, 'claim must not deadlock or time out').toBeUndefined();
    // An optimistic frontier repair may truthfully defer/abstain when the writer
    // changes the frontier. It must never publish the old inventory as complete.
    expect(['claimed', 'progress', 'unavailable']).toContain((results[1]?.result as { outcome?: string })?.outcome);
    expect((await f.app.query('SELECT body FROM memories WHERE id=$1', [source.id])).rows[0].body).toBe('AFTER-WRITE');
    if ((results[1]?.result as { outcome?: string })?.outcome === 'claimed') {
      expect((await f.owner.query(`SELECT count(*)::int AS n FROM brief_run_inputs
        WHERE run_id=$1 AND root_id=$2`, [queued.runId, source.id])).rows[0].n).toBe(1);
    }
  });
}, 120_000);
