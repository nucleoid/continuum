import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../api/server.js';
import { embeddingQueueFixture } from '../embeddings/test-helpers.js';
import { memoryEmbeddingText } from '../embeddings/text.js';
import { staticEmbeddingRouter } from '../embeddings/router.js';
import { captureMemory } from '../services/capture.js';
import { classifyRelation, type RelatedMemory } from '../services/relations.js';
import { bindEmbeddingWorker, configureEmbeddingPolicy, configureEmbeddingTarget, controlEmbeddingJobs } from '../services/embedding-jobs.js';
import { getMemoryForPrincipal } from '../services/memories.js';
import { verifyForPrincipal } from '../services/lifecycle.js';
import { renderAgentsMdForPrincipal } from '../services/agents-md.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { getPrincipal } from './principals.js';
import { getMemory, updateMemoryMetadata } from './memories.js';
import { SqlEmbeddingJobStore, readEmbeddingStatus } from './embedding-jobs.js';
import { processEmbeddingJobs } from '../workers/embedding-jobs.js';
import type { CaptureInput } from '../types.js';
import type { EmbeddingJobClaim } from './embedding-jobs-model.js';

type Base = Parameters<Parameters<typeof embeddingQueueFixture>[0]>[0];
type Fixture = Base & { origin: Base; vectors: Map<string, number[]>; route(localOnly?: boolean): Promise<void> };
const unit = (axis = 0) => Array.from({ length: 768 }, (_, i) => i === axis ? 1 : 0);
const near = (similarity = 0.95, axis = 0) => {
  const v = unit(axis); v[axis] = similarity; v[axis + 1] = Math.sqrt(1 - similarity * similarity); return v;
};
const input = (f: Base, title: string, body: string): CaptureInput => ({ scope: { kind: f.scope.kind, name: f.scope.name },
  type: 'fact', title, body, source: 'manual' });
const run = (f: Base, store = new SqlEmbeddingJobStore(f.worker)) => processEmbeddingJobs(store, f.target, f.policy, f.provider, f.profile, randomUUID());
async function relations(f: Base, id: string): Promise<RelatedMemory[]> {
  const memory = await getMemory(f.app, id);
  expect(Array.isArray(memory!.metadata.related)).toBe(true);
  return memory!.metadata.related as RelatedMemory[];
}
async function projectFixture(work: (f: Fixture) => Promise<void>) {
  await embeddingQueueFixture(async f => {
    const project = await createScope(f.owner, { kind: 'project', name: `relations-${randomUUID()}` });
    for (const principal of [f.actorId, f.producerId, f.adminId]) await addMembership(f.owner, principal, project.id, 'admin');
    const admin = (await getPrincipal(f.owner, f.adminId))!;
    const vectors = new Map<string, number[]>();
    vi.mocked(f.adapter.invoke).mockImplementation(async wire => {
      const texts = (JSON.parse(wire) as { input: string[] }).input;
      const value = texts.map(text => { const vector = vectors.get(text); if (!vector) throw new Error('Missing explicit synthetic vector'); return vector; });
      return { value, response: value };
    });
    let context: Fixture | undefined;
    const route = async (localOnly = false) => {
      const routing = { default: { target: null, localOnly: false }, scopes: {
        [f.scopeId]: { target: f.target.fingerprint, localOnly: false },
        [project.id]: { target: f.target.fingerprint, localOnly },
      }, kinds: {} };
      const policy = await configureEmbeddingPolicy(f.operator, admin, routing, createHash('sha256').update(JSON.stringify(routing)).digest('hex'));
      const router = Object.assign(staticEmbeddingRouter(f.provider), { queuePolicy: policy });
      if (context) { context.policy = policy; context.router = router; context.origin.policy = policy; context.origin.router = router; }
      return { policy, router };
    };
    const initial = await route();
    await bindEmbeddingWorker(f.operator, admin, f.workerRole, f.producerId, project.id, f.target.fingerprint, true);
    context = { ...f, scope: project, scopeId: project.id, ...initial, vectors,
      origin: { ...f, ...initial }, route: async localOnly => { await route(localOnly); } };
    await work(context);
  });
}
async function publish(f: Fixture, capture: CaptureInput, vector: number[], scope: Base = f) {
  f.vectors.set(memoryEmbeddingText(capture), vector);
  const result = await captureMemory(scope.app, scope.router, scope.principal, capture, {}, { relationThreshold: 1 });
  expect(result.related).toEqual([]); expect(result.embedded).toBe(false);
  expect(await run(scope)).toBe('processed');
  return result.memory;
}
async function requireNativeFixture(f: Fixture) {
  const support = (await f.owner.query(`SELECT current_setting('server_encoding')='UTF8' AS utf8,
    EXISTS(SELECT 1 FROM pg_collation WHERE collprovider='i' AND replace(lower(colliculocale),'_','-') LIKE 'en-us%') AS en_us_icu`)).rows[0];
  expect(support, 'positive native-classifier fixture requires UTF8 and catalog ICU en-US; unsupported behavior has a separate negative').toEqual({ utf8: true, en_us_icu: true });
}

