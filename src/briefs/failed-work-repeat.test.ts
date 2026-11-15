import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { EvidencePayloadRegistry } from '../evidence/model.js';
import { registerEvidence } from '../services/evidence.js';
import { briefForPrincipal, refreshBrief } from '../services/briefs.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { processBrief } from '../workers/briefs.js';
import { briefFixture, syntheticBrief } from './test-helpers.js';
import type { BriefInput } from './model.js';

type Fixture = Parameters<Parameters<typeof briefFixture>[0]>[0];
function pricedProfile() {
  const state = { fail: false, calls: 0, inputDigests: [] as string[] };
  const good = syntheticBrief();
  const profile = syntheticBrief(async (wire, caps) => {
    state.calls++;
    const input = JSON.parse(wire).input as BriefInput;
    state.inputDigests.push(createHash('sha256').update(JSON.stringify(input)).digest('hex'));
    const result = await good.adapter.invoke(wire, caps);
    // A settled real callback, charged before the domain rejects invalid output.
    // No provider exception/backoff timing or forged budget/job state is needed.
    const value = state.fail ? { claims: result.value.claims.map(claim => ({ ...claim, text: 'x'.repeat(2001) })) } : result.value;
    return { value, response: value };
  });
  profile.qualification = { kind: 'operator-qualified', reportSha256: 'a'.repeat(64) };
  profile.adapter.price = { id: 'priced-local-repeat-test-v1', currency: 'USD', unitTokens: 1,
    inputMicros: 1, outputMicros: 1, reasoningMicros: 0 };
  profile.budget = { ...profile.budget, rateSchedule: 'priced-local-repeat-test-v1', limits: {
    ...profile.budget.limits, spendMicros: 1_000_000, outputTokens: 131072, completionTokens: 131072,
  } };
  return { profile, state };
}
async function drive(f: Fixture) {
  for (let page = 0; page < 9; page++) {
    const outcome = await processBrief(f.worker, randomUUID(), f.profile);
    if (outcome !== 'progress') return outcome;
  }
  throw new Error('Finite inventory did not finish');
}
async function source(f: Fixture, body: string) {
  return createMemory(f.app, { scopeId: f.projectId, scopeKind: 'project', authorId: f.actorId,
    type: 'decision', title: body, body, source: 'manual' });
}
async function paid(f: Fixture) {
  return (await f.owner.query(`SELECT COALESCE(sum((w.used->>'spendMicros')::bigint),0)::text AS spend,
    (SELECT count(*)::int FROM brief_dispatch_receipts receipt JOIN brief_run_attempts a ON a.attempt_id=receipt.attempt_id
      JOIN brief_runs r ON r.id=a.run_id WHERE r.definition_id=$1) AS dispatches
    FROM brief_runs j JOIN pipeline_budget_workflows w ON w.id=j.workflow_id WHERE j.definition_id=$1`, [f.definitionId])).rows[0];
}
async function originalLedger(f: Fixture, runId: string) {
  return (await f.owner.query(`SELECT j.workflow_id,j.budget_owner,j.deadline_at,w.used,w.active,w.cancelled,w.generation,
    ARRAY(SELECT attempt_id FROM brief_run_attempts WHERE run_id=j.id ORDER BY attempt_id) AS attempt_ids
    FROM brief_runs j JOIN pipeline_budget_workflows w ON w.id=j.workflow_id WHERE j.id=$1`, [runId])).rows[0];
}
async function failedAutomatic(f: Fixture, state: ReturnType<typeof pricedProfile>['state']) {
  const actor = (await getPrincipal(f.app, f.actorId))!;
  await source(f, 'READABLE-OLD-HEAD');
  await refreshBrief(f.app, actor, { project: f.projectName, mode: 'full', dryRun: false, idempotencyKey: 'initial-head' });
  expect(await drive(f)).toBe('processed');
  const before = await briefForPrincipal(f.app, actor, f.projectName);
  await source(f, 'AUTHORIZED-CHANGE-THAT-FAILED');
  state.fail = true;
  expect(await drive(f)).toBe('unavailable'); // Actual automatic repair, not a second manual request.
  const failed = (await f.owner.query(`SELECT id,state,reason,automatic,inventory_done FROM brief_runs
    WHERE definition_id=$1 AND automatic ORDER BY created_at DESC,id DESC LIMIT 1`, [f.definitionId])).rows[0];
  expect(failed).toMatchObject({ state: 'unavailable', reason: 'invalid-output', automatic: true, inventory_done: true });
  expect((await originalLedger(f, failed.id)).used.spendMicros).toBeGreaterThan(0);
  expect((await originalLedger(f, failed.id)).active).toBe(0);
  expect((await briefForPrincipal(f.app, actor, f.projectName)).blocks).toEqual(before.blocks);
  return { actor, failed, before };
}
async function excludedOrgWrite(f: Fixture) {
  // The org administrator gets only explicit private-source read access, no
  // project membership. This org derivative is outside the brief's intersection.
  await addMembership(f.owner, f.adminId, f.scopeId, 'reader');
  const hidden = await createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId,
    type: 'decision', title: 'Excluded personal input', body: 'EXCLUDED-ORG-DERIVATIVE', source: 'manual' });
  const version = (await f.app.query('SELECT continuum_evidence_source($1,$2) AS id', [f.adminId, hidden.id])).rows[0].id;
  const org = (await f.owner.query("SELECT id FROM scopes WHERE kind='org'")).rows[0].id;
  const owners = new EvidencePayloadRegistry(); owners.register('extracted-assertion', () => true);
  await registerEvidence(f.app, f.adminId, { nodeId: randomUUID(), expectedCurrent: null, scopeId: org,
    kind: 'extracted-assertion', parents: [{ versionId: version, kind: 'source' }],
    identity: { transform: 'synthetic', model: 'synthetic', prompt: 'synthetic', schema: 'synthetic' },
    payload: '{"assertion":{"text":"EXCLUDED-ORG-DERIVATIVE"}}' }, owners);
}

