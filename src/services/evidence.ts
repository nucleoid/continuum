import type pg from 'pg';
import { EVIDENCE_LIMITS, type EvidenceEnvelope, type EvidencePayloadRegistry, type EvidenceRegistration } from '../evidence/model.js';
import { decideEvidencePolicy, type EvidenceAuthorityContext, type EvidencePolicyDecision } from '../evidence/policy.js';
import { evidenceTransaction, evidenceEnvelope, evidencePayload, registerEvidenceVersion } from '../storage/evidence.js';
import { ServiceError } from './errors.js';

const unavailable = () => new ServiceError('NOT_FOUND', 'Evidence unavailable');
function decision(actor: string, envelope: EvidenceEnvelope, provider?: EvidenceAuthorityContext['provider']): EvidencePolicyDecision {
  const policy = { version: 'evidence-envelope-v1', currentVersion: 'evidence-envelope-v1', scopeIds: [envelope.scopeId],
    state: 'active' as const, expiresAt: envelope.expiresAt, residency: 'any' as const, connector: 'not-required' as const, repository: 'not-required' as const };
  return decideEvidencePolicy({ now: envelope.now, action: provider ? 'provider-disclosure' : 'text-hydration',
    continuum: { principalId: actor, enabled: true, checkedAt: envelope.now,
      readableScopeIds: [...new Set([envelope.scopeId, ...envelope.policies.flatMap(p => p.scopeIds)])] },
    artifact: { kind: envelope.kind, policy, authorityDependencies: envelope.policies }, providerInput: 'artifact', provider });
}
function safeError(error: unknown): never {
  if (error instanceof ServiceError) throw error;
  const code = (error as { code?: string }).code;
  if (code === '23514' || code === '42501') throw unavailable();
  throw new ServiceError('DEPENDENCY_UNAVAILABLE', 'Evidence dependency unavailable', { cause: error });
}
/** Internal authenticated composition. No transport or generator is enabled. */
export async function registerEvidence(pool: pg.Pool, actor: string, registration: EvidenceRegistration, owners: EvidencePayloadRegistry): Promise<string> {
  const input = structuredClone(registration);
  if (input.parents.length < 1 || input.parents.length > EVIDENCE_LIMITS.parents || !owners.accepts(input.kind, input.payload)) throw unavailable();
  try {
    return await evidenceTransaction(pool, async client => {
      const version = await registerEvidenceVersion(client, actor, input);
      // SQL has locked and rechecked all parents, roots, principal and current
      // memberships. Pure policy participates before this transaction commits.
      const envelope = await evidenceEnvelope(client, actor, version);
      if (!envelope || decision(actor, envelope).artifactRead.decision !== 'allow') throw unavailable();
      return version;
    });
  } catch (error) { return safeError(error); }
}
export async function readEvidence(pool: pg.Pool, actor: string, version: string, owners: EvidencePayloadRegistry,
  provider?: EvidenceAuthorityContext['provider']): Promise<string> {
  const destination = provider === undefined ? undefined : structuredClone(provider);
  try {
    return await evidenceTransaction(pool, async client => {
      const envelope = await evidenceEnvelope(client, actor, version);
      if (!envelope || !owners.supports(envelope.kind)) throw unavailable();
      const permit = decision(actor, envelope, destination);
      if ((destination ? permit.providerDisclosure : permit.artifactRead).decision !== 'allow') throw unavailable();
      const payload = await evidencePayload(client, actor, version, destination?.locality === 'hosted' ? 'hosted' : destination ? 'local' : null);
      if (payload === null) throw unavailable();
      return payload;
    });
  } catch (error) { return safeError(error); }
}