it('uses the original .99 threshold after replay and a real routing replacement, while .90 admits a .95 cosine neighbor', async () => {
  await projectFixture(async f => {
    await requireNativeFixture(f);
    const candidateInput = input(f, 'Threshold candidate', 'Threshold source');
    const candidate = await publish(f, candidateInput, near());
    const high = input(f, 'High threshold', 'Incoming source'); f.vectors.set(memoryEmbeddingText(high), unit());
    const key = 'retained-high-threshold';
    const accepted = await captureMemory(f.app, f.router, f.principal, high, {}, { idempotencyKey: key, relationThreshold: 0.99 });
    const calls = vi.mocked(f.adapter.invoke).mock.calls.length;
    expect(accepted.related).toEqual([]);
    const replay = await captureMemory(f.app, f.router, f.principal, high, {}, { idempotencyKey: key, relationThreshold: 0.90 });
    expect(replay.memory.id).toBe(accepted.memory.id); expect(replay.replayed).toBe(true);
    expect(vi.mocked(f.adapter.invoke).mock.calls.length).toBe(calls); // ACK/replay no provider I/O.
    await f.route(true); // Actual stricter local-only policy; target itself is local.
    const admin = (await getPrincipal(f.owner, f.adminId))!;
    expect(await controlEmbeddingJobs(f.operator, admin, 'reconcile', f.target.fingerprint, 10)).toMatchObject({ processed: 1 });
    expect(await run(f)).toBe('processed');
    expect(await relations(f, accepted.memory.id)).toEqual([]); // Losing immutable threshold -> default.92 incorrectly includes.95.
    const low = input(f, 'Low threshold', 'Incoming source'); f.vectors.set(memoryEmbeddingText(low), unit());
    const lowCapture = await captureMemory(f.app, f.router, f.principal, low, {}, { relationThreshold: 0.90 });
    expect(lowCapture.related).toEqual([]); expect(await run(f)).toBe('processed');
    const hit = (await relations(f, lowCapture.memory.id)).find(item => item.id === candidate.id)!;
    expect(hit).toMatchObject({ id: candidate.id, provider: f.provider.id, threshold: 0.90,
      relation: classifyRelation(low, candidateInput) });
    expect(hit.similarity).toBeCloseTo(0.95, 4);
    expect(f.provider.embed).not.toHaveBeenCalled();
  });
}, 120000);

