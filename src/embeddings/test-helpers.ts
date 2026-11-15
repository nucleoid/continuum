import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import pg from 'pg';
import { vi } from 'vitest';
import type { EmbeddingProvider } from './provider.js';
import { embeddingTarget, MEMORY_EMBEDDING_INPUT_TRANSFORM } from './target.js';
import { staticEmbeddingRouter } from './router.js';
import { starterProfile, type BudgetAdapter, type BudgetProfile } from '../pipeline/budget.js';
import type { Queryable } from '../storage/queryable.js';
import type { EmbeddingPolicyIdentity } from '../storage/embedding-jobs-model.js';
import { getPrincipal } from '../storage/principals.js';
import { getScope } from '../storage/scopes.js';
import { admitMemoryEmbedding, storeMemoryEmbeddingVector } from '../storage/embeddings.js';
import { standupProducerFixture, quoteStandupIdentifier } from '../standup/test-helpers.js';

/** Explicit synthetic request identity for existing static-vector test doubles.
 * This is not a production fallback or a descriptor inferred for historical data. */
export function syntheticEmbeddingTargetForTest(provider: Pick<EmbeddingProvider, 'id' | 'dim' | 'local'>) {
  if (provider.dim !== 768) throw new Error('Synthetic embedding fixture requires 768 dimensions');
  return embeddingTarget({ space: { provider: provider.id, model: 'synthetic-static-vector-v1', profile: 'synthetic-fixture-v1',
    dim: 768, inputTransform: MEMORY_EMBEDDING_INPUT_TRANSFORM }, endpoint: 'http://fixture.invalid/static-vector', local: provider.local ?? true });
}
export function withSyntheticTargetForTest<T extends Pick<EmbeddingProvider, 'id' | 'dim' | 'local' | 'target'>>(provider: T): T & { target: NonNullable<EmbeddingProvider['target']> } {
  if (!provider.target) Object.defineProperty(provider, 'target', { value: syntheticEmbeddingTargetForTest(provider), configurable: true });
  return provider as T & { target: NonNullable<EmbeddingProvider['target']> };
}

/** Owner-only prerequisite fixture. Real OP authorization/binding tests use
 * embeddingQueueFixture instead. No application connection can seed this state. */
