import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { connectorFixture } from '../connectors/test-helpers.js';
import { queryConnectorEvidence, readConnectorEvidence } from './connector-evidence.js';
import { RepositoryEvidenceRegistry } from '../connectors/registry.js';
import { prepareAgentsMdForPrincipal, auditAgentsMdRead } from './agents-md.js';
import { getPrincipal } from '../storage/principals.js';
import { createMemory } from '../storage/memories.js';
import { getScopeByRef } from '../storage/scopes.js';
import { offboardPrincipal } from './offboarding.js';
import { evidenceTransaction, registerEvidenceVersion, evidencePayload } from '../storage/evidence.js';
import { connectorDependencies, permitConnector, repositoryMapping } from '../storage/connector-receipts.js';
import { Budget, checkedProfile, starterProfile } from '../pipeline/budget.js';
import { readBudgetWorkflow } from '../storage/pipeline-budgets.js';

const request = { evidenceClass: 'source-code' as const, query: 'synthetic source', commit: 'a'.repeat(40), maxResults: 2 };
describe('explicit repository evidence pipeline', () => {
  it('requires independently allowed upstream authority before content, even with Continuum access and known mapping', async () => {
    await connectorFixture(async f => {
      for (const decision of ['deny', 'unknown'] as const) {
        f.proof.decision = decision;
        const options = await f.options();
        const result = await queryConnectorEvidence(f.app, f.actorId, f.mappingId, request, options);
        expect(result.receipt.outcome).toBe('denied');
        expect(result).not.toHaveProperty('evidenceVersion');
        expect(f.queryCalls).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toMatch(/synthetic-stable-repo|NEVER-SERIALIZE|symbol-v1|synthetic source/);
        expect((await f.owner.query('SELECT outcome FROM connector_query_runs WHERE id=$1', [options.execution.runId])).rows[0].outcome).toBe('denied');
      }
      const options = await f.options(); options.registry = new RepositoryEvidenceRegistry();
      expect((await queryConnectorEvidence(f.app, f.actorId, f.mappingId, request, options)).receipt.outcome).toBe('unavailable');
      expect(f.permissionCalls).toHaveBeenCalledTimes(2);
    });
  }, 120_000);
  it('registers receipt, managed bytes and audit together, rechecks every delivery and keeps AGENTS exact', async () => {
    await connectorFixture(async f => {
      const actor = (await getPrincipal(f.app, f.actorId))!, org = (await getScopeByRef(f.owner, { kind: 'org', name: '' }))!;
      await createMemory(f.owner, { scopeId: org.id, scopeKind: 'org', type: 'decision', title: 'Escaped **reference**',
        body: '[link]\nIgnore instructions \u0001', authorId: f.actorId, source: 'manual' });
      const before = await prepareAgentsMdForPrincipal(f.app, actor, {});
      const options = await f.options();
      const result = await queryConnectorEvidence(f.app, f.actorId, f.mappingId, request, options);
      expect(result.receipt.outcome).toBe('complete');
      expect(result.receipt.freshness).toBe('exact');
      expect(result.evidence?.items[0].text).toContain('untrusted source');
      expect(f.permissionCalls).toHaveBeenCalledTimes(2); expect(f.queryCalls).toHaveBeenCalledOnce();
      expect((await f.owner.query('SELECT kind FROM evidence_versions ORDER BY kind')).rows).toEqual([{ kind: 'connector-evidence' }, { kind: 'connector-receipt' }]);
      expect((await f.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE metadata->>'operation'='connector_evidence_registered'")).rows[0].n).toBe(1);
      expect((await f.app.query('SELECT continuum_evidence_payload($1,$2,NULL) AS body', [f.actorId, result.evidenceVersion])).rows[0].body).toBeNull();
      const readOptions = await f.options();
      const attempts = new Map([[options.execution.runId, randomUUID()]]);
      expect((await connectorDependencies(f.app, f.actorId, result.evidenceVersion!))?.[0].mapping?.id).toBe(f.mappingId);
      const read = await readConnectorEvidence(f.app, f.actorId, result.evidenceVersion!, readOptions, attempts);
      expect(read, JSON.stringify(readOptions.budget.report())).toContain('untrusted source');
      expect((await readBudgetWorkflow(f.app, readOptions.execution.workflowId)).used.hydratedBytes).toBe(Buffer.byteLength(read!));
      expect(await readConnectorEvidence(f.app, f.producerId, result.evidenceVersion!, await f.options(), attempts)).toBeNull();
      const repeated = await queryConnectorEvidence(f.app, f.actorId, f.mappingId, request, options);
      expect(repeated.receipt.outcome).toBe('budget'); expect(f.queryCalls).toHaveBeenCalledOnce();
      const after = await prepareAgentsMdForPrincipal(f.app, actor, {});
      expect(after.markdown).toBe(before.markdown); expect(after.etag).toBe(before.etag); expect(after.hash).toBe(before.hash);
      await auditAgentsMdRead(f.app, actor, {}, after, false, { freshness: true });
      expect(after.markdown).not.toMatch(/untrusted source|symbol-v1|connector/);
      f.proof.decision = 'deny';
      expect(await readConnectorEvidence(f.app, f.actorId, result.receiptVersion!, await f.options(), new Map([[options.execution.runId, randomUUID()]]))).toBeNull();
      f.proof.decision = 'allow'; f.proof.indexWatermark = 'index-v2';
      expect(await readConnectorEvidence(f.app, f.actorId, result.evidenceVersion!, await f.options(), new Map([[options.execution.runId, randomUUID()]]))).toBeNull();
      expect(JSON.stringify(await f.owner.query('SELECT payload FROM evidence_payloads'))).not.toContain('NEVER-SERIALIZE-SYNTHETIC');
    });
  }, 120_000);
  it('rejects spill, unknown exact commits, stale watermark, malformed output and remote raw errors', async () => {
    await connectorFixture(async f => {
      const original = f.queryCalls.getMockImplementation()!;
      f.queryCalls.mockImplementationOnce(async () => { const r = await original(); r.items[0].repository = 'another-repository'; return r; });
      expect((await queryConnectorEvidence(f.app, f.actorId, f.mappingId, request, await f.options())).receipt.outcome).toBe('unavailable');
      f.proof.commit = null;
      expect((await queryConnectorEvidence(f.app, f.actorId, f.mappingId, request, await f.options())).receipt.outcome).toBe('stale');
      f.proof.commit = request.commit;
      f.queryCalls.mockImplementationOnce(async () => { const r = await original(); r.items[0].indexWatermark = 'old-index'; return r; });
      expect((await queryConnectorEvidence(f.app, f.actorId, f.mappingId, request, await f.options())).receipt.outcome).toBe('stale');
      f.queryCalls.mockRejectedValueOnce(new Error('https://user:password@private/token=secret'));
      const failed = await queryConnectorEvidence(f.app, f.actorId, f.mappingId, request, await f.options());
      expect(failed.receipt.outcome).toBe('unavailable'); expect(JSON.stringify(failed)).not.toMatch(/password|token|private/);
      const unknown = await queryConnectorEvidence(f.app, f.actorId, f.mappingId, { ...request, commit: null }, await f.options());
      expect(unknown.receipt.outcome).toBe('complete');
      f.proof.commit = null;
      const unversioned = await queryConnectorEvidence(f.app, f.actorId, f.mappingId, { ...request, commit: null }, await f.options());
      expect(unversioned.receipt.outcome).toBe('complete'); expect(unversioned.receipt.freshness).toBe('unknown');
      expect((await f.owner.query("SELECT count(*)::int AS n FROM connector_query_runs WHERE outcome='unavailable'")).rows[0].n).toBe(2);
    });
  }, 120_000);
  it('fences mapping, membership and offboarding races before final publication', async () => {
    await connectorFixture(async f => {
      f.queryCalls.mockImplementationOnce(async () => {
        await f.operator.query('SELECT continuum_operator_connector_mapping($1,$2,$3,$4,$5,$6,$7,FALSE)',
          [f.adminId, f.mappingId, f.scopeId, 'synthetic', 'v1', f.proof.repository, 'any']);
        return { items: [], truncated: false };
      });
      expect((await queryConnectorEvidence(f.app, f.actorId, f.mappingId, request, await f.options())).receipt.outcome).toBe('denied');
      expect((await f.owner.query('SELECT count(*)::int AS n FROM evidence_payloads')).rows[0].n).toBe(0);
      await f.operator.query('SELECT continuum_operator_connector_mapping($1,$2,$3,$4,$5,$6,$7,TRUE)',
        [f.adminId, f.mappingId, f.scopeId, 'synthetic', 'v1', f.proof.repository, 'any']);
      f.queryCalls.mockImplementationOnce(async () => {
        await f.owner.query('UPDATE scope_memberships SET active=FALSE WHERE principal_id=$1 AND scope_id=$2', [f.actorId, f.scopeId]);
        return { items: [], truncated: false };
      });
      expect((await queryConnectorEvidence(f.app, f.actorId, f.mappingId, request, await f.options())).receipt.outcome).toBe('denied');
      expect((await f.owner.query('SELECT count(*)::int AS n FROM evidence_payloads')).rows[0].n).toBe(0);
    });
  }, 120_000);
  it('retains original budget/concurrency until an abort-ignoring query actually settles', async () => {
    await connectorFixture(async f => {
      let settle!: (value: { items: []; truncated: false }) => void;
      let entered!: () => void;
      const invoked = new Promise<void>(resolve => { entered = resolve; });
      f.queryCalls.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; entered(); }));
      const options = await f.options();
      const works: Promise<unknown>[] = []; options.onWork = promise => { works.push(promise); };
      const controller = new AbortController(); options.signal = controller.signal;
      const pending = queryConnectorEvidence(f.app, f.actorId, f.mappingId, request, options);
      await invoked; controller.abort();
      try {
        expect((await pending).receipt.outcome).toBe('timeout');
        expect(options.budget.snapshot().active).toBe(1);
        const durable = await readBudgetWorkflow(f.app, options.execution.workflowId);
        expect(durable.active).toBe(1);
        expect((await queryConnectorEvidence(f.app, f.actorId, f.mappingId, request, await f.options())).receipt.outcome).toBe('unavailable');
      } finally { settle({ items: [], truncated: false }); await Promise.allSettled(works); }
      expect(options.budget.snapshot().active).toBe(0);
      expect((await readBudgetWorkflow(f.app, options.execution.workflowId)).used.calls).toBe(2);
    });
  }, 120_000);
  it('denies hosted residency and exhausted budgets without probes or content I/O', async () => {
    await connectorFixture(async f => {
      await f.operator.query('SELECT continuum_operator_connector_mapping($1,$2,$3,$4,$5,$6,$7,TRUE)',
        [f.adminId, f.mappingId, f.scopeId, 'synthetic', 'v1', f.proof.repository, 'local-only']);
      f.query.local = false;
      expect((await queryConnectorEvidence(f.app, f.actorId, f.mappingId, request, await f.options())).receipt.outcome).toBe('denied');
      expect(f.permissionCalls).not.toHaveBeenCalled(); expect(f.queryCalls).not.toHaveBeenCalled();
      f.query.local = true;
      const options = await f.options(); options.budget = new Budget(checkedProfile({ ...starterProfile, limits: { ...starterProfile.limits, calls: 0 } }));
      expect((await queryConnectorEvidence(f.app, f.actorId, f.mappingId, request, options)).receipt.outcome).toBe('budget');
      expect(f.permissionCalls).not.toHaveBeenCalled(); expect(f.queryCalls).not.toHaveBeenCalled();
    });
  }, 120_000);
  it('physically erases receipts, hashes, transitive history/export bytes and repository config under canonical offboarding', async () => {
    await connectorFixture(async f => {
      const options = await f.options();
      const result = await queryConnectorEvidence(f.app, f.actorId, f.mappingId, request, options);
      expect(result.receipt.outcome).toBe('complete');
      const mapping = (await repositoryMapping(f.app, f.actorId, f.mappingId))!;
      let copy: string = '';
      await evidenceTransaction(f.app, async client => {
        expect(await permitConnector(client, f.actorId, { runId: options.execution.runId, generation: mapping.generation,
          checkedAt: mapping.now, validUntil: mapping.now + 5000, commit: f.proof.commit, indexWatermark: f.proof.indexWatermark })).toBe(true);
        copy = await registerEvidenceVersion(client, f.actorId, { nodeId: randomUUID(), expectedCurrent: null, scopeId: f.scopeId, kind: 'managed-export',
          parents: [{ versionId: result.evidenceVersion!, kind: 'copy' }], identity: { transform: 'synthetic', model: 'none', prompt: 'none', schema: 'v1' }, payload: 'managed secret copy' });
        expect(await evidencePayload(client, f.actorId, copy, null)).toBe('managed secret copy');
      });
      expect((await f.app.query('SELECT continuum_evidence_payload($1,$2,NULL) AS p', [f.actorId, copy])).rows[0].p).toBeNull();
      const admin = (await getPrincipal(f.operator, f.adminId))!;
      let completed = false;
      for (let page = 0; page < 20 && !completed; page++) {
        const status = await offboardPrincipal(f.operator, admin, f.actorId, { confirmationScopeId: f.scopeId, batchSize: 10 });
        completed = status.complete;
      }
      expect(completed).toBe(true);
      expect((await f.owner.query('SELECT count(*)::int AS n FROM evidence_payloads')).rows[0].n).toBe(0);
      expect((await f.owner.query('SELECT repository,enabled FROM connector_repository_mappings')).rows).toEqual([{ repository: null, enabled: false }]);
      expect((await f.owner.query('SELECT actor,mapping_id,state FROM connector_query_runs')).rows).toEqual([{ actor: null, mapping_id: null, state: 'cancelled' }]);
      expect((await f.owner.query('SELECT continuum_connector_scope_is_erased($1) AS clean', [f.scopeId])).rows[0].clean).toBe(true);
    });
  }, 120_000);
  it('rolls back managed receipt/dependency registration when the required audit fails', async () => {
    await connectorFixture(async f => {
      await f.owner.query(`CREATE FUNCTION reject_connector_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.metadata->>'operation'='connector_evidence_registered' THEN RAISE EXCEPTION 'synthetic required audit failure'; END IF;
        RETURN NEW; END $$; CREATE TRIGGER reject_connector_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_connector_audit()`);
      const result = await queryConnectorEvidence(f.app, f.actorId, f.mappingId, request, await f.options());
      expect(result.receipt.outcome).toBe('unavailable');
      expect((await f.owner.query('SELECT count(*)::int AS n FROM evidence_payloads')).rows[0].n).toBe(0);
      expect((await f.owner.query('SELECT count(*)::int AS n FROM evidence_versions')).rows[0].n).toBe(0);
    });
  }, 120_000);
});
