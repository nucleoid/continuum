import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { briefFixture, syntheticBrief } from '../briefs/test-helpers.js';
import type { BriefInput, BriefClaim } from '../briefs/model.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { refreshBrief } from '../services/briefs.js';
import { BriefWorker } from './briefs.js';

it('drains bounded metadata progress within one real poll under its original workflow at a supported30s pace', async () => {
  let calls = 0;
  const profile = syntheticBrief(async wire => {
    calls++;
    const input = JSON.parse(wire).input as BriefInput;
    const source = input.referenceData.sources[0];
    const claims: BriefClaim[] = input.sections.includes('decisions') ? [{ section: 'decisions',
      label: 'recorded_intent', text: 'Recorded multi-page inventory.', unknown: false, contradiction: false,
      citations: [{ version: source.version, quote: source.text.slice(0, 80) }] }] : [];
    const value = { claims }; return { value, response: value };
  });
  await briefFixture(async f => {
    for (let i = 0; i < 33; i++) await createMemory(f.app, {
      scopeId: f.projectId, scopeKind: 'project', authorId: f.actorId, type: 'decision',
      title: `Page input ${i}`, body: `PAGE-${i}`, source: 'manual',
    });
    const request = await refreshBrief(f.app, (await getPrincipal(f.app, f.actorId))!, {
      project: f.projectName, mode: 'full', dryRun: false, idempotencyKey: randomUUID(),
    });
    const identity = async () => (await f.owner.query(`SELECT workflow_id,attempt_id,budget_owner,budget_generation
      FROM brief_runs WHERE id=$1`, [request.runId])).rows[0];
    const original = await identity();
    const worker = new BriefWorker(f.worker, f.registry, { pollMs: 30000 });
    try {
      await worker.start();
      await worker.poll(); // Actual public worker path; no direct processBrief loop or fake timers.
      expect((await f.owner.query(`SELECT state,inventory_done FROM brief_runs WHERE id=$1`,
        [request.runId])).rows[0]).toEqual({ state: 'complete', inventory_done: true });
      expect(await identity()).toEqual(original);
      expect(calls).toBe(2); // Decision and combined groups; no purpose inputs.
      expect((await f.owner.query('SELECT count(*)::int AS n FROM brief_run_inputs WHERE run_id=$1',
        [request.runId])).rows[0].n).toBe(33);
      expect((await f.owner.query(`SELECT count(*)::int AS n FROM pipeline_budget_workflows`)).rows[0].n).toBe(1);
      const ledger = (await f.owner.query(`SELECT w.active,w.cancelled,w.used,
        extract(epoch FROM(w.deadline_at-w.created_at))*1000 AS lifetime
        FROM pipeline_budget_workflows w WHERE w.id=$1`, [original.workflow_id])).rows[0];
      expect(ledger).toMatchObject({ active: 0, cancelled: false, used: { calls: 2, retries: 0 } });
      expect(Number(ledger.lifetime)).toBeLessThanOrEqual(f.profile.budget.overallMs + 1); //DB timestamp evaluation margin only.
    } finally { await worker.stop(); }
  }, profile);
}, 120000);
