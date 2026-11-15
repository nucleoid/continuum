import type pg from 'pg';
import { Budget, BudgetError, amounts, boundedJson, budgetedStageUnavailable, runBudgetedStage, type BudgetAdapter } from '../pipeline/budget.js';
import { pipelineAttempt } from '../storage/pipeline-budgets.js';
import { evidenceEnvelope, evidencePayload, evidenceTransaction } from '../storage/evidence.js';
import { connectorAdmission, connectorDependencies, finishConnectorRun, permitConnector, repositoryMapping, startConnectorRun,
  type ConnectorExecution, type ConnectorPermit, type RepositoryMapping } from '../storage/connector-receipts.js';
import { decideEvidencePolicy } from '../evidence/policy.js';
import { decideManagedEvidence } from './evidence.js';
import { REPOSITORY_EVIDENCE_LIMITS, repositoryAuthoritySchema, repositoryRequestSchema, validateRepositoryEvidence,
  type ConnectorOutcome, type ConnectorReceipt, type RepositoryAuthority, type RepositoryEvidenceClass, type RepositoryEvidenceResponse,
  type RepositoryPermissionRequest } from '../connectors/evidence.js';
import type { RepositoryEvidenceRegistry } from '../connectors/registry.js';

export interface ConnectorEvidenceOptions {
  registry: RepositoryEvidenceRegistry;
  /** Transport-owned context; never cloned into a request, model, audit or receipt. */
  authorizationContext: object;
  budget: Budget;
  execution: ConnectorExecution;
  signal?: AbortSignal;
  onWork?: (settlement: Promise<unknown>) => void;
}
export type ConnectorEvidenceResult = { receipt: ConnectorReceipt; receiptVersion?: string; evidenceVersion?: string; evidence?: RepositoryEvidenceResponse };
function safeReceipt(evidenceClass: RepositoryEvidenceClass, outcome: ConnectorOutcome): ConnectorReceipt {
  return { schema: 'repository-evidence-v1', outcome, evidenceClass, freshness: outcome === 'stale' ? 'stale' : 'unknown',
    commit: null, indexWatermark: null, truncated: false };
}
function sameMapping(a: RepositoryMapping, b: RepositoryMapping | null): b is RepositoryMapping {
  return b !== null && a.id === b.id && a.generation === b.generation && a.scopeId === b.scopeId
    && a.connectorId === b.connectorId && a.connectorVersion === b.connectorVersion && a.repository === b.repository && a.residency === b.residency;
}
function stageReason(reason: string): ConnectorOutcome {
  if (reason === 'deadline' || reason === 'cancelled') return 'timeout';
  if (reason === 'policy_denied') return 'denied';
  if (reason === 'budget_exhausted' || reason === 'stale_attempt') return 'budget';
  return 'unavailable';
}
function zeroPrice<I, O>(adapter: BudgetAdapter<I, O>): boolean {
  return adapter.price?.id === 'local-zero-v1' && adapter.price.inputMicros === 0 && adapter.price.outputMicros === 0
    && adapter.price.reasoningMicros === 0 && adapter.responseBodyBytes <= REPOSITORY_EVIDENCE_LIMITS.responseBytes;
}
function currentPolicy(actor: string, mapping: RepositoryMapping, proof: RepositoryAuthority, checkedAt: number, local: boolean): boolean {
  const authority = { decision: proof.decision, checkedAt, validUntil: checkedAt + proof.validForMs };
  const policy = { version: String(mapping.generation), currentVersion: String(mapping.generation), scopeIds: [mapping.scopeId],
    state: 'active' as const, expiresAt: authority.validUntil, residency: mapping.residency, connector: authority, repository: authority };
  return proof.repository === mapping.repository && proof.principalId === actor && decideEvidencePolicy({ now: mapping.now,
    action: 'provider-disclosure', continuum: { principalId: actor, enabled: true, checkedAt: mapping.now, readableScopeIds: [mapping.scopeId] },
    artifact: { kind: 'connector-evidence', policy, authorityDependencies: [] }, providerInput: 'artifact',
    provider: { locality: local ? 'local' : 'hosted', authority } }).providerDisclosure.decision === 'allow';
}
async function probe(pool: pg.Pool, actor: string, mapping: RepositoryMapping,
  adapter: BudgetAdapter<RepositoryPermissionRequest, RepositoryAuthority>, options: ConnectorEvidenceOptions, attemptId: string,
  admission: { candidates?: number; hydratedBytes?: number; outputBytes?: number } = {}): Promise<
    { proof: RepositoryAuthority; checkedAt: number } | { outcome: ConnectorOutcome }> {
  const checkedAt = mapping.now; // Conservative database time BEFORE serialization/remote work.
  let admitted = false;
  const { outputBytes: deliveryBytes = 0, ...metadataAdmission } = admission;
  options.budget.consume(metadataAdmission);
  if (deliveryBytes > options.budget.available('outputBytes')) throw new BudgetError();
  const durable = pipelineAttempt(pool, { id: options.execution.workflowId, attemptId, owner: options.execution.workerId, generation: options.execution.generation });
  const result = await runBudgetedStage(options.budget, adapter, { repository: mapping.repository, principalId: actor }, {
    signal: options.signal, onWork: options.onWork,
    durable: { ...durable,
      reserve: (requested, retained) => durable.reserve(amounts({ ...requested, ...metadataAdmission,
        outputBytes: requested.outputBytes + deliveryBytes }), retained + deliveryBytes),
      // Publication happens after this probe settles. Keep the whole bounded
      // delivery allowance, including on failure, rather than refunding an
      // original workflow before its final serialization/transaction completes.
      settle: (actual, provenance) => durable.settle(actual.outputBytes === undefined ? actual
        : { ...actual, outputBytes: actual.outputBytes + deliveryBytes }, provenance),
    },
    authorize: async () => {
      if (!sameMapping(mapping, await repositoryMapping(pool, actor, mapping.id))) return false;
      if (admitted) return true;
      admitted = true;
      return connectorAdmission(pool, actor, mapping, 'permission');
    },
  });
  if (result.status !== 'complete') return { outcome: stageReason(result.reason) } as const;
  const parsed = repositoryAuthoritySchema.safeParse(result.value);
  if (!parsed.success || !currentPolicy(actor, { ...mapping, now: (await repositoryMapping(pool, actor, mapping.id))?.now ?? Infinity }, parsed.data, checkedAt, adapter.local)) {
    return { outcome: 'denied' } as const;
  }
  return { proof: parsed.data, checkedAt };
}