it('classifies actual deferred Unicode candidates exactly as the existing TypeScript classifier', async () => {
  await projectFixture(async f => {
    await requireNativeFixture(f);
    const esWhitespace = '\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF';
    const cases: Array<[string, string, string, string, string]> = [
      ['Greek final sigma', 'ΟΣ', 'ος', 'Same body', 'same body'],
      ['Greek nonfinal sigma stays distinct', 'ΟΣ', 'οσ', 'Same body', 'same body'],
      ['Turkish dotted I', 'İ', 'i\u0307', 'Same body', 'same body'],
      ['Turkish dotless I stays distinct', 'I', 'ı', 'Same body', 'same body'],
      ['NFKC fullwidth', 'ＰＯＬＩＣＹ', 'policy', 'Same body', 'same body'],
      ['BOM and NBSP', '\uFEFF Policy\u00A0', 'policy', '\uFEFFalpha\u00A0beta\uFEFF', ' alpha beta '],
      ['all ECMAScript whitespace', 'Whitespace', 'whitespace', `alpha${esWhitespace}beta`, 'alpha beta'],
    ];
    for (const [i, [label, oldTitle, newTitle, oldBody, newBody]] of cases.entries()) {
      const candidateInput = input(f, oldTitle, `${i}: ${oldBody}`), incoming = input(f, newTitle, `${i}: ${newBody}`);
      const candidate = await publish(f, candidateInput, near(0.95, 2 * i));
      f.vectors.set(memoryEmbeddingText(incoming), unit(2 * i));
      const capture = await captureMemory(f.app, f.router, f.principal, incoming, {}, { relationThreshold: 0.9 });
      expect(await run(f), label).toBe('processed');
      const hit = (await relations(f, capture.memory.id)).find(item => item.id === candidate.id);
      expect(hit, label).toMatchObject({ relation: classifyRelation(incoming, candidateInput), threshold: 0.9 });
    }
  });
}, 120000);

it('limits relations to five current eligible candidates in the claimed scope despite nearer stale or other-scope vectors', async () => {
  await projectFixture(async f => {
    await requireNativeFixture(f);
    const stale: string[] = [];
    for (let i = 0; i < 2; i++) {
      const memory = await publish(f, input(f, `Stale ${i}`, `Source ${i}`), near(0.999 - i / 10000));
      await verifyForPrincipal(f.app, f.principal, memory.id, false); stale.push(memory.id);
    }
    const eligible: string[] = [];
    for (let i = 0; i < 6; i++) eligible.push((await publish(f, input(f, `Current ${i}`, `Current source ${i}`), near(0.98 - i / 100))).id);
    const other = await publish(f, input(f.origin, 'Other bound scope', 'Still authorized but outside this claim'), unit(), f.origin);
    const incoming = input(f, 'Top five', 'Select current bounded neighbors'); f.vectors.set(memoryEmbeddingText(incoming), unit());
    const capture = await captureMemory(f.app, f.router, f.principal, incoming, {}, { relationThreshold: 0.9 });
    expect(await run(f)).toBe('processed');
    const hits = await relations(f, capture.memory.id);
    expect(hits).toHaveLength(5);
    expect(new Set(hits.map(hit => hit.id))).toEqual(new Set(eligible.slice(0, 5)));
    expect(hits.some(hit => stale.includes(hit.id) || hit.id === other.id || hit.id === capture.memory.id)).toBe(false);
  });
}, 120000);

