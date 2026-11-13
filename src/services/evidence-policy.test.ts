import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership, removeMembership } from '../storage/memberships.js';
import { loadCorpus } from '../evaluation/test-helpers.js';
import type { EvidenceTarget } from '../evidence/policy.js';
import { decideEvidenceForPrincipal } from './access.js';

const target = (scopeId: string): EvidenceTarget => ({ kind: 'extracted-assertion',
  policy: { version: '1', currentVersion: '1', scopeIds: [scopeId], state: 'active', expiresAt: null,
    residency: 'any', connector: 'not-required', repository: 'not-required' }, authorityDependencies: [],
});
describe('trusted current evidence authority', () => {
  let owner: pg.Pool;
  let reader: Awaited<ReturnType<typeof createPrincipal>>;
  let scope: Awaited<ReturnType<typeof createScope>>;
  beforeEach(async () => {
    owner ??= await makeTestPool(); await resetData(owner);
    reader = await createPrincipal(owner, { externalId: 'evidence-reader', kind: 'service', displayName: 'Reader' });
    scope = await createScope(owner, { kind: 'project', name: 'evidence' });
    await addMembership(owner, reader.id, scope.id, 'reader');
  }, 30_000);
  afterAll(async () => { await owner?.end(); });

  it('ignores caller snapshots and rechecks removal, disablement and explicit restoration', async () => {
    const request = { action: 'read' as const, artifact: target(scope.id), providerInput: 'artifact' as const,
      ...{ continuum: { enabled: true, readableScopeIds: [scope.id] }, public: true, tags: ['decision'] } };
    expect((await decideEvidenceForPrincipal(owner, reader.id, request)).artifactRead.decision).toBe('allow');
    await removeMembership(owner, reader.id, scope.id);
    expect((await decideEvidenceForPrincipal(owner, reader.id, request)).artifactRead.decision).toBe('deny');
    await addMembership(owner, reader.id, scope.id, 'reader');
    await owner.query('UPDATE principals SET disabled_at=clock_timestamp() WHERE id=$1', [reader.id]);
    expect((await decideEvidenceForPrincipal(owner, reader.id, request)).artifactRead.decision).toBe('deny');
    // Owner-only fixture restoration does not restore memberships deleted/deactivated by disablement.
    await owner.query('UPDATE principals SET disabled_at=NULL WHERE id=$1', [reader.id]);
    expect((await decideEvidenceForPrincipal(owner, reader.id, request)).artifactRead.decision).toBe('deny');
    await addMembership(owner, reader.id, scope.id, 'reader');
    expect((await decideEvidenceForPrincipal(owner, reader.id, request)).artifactRead.decision).toBe('allow');
  });

  it('uses database Entra freshness while retaining manual break-glass semantics', async () => {
    await removeMembership(owner, reader.id, scope.id);
    await owner.query(`INSERT INTO scope_memberships(principal_id,scope_id,role,source_kind,source_id,active)
      VALUES($1,$2,'reader','entra','fixture',TRUE)`, [reader.id, scope.id]);
    await owner.query(`INSERT INTO entra_sync_state(singleton,last_success_at,max_staleness_hours)
      VALUES(TRUE,clock_timestamp(),48) ON CONFLICT(singleton) DO UPDATE SET last_success_at=EXCLUDED.last_success_at`);
    const request = { action: 'read' as const, artifact: target(scope.id), providerInput: 'artifact' as const };
    expect((await decideEvidenceForPrincipal(owner, reader.id, request)).artifactRead.decision).toBe('allow');
    await owner.query("UPDATE entra_sync_state SET last_success_at=clock_timestamp()-interval '49 hours'");
    expect((await decideEvidenceForPrincipal(owner, reader.id, request)).artifactRead.decision).toBe('deny');
    await addMembership(owner, reader.id, scope.id, 'reader');
    expect((await decideEvidenceForPrincipal(owner, reader.id, request)).artifactRead.decision).toBe('allow');
  });

  it('uses frozen denied-scope attacks against real membership, independent external authority and source restrictions', async () => {
    const corpus = await loadCorpus();
    const deniedScope = await createScope(owner, { kind: 'project', name: 'denied' });
    const attack = corpus.cases.find(item => item.id === 'cross-scope-denied')!;
    expect(attack.documents[0].allowed).toBe(false);
    const request = { action: 'read' as const, artifact: target(deniedScope.id), providerInput: 'artifact' as const,
      ...{ snapshot: attack.documents[0], allowedSource: 'manual' } };
    expect((await decideEvidenceForPrincipal(owner, reader.id, request)).artifactRead.decision).toBe('deny');
    request.artifact = target(scope.id);
    request.artifact.policy.repository = { decision: 'unknown', checkedAt: 0, validUntil: 0 };
    expect((await decideEvidenceForPrincipal(owner, reader.id, request)).artifactRead.decision).toBe('deny');
    request.artifact.policy.repository = 'not-required';
    expect((await decideEvidenceForPrincipal(owner, reader.id, request)).artifactRead.decision).toBe('allow');
    request.artifact.policy.scopeIds = [randomUUID()];
    expect((await decideEvidenceForPrincipal(owner, reader.id, request)).artifactRead.decision).toBe('deny');
  });

  it('resolves an actual non-owner APP read without granting operator mutation from an admin UUID', async () => {
    const role = `evidence26_${randomUUID().replaceAll('-', '')}`;
    const password = randomUUID();
    const url = new URL(process.env.CONTINUUM_TEST_DATABASE_URL ?? 'postgres://continuum:continuum@localhost:5433/continuum');
    let app: pg.Pool | undefined;
    await owner.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    try {
      execFileSync('psql', [url.toString(), '-X', '-v', 'ON_ERROR_STOP=1', '-v', 'continuum_schema=public',
        '-v', `continuum_app_role=${role}`, '-f', resolve('scripts/grant-application-role.sql')], { stdio: 'pipe', timeout: 30_000 });
      url.username = role; url.password = password;
      app = new pg.Pool({ connectionString: url.toString(), max: 1 });
      expect((await app.query('SELECT current_user AS role')).rows[0].role).toBe(role);
      const org = (await getScopeByRef(owner, { kind: 'org', name: '' }))!;
      await addMembership(owner, reader.id, org.id, 'admin');
      expect((await decideEvidenceForPrincipal(app, reader.id, {
        action: 'read', artifact: target(scope.id), providerInput: 'artifact',
      })).artifactRead.decision).toBe('allow');
      const result = await decideEvidenceForPrincipal(app, reader.id, {
        action: 'apply-publish', artifact: target(org.id), providerInput: 'artifact',
      });
      expect(result.artifactRead.reason).toBe('unsupported-action');
      await expect(app.query('SELECT continuum_operator_set_promotion_webhook_ids($1,$2)', [reader.id, []]))
        .rejects.toThrow();
    } finally {
      await app?.end();
      await owner.query('DELETE FROM continuum_pgvector_role_profiles WHERE database_role_oid=(SELECT oid FROM pg_roles WHERE rolname=$1)', [role]);
      await owner.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    }
  }, 30_000);
});