/** Explicit internal pipeline consumer only. No ordinary recall, capture,
 * transport credential or generator path implicitly invokes this service. */
async function executeQuery(pool: pg.Pool, actor: string, mappingId: string,
  request: Omit<import('../connectors/evidence.js').RepositoryEvidenceRequest, 'repository'>, options: ConnectorEvidenceOptions,
  invocation: { started: boolean }): Promise<ConnectorEvidenceResult> {
  const parsedRequest = repositoryRequestSchema.omit({ repository: true }).safeParse(request);
  const evidenceClass = parsedRequest.success ? parsedRequest.data.evidenceClass : 'repository-brief';
  const fail = (outcome: ConnectorOutcome): ConnectorEvidenceResult => ({ receipt: safeReceipt(evidenceClass, outcome) });
  if (!parsedRequest.success) return fail('unavailable');
  try {
    const mapping = await repositoryMapping(pool, actor, mappingId);
    if (!mapping) return fail('denied');
    const connector = options.registry.get(mapping.connectorId);
    if (!connector || connector.version !== mapping.connectorVersion || !connector.classes.includes(evidenceClass)) return fail('unavailable');
    const input = repositoryRequestSchema.parse({ ...parsedRequest.data, repository: mapping.repository });
    boundedJson(input, REPOSITORY_EVIDENCE_LIMITS.requestBytes);
    const session = connector.open(options.authorizationContext);
    if (!zeroPrice(session.permission) || !zeroPrice(session.query)
      || budgetedStageUnavailable(options.budget.profile, session.permission) || budgetedStageUnavailable(options.budget.profile, session.query)) return fail('unavailable');
    if (mapping.residency === 'local-only' && (!session.permission.local || !session.query.local)) return fail('denied');
    if (!await startConnectorRun(pool, actor, mapping, options.execution)) return fail('budget');
    invocation.started = true;
    const first = await probe(pool, actor, mapping, session.permission, options, options.execution.permissionAttempt);
    if (!('proof' in first)) return fail(first.outcome);
    if (input.commit !== null && input.commit !== first.proof.commit) return fail('stale');
    // Reserve worst-case managed costs before content I/O in BOTH ledgers.
    // Non-call dimensions have no optimistic refund on failure/restart.
    if (session.query.responseBodyBytes > options.budget.profile.maxItemHydratedBytes) return fail('budget');
    const managed = { candidates: input.maxResults, hydratedBytes: session.query.responseBodyBytes,
      artifactBytes: session.query.responseBodyBytes, storageBytes: session.query.responseBodyBytes + REPOSITORY_EVIDENCE_LIMITS.receiptBytes };
    options.budget.consume(managed);
    const durableQuery = pipelineAttempt(pool, { id: options.execution.workflowId, attemptId: options.execution.queryAttempt,
      owner: options.execution.workerId, generation: options.execution.generation });
    let contentAdmitted = false;
    const queried = await runBudgetedStage(options.budget, session.query, input, { signal: options.signal, onWork: options.onWork,
      durable: { ...durableQuery, reserve: (requested, retained) => durableQuery.reserve(amounts({ ...requested, ...managed }), retained) },
      authorize: async () => {
        const current = await repositoryMapping(pool, actor, mapping.id);
        if (!sameMapping(mapping, current) || !currentPolicy(actor, current, first.proof, first.checkedAt, session.query.local)) return false;
        if (contentAdmitted) return true;
        contentAdmitted = true;
        return connectorAdmission(pool, actor, current, 'content');
      } });
    if (queried.status !== 'complete') return fail(stageReason(queried.reason));
    if (!validateRepositoryEvidence(queried.value, input)) return fail('unavailable');
    const content = boundedJson(queried.value, Math.min(REPOSITORY_EVIDENCE_LIMITS.responseBytes, session.query.responseBodyBytes));
    const latest = await repositoryMapping(pool, actor, mapping.id);
    if (!sameMapping(mapping, latest)) return fail('denied');
    const final = await probe(pool, actor, latest, session.permission, options, options.execution.deliveryAttempt,
      { outputBytes: Buffer.byteLength(content) + REPOSITORY_EVIDENCE_LIMITS.receiptBytes + 512 });
    if (!('proof' in final)) return fail(final.outcome);
    if (final.proof.commit !== first.proof.commit || final.proof.indexWatermark !== first.proof.indexWatermark
      || queried.value.items.some(item => (item.commit !== null && item.commit !== final.proof.commit)
        || (item.indexWatermark !== null && item.indexWatermark !== final.proof.indexWatermark))) return fail('stale');
    const receipt: ConnectorReceipt = { schema: 'repository-evidence-v1', outcome: 'complete', evidenceClass,
      freshness: queried.value.items.length > 0 && queried.value.items.every(item => item.commit !== null && item.kind !== 'history') ? 'exact' : 'unknown',
      commit: final.proof.commit, indexWatermark: final.proof.indexWatermark, truncated: queried.value.truncated };
    boundedJson(receipt, REPOSITORY_EVIDENCE_LIMITS.receiptBytes);
    return await evidenceTransaction(pool, async client => {
      if (!await permitConnector(client, actor, { runId: options.execution.runId, generation: mapping.generation,
        checkedAt: final.checkedAt, validUntil: final.checkedAt + final.proof.validForMs, commit: final.proof.commit, indexWatermark: final.proof.indexWatermark })) return fail('denied');
      const versions = await finishConnectorRun(client, actor, options.execution.runId, receipt, content);
      const envelope = await evidenceEnvelope(client, actor, versions.evidenceVersion);
      if (!envelope || decideManagedEvidence(actor, envelope).artifactRead.decision !== 'allow') throw new BudgetError('policy_denied');
      const delivered = await evidencePayload(client, actor, versions.evidenceVersion, null);
      if (delivered !== content) throw new BudgetError('policy_denied');
      options.budget.assertLive();
      const output = { receipt, ...versions, evidence: JSON.parse(content) as RepositoryEvidenceResponse };
      options.budget.serializeOutput(output); // Whole direct-library envelope, before successful commit.
      return output;
    });
  } catch (error) { return fail(error instanceof BudgetError ? stageReason(error.reason) : 'unavailable'); }
}