it('rolls vector, related and ready state back with required audit failure, then preserves current metadata and source-only outputs on retry and duplicate apply', async () => {
  await projectFixture(async f => {
    await requireNativeFixture(f);
    const candidate = await publish(f, input(f, 'Relation audit candidate', 'RelationAuditToken original candidate'), near());
    const incoming = input(f, 'Relation audit source', 'RelationAuditToken incoming'); f.vectors.set(memoryEmbeddingText(incoming), unit());
    const capture = await captureMemory(f.app, f.router, f.principal, incoming, {}, { relationThreshold: 0.9 });
    await f.owner.query(`CREATE FUNCTION relation_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic required relation completion audit failure'; END $$;
      REVOKE ALL ON FUNCTION relation_test_audit_failure() FROM PUBLIC;
      CREATE TRIGGER relation_test_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW
      WHEN (NEW.metadata->>'operation'='embedding_completed') EXECUTE FUNCTION relation_test_audit_failure()`);
    try {
      expect(await run(f)).toBe('unavailable');
      expect((await f.owner.query('SELECT count(*)::int AS n FROM memory_embeddings WHERE memory_id=$1', [capture.memory.id])).rows[0].n).toBe(0);
      expect(await relations(f, capture.memory.id)).toEqual([]);
      expect((await readEmbeddingStatus(f.app, f.actorId, capture.memory.id))!.embeddingStatus).not.toBe('ready');
    } finally { await f.owner.query('DROP TRIGGER relation_test_audit_failure ON audit_log; DROP FUNCTION relation_test_audit_failure()'); }
    const admin = (await getPrincipal(f.owner, f.adminId))!;
    await controlEmbeddingJobs(f.operator, admin, 'retry', f.target.fingerprint, 10);
    const current = (await getMemory(f.app, capture.memory.id))!;
    await updateMemoryMetadata(f.app, current.id, { ...current.metadata, operatorNote: 'PRESERVE-CURRENT-METADATA' });
    const checkpoint = (await getMemory(f.app, current.id))!;
    const renderedBefore = await renderAgentsMdForPrincipal(f.app, f.principal, { project: f.scope.name, limit: 200 });
    const store = new SqlEmbeddingJobStore(f.worker), apply = store.apply.bind(store);
    let observed: { claim: EmbeddingJobClaim; vectors: Array<{ id: string; vector: number[] }> } | undefined;
    vi.spyOn(store, 'apply').mockImplementation((claim, vectors) => { observed = { claim, vectors }; return apply(claim, vectors); });
    expect(await run(f, store)).toBe('processed');
    expect((await relations(f, current.id)).some(item => item.id === candidate.id)).toBe(true);
    const after = (await getMemory(f.app, current.id))!;
    expect(after.metadata.operatorNote).toBe(checkpoint.metadata.operatorNote);
    expect(after.updatedAt).toEqual(checkpoint.updatedAt);
    const completionCount = async () => (await f.owner.query(`SELECT count(*)::int AS n FROM audit_log
      WHERE memory_id=$1 AND metadata->>'operation'='embedding_completed'`, [current.id])).rows[0].n;
    expect(await completionCount()).toBe(1);
    expect(observed).toBeDefined();
    expect(await store.apply(observed!.claim, observed!.vectors)).toBeTypeOf('boolean'); // Refused or accepted replay cannot duplicate effects.
    expect(await completionCount()).toBe(1);
    expect((await getMemory(f.app, current.id))!.metadata).toEqual(after.metadata);
    expect(await renderAgentsMdForPrincipal(f.app, f.principal, { project: f.scope.name, limit: 200 })).toBe(renderedBefore);
    const app = createApp(f.app, { embeddingProvider: null }); // Real REST projections; lexical recall makes no provider request.
    const recall = await request(app).post('/api/v0/recall').set('Authorization', `Bearer ${f.principal.externalId}`)
      .send({ query: 'RelationAuditToken', scopes: [`project:${f.scope.name}`], limit: 100 });
    expect(recall.status).toBe(200); expect(recall.body.results.some((item: { id: string }) => item.id === current.id)).toBe(true);
    const review = await request(app).get('/api/v0/review-queue').set('Authorization', `Bearer ${f.principal.externalId}`)
      .query({ scope: `project:${f.scope.name}`, horizonDays: 365 });
    expect(review.status).toBe(200); expect(review.body.items.length).toBeGreaterThan(0);
    expect(JSON.stringify({ recall: recall.body, review: review.body })).not.toContain('possible-conflict');
    expect(JSON.stringify({ recall: recall.body, review: review.body })).not.toContain('detectedAt');
    // Source UUIDs may legitimately remain recall results/generator citations/review items.
    // The forbidden output is the newly generated relation-candidate metadata.
  });
}, 120000);

