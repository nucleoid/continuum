import { createHash } from 'node:crypto';
import { boundedJson, checkedProfile, type BudgetAdapter, type BudgetProfile } from '../pipeline/budget.js';
import { BRIEF_PROMPT, BRIEF_SCHEMA, type BriefInput, type BriefOutput } from './model.js';

export interface BriefProfile {
  id: string; version: string; adapter: BudgetAdapter<BriefInput, BriefOutput>; budget: BudgetProfile;
  qualification: { kind: 'synthetic-only' } | { kind: 'operator-qualified'; reportSha256: string };
}
export class BriefRegistry {
  private readonly entries = new Map<string, Readonly<BriefProfile>>();
  register(profile: BriefProfile): void {
    const budget = checkedProfile(profile.budget);
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(profile.id) || !/^[a-zA-Z0-9_.:/-]{1,128}$/.test(profile.version)
      || this.entries.size >= 32 || this.entries.has(profile.id) || budget.overallMs > 20_000 || profile.adapter.timeoutMs > 15_000
      || budget.limits.spendMicros !== 0 || budget.rateSchedule !== 'local-zero-v1'
      || Object.keys(profile.qualification).some(k=>!['kind','reportSha256'].includes(k))
      || (!profile.adapter.local && profile.qualification.kind === 'synthetic-only')
      || (profile.qualification.kind === 'operator-qualified' && !/^[0-9a-f]{64}$/.test(profile.qualification.reportSha256))) throw new TypeError('Invalid brief profile');
    this.entries.set(profile.id, Object.freeze({ ...profile, budget, qualification: Object.freeze({ ...profile.qualification }) }));
  }
  get(id: string): Readonly<BriefProfile> | undefined { return this.entries.get(id); }
  ids(): string[] { return [...this.entries.keys()].sort(); }
}
export function briefDescriptor(profile: Readonly<BriefProfile>) {
  const a = profile.adapter;
  const value = { id: profile.id, version: profile.version, adapter: a.id, model: a.model, adapterProfile: a.profile,
    locality: a.local ? 'local' : 'hosted', schema: BRIEF_SCHEMA, prompt: BRIEF_PROMPT, budget: profile.budget,
    qualification: profile.qualification, responseBodyBytes: a.responseBodyBytes, outputTokens: a.outputTokens,
    reasoningTokens: a.reasoningTokens, completionTokens: a.completionTokens,
    accounting: a.tokens ? { kind: a.tokens.kind, model: a.tokens.model, profile: a.tokens.profile,
      validationId: a.tokens.validationId, overheadTokens: a.tokens.overheadTokens } : null, price: a.price ?? null };
  return { ...value, hash: createHash('sha256').update(boundedJson(value, 16_384)).digest('hex') };
}
