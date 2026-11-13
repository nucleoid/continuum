import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../evaluation/test-helpers.js';
import {
  decideEvidencePolicy, EVIDENCE_ACTIONS, EVIDENCE_ARTIFACT_KINDS,
  type EvidenceAuthorityContext, type EvidencePolicy, type EvidenceTarget,
} from './policy.js';

const now = Date.parse('2026-02-01T00:00:00Z');
const fresh = () => ({ decision: 'allow' as const, checkedAt: now, validUntil: now + 1000 });
const policy = (scope = 'visible'): EvidencePolicy => ({
  version: '1', currentVersion: '1', scopeIds: [scope], state: 'active', expiresAt: null,
  residency: 'any', connector: 'not-required', repository: 'not-required',
});
const target = (scope = 'visible'): EvidenceTarget => ({
  kind: 'extracted-assertion', policy: policy(scope), authorityDependencies: [policy(scope)],
});
const context = (): EvidenceAuthorityContext => ({
  now, action: 'read', continuum: { principalId: 'reader', enabled: true, checkedAt: now, readableScopeIds: ['visible'] },
  artifact: target(), sourceDocument: { ...target('hidden'), kind: 'source-document-version' },
  provider: { locality: 'local', authority: fresh() }, providerInput: 'artifact',
});

describe('evidence authority intersection', () => {
  it.each(EVIDENCE_ARTIFACT_KINDS)('gates %s at every action without promoting read to mutation authority', (kind) => {
    for (const action of EVIDENCE_ACTIONS) {
      const input = context(); input.artifact = { ...target(), kind }; input.action = action;
      const supported = !['apply-publish', 'quarantine', 'erasure'].includes(action);
      expect(decideEvidencePolicy(input).artifactRead.decision).toBe(supported ? 'allow' : 'deny');
      input.artifact = { ...target('hidden'), kind };
      expect(decideEvidencePolicy(input).artifactRead.decision).toBe('deny');
    }
  });

  it('keeps separately authorized assertions independent of document text and provider input', () => {
    const input = context();
    expect(decideEvidencePolicy(input)).toMatchObject({ artifactRead: { decision: 'allow' },
      sourceDocumentRead: { decision: 'deny' }, providerDisclosure: { decision: 'allow' } });
    input.providerInput = 'source-document';
    expect(decideEvidencePolicy(input).providerDisclosure.decision).toBe('deny');
    input.artifact = target('hidden'); input.sourceDocument = target();
    expect(decideEvidencePolicy(input)).toMatchObject({ artifactRead: { decision: 'deny' }, sourceDocumentRead: { decision: 'allow' } });
  });

  it('intersects every parent and never accepts duplicate evidence or declassification flags as grants', () => {
    const input = context();
    input.artifact = { ...target(), authorityDependencies: [policy(), policy(), policy('hidden')],
      ...{ declassified: true, tags: ['public'], confidence: 1, sourceCount: 300 } };
    expect(decideEvidencePolicy(input).artifactRead).toEqual({ decision: 'deny', reason: 'scope-denied' });
    input.artifact.authorityDependencies = null;
    expect(decideEvidencePolicy(input).artifactRead.reason).toBe('authority-unknown');
  });

  it('denies missing, stale, disabled and unknown authority with bounded content-free reasons', () => {
    const changes: Array<(input: EvidenceAuthorityContext) => void> = [
      input => { input.continuum.enabled = false; },
      input => { input.continuum.principalId = ''; },
      input => { input.continuum.checkedAt--; },
      input => { input.now = NaN; },
      input => { input.artifact.policy.scopeIds = []; },
      input => { input.artifact.policy.version = ''; },
      input => { input.artifact.policy.currentVersion = '2'; },
      input => { input.artifact.policy.state = 'quarantined'; },
      input => { input.artifact.policy.expiresAt = now; },
      input => { input.artifact.policy.expiresAt = NaN; },
      input => { input.artifact.policy.repository = { ...fresh(), decision: 'unknown' }; },
      input => { input.artifact.policy.connector = { ...fresh(), validUntil: now }; },
      input => { input.artifact.policy.connector = { ...fresh(), checkedAt: now + 1 }; },
    ];
    for (const change of changes) {
      const input = context(); change(input);
      const result = decideEvidencePolicy(input);
      expect(result.artifactRead.decision).toBe('deny');
      expect(JSON.stringify(result)).not.toMatch(/hidden|reader|sourceCount|confidence/);
    }
  });

  it('requires independent repository and connector authority even with Continuum access', () => {
    const input = context();
    input.artifact.policy.repository = fresh();
    input.artifact.policy.connector = { ...fresh(), decision: 'deny' };
    expect(decideEvidencePolicy(input).artifactRead.decision).toBe('deny');
    input.artifact.policy.connector = fresh();
    expect(decideEvidencePolicy(input).artifactRead.decision).toBe('allow');
    input.continuum.readableScopeIds = [];
    expect(decideEvidencePolicy(input).artifactRead.decision).toBe('deny');
  });

  it('rechecks provider freshness and inherited locality for retries, fallbacks and cache reuse', () => {
    const input = context();
    input.artifact.authorityDependencies = [{ ...policy(), residency: 'local-only' }];
    input.provider!.locality = 'hosted';
    expect(decideEvidencePolicy(input)).toMatchObject({ artifactRead: { decision: 'allow' }, providerDisclosure: { reason: 'residency-denied' } });
    input.provider!.locality = 'unknown';
    expect(decideEvidencePolicy(input).providerDisclosure.decision).toBe('deny');
    input.provider!.locality = 'local';
    expect(decideEvidencePolicy(input).providerDisclosure.decision).toBe('allow');
    input.now += 1000; input.continuum.checkedAt = input.now;
    expect(decideEvidencePolicy(input).providerDisclosure.reason).toBe('authority-stale');
    delete input.provider;
    expect(decideEvidencePolicy(input).providerDisclosure.decision).toBe('deny');
  });

  it('uses frozen v1 policy attacks as data without trusting their snapshots or instruction text', async () => {
    const corpus = await loadCorpus();
    let denied = 0;
    for (const item of corpus.cases) for (const document of item.documents) {
      const input = context();
      // Synthetic trusted resolution for this matrix, not a production fixture adapter.
      input.artifact = { ...target(document.allowed ? 'visible' : 'hidden'),
        ...{ body: document.body, title: document.title, metadata: document } };
      if (!document.allowed) {
        expect(decideEvidencePolicy(input).artifactRead.decision).toBe('deny'); denied++;
      }
    }
    expect(denied).toBeGreaterThan(0);
  });
});