it('declines oversized optional candidate hydration under the remaining original budget while still committing the vector', async () => {
  await projectFixture(async f => {
    await requireNativeFixture(f);
    await publish(f, input(f, 'Large current candidate', 'L'.repeat(5000)), near());
    const tight = { ...f.profile, maxItemHydratedBytes: 4096, limits: { ...f.profile.limits, hydratedBytes: 4096 } };
    const admin = (await getPrincipal(f.owner, f.adminId))!;
    await configureEmbeddingTarget(f.operator, admin, f.target, tight,
      { seconds: 60, dispatches: 64, inputBytes: 16777216, tokens: 16777216, spendMicros: 0, rateSchedule: tight.rateSchedule }, true);
    f.profile = tight; f.origin.profile = tight; await f.route();
    const incoming = input(f, 'Small source', 'Small incoming'); f.vectors.set(memoryEmbeddingText(incoming), unit());
    const capture = await captureMemory(f.app, f.router, f.principal, incoming, {}, { relationThreshold: 0.9 });
    expect(await run(f)).toBe('processed');
    expect(await readEmbeddingStatus(f.app, f.actorId, capture.memory.id)).toMatchObject({ embeddingStatus: 'ready', embedded: true });
    expect(await relations(f, capture.memory.id)).toEqual([]);
    const charged = (await f.owner.query(`SELECT w.used FROM pipeline_budget_workflows w JOIN embedding_cohorts c ON c.workflow_id=w.id
      JOIN embedding_cohort_jobs membership ON membership.cohort_id=c.id JOIN embedding_jobs job ON job.id=membership.job_id
      WHERE job.memory_id=$1 ORDER BY c.created_at DESC LIMIT 1`, [capture.memory.id])).rows[0].used;
    expect(charged.hydratedBytes).toBeGreaterThan(0); expect(charged.hydratedBytes).toBeLessThanOrEqual(4096);
  });
}, 120000);



it('does not consume a stricter SQL statement deadline as optional relation success', async () => {
  await projectFixture(async f => {
    const candidateInput = input(f, 'Deadline candidate', 'Bounded candidate evidence');
    f.vectors.set(memoryEmbeddingText(candidateInput), near());
    const candidate = await captureMemory(f.app, f.router, f.principal, candidateInput);
    await f.owner.query('SELECT continuum_evidence_source($1,$2)', [f.actorId, candidate.memory.id]);
    expect(await run(f)).toBe('processed');
    const incoming = input(f, 'Deadline incoming', 'Bounded incoming evidence'); f.vectors.set(memoryEmbeddingText(incoming), unit());
    const capture = await captureMemory(f.app, f.router, f.principal, incoming);
    const lock = await f.owner.connect();
    try {
      const invoke = vi.mocked(f.adapter.invoke).getMockImplementation()!;
      vi.mocked(f.adapter.invoke).mockImplementation(async (...args) => {
        const response = await invoke(...args);
        // Root contention now declines without waiting. This owner-only payload
        // table barrier instead forces the original SQL deadline during optional
        // relation preparation after actual incoming dispatch. The incoming
        // source has no evidence root, so failure/audit recording stays unblocked.
        await lock.query('BEGIN');
        await lock.query('LOCK TABLE evidence_payloads IN ACCESS EXCLUSIVE MODE');
        return response;
      });
      const store = new SqlEmbeddingJobStore(f.worker), apply = vi.spyOn(store, 'apply');
      await f.worker.query("SET statement_timeout='200ms'");
      const outcome = await run(f, store);
      expect(f.adapter.invoke).toHaveBeenCalledTimes(2);
      expect(apply).toHaveBeenCalledOnce();
      await expect(apply.mock.results[0].value).rejects.toMatchObject({ code: '57014' });
      expect(outcome).toBe('unavailable');
    } finally {
      await lock.query('ROLLBACK'); lock.release();
      await f.worker.query("SET statement_timeout='5s'");
    }
    expect((await f.owner.query('SELECT 1 FROM memory_embeddings WHERE memory_id=$1', [capture.memory.id])).rows).toEqual([]);
    expect(await readEmbeddingStatus(f.app, f.actorId, capture.memory.id)).toMatchObject({ embedded: false, embeddingStatus: 'retry_wait' });
    expect((await f.owner.query("SELECT 1 FROM audit_log WHERE memory_id=$1 AND metadata->>'operation'='embedding_completed'", [capture.memory.id])).rows).toEqual([]);
    expect((await f.owner.query('SELECT failures FROM embedding_provider_control')).rows[0].failures).toBe('0');
  });
}, 120000);


