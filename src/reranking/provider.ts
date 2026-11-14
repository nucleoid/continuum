import { checkedProfile, type BudgetAdapter, type BudgetProfile } from '../pipeline/budget.js';
import type { CurrentEvidenceAuthority } from '../evidence/policy.js';

/** Reference data only. IDs are request-local aliases, never storage identities. */
export interface RerankingInput {
  readonly query: string;
  readonly candidates: readonly Readonly<{ id: string; title: string; excerpt: string }>[];
}
export interface RerankingOutput {
  version: string;
  scores: Array<{ id: string; score: number }>;
}
export interface RerankingAdapter extends BudgetAdapter<RerankingInput, unknown> {
  purpose: 'deterministic' | 'model';
  /** Immutable algorithm/model/prompt revision. Changed bytes require a new version. */
  version: string;
}
export interface RerankingEvidence {
  kind: 'local-contract' | 'operator-qualified';
  adapterId: string;
  version: string;
  model: string;
  profile: string;
  /** Reviewed #25 evidence for this exact version/profile, not an inferred approval. */
  reportSha256?: string;
}
export interface Reranking {
  readonly adapter: Readonly<RerankingAdapter>;
  readonly profile: Readonly<BudgetProfile>;
  readonly candidateLimit: number;
  readonly evidence: Readonly<RerankingEvidence>;
  readonly providerAuthority: (databaseNow: number) => CurrentEvidenceAuthority;
}

/** Server-owned opt-in. Core supplies no provider, endpoint, credential or paid default.
 * Evidence references are operator attestations, not independently verified quality. */
export function configureReranking(adapter: RerankingAdapter, profile: BudgetProfile,
  options: { candidateLimit: number; evidence: RerankingEvidence; providerAuthority?: (databaseNow: number) => CurrentEvidenceAuthority }): Reranking {
  const evidence = Object.freeze({ ...options.evidence });
  const identity = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
  if (!Number.isSafeInteger(options.candidateLimit) || options.candidateLimit < 1 || options.candidateLimit > 100
    || options.candidateLimit > profile.limits.candidates
    || !/^[a-z][a-z0-9.-]{0,63}$/.test(adapter.id)
    || [adapter.version, adapter.model, adapter.profile].some(value => typeof value !== 'string' || !identity.test(value))
    || evidence.adapterId !== adapter.id || evidence.version !== adapter.version
    || evidence.model !== adapter.model || evidence.profile !== adapter.profile
    || !['local-contract', 'operator-qualified'].includes(evidence.kind)
    || (evidence.kind === 'operator-qualified' && (!/^[a-f0-9]{64}$/.test(evidence.reportSha256 ?? '') || !options.providerAuthority))
    || !['deterministic', 'model'].includes(adapter.purpose)
    || (evidence.kind === 'local-contract' && (adapter.purpose !== 'deterministic' || adapter.local !== true || adapter.price?.inputMicros !== 0
      || adapter.price.outputMicros !== 0 || adapter.price.reasoningMicros !== 0))) {
    throw new TypeError('Reranking requires a bounded profile and matching qualification evidence');
  }
  return Object.freeze({ candidateLimit: options.candidateLimit, evidence, profile: checkedProfile(profile),
    providerAuthority: options.providerAuthority ?? ((now: number) => ({ decision: 'allow', checkedAt: now, validUntil: now + 1 })),
    adapter: Object.freeze({ ...adapter,
      tokens: adapter.tokens && Object.freeze({ ...adapter.tokens, count: adapter.tokens.count.bind(adapter.tokens) }),
      price: adapter.price && Object.freeze({ ...adapter.price }),
      serialize: adapter.serialize.bind(adapter), invoke: adapter.invoke.bind(adapter) }) });
}