it('does not buy a second paid automatic attempt for identical failed inputs after an excluded org write', async () => {
  const { profile, state } = pricedProfile();
  await briefFixture(async f => {
    const { failed, before, actor } = await failedAutomatic(f, state);
    const calls = state.calls, ledger = await originalLedger(f, failed.id), charges = await paid(f);
    const frontier = async () => (await f.owner.query('SELECT continuum_brief_frontier($1) AS value', [f.projectId])).rows[0].value;
    const originalFrontier = await frontier();
    await excludedOrgWrite(f);
    expect(await frontier()).not.toEqual(originalFrontier); // Real coarse frontier moved.
    const inputsBeforeProbe = state.inputDigests.at(-1);
    for (let poll = 0; poll < 3; poll++) await drive(f);
    // Historical a6 re-enters the callback with the exact failed input digest.
    // The fixed path may charge/cancel a finite metadata probe, never dispatch it.
    expect(state.inputDigests.slice(calls).every(digest => digest === inputsBeforeProbe)).toBe(true);
    expect(state.calls, 'excluded frontier changes must not buy replacement provider work').toBe(calls);
    expect(await paid(f)).toEqual(charges);
    expect(await originalLedger(f, failed.id)).toEqual(ledger); // No reset/refund/identity change.
    expect((await briefForPrincipal(f.app, actor, f.projectName)).blocks).toEqual(before.blocks);
  }, profile);
}, 120000);

it('still automatically repairs genuinely changed authorized inputs after an unavailable repair', async () => {
  const { profile, state } = pricedProfile();
  await briefFixture(async f => {
    const { actor } = await failedAutomatic(f, state);
    const calls = state.calls, previousInput = state.inputDigests.at(-1);
    state.fail = false;
    await source(f, 'GENUINELY-NEW-AUTHORIZED-INPUT');
    expect(await drive(f)).toBe('processed');
    expect(state.calls).toBeGreaterThan(calls);
    expect(state.inputDigests.at(-1)).not.toBe(previousInput);
    expect(JSON.stringify((await briefForPrincipal(f.app, actor, f.projectName)).blocks)).toContain('GENUINELY-NEW-AUTHORIZED-INPUT');
  }, profile);
}, 120000);

it('permits an explicit new manual key for the same inputs and replays that key without another provider call', async () => {
  const { profile, state } = pricedProfile();
  await briefFixture(async f => {
    const { actor, failed } = await failedAutomatic(f, state);
    const calls = state.calls, previousInput = state.inputDigests.at(-1), oldLedger = await originalLedger(f, failed.id);
    state.fail = false;
    const request = { project: f.projectName, mode: 'delta' as const, dryRun: false, idempotencyKey: 'deliberate-new-logical-request' };
    const manual = await refreshBrief(f.app, actor, request);
    expect(await drive(f)).toBe('processed');
    expect(state.calls).toBeGreaterThan(calls);
    expect(state.inputDigests.slice(calls)).toContain(previousInput);
    expect((await refreshBrief(f.app, actor, request)).runId).toBe(manual.runId);
    expect(await drive(f)).toBe('idle');
    expect(await originalLedger(f, failed.id)).toEqual(oldLedger);
    expect((await originalLedger(f, String(manual.runId))).workflow_id).not.toBe(oldLedger.workflow_id);
  }, profile);
}, 120000);