it('retains two failed relation-read debits across audit rollback and declines a third read under the same settled provider attempt', async () => {
  await projectFixture(async f => {
    await publish(f, input(f, 'Retained candidate', 'C'.repeat(6000)), near());
    const tight = { ...f.profile, maxItemHydratedBytes: 12000, limits: { ...f.profile.limits, hydratedBytes: 30000 } };
    const admin = (await getPrincipal(f.owner, f.adminId))!;
    await configureEmbeddingTarget(f.operator, admin, f.target, tight,
      { seconds: 60, dispatches: 64, inputBytes: 16777216, tokens: 16777216, spendMicros: 0, rateSchedule: tight.rateSchedule }, true);
    f.profile = tight; f.origin.profile = tight; await f.route();
    const incoming = input(f, 'Retained incoming', 'Small source whose advisory work retries'); f.vectors.set(memoryEmbeddingText(incoming), unit());
    const accepted = await captureMemory(f.app, f.router, f.principal, incoming);
    await f.owner.query(`CREATE FUNCTION relation_read_debit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.memory_id='${accepted.memory.id}'::uuid AND NEW.metadata->>'operation'='embedding_completed' THEN
        RAISE EXCEPTION 'Synthetic relation debit audit failure: %',NEW.metadata->>'relationsStatus'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER relation_read_debit_fault BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION relation_read_debit_fault()`);
    const store = new SqlEmbeddingJobStore(f.worker), apply = store.apply.bind(store);
    let assertionFailure: unknown; let originalWorkflow: string | undefined; const debits: number[] = [];
    vi.spyOn(store, 'apply').mockImplementation(async (claim, vectors) => {
      try {
        originalWorkflow = claim.workflowId;
        const inspect = async () => (await f.owner.query('SELECT id,owner,generation,deadline_at,profile,used FROM pipeline_budget_workflows WHERE id=$1', [claim.workflowId])).rows[0];
        const before = await inspect();
        const identity = (value: typeof before) => ({ id: value.id, owner: value.owner, generation: value.generation, deadline: value.deadline_at, profile: value.profile });
        for (let i = 0; i < 2; i++) {
          await expect(apply(claim, vectors)).rejects.toThrow('Synthetic relation debit audit failure: computed');
          const retained = await inspect(); debits.push(retained.used.hydratedBytes);
          expect(identity(retained)).toEqual(identity(before));
          expect(retained.used.hydratedBytes).toBeGreaterThan((i ? debits[i - 1] : before.used.hydratedBytes) + 14000);
          expect(retained.used.hydratedBytes).toBeLessThanOrEqual(tight.limits.hydratedBytes);
          expect((await f.owner.query('SELECT 1 FROM memory_embeddings WHERE memory_id=$1', [accepted.memory.id])).rows).toEqual([]);
          expect((await f.owner.query('SELECT 1 FROM embedding_completions WHERE job_id=$1', [claim.jobs[0].id])).rows).toEqual([]);
        }
        await f.owner.query('DROP TRIGGER relation_read_debit_fault ON audit_log');
        return await apply(claim, vectors); // A fresh declined prepare must not resurrect the earlier funded cap.
      } catch (error) { assertionFailure = error; throw error; }
    });
    try {
      const result = await run(f, store);
      if (assertionFailure) throw assertionFailure;
      expect(result).toBe('processed'); expect(debits).toHaveLength(2);
      expect(await relations(f, accepted.memory.id)).toEqual([]);
      expect(await readEmbeddingStatus(f.app, f.actorId, accepted.memory.id)).toMatchObject({ embedded: true, embeddingStatus: 'ready' });
      const retained = (await f.owner.query('SELECT used FROM pipeline_budget_workflows WHERE id=$1', [originalWorkflow])).rows[0].used;
      expect(retained.hydratedBytes).toBe(debits[1]); expect(retained).toMatchObject({ calls: 1, retries: 0 });
      expect((await f.owner.query('SELECT count(*)::int AS n FROM pipeline_budget_attempts WHERE workflow_id=$1', [originalWorkflow])).rows[0].n).toBe(1);
      expect((await f.owner.query(`SELECT metadata->>'relationsStatus' AS status FROM audit_log
        WHERE memory_id=$1 AND metadata->>'operation'='embedding_completed'`, [accepted.memory.id])).rows).toEqual([{ status: 'budget' }]);
      expect(f.adapter.invoke).toHaveBeenCalledTimes(2);
    } finally { await f.owner.query('DROP TRIGGER IF EXISTS relation_read_debit_fault ON audit_log'); }
  });
}, 120000);


