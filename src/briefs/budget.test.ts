import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { refreshBrief } from '../services/briefs.js';
import { processBrief } from '../workers/briefs.js';
import { briefDescriptor, BriefRegistry } from './provider.js';
import { briefFixture, syntheticBrief } from './test-helpers.js';

it.each([0, 1_000_000])('enforces an explicitly installed %i spend limit without any paid provider call', async allowance => {
  const original = syntheticBrief();
  let calls = 0;
  const profile = syntheticBrief(async (...args) => { calls++; return original.adapter.invoke(...args); });
  // Test-only local byte protocol and fictitious price, not a qualified model.
  profile.qualification = { kind: 'operator-qualified', reportSha256: 'a'.repeat(64) };
  profile.budget = { ...profile.budget, rateSchedule: 'priced-local-test-v1',
    limits: { ...profile.budget.limits, spendMicros: allowance } };
  profile.adapter.price = { id: 'priced-local-test-v1', currency: 'USD', unitTokens: 1,
    inputMicros: 1, outputMicros: 1, reasoningMicros: 0 };
  await briefFixture(async f => {
    await expect(f.app.query('SELECT continuum_operator_install_brief_profile($1,$2,TRUE)',
      [f.actorId, briefDescriptor(f.profile)])).rejects.toMatchObject({ code: '42501' });
    await createMemory(f.app, { scopeId: f.projectId, scopeKind: 'project', authorId: f.actorId,
      type: 'decision', title: 'Budgeted plan', body: 'Use the approved source.', source: 'manual' });
    await refreshBrief(f.app, (await getPrincipal(f.app, f.actorId))!, {
      project: f.projectName, mode: 'full', dryRun: false, idempotencyKey: randomUUID() });
    const outcome = await processBrief(f.worker, randomUUID(), f.profile);
    const workflow = (await f.owner.query('SELECT used,active FROM pipeline_budget_workflows')).rows[0];
    if (allowance === 0) {
      expect(outcome).not.toBe('processed');
      expect(calls).toBe(0);
      expect(workflow.used.spendMicros).toBe(0);
      expect((await f.owner.query('SELECT count(*)::int AS n FROM brief_versions')).rows[0].n).toBe(0);
    } else {
      expect(outcome).toBe('processed');
      expect(calls).toBeGreaterThan(0);
      expect(workflow.active).toBe(0);
      expect(workflow.used.spendMicros).toBeGreaterThan(0);
      expect(workflow.used.spendMicros).toBeLessThanOrEqual(allowance);
      // No usage is returned: the original maximum completion charge remains.
      expect(workflow.used.outputTokens).toBe(calls * profile.adapter.outputTokens);
    }
  }, profile);
}, 120000);

it('keeps an unqualified synthetic profile at zero spend', () => {
  const profile = syntheticBrief();
  profile.budget = { ...profile.budget, limits: { ...profile.budget.limits, spendMicros: 1 } };
  expect(() => new BriefRegistry().register(profile)).toThrow('Invalid brief profile');
});
