import { expect, it } from 'vitest';
import { embeddingQueueFixture } from '../embeddings/test-helpers.js';
import { captureMemory } from '../services/capture.js';
import { mapOwnedUserScope, offboardPrincipal } from '../services/offboarding.js';
import { quoteStandupIdentifier } from '../standup/test-helpers.js';
import { getPrincipal } from './principals.js';

it.each(['grant', 'function'] as const)('commits access revocation while the new scrub %s is missing, then resumes physical erasure', async missing => {
  await embeddingQueueFixture(async f => {
    const captured = await captureMemory(f.app, f.router, f.principal, {
      scope: { kind: f.scope.kind, name: f.scope.name }, type: 'fact',
      title: 'Pending privacy source', body: 'Must not be called erased while capability is missing.', source: 'manual',
    }, {}, { idempotencyKey: 'pending-privacy-source' });
    const admin = (await getPrincipal(f.operator, f.adminId))!;
    await mapOwnedUserScope(f.operator, admin, f.actorId, f.scopeId, true);
    const opRole = (await f.operator.query('SELECT session_user AS name')).rows[0].name as string;
    const capability = 'continuum_operator_scrub_embedding_scope(uuid,uuid,uuid,integer)';
    const options = { confirmationScopeId: f.scopeId, batchSize: 10 };
    const pendingAudits = async () => (await f.owner.query(`SELECT metadata FROM audit_log
      WHERE metadata->>'operation'='principal_offboarding_access_revoked'
        AND metadata->>'principal_id'=$1`, [f.actorId])).rows;
    const renamed = 'continuum_operator_scrub_embedding_scope_pending_test(uuid,uuid,uuid,integer)';
    if (missing === 'grant') await f.owner.query(`REVOKE EXECUTE ON FUNCTION ${capability} FROM ${quoteStandupIdentifier(opRole)}`);
    else await f.owner.query(`ALTER FUNCTION ${capability} RENAME TO continuum_operator_scrub_embedding_scope_pending_test`);
    try {
      if (missing === 'grant') {
        expect((await f.operator.query('SELECT has_function_privilege($1,\'EXECUTE\') AS allowed', [capability])).rows)
          .toEqual([{ allowed: false }]);
      } else {
        expect((await f.operator.query('SELECT to_regprocedure($1) IS NULL AS absent', [capability])).rows)
          .toEqual([{ absent: true }]);
      }
      // Missing the new capability must not turn an unauthorized actor or APP
      // database session into a successful/pending administrative operation.
      await expect(offboardPrincipal(f.operator, f.principal, f.actorId, options))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(offboardPrincipal(f.app, admin, f.actorId, options))
        .rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
      expect((await f.owner.query('SELECT disabled_at FROM principals WHERE id=$1', [f.actorId])).rows)
        .toEqual([{ disabled_at: null }]);
      expect((await f.owner.query('SELECT 1 FROM principal_offboarding_runs WHERE principal_id=$1', [f.actorId])).rowCount).toBe(0);

      const first = await offboardPrincipal(f.operator, admin, f.actorId, options);
      expect(first).toMatchObject({ complete: false, progressed: true, reason: 'migration_pending' });
      expect((await f.owner.query('SELECT disabled_at IS NOT NULL AS disabled FROM principals WHERE id=$1', [f.actorId])).rows)
        .toEqual([{ disabled: true }]);
      expect((await f.owner.query('SELECT 1 FROM scope_memberships WHERE principal_id=$1 AND scope_id=$2 AND active',
        [f.actorId, f.scopeId])).rowCount).toBe(0);
      expect((await f.owner.query('SELECT scope_cleanup_complete FROM principal_offboarding_runs WHERE principal_id=$1', [f.actorId])).rows)
        .toEqual([{ scope_cleanup_complete: false }]);
      expect((await f.owner.query(`SELECT 1 FROM principal_offboarding_run_events e JOIN principal_offboarding_runs r ON r.run_id=e.run_id
        WHERE r.principal_id=$1 AND e.phase='completed'`, [f.actorId])).rowCount).toBe(0);
      const audits = await pendingAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0].metadata).toMatchObject({ privacy_pending: true, reason: 'migration_pending' });
      expect((await f.owner.query('SELECT title,body FROM memories WHERE id=$1', [captured.memory.id])).rows)
        .toEqual([{ title: 'Pending privacy source', body: 'Must not be called erased while capability is missing.' }]);
      const retry = await offboardPrincipal(f.operator, admin, f.actorId, options);
      expect(retry).toMatchObject({ complete: false, progressed: false, reason: 'migration_pending' });
      expect(retry.progress.batch).toBe(first.progress.batch);
      expect(await pendingAudits()).toEqual(audits);
    } finally {
      if (missing === 'grant') await f.owner.query(`GRANT EXECUTE ON FUNCTION ${capability} TO ${quoteStandupIdentifier(opRole)}`);
      else await f.owner.query(`ALTER FUNCTION ${renamed} RENAME TO continuum_operator_scrub_embedding_scope`);
    }
    let result = await offboardPrincipal(f.operator, admin, f.actorId, options);
    for (let batch = 0; !result.complete && batch < 30; batch++) {
      result = await offboardPrincipal(f.operator, admin, f.actorId, options);
    }
    expect(result.complete).toBe(true);
    expect((await f.owner.query('SELECT continuum_embedding_scope_is_erased($1) AS clean', [f.scopeId])).rows)
      .toEqual([{ clean: true }]);
    expect((await f.owner.query('SELECT continuum_offboarding_lifecycle_state_is_erased(run_id) AS clean FROM principal_offboarding_runs WHERE principal_id=$1',
      [f.actorId])).rows).toEqual([{ clean: true }]);
    expect((await f.owner.query('SELECT title,body FROM memories WHERE id=$1', [captured.memory.id])).rows)
      .toEqual([{ title: '[erased]', body: '[erased]' }]);
  });
}, 120000);
