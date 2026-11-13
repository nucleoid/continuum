/** Trusted resolved facts only. Never bind these types directly to REST/MCP input. */
export const EVIDENCE_POLICY_VERSION = 'evidence-authorization-v1';
export const EVIDENCE_ARTIFACT_KINDS = [
  'source-document-version', 'extracted-assertion', 'derived-observation',
  'brief-section-version', 'connector-evidence', 'connector-receipt',
  'history', 'cache', 'trace', 'managed-export', 'queued-payload',
] as const;
export const EVIDENCE_ACTIONS = [
  'metadata-admission', 'text-hydration', 'provider-disclosure', 'generation',
  'apply-publish', 'read', 'history', 'export', 'quarantine', 'erasure',
] as const;
export type EvidenceAction = typeof EVIDENCE_ACTIONS[number];
export type EvidenceArtifactKind = typeof EVIDENCE_ARTIFACT_KINDS[number];

export interface CurrentEvidenceAuthority {
  decision: 'allow' | 'deny' | 'unknown';
  checkedAt: number;
  validUntil: number;
}
export interface EvidencePolicy {
  version: string;
  currentVersion: string;
  scopeIds: readonly string[];
  state: 'active' | 'quarantined' | 'erased' | 'unknown';
  expiresAt: number | null;
  residency: 'local-only' | 'any';
  connector: CurrentEvidenceAuthority | 'not-required';
  repository: CurrentEvidenceAuthority | 'not-required';
}
export interface EvidenceTarget {
  kind: EvidenceArtifactKind;
  policy: EvidencePolicy;
  /** Complete transitive restriction closure, resolved by trusted code; null means unknown. */
  authorityDependencies: readonly EvidencePolicy[] | null;
}
export interface EvidenceAuthorityContext {
  now: number;
  action: EvidenceAction;
  continuum: {
    principalId: string;
    enabled: boolean;
    /** Same operation's database clock, never a reusable authorization cache. */
    checkedAt: number;
    readableScopeIds: readonly string[];
  };
  artifact: EvidenceTarget;
  sourceDocument?: EvidenceTarget;
  providerInput: 'artifact' | 'source-document';
  provider?: { locality: 'local' | 'hosted' | 'unknown'; authority: CurrentEvidenceAuthority };
}
export type EvidenceReason = 'authorized' | 'principal-denied' | 'scope-denied'
  | 'authority-unknown' | 'authority-denied' | 'authority-stale' | 'policy-stale'
  | 'artifact-unavailable' | 'residency-denied' | 'unsupported-action';
export type EvidenceDecision = { decision: 'allow' | 'deny'; reason: EvidenceReason };
export interface EvidencePolicyDecision {
  policyVersion: typeof EVIDENCE_POLICY_VERSION;
  artifactRead: EvidenceDecision;
  sourceDocumentRead: EvidenceDecision;
  providerDisclosure: EvidenceDecision;
}
const deny = (reason: EvidenceReason): EvidenceDecision => ({ decision: 'deny', reason });
const allow = (): EvidenceDecision => ({ decision: 'allow', reason: 'authorized' });

function checkAuthority(authority: CurrentEvidenceAuthority | 'not-required', now: number): EvidenceDecision {
  if (authority === 'not-required') return allow();
  if (!authority || authority.decision === 'unknown') return deny('authority-unknown');
  if (authority.decision !== 'allow') return deny('authority-denied');
  if (!Number.isFinite(authority.checkedAt) || !Number.isFinite(authority.validUntil)
      || authority.checkedAt > now || authority.validUntil <= now) return deny('authority-stale');
  return allow();
}

function checkTarget(context: EvidenceAuthorityContext, target?: EvidenceTarget): EvidenceDecision {
  if (!target || !EVIDENCE_ARTIFACT_KINDS.includes(target.kind)
      || !Array.isArray(target.authorityDependencies)) return deny('authority-unknown');
  const policies = [target.policy, ...target.authorityDependencies];
  for (const policy of policies) {
    if (!policy || !policy.version || policy.version !== policy.currentVersion) return deny('policy-stale');
    if (policy.state !== 'active' || (policy.expiresAt !== null
        && (!Number.isFinite(policy.expiresAt) || policy.expiresAt <= context.now))) return deny('artifact-unavailable');
    if (!Array.isArray(policy.scopeIds) || !policy.scopeIds.length) return deny('authority-unknown');
    if (policy.scopeIds.some(id => !context.continuum.readableScopeIds.includes(id))) return deny('scope-denied');
    if (!['local-only', 'any'].includes(policy.residency)) return deny('authority-unknown');
    for (const authority of [policy.connector, policy.repository]) {
      const decision = checkAuthority(authority, context.now);
      if (decision.decision === 'deny') return decision;
    }
  }
  return allow();
}

/** A decision is an operation-local permit, not an audit, network cutoff or publication grant. */
export function decideEvidencePolicy(context: EvidenceAuthorityContext): EvidencePolicyDecision {
  let common: EvidenceDecision | undefined;
  if (!EVIDENCE_ACTIONS.includes(context.action)
      || ['apply-publish', 'quarantine', 'erasure'].includes(context.action)) common = deny('unsupported-action');
  else if (!context.continuum?.principalId || context.continuum.enabled !== true) common = deny('principal-denied');
  else if (!Number.isFinite(context.now) || context.continuum.checkedAt !== context.now) common = deny('authority-stale');
  const artifactRead = common ?? checkTarget(context, context.artifact);
  const sourceDocumentRead = common ?? checkTarget(context, context.sourceDocument);
  const selected = context.providerInput === 'artifact' ? context.artifact : context.sourceDocument;
  let providerDisclosure = context.providerInput === 'artifact' ? artifactRead
    : context.providerInput === 'source-document' ? sourceDocumentRead : deny('authority-unknown');
  if (providerDisclosure.decision === 'allow') {
    const provider = context.provider;
    if (!provider || !['local', 'hosted'].includes(provider.locality)) providerDisclosure = deny('authority-unknown');
    else {
      providerDisclosure = checkAuthority(provider.authority, context.now);
      if (providerDisclosure.decision === 'allow' && provider.locality !== 'local'
          && [selected!.policy, ...selected!.authorityDependencies!].some(policy => policy.residency === 'local-only')) {
        providerDisclosure = deny('residency-denied');
      }
    }
  }
  return { policyVersion: EVIDENCE_POLICY_VERSION, artifactRead, sourceDocumentRead, providerDisclosure };
}