export async function registerEmbeddingTargetForTest(owner: Queryable,
  provider: Pick<EmbeddingProvider, 'id' | 'dim' | 'target'>, scopeIds?: string[]): Promise<EmbeddingPolicyIdentity> {
  const target = provider.target;
  if (!target || target.space.provider !== provider.id || target.space.dim !== provider.dim) throw new Error('Explicit embedding fixture target is required');
  const authority = (await owner.query<{ owner: boolean; valid: boolean }>(`SELECT
    (SELECT relowner FROM pg_catalog.pg_class WHERE oid='memories'::regclass)=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owner,
    continuum_embedding_valid_target($1) AS valid`, [target])).rows[0];
  if (!authority?.owner || !authority.valid) throw new Error('Embedding fixture requires the actual migration owner and a valid explicit descriptor');
  const profile = { ...starterProfile, maxConcurrency: 1 };
  const window = { seconds: 60, dispatches: 1024, inputBytes: 16777216, tokens: 16777216, spendMicros: 0, rateSchedule: profile.rateSchedule };
  await owner.query('INSERT INTO embedding_vector_spaces VALUES($1,768,$2,$3) ON CONFLICT DO NOTHING', [provider.id, target.spaceFingerprint, target.space]);
  const approved = (await owner.query<{ same: boolean }>('SELECT descriptor=$2::jsonb AND space_fingerprint=$3 AS same FROM embedding_vector_spaces WHERE provider=$1 AND dim=768',
    [provider.id, target.space, target.spaceFingerprint])).rows[0];
  if (!approved?.same) throw new Error('Synthetic fixture cannot reinterpret an approved vector space');
  await owner.query(`INSERT INTO embedding_targets VALUES($1,$2,$3,768,$4,$5,TRUE) ON CONFLICT DO NOTHING`,
    [target.fingerprint, target, provider.id, profile, window]);
  await owner.query('INSERT INTO embedding_provider_control(provider,dim) VALUES($1,768) ON CONFLICT DO NOTHING', [provider.id]);
  const previous = (await owner.query<{ routing: { default: unknown; scopes: Record<string, unknown>; kinds: Record<string, unknown> } }>(
    'SELECT routing FROM embedding_policy WHERE singleton')).rows[0]?.routing ?? { default: { target: null, localOnly: false }, scopes: {}, kinds: {} };
  const routing = structuredClone(previous);
  if (scopeIds) for (const scope of scopeIds) routing.scopes[scope] = { target: target.fingerprint, localOnly: false };
  else routing.default = { target: target.fingerprint, localOnly: false };
  const digest = createHash('sha256').update(JSON.stringify(routing)).digest('hex');
  return (await owner.query<{ result: EmbeddingPolicyIdentity }>(`INSERT INTO embedding_policy(singleton,generation,digest,routing)
    VALUES(TRUE,1,$1,$2) ON CONFLICT(singleton) DO UPDATE SET generation=CASE WHEN embedding_policy.routing=EXCLUDED.routing THEN embedding_policy.generation ELSE embedding_policy.generation+1 END,
    digest=EXCLUDED.digest,routing=EXCLUDED.routing RETURNING jsonb_build_object('generation',generation::text,'digest',digest) AS result`, [digest, routing])).rows[0].result;
}
/** Precomputed fixture vectors only. Race tests must retain an explicitly
 * admitted earlier generation instead of calling this seeding convenience. */
export async function seedEmbeddingVectorForTest(owner: Queryable, connection: Queryable, memoryId: string,
  vector: number[], input: Pick<EmbeddingProvider, 'id' | 'dim' | 'local' | 'target'>): Promise<boolean> {
  const provider = withSyntheticTargetForTest(input);
  const row = (await connection.query<{ scope_id: string }>('SELECT scope_id FROM memories WHERE id=$1', [memoryId])).rows[0];
  if (!row) throw new Error('Embedding fixture source is unavailable');
  await registerEmbeddingTargetForTest(owner, provider, [row.scope_id]);
  const admission = await admitMemoryEmbedding(connection, memoryId, provider);
  if (!admission) throw new Error('Embedding fixture source lacks current original admission');
  return storeMemoryEmbeddingVector(connection, memoryId, vector, provider, admission);
}

export function syntheticQueueProvider() {
  const id = 'synthetic:queue-v1';
  const target = embeddingTarget({ space: { provider: id, model: 'synthetic-queue-v1', profile: 'synthetic-queue-v1', dim: 768,
    inputTransform: MEMORY_EMBEDDING_INPUT_TRANSFORM }, endpoint: 'http://fixture.invalid/embedding', local: true });
  const adapter: BudgetAdapter<string[], number[][]> = { id, model: target.space.model, profile: target.space.profile, local: true,
    timeoutMs: 1000, credentials: 'not-required', responseBodyBytes: 131072, enforceableCaps: true, cancellation: 'cooperative',
    outputTokens: 0, reasoningTokens: 0, completionTokens: 0,
    tokens: { kind: 'exact', model: target.space.model, profile: target.space.profile, validationId: 'synthetic-byte-only-v1', overheadTokens: 0,
      count: value => Buffer.byteLength(value) },
    price: { id: 'local-zero-v1', currency: 'USD', unitTokens: 1, inputMicros: 0, outputMicros: 0, reasoningMicros: 0 },
    serialize: input => ({ input }), invoke: vi.fn(async serialized => {
      const texts = (JSON.parse(serialized) as { input: string[] }).input;
      const value = texts.map(() => Array(768).fill(0.125) as number[]);
      return { value, response: value };
    }) };
  const provider: EmbeddingProvider = { id, dim: 768, local: true, target, batchSize: 32, timeoutMs: 1000, pipelineAdapter: adapter,
    embed: vi.fn(async texts => texts.map(() => Array(768).fill(0.125) as number[])) };
  return { provider, adapter, target, profile: { ...starterProfile, maxConcurrency: 1 } as BudgetProfile };
}