export async function queryConnectorEvidence(pool: pg.Pool, actor: string, mappingId: string,
  request: Omit<import('../connectors/evidence.js').RepositoryEvidenceRequest, 'repository'>, options: ConnectorEvidenceOptions): Promise<ConnectorEvidenceResult> {
  options = { ...options, execution: { ...options.execution } };
  const invocation = { started: false };
  const result = await executeQuery(pool, actor, mappingId, request, options, invocation);
  if (invocation.started && result.receipt.outcome !== 'complete') {
    try {
      await evidenceTransaction(pool, client => client.query('SELECT continuum_connector_fail($1,$2,$3,$4,$5,$6)',
        [actor, options.execution.runId, result.receipt.outcome, options.execution.workflowId,
          options.execution.workerId, options.execution.generation]));
    } catch { return { receipt: safeReceipt(result.receipt.evidenceClass, 'unavailable') }; }
  }
  try { options.budget.assertLive(); } catch { return { receipt: safeReceipt(result.receipt.evidenceClass, 'timeout') }; }
  return result;
}

/** Managed read/history/cache/export/provider composition. Reauthorize every
 * connector root before SQL hydration. One original durable attempt per root;
 * no cross-principal cache. Callers must persist these identities for retry. */
export async function readConnectorEvidence(pool: pg.Pool, actor: string, version: string, options: ConnectorEvidenceOptions,
  attempts: ReadonlyMap<string, string>, provider?: import('../evidence/policy.js').EvidenceAuthorityContext['provider']): Promise<string | null> {
  options = { ...options, execution: { ...options.execution } };
  attempts = new Map(attempts);
  provider = provider === undefined ? undefined : structuredClone(provider);
  try {
    const dependencies = await connectorDependencies(pool, actor, version);
    if (!dependencies?.length || dependencies.length > 64) return null;
    const admittedBytes = dependencies[0].bytes;
    if (!Number.isSafeInteger(admittedBytes) || admittedBytes < 0 || admittedBytes > options.budget.profile.maxItemHydratedBytes) return null;
    const permits: ConnectorPermit[] = [];
    for (const dependency of dependencies) {
      const mapping = dependency.mapping, attempt = attempts.get(dependency.runId);
      if (!mapping || !attempt) return null;
      const connector = options.registry.get(mapping.connectorId);
      if (!connector || connector.version !== mapping.connectorVersion) return null;
      const session = connector.open(options.authorizationContext);
      if (!zeroPrice(session.permission) || (mapping.residency === 'local-only' && (!session.permission.local || provider?.locality === 'hosted'))) return null;
      const result = await probe(pool, actor, mapping, session.permission, options, attempt,
        // A returned string can grow sixfold under JSON escaping. Reserve this
        // before hydration without loading source text to measure it first.
        permits.length === 0 ? { candidates: 1, hydratedBytes: admittedBytes, outputBytes: admittedBytes * 6 + 2 } : {});
      if (!('proof' in result)) return null;
      permits.push({ runId: dependency.runId, generation: mapping.generation, checkedAt: result.checkedAt,
        validUntil: result.checkedAt + result.proof.validForMs, commit: result.proof.commit, indexWatermark: result.proof.indexWatermark });
    }
    const delivered = await evidenceTransaction(pool, async client => {
      for (const permit of permits) if (!await permitConnector(client, actor, permit)) return null;
      const envelope = await evidenceEnvelope(client, actor, version);
      if (!envelope) return null;
      const decision = decideManagedEvidence(actor, envelope, provider);
      if ((provider ? decision.providerDisclosure : decision.artifactRead).decision !== 'allow') return null;
      if (envelope.bytes > admittedBytes) return null;
      const result = await evidencePayload(client, actor, version, provider?.locality === 'hosted' ? 'hosted' : provider ? 'local' : null);
      options.budget.assertLive();
      if (result !== null) options.budget.serializeOutput(result);
      return result;
    });
    options.budget.assertLive();
    return delivered;
  } catch { return null; }
}
