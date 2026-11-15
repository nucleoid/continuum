import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { EvidencePayloadRegistry } from '../evidence/model.js';
import { registerEvidence } from '../services/evidence.js';
import { briefForPrincipal, refreshBrief } from '../services/briefs.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { processBrief } from '../workers/briefs.js';
import { briefFixture, syntheticBrief } from './test-helpers.js';

it('publishes the original cutoff after an excluded derivative commits during synthesis without buying replacement work', async () => {
  let calls = 0;
  let change: (() => Promise<void>) | undefined;
  const good = syntheticBrief();
  const profile = syntheticBrief(async (...args) => {
    calls++;
    if (change) { const invoke = change; change = undefined; await invoke(); }
    return good.adapter.invoke(...args);
  });
  // Local fictitious pricing exercises durable charges, never a paid provider.
  profile.qualification = { kind: 'operator-qualified', reportSha256: 'a'.repeat(64) };
  profile.adapter.price = { id: 'priced-local-test-v1', currency: 'USD', unitTokens: 1,
    inputMicros: 1, outputMicros: 1, reasoningMicros: 0 };
  profile.budget = { ...profile.budget, rateSchedule: 'priced-local-test-v1', limits: {
    ...profile.budget.limits, spendMicros: 1_000_000, outputTokens: 131072, completionTokens: 131072,
  } };
  await briefFixture(async f => {
    const actor = (await getPrincipal(f.app, f.actorId))!;
    await createMemory(f.app, { scopeId: f.projectId, scopeKind: 'project', authorId: actor.id,
      type: 'decision', title: 'Public decision', body: 'ORIGINAL-CUTOFF-INPUT', source: 'manual' });
    const hidden = await createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: actor.id,
      type: 'decision', title: 'Private decision', body: 'PRIVATE-INFLUENCE', source: 'manual' });
    const source = (await f.app.query('SELECT continuum_evidence_source($1,$2) AS id', [actor.id, hidden.id])).rows[0].id;
    const owners = new EvidencePayloadRegistry(); owners.register('extracted-assertion', () => true);
    change = async () => {
      await registerEvidence(f.app, actor.id, { nodeId: randomUUID(), expectedCurrent: null,
        scopeId: f.projectId, kind: 'extracted-assertion', parents: [{ versionId: source, kind: 'source' }],
        identity: { transform: 'synthetic', model: 'synthetic', prompt: 'synthetic', schema: 'synthetic' },
        payload: '{"assertion":{"text":"PRIVATE-INFLUENCE"}}' }, owners);
    };
    const run = await refreshBrief(f.app, actor, { project: f.projectName, mode: 'full', dryRun: false,
      idempotencyKey: 'original-cutoff' });
    expect(await processBrief(f.worker, randomUUID(), f.profile)).toBe('processed');
    const before = await briefForPrincipal(f.app, actor, f.projectName);
    expect(before).toMatchObject({ fresh: true, coverage: 'complete' });
    expect(JSON.stringify(before.blocks)).toContain('ORIGINAL-CUTOFF-INPUT');
    expect(JSON.stringify(before)).not.toContain('PRIVATE-INFLUENCE');
    const used = (await f.owner.query(`SELECT j.state,w.used,w.active FROM brief_runs j
      JOIN pipeline_budget_workflows w ON w.id=j.workflow_id WHERE j.id=$1`, [run.runId])).rows[0];
    expect(used).toMatchObject({ state: 'complete', active: 0 });
    expect(used.used.spendMicros).toBeGreaterThan(0);
    const originalCalls = calls;
    // A later inventory may drain its new frontier, but the excluded input must
    // neither invalidate the original result nor dispatch synthesis again.
    expect(await processBrief(f.worker, randomUUID(), f.profile)).toBe('processed');
    expect(calls).toBe(originalCalls);
    expect(await briefForPrincipal(f.app, actor, f.projectName)).toEqual(before);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM brief_versions')).rows[0].n).toBe(1);
  }, profile);
}, 120_000);
