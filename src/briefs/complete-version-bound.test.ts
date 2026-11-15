import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { briefFixture, syntheticBrief } from './test-helpers.js';
import { validateBriefOutput, type BriefInput, type BriefClaim } from './model.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { briefForPrincipal, refreshBrief } from '../services/briefs.js';
import { processBrief } from '../workers/briefs.js';

type Fixture = Parameters<Parameters<typeof briefFixture>[0]>[0];
const enqueue = async (f: Fixture, mode: 'full' | 'delta') => refreshBrief(f.app,
  (await getPrincipal(f.app, f.actorId))!, { project: f.projectName, mode, dryRun: false, idempotencyKey: randomUUID() });
async function sources(f: Fixture, type: 'fact' | 'decision', quote: string) {
  for (let i = 0; i < 8; i++) await createMemory(f.app, {
    scopeId: f.projectId, scopeKind: 'project', authorId: f.actorId, type,
    title: `${type} support ${i}`, body: quote, source: 'manual',
  });
}
function profileFor(invoke: Parameters<typeof syntheticBrief>[0]) {
  const profile = syntheticBrief(invoke);
  profile.adapter.responseBodyBytes = 65536; profile.adapter.outputTokens = 65536; profile.adapter.completionTokens = 65536;
  profile.budget = { ...profile.budget, limits: { ...profile.budget.limits,
    contextTokens: 262144, outputTokens: 262144, completionTokens: 262144 } };
  return profile;
}
function output(input: BriefInput, claims: BriefClaim[]) {
  const value = validateBriefOutput({ claims }, input); // Exact versions/quotes/labels/count/text limits.
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(60000);
  return { value, response: value };
}
const citations = (input: BriefInput, quote: string) => input.referenceData.sources.slice(0, 8)
  .map(source => ({ version: source.version, quote }));
const claim = (section: 'purpose' | 'decisions', text: string, input: BriefInput, quote: string): BriefClaim => ({
  section, label: 'recorded_intent', text, unknown: false, contradiction: false, citations: citations(input, quote),
});
async function head(f: Fixture) {
  return (await f.owner.query('SELECT head FROM brief_definitions WHERE id=$1', [f.definitionId])).rows[0].head;
}

it('refuses one valid escaped generated block that its own view cannot hydrate, preserving the readable old head', async () => {
  const quote = '🚀'.repeat(500); //1000 UTF16 units; exact authorized quote,2000UTF8 bytes.
  let large = false;
  const profile = profileFor(async wire => {
    const input = JSON.parse(wire).input as BriefInput;
    return output(input, input.sections.includes('decisions') ? [claim('decisions',
      large ? '\u001b'.repeat(2000) : 'Readable old decision.', input, quote)] : []);
  });
  await briefFixture(async f => {
    await sources(f, 'decision', quote); await enqueue(f, 'full');
    expect(await processBrief(f.worker, randomUUID(), f.profile)).toBe('processed');
    const actor = (await getPrincipal(f.app, f.actorId))!;
    const before = await briefForPrincipal(f.app, actor, f.projectName); const oldHead = await head(f);
    large = true; await enqueue(f, 'full');
    expect(await processBrief(f.worker, randomUUID(), f.profile)).toBe('unavailable');
    expect(await head(f)).toBe(oldHead);
    expect((await briefForPrincipal(f.app, actor, f.projectName)).blocks).toEqual(before.blocks);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM brief_versions')).rows[0].n).toBe(1);
    // One claim: escaped text ~12KB +8exact UTF8quotes ~16KB. It fits65KB output,
    // but6x THIS payload exceeds131072 even as the first block in a view.
  }, profile);
}, 120000);

it('counts reused purpose blocks together with new delta decisions before publishing a complete version', async () => {
  const quote = 'Q'.repeat(1000); let addDecisions = false;
  const profile = profileFor(async wire => {
    const input = JSON.parse(wire).input as BriefInput;
    const section = input.sections.includes('purpose') ? 'purpose'
      : input.sections.includes('decisions') && addDecisions ? 'decisions' : undefined;
    const claims = section ? Array.from({ length: 5 }, (_, i) => claim(section,
      `${section}-${i}:` + 'x'.repeat(1980), input, quote)) : [];
    return output(input, claims);
  });
  await briefFixture(async f => {
    await sources(f, 'fact', quote); await enqueue(f, 'full');
    expect(await processBrief(f.worker, randomUUID(), f.profile)).toBe('processed');
    const actor = (await getPrincipal(f.app, f.actorId))!;
    const before = await briefForPrincipal(f.app, actor, f.projectName); const oldHead = await head(f);
    expect(before.blocks).toHaveLength(5);
    await sources(f, 'decision', quote); addDecisions = true; await enqueue(f, 'delta');
    expect(await processBrief(f.worker, randomUUID(), f.profile)).toBe('unavailable');
    expect(await head(f)).toBe(oldHead);
    expect((await briefForPrincipal(f.app, actor, f.projectName)).blocks).toEqual(before.blocks);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM brief_versions')).rows[0].n).toBe(1);
    // Five ~10.7KB purpose blocks are readable. Five new decision blocks also
    // fit65KB generation output, but10accumulated blocks fail the complete view.
  }, profile);
}, 120000);
