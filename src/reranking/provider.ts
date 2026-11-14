import { Budget, boundedJson, checkedProfile, priceMicros, type BudgetAdapter, type BudgetProfile } from '../pipeline/budget.js';
import type { CurrentEvidenceAuthority } from '../evidence/policy.js';
import { asEmbeddingRouter, type EmbeddingRouting } from '../embeddings/router.js';

/** Reject an incompatible opt-in rather than silently replace semantic recall
 * with lexical-only candidates. Never bypass accounting to enable a provider. */
export function assertRerankingEmbeddingBudget(routing: EmbeddingRouting, config: Pick<Reranking, 'profile'>): void {
  try {
    const providers = [...new Map(asEmbeddingRouter(routing).providers().map(p => [`${p.id}\0${p.dim}`, p])).values()];
    if (config.profile.limits.calls < providers.length + 1) throw new TypeError();
    // Admission-only probe using the same accountant. No invocation, durable
    // charge or process slot. A real query still needs its actual reservation.
    const probe = new Budget(config.profile);
    for (const provider of providers) {
      const adapter = provider.pipelineAdapter;
      if (!adapter || adapter.id !== provider.id || adapter.local !== provider.local
        || adapter.credentials === 'missing' || typeof adapter.local !== 'boolean'
        || typeof adapter.id !== 'string' || adapter.id.length > 200
        || typeof adapter.model !== 'string' || !adapter.model || adapter.model.length > 200
        || typeof adapter.profile !== 'string' || !adapter.profile || adapter.profile.length > 200 || !adapter.enforceableCaps
        || !adapter.tokens || adapter.tokens.model !== adapter.model || adapter.tokens.profile !== adapter.profile
        || !adapter.tokens.validationId || !['exact', 'conservative'].includes(adapter.tokens.kind)
        || !adapter.price || adapter.price.id !== config.profile.rateSchedule || adapter.price.currency !== config.profile.currency
        || !Number.isSafeInteger(adapter.timeoutMs) || adapter.timeoutMs < 1
        || !Number.isSafeInteger(adapter.responseBodyBytes) || adapter.responseBodyBytes < 1
        || (provider.batchSize !== undefined && (!Number.isSafeInteger(provider.batchSize) || provider.batchSize < 1 || provider.batchSize > 1000))) throw new TypeError();
      const caps = { outputTokens: adapter.outputTokens, reasoningTokens: adapter.reasoningTokens, completionTokens: adapter.completionTokens };
      if (caps.outputTokens + caps.reasoningTokens > caps.completionTokens) throw new TypeError();
      const wire = boundedJson(adapter.serialize(['a'], Object.freeze(caps)), probe.available('inputBytes'));
      const counted = adapter.tokens.count(wire);
      if (!Number.isSafeInteger(counted) || counted < 0 || !Number.isSafeInteger(adapter.tokens.overheadTokens) || adapter.tokens.overheadTokens < 0) throw new TypeError();
      const tokens = counted + adapter.tokens.overheadTokens;
      const inputBytes = Buffer.byteLength(wire);
      // Recall starts routed groups concurrently. Keep every probe reservation
      // active to validate their combined concurrency and retained allowance.
      probe.reserve({ ...caps, inputBytes, contextTokens: tokens, outputBytes: adapter.responseBodyBytes, calls: 1,
        spendMicros: priceMicros(adapter.price, tokens, caps.outputTokens, caps.reasoningTokens) }, inputBytes + adapter.responseBodyBytes);
    }
  } catch {
    throw new TypeError('Reranking requires budget-compatible embedding providers');
  }
}

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
