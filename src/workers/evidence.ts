import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { EVIDENCE_LIMITS, type EvidenceParent, type EvidencePayloadRegistry, type EvidenceRegistration } from '../evidence/model.js';
import type { EvidenceAuthorityContext } from '../evidence/policy.js';
import { Budget, boundedJson, checkedProfile, runBudgetedStage, type BudgetAdapter, type BudgetProfile } from '../pipeline/budget.js';
import { createBudgetWorkflow, fenceBudgetWorkflow, pipelineAttempt } from '../storage/pipeline-budgets.js';
import { evidenceTransaction, evidenceEnvelope } from '../storage/evidence.js';
import { authorizeEvidence, readEvidence, decideManagedEvidence } from '../services/evidence.js';

interface DirtyClaim { root_id: string; generation: string; owner: string; claim_generation: string }
/** One bounded poll, no timer and no automatic activation in stock runtimes. */
export async function materializeEvidence(pool: pg.Pool, options: { owner: string; pageSize?: number; deadlineMs: number }): Promise<{ processed: number; complete: boolean }> {
  const page = options.pageSize ?? EVIDENCE_LIMITS.page;
  if (!Number.isInteger(page) || page < 1 || page > EVIDENCE_LIMITS.maxPage || !Number.isInteger(options.deadlineMs)
    || options.deadlineMs < 1 || options.deadlineMs > 30_000) throw new TypeError('Invalid evidence work bounds');
  const started = performance.now();
  const claim = await evidenceTransaction(pool, async client => (await client.query<{ claim: DirtyClaim | null }>(
    'SELECT continuum_evidence_claim_dirty($1,30000) AS claim', [options.owner])).rows[0].claim);
  if (!claim) return { processed: 0, complete: true };
  let processed = 0;
  while (performance.now() - started < options.deadlineMs) {
    const result = await evidenceTransaction(pool, async client => (await client.query<{ result: { processed: number; complete: boolean } }>(
      'SELECT continuum_evidence_invalidate_page($1,$2,$3,$4,$5) AS result',
      [claim.root_id, claim.generation, claim.owner, claim.claim_generation, page])).rows[0].result);
    processed += result.processed;
    if (result.complete) return { processed, complete: true };
  }
  return { processed, complete: false };
}
export interface EvidenceRepairInput { parents: Array<{ versionId: string; payload: string }> }
export type EvidenceRepairOutput = Pick<EvidenceRegistration, 'parents' | 'identity' | 'payload'>;
interface RepairClaim {
  outcome: 'claimed'; versionId: string; nodeId: string; scopeId: string;
  kind: EvidenceRegistration['kind']; owner: string; generation: number; parents: EvidenceParent[];
}
/** Artifact-specific generation remains supplied by trusted composition. There
 * is no built-in extractor/synthesizer, external storage or paid default. */
export async function repairEvidence(pool: pg.Pool, actor: string, worker: string, config: {
  owners: EvidencePayloadRegistry; profile: BudgetProfile;
  adapter: BudgetAdapter<EvidenceRepairInput, EvidenceRepairOutput>;
  providerAuthority(): Promise<NonNullable<EvidenceAuthorityContext['provider']>>;
  signal?: AbortSignal;
}): Promise<'idle' | 'unavailable' | 'completed'> {
  const profile = checkedProfile(config.profile);
  if (profile.overallMs > 30_000) throw new TypeError('Evidence repair lifetime exceeds its lease');
  let claim: RepairClaim | undefined;
  let execution: { id: string; owner: string; generation: number } | undefined;
  const cancel = async () => {
    if (execution) await fenceBudgetWorkflow(pool, execution.id, execution.owner, execution.generation, execution.owner, true);
  };
  const finish = async (registration: EvidenceRepairOutput | null): Promise<string | null> => evidenceTransaction(pool, async client => {
    const version = (await client.query<{ result: string | null }>('SELECT continuum_operator_evidence_repair_finish($1,$2,$3,$4,$5) AS result',
      [actor, claim!.versionId, worker, claim!.generation, registration])).rows[0].result;
    if (version) {
      const envelope = await evidenceEnvelope(client, actor, version);
      if (!envelope || decideManagedEvidence(actor, envelope).artifactRead.decision !== 'allow') throw new Error('Evidence unavailable');
    }
    return version;
  });
  try {
    const selected = await evidenceTransaction(pool, async client => (await client.query<{ result: RepairClaim | { outcome: 'unavailable' } | null }>(
      'SELECT continuum_operator_evidence_repair_claim($1,$2,30000) AS result', [actor, worker])).rows[0].result);
    if (!selected) return 'idle';
    if (selected.outcome !== 'claimed') return 'unavailable';
    claim = selected;
    if (!config.owners.supports(claim.kind)) { await finish(null); return 'unavailable'; }
    const budget = new Budget(profile);
    const workflowId = randomUUID(), attemptId = randomUUID();
    const workflow = await createBudgetWorkflow(pool, workflowId, worker, profile);
    execution = { id: workflowId, owner: worker, generation: workflow.generation };
    const attached = await evidenceTransaction(pool, async client => (await client.query<{ attached: boolean }>(
      'SELECT continuum_operator_evidence_repair_attach($1,$2,$3,$4,$5,$6,$7,$8) AS attached',
      [actor, claim!.versionId, worker, claim!.generation, workflowId, attemptId, worker, workflow.generation])).rows[0].attached);
    if (!attached) { await cancel(); return 'unavailable'; }
    const parents: EvidenceRepairInput['parents'] = [];
    for (const parent of claim.parents) parents.push({ versionId: parent.versionId,
      payload: await readEvidence(pool, actor, parent.versionId, config.owners, await config.providerAuthority(), budget) });
    const allowed = async () => {
      const destination = await config.providerAuthority();
      if ((config.adapter.local ? 'local' : 'hosted') !== destination.locality) return false;
      for (const parent of claim!.parents) if (!await authorizeEvidence(pool, actor, parent.versionId, destination)) return false;
      return true;
    };
    // Includes rejection when both durable settlement attempts fail. Retain
    // original IDs and conservative charges, never issue a fresh retry budget.
    const outcome = await runBudgetedStage(budget, config.adapter, { parents }, { signal: config.signal, authorize: allowed,
      durable: pipelineAttempt(pool, { id: workflowId, attemptId, owner: worker, generation: workflow.generation }) });
    if (outcome.status !== 'complete' || !config.owners.accepts(claim.kind, outcome.value.payload)) { await cancel(); await finish(null); return 'unavailable'; }
    const output = structuredClone(outcome.value);
    // A response cannot silently drop evidence restrictions or substitute a
    // parent. Repair is newly generated wording over the admitted surviving set.
    const ids = (values: readonly EvidenceParent[]) => values.map(p => `${p.versionId}:${p.kind}`).sort().join(',');
    if (ids(output.parents) !== ids(claim.parents)) { await cancel(); await finish(null); return 'unavailable'; }
    const bytes = Buffer.byteLength(boundedJson(output, budget.available('artifactBytes')));
    budget.consume({ artifactBytes: bytes, storageBytes: bytes });
    budget.assertLive();
    return await finish(output) ? 'completed' : 'unavailable';
  } catch {
    try { await cancel(); } catch { /* Original IDs and retained charges remain. */ }
    if (claim) { try { await finish(null); } catch { /* Stale/cancelled claims stay fenced. */ } }
    return 'unavailable';
  }
}