it('declines optional reads when their complete cohort aggregate cannot fit the original allowance', async () => {
  await projectFixture(async f => {
    await publish(f, input(f, 'Aggregate current candidate', 'C'.repeat(6000)), near());
    const tight = { ...f.profile, maxItemHydratedBytes: 12000, limits: { ...f.profile.limits, hydratedBytes: 20000 } };
    const admin = (await getPrincipal(f.owner, f.adminId))!;
    await configureEmbeddingTarget(f.operator, admin, f.target, tight,
      { seconds: 60, dispatches: 64, inputBytes: 16777216, tokens: 16777216, spendMicros: 0, rateSchedule: tight.rateSchedule }, true);
    f.profile = tight; f.origin.profile = tight; await f.route();
    const captures = [];
    for (let i = 0; i < 2; i++) {
      const incoming = input(f, `Aggregate incoming ${i}`, 'Small aggregate source'); f.vectors.set(memoryEmbeddingText(incoming), unit());
      captures.push(await captureMemory(f.app, f.router, f.principal, incoming));
    }
    expect(await run(f)).toBe('processed');
    for (const capture of captures) {
      expect(await readEmbeddingStatus(f.app, f.actorId, capture.memory.id)).toMatchObject({ embedded: true, embeddingStatus: 'ready' });
      expect(await relations(f, capture.memory.id)).toEqual([]);
    }
    const budgets = (await f.owner.query(`SELECT DISTINCT c.workflow_id,w.used FROM embedding_cohorts c
      JOIN pipeline_budget_workflows w ON w.id=c.workflow_id JOIN embedding_cohort_jobs cj ON cj.cohort_id=c.id
      JOIN embedding_jobs j ON j.id=cj.job_id WHERE j.memory_id=ANY($1::uuid[])`, [captures.map(capture => capture.memory.id)])).rows;
    expect(budgets).toHaveLength(1);
    expect(budgets[0].used.hydratedBytes).toBeLessThan(20000); expect(budgets[0].used).toMatchObject({ candidates: 2, calls: 1 });
    expect((await f.owner.query(`SELECT metadata->>'relationsStatus' AS status FROM audit_log
      WHERE memory_id=ANY($1::uuid[]) AND metadata->>'operation'='embedding_completed'`, [captures.map(capture => capture.memory.id)])).rows)
      .toEqual([{ status: 'budget' }, { status: 'budget' }]);
    expect(f.adapter.invoke).toHaveBeenCalledTimes(2);
  });
}, 120000);
