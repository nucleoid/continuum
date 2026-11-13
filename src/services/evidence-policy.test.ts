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
import { provisionEntraGroupBinding, syncEntraMemberships } from './membership-sync.js';

const target = (scopeId: string): EvidenceTarget => ({ kind: 'extracted-assertion',
  policy: { version: '1', currentVersion: '1', scopeIds: [scopeId], state: 'active', expiresAt: null,
    residency: 'any', connector: 'not-required', repository: 'not-required' },
  authorityDependencies: [{ version: '1', currentVersion: '1', scopeIds: [scopeId], state: 'active', expiresAt: null,
    residency: 'any', connector: 'not-required', repository: 'not-required' }],
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

  it('does not turn a borrowed old transaction snapshot into current authority', async () => {
    const client = await owner.connect();
    try {
      expect((await decideEvidenceForPrincipal(client, reader.id, {
        action: 'read', artifact: target(scope.id), providerInput: 'artifact',
      })).artifactRead.decision).toBe('allow');
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query('SELECT 1 FROM scope_memberships');
      await removeMembership(owner, reader.id, scope.id);
      const result = await decideEvidenceForPrincipal(client, reader.id, {
        action: 'read', artifact: target(scope.id), providerInput: 'artifact',
      });
      expect(result.artifactRead.decision).toBe('deny');
      expect(result.artifactRead.reason).toBe('authority-stale');
      expect((await client.query('SELECT 42 AS value')).rows[0].value).toBe(42);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('snapshots trusted policy before awaiting and samples current time after resolving memberships', async () => {
    const request = { action: 'read' as const, artifact: target(scope.id), providerInput: 'artifact' as const };
    let called = false;
    const observed = { query: async (...args: Parameters<pg.Pool['query']>) => {
      if (!called) { called = true; request.artifact.policy.scopeIds = [randomUUID()]; }
      return owner.query(...args);
    } } as unknown as pg.Pool;
    expect((await decideEvidenceForPrincipal(observed, reader.id, request)).artifactRead.decision).toBe('allow');
    expect((await decideEvidenceForPrincipal(owner, reader.id, request)).artifactRead.decision).toBe('deny');
  });

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
    const admin = await createPrincipal(owner, { externalId: 'evidence-admin', kind: 'user', displayName: 'Admin' });
    const org = (await getScopeByRef(owner, { kind: 'org', name: '' }))!;
    await addMembership(owner, admin.id, org.id, 'admin');
    reader = await createPrincipal(owner, { externalId: randomUUID(), kind: 'user', displayName: 'Entra reader' });
    const groupId = randomUUID();
    await provisionEntraGroupBinding(owner, admin, { externalId: groupId, scopeId: scope.id, role: 'reader' });
    await syncEntraMemberships(owner, admin, [{ id: groupId, status: 'present', displayName: 'Evidence', memberObjectIds: [reader.externalId] }]);
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
    const operatorRole = `evidence26_op_${randomUUID().replaceAll('-', '')}`;
    const password = randomUUID();
    const url = new URL(process.env.CONTINUUM_TEST_DATABASE_URL ?? 'postgres://continuum:continuum@localhost:5433/continuum');
    let app: pg.Pool | undefined;
    let operator: pg.Pool | undefined;
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
        .rejects.toThrow(/permission denied/);
      const admin = await createPrincipal(owner, { externalId: 'bound-evidence-admin', kind: 'user', displayName: 'Admin' });
      await addMembership(owner, admin.id, org.id, 'admin');
      await owner.query(`CREATE ROLE "${operatorRole}" LOGIN PASSWORD '${password}'`);
      const ownerUrl = process.env.CONTINUUM_TEST_DATABASE_URL ?? 'postgres://continuum:continuum@localhost:5433/continuum';
      for (const script of ['grant-application-role.sql', 'grant-operator-role.sql']) {
        execFileSync('psql', [ownerUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-v', 'continuum_schema=public',
          '-v', `continuum_app_role=${operatorRole}`, '-v', `continuum_operator_role=${operatorRole}`,
          '-v', `continuum_principal_id=${admin.id}`, '-f', resolve('scripts', script)], { stdio: 'pipe', timeout: 30_000 });
      }
      url.username = operatorRole;
      operator = new pg.Pool({ connectionString: url.toString(), max: 1 });
      await operator.query('SELECT continuum_operator_set_promotion_webhook_ids($1,$2)', [admin.id, ['evidence26']]);
      expect((await owner.query('SELECT webhook_ids FROM promotion_webhook_registry')).rows[0].webhook_ids).toEqual(['evidence26']);
      await expect(operator.query('SELECT continuum_operator_set_promotion_webhook_ids($1,$2)', [reader.id, []]))
        .rejects.toThrow();
    } finally {
      await app?.end();
      await operator?.end();
      for (const cleanupRole of [role, operatorRole]) {
        if (!(await owner.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [cleanupRole])).rowCount) continue;
        await owner.query('DELETE FROM continuum_pgvector_role_profiles WHERE database_role_oid=(SELECT oid FROM pg_roles WHERE rolname=$1)', [cleanupRole]);
        await owner.query('DELETE FROM continuum_trusted_database_identities WHERE database_role=$1::name', [cleanupRole]);
        await owner.query(`DROP OWNED BY "${cleanupRole}"; DROP ROLE "${cleanupRole}"`);
      }
    }
  }, 30_000);
});
