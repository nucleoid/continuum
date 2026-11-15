import pg from 'pg';
import { expect, it } from 'vitest';
import { briefFixture } from '../briefs/test-helpers.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { getScopeByRef } from '../storage/scopes.js';
import { promoteMemoryWithAudit, type PromoteResult } from '../storage/promote.js';

type Result = { value: PromoteResult; error?: never } | { value?: never; error: { code?: string; message: string } };
const settle = async (operation: Promise<PromoteResult>): Promise<Result> => {
  try { return { value: await operation }; }
  catch (error) { return { error: { code: (error as { code?: string }).code, message: (error as Error).message } }; }
};
async function waiting(observer: pg.PoolClient, gate: number, pid: number): Promise<boolean> {
  return (await observer.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
    AND NOT granted AND classid=0 AND objid=$1::oid AND objsubid=1 AND pid=$2
    AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS value`, [gate, pid])).rows[0].value;
}

it('opposite project/org canonical APP promotions both commit with briefs enrolled', async () => {
  await briefFixture(async f => {
    const org = (await getScopeByRef(f.owner, { kind: 'org', name: '' }))!;
    await addMembership(f.owner, f.actorId, org.id, 'admin');
    const first = await createMemory(f.app, { scopeId: f.projectId, scopeKind: 'project', authorId: f.actorId,
      type: 'decision', title: 'Project source', body: 'PROJECT-TO-ORG', source: 'manual' });
    const second = await createMemory(f.app, { scopeId: org.id, scopeKind: 'org', authorId: f.actorId,
      type: 'decision', title: 'Org source', body: 'ORG-TO-PROJECT', source: 'manual' });
    // The feature has enrolled exactly these project/org epoch rows. Do not seed
    // roots, epochs, counters or provenance with fabricated fixture mutations.
    expect((await f.owner.query('SELECT scope_id FROM brief_scope_epochs ORDER BY scope_id')).rows.map(row => row.scope_id).sort())
      .toEqual([f.projectId, org.id].sort());
    const gate = Math.floor(Math.random() * 1_000_000_000) + 1;
    await f.owner.query(`CREATE FUNCTION parent_promotion_epoch_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id=ANY(ARRAY['${first.id}'::uuid,'${second.id}'::uuid]) AND NEW.state='promoted' THEN
          PERFORM pg_advisory_xact_lock_shared(${gate}::bigint);
        END IF;
        RETURN NEW;
      END $$;
      REVOKE ALL ON FUNCTION parent_promotion_epoch_gate() FROM PUBLIC;
      CREATE TRIGGER parent_promotion_epoch_gate BEFORE UPDATE ON memories
        FOR EACH ROW EXECUTE FUNCTION parent_promotion_epoch_gate()`);
    // Separate pools retain the fixture's real APP LOGIN and existing limits.
    // max=1 also makes each observed backend the promotion's backend.
    const left = new pg.Pool({ ...f.app.options, max: 1 });
    const right = new pg.Pool({ ...f.app.options, max: 1 });
    const observer = await f.owner.connect();
    const pending: Promise<Result>[] = [];
    let results: Result[] = [];
    try {
      const expectedLogin = (await f.app.query('SELECT session_user AS login')).rows[0].login;
      const leftSession = (await left.query('SELECT pg_backend_pid() AS pid,session_user AS login')).rows[0];
      const rightSession = (await right.query('SELECT pg_backend_pid() AS pid,session_user AS login')).rows[0];
      expect(leftSession.login).toBe(expectedLogin); expect(rightSession.login).toBe(expectedLogin);
      expect(leftSession.pid).not.toBe(rightSession.pid);
      await observer.query('SELECT pg_advisory_lock($1::bigint)', [gate]);
      pending.push(settle(promoteMemoryWithAudit(left, f.actorId, first.id, { kind: 'org', name: '' })));
      let entered = false;
      for (let i = 0; i < 75; i++) {
        entered = await waiting(observer, gate, leftSession.pid);
        if (entered) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(entered, 'first canonical destination INSERT must complete before source UPDATE').toBe(true);
      pending.push(settle(promoteMemoryWithAudit(right, f.actorId, second.id, { kind: 'project', name: f.projectName })));
      let secondAtGate = false, safelySerialized = false;
      for (let i = 0; i < 75; i++) {
        secondAtGate = await waiting(observer, gate, rightSession.pid);
        safelySerialized = (await observer.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS value',
          [leftSession.pid, rightSession.pid])).rows[0].value;
        if (secondAtGate || safelySerialized) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(secondAtGate || safelySerialized,
        'second promotion must reach the opposing destination epoch or serialize before destination insertion').toBe(true);
      if (secondAtGate) {
        const holders = (await observer.query(`SELECT DISTINCT pid FROM pg_locks
          WHERE relation='brief_scope_epochs'::regclass AND mode='RowExclusiveLock' AND granted
            AND pid=ANY($1::int[])`, [[leftSession.pid, rightSession.pid]])).rows.map(row => row.pid);
        expect(holders.sort()).toEqual([leftSession.pid, rightSession.pid].sort());
      }
      // On the current unfixed source both are here holding opposite epochs.
      // A correct fix may instead serialize the second operation before INSERT;
      // release the first in either case. Shared gates introduce no new cycle.
    } finally {
      await observer.query('SELECT pg_advisory_unlock($1::bigint)', [gate]);
      results = await Promise.all(pending);
      observer.release();
      await Promise.all([left.end(), right.end()]);
    }
    expect(results, 'both legitimate APP promotions must commit without 40P01/55P03').toHaveLength(2);
    expect(results.map(result => result.error)).toEqual([undefined, undefined]);
    const values = results.map(result => result.value!);
    expect(values[0].destination.scopeId).toBe(org.id);
    expect(values[1].destination.scopeId).toBe(f.projectId);
    for (const [index, source] of [first, second].entries()) {
      expect(values[index].source).toMatchObject({ id: source.id, state: 'promoted', promotedToId: values[index].destination.id });
      expect(values[index].destination).toMatchObject({ body: source.body, source: 'promote:manual', metadata: { promoted_from: source.id } });
    }
    expect((await f.app.query("SELECT count(*)::int AS n FROM audit_log WHERE action='promote' AND memory_id=ANY($1::uuid[])",
      [[first.id, second.id]])).rows[0].n).toBe(2);
  });
}, 120_000);