export async function embeddingQueueFixture(run: (context: Parameters<Parameters<typeof standupProducerFixture>[0]>[0] & {
  worker: pg.Pool; workerRole: string; principal: NonNullable<Awaited<ReturnType<typeof getPrincipal>>>;
  scope: NonNullable<Awaited<ReturnType<typeof getScope>>>; router: ReturnType<typeof staticEmbeddingRouter>;
  policy: EmbeddingPolicyIdentity;
} & ReturnType<typeof syntheticQueueProvider>) => Promise<void>, options: { windowSeconds?: number; profile?: BudgetProfile } = {}) {
  return standupProducerFixture(async f => {
    const synthetic = syntheticQueueProvider();
    if (options.profile) synthetic.profile = options.profile;
    const schema = (await f.owner.query('SELECT current_schema() AS name')).rows[0].name as string;
    const workerRole = `embed_worker_${randomUUID().replaceAll('-','').slice(0,16)}`, password = randomUUID();
    const connection = process.env.CONTINUUM_TEST_DATABASE_URL ?? 'postgres://continuum:continuum@localhost:5433/continuum';
    let worker: pg.Pool | undefined;
    try {
      await f.owner.query(`CREATE ROLE ${quoteStandupIdentifier(workerRole)} LOGIN PASSWORD '${password}'`);
      execFileSync('psql', [connection, '-X', '-v', 'ON_ERROR_STOP=1', '-v', `continuum_schema=${schema}`,
        '-v', `continuum_embedding_worker_role=${workerRole}`, '-f', join(process.cwd(), 'scripts/grant-embedding-worker-role.sql')], { timeout: 30000, stdio: 'pipe' });
      await f.operator.query('SELECT continuum_operator_embedding_target($1,$2,$3,$4,TRUE)', [f.adminId, synthetic.target, synthetic.profile,
        { seconds: options.windowSeconds ?? 60, dispatches: 64, inputBytes: 16777216, tokens: 16777216, spendMicros: 0, rateSchedule: synthetic.profile.rateSchedule }]);
      const routing = { default: { target: null, localOnly: false }, scopes: { [f.scopeId]: { target: synthetic.target.fingerprint, localOnly: false } }, kinds: {} };
      const digest = createHash('sha256').update(JSON.stringify(routing)).digest('hex');
      const policy = (await f.operator.query<{ policy: EmbeddingPolicyIdentity }>('SELECT continuum_operator_embedding_policy($1,$2,$3) AS policy',
        [f.adminId, routing, digest])).rows[0].policy;
      await f.operator.query('SELECT continuum_operator_bind_embedding_worker($1,$2,$3,$4,$5,TRUE)',
        [f.adminId, workerRole, f.producerId, f.scopeId, synthetic.target.fingerprint]);
      const url = new URL(connection);url.username=workerRole;url.password=password;
      worker = new pg.Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 5000,
        options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=1000` });
      const principal = (await getPrincipal(f.owner, f.actorId))!;
      const scope = (await getScope(f.owner, f.scopeId))!;
      const router = Object.assign(staticEmbeddingRouter(synthetic.provider), { queuePolicy: policy });
      await run({ ...f, ...synthetic, worker, workerRole, principal, scope, router, policy });
    } finally {
      await worker?.end();
      await f.owner.query(`DROP OWNED BY ${quoteStandupIdentifier(workerRole)}`);
      await f.owner.query(`DROP ROLE IF EXISTS ${quoteStandupIdentifier(workerRole)}`);
    }
  });
}
