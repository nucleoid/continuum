// Distinct connections establish the inventory/commit interleaving directly.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { briefFixture } from '../briefs/test-helpers.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { briefForPrincipal, refreshBrief } from '../services/briefs.js';
import { processBrief } from './briefs.js';

it('never drains an epoch past a concurrent already-enrolled source omitted by its inventory snapshot', async () => {
  await briefFixture(async f => {
    const actor = (await getPrincipal(f.app, f.actorId))!;
    const source = await createMemory(f.app, {
      scopeId: f.projectId, scopeKind: 'project', authorId: actor.id,
      type: 'decision', title: 'Initial input', body: 'INITIAL-INPUT', source: 'manual',
    });
    await f.app.query('SELECT continuum_evidence_source($1,$2)', [actor.id, source.id]);
    const queued = await refreshBrief(f.app, actor, {
      project: f.projectName, mode: 'full', dryRun: false, idempotencyKey: randomUUID(),
    });
    // An owner-only fixture trigger gives a deterministic point after the
    // original memory SELECT has opened its snapshot but before the frontier.
    const key = Math.floor(Math.random() * 1_000_000_000) + 1;
    await f.owner.query(`CREATE FUNCTION parent_brief_inventory_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.run_id='${queued.runId}'::uuid THEN
          PERFORM pg_advisory_xact_lock_shared(${key + 3}::bigint);
          WHILE NOT pg_try_advisory_xact_lock(${key}::bigint) LOOP PERFORM pg_sleep(0.005); END LOOP;
        END IF;
        RETURN NEW;
      END $$;
      REVOKE ALL ON FUNCTION parent_brief_inventory_gate() FROM PUBLIC;
      CREATE TRIGGER parent_brief_inventory_gate AFTER INSERT ON brief_run_inputs
        FOR EACH ROW EXECUTE FUNCTION parent_brief_inventory_gate()`);
    const blocker = await f.owner.connect();
    let pending: Promise<'idle' | 'progress' | 'processed' | 'unavailable'> | undefined;
    let committed = false;
    let outcome: 'idle' | 'progress' | 'processed' | 'unavailable' | undefined;
    try {
      await blocker.query('SELECT pg_advisory_lock($1::bigint)', [key]);
      pending = processBrief(f.worker, randomUUID(), f.profile);
      let entered = false;
      for (let probe = 0; probe < 75; probe++) {
        entered = (await blocker.query<{ entered: boolean }>(`SELECT EXISTS(
          SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted
            AND classid=0 AND objid=$1::oid
            AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        ) AS entered`, [key + 3])).rows[0].entered;
        if (entered) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(entered, 'claim must reach the owned inventory gate').toBe(true);
      const added = await createMemory(f.app, {
        scopeId: f.projectId, scopeKind: 'project', authorId: actor.id,
        type: 'decision', title: 'Concurrent committed input',
        body: 'CONCURRENT-ENROLLED-INPUT', source: 'manual',
      });
      await f.app.query('SELECT continuum_evidence_source($1,$2)', [actor.id, added.id]);
      committed = true;
    } finally {
      await blocker.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
      blocker.release();
      if (pending) outcome = await pending;
    }
    expect(committed).toBe(true);
    expect(outcome, 'a changed committed frontier must defer the original inventory').toBe('progress');
    const accounting = async () => (await f.owner.query(`SELECT r.workflow_id,r.budget_owner,r.attempt_id,r.deadline_at,w.used
      FROM brief_runs r JOIN pipeline_budget_workflows w ON w.id=r.workflow_id WHERE r.id=$1`, [queued.runId])).rows[0];
    const before = await accounting();
    expect(await processBrief(f.worker, randomUUID(), f.profile)).toBe('processed');
    const after = await accounting();
    for (const field of ['workflow_id', 'budget_owner', 'attempt_id', 'deadline_at']) {
      expect(after[field]).toEqual(before[field]);
    }
    for (const field of Object.keys(before.used)) {
      expect(Number(after.used[field])).toBeGreaterThanOrEqual(Number(before.used[field]));
    }
    const current = await briefForPrincipal(f.app, actor, f.projectName);
    expect(current).toMatchObject({ fresh: true, coverage: 'complete' });
    expect(JSON.stringify(current.blocks)).toContain('INITIAL-INPUT');
    expect(JSON.stringify(current.blocks)).toContain('CONCURRENT-ENROLLED-INPUT');
  });
}, 120_000);
