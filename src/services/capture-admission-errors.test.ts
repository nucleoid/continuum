import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { embeddingQueueFixture } from '../embeddings/test-helpers.js';
import { EmbeddingRegistry, ScopeEmbeddingRouter, staticEmbeddingRouter } from '../embeddings/router.js';
import { quoteStandupIdentifier } from '../standup/test-helpers.js';
import { captureMemory } from './capture.js';
import { configureEmbeddingPolicy, controlEmbeddingJobs, captureReceiptIdentity } from './embedding-jobs.js';
import { getPrincipal } from '../storage/principals.js';
import { SqlEmbeddingJobStore, readEmbeddingStatus } from '../storage/embedding-jobs.js';
import { processEmbeddingJobs } from '../workers/embedding-jobs.js';
import type { CaptureInput } from '../types.js';

type Fixture = Parameters<Parameters<typeof embeddingQueueFixture>[0]>[0];
const input = (f: Fixture, ref = randomUUID()): CaptureInput => ({ scope: { kind: f.scope.kind, name: f.scope.name },
  type: 'fact', title: 'Capture admission control', body: 'Durable source before provider work.', source: 'manual', sourceRef: ref });

// Real PostgreSQL lock/statement cancellation, not an injected error-shaped mock.
// Source/audit/receipt/job must roll back together and same-key recovery must work.
it.each([{ code: '55P03', statementMs: 5000 }, { code: '57014', statementMs: 500 }])(
  'reports bounded capture admission wait $code as a transient dependency failure without committing partial work',
  async ({ code, statementMs }) => {
    await embeddingQueueFixture(async f => {
      const app = new pg.Pool({ connectionString: f.app.options.connectionString, max: 1, connectionTimeoutMillis: 5000,
        options: `${f.app.options.options} -c statement_timeout=${statementMs} -c lock_timeout=1000` });
      const key = `locked-${randomUUID()}`, capture = input(f), marker = randomUUID();
      const identity = captureReceiptIdentity(f.actorId, f.scopeId, key, capture);
      try {
        const blocker = await f.owner.connect();
        let failure: unknown;
        try {
          await blocker.query('BEGIN');
          await blocker.query('SELECT singleton FROM embedding_admission WHERE singleton FOR UPDATE');
          try { await captureMemory(app, f.router, f.principal, capture, { fixture: marker }, { idempotencyKey: key }); }
          catch (error) { failure = error; }
        } finally {
          try { await blocker.query('ROLLBACK'); } finally { blocker.release(); }
        }
        expect(failure).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', status: 503, cause: { code } });
        expect((await f.owner.query('SELECT count(*)::int AS n FROM memories WHERE source_ref=$1', [capture.sourceRef])).rows[0].n).toBe(0);
        expect((await f.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE metadata->>'fixture'=$1", [marker])).rows[0].n).toBe(0);
        expect((await f.owner.query('SELECT count(*)::int AS n FROM embedding_capture_receipts WHERE principal_id=$1 AND key_hash=$2',
          [f.actorId, identity.keyHash])).rows[0].n).toBe(0);
        expect(f.provider.embed).not.toHaveBeenCalled(); expect(f.adapter.invoke).not.toHaveBeenCalled();
        const recovered = await captureMemory(f.app, f.router, f.principal, capture, {}, { idempotencyKey: key });
        const replay = await captureMemory(f.app, f.router, f.principal, capture, {}, { idempotencyKey: key });
        expect(replay.memory.id).toBe(recovered.memory.id); expect(replay.replayed).toBe(true);
      } finally { await app.end(); }
    });
  }, 120000,
);

it('does not mislabel an actual unkeyed APP EXECUTE privilege failure as capture replay denial', async () => {
  await embeddingQueueFixture(async f => {
    const role = (await f.app.query('SELECT session_user AS name')).rows[0].name as string;
    const capability = 'continuum_embedding_enqueue(uuid,uuid,jsonb,jsonb,text)';
    await f.owner.query(`REVOKE EXECUTE ON FUNCTION ${capability} FROM ${quoteStandupIdentifier(role)}`);
    let failure: unknown;
    try {
      try { await captureMemory(f.app, f.router, f.principal, input(f)); }
      catch (error) { failure = error; }
    } finally {
      await f.owner.query(`GRANT EXECUTE ON FUNCTION ${capability} TO ${quoteStandupIdentifier(role)}`);
    }
    expect(failure).toMatchObject({ code: 'INTERNAL', status: 500, cause: { code: '42501' } });
    expect((failure as Error).message).not.toBe('Capture replay unavailable');
    expect(f.adapter.invoke).not.toHaveBeenCalled();
  });
}, 120000);

it('retains the intended replay authorization denial when the original source is no longer readable', async () => {
  await embeddingQueueFixture(async f => {
    const capture = input(f), key = 'original-readable-capture';
    await captureMemory(f.app, f.router, f.principal, capture, {}, { idempotencyKey: key });
    await f.owner.query('UPDATE scope_memberships SET active=FALSE WHERE principal_id=$1 AND scope_id=$2', [f.actorId, f.scopeId]);
    await expect(captureMemory(f.app, f.router, f.principal, capture, {}, { idempotencyKey: key }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', status: 403, publicMessage: 'Capture replay unavailable' });
    expect(f.adapter.invoke).not.toHaveBeenCalled();
  });
}, 120000);

// Positive contract control, expected to pass existing bbb9. It does not require
// 10,001 captures, bypass capacity or erase an acknowledged blocked job.
it('recovers accepted target-less blocked work through approved local policy while retaining active admission and replay', async () => {
  await embeddingQueueFixture(async f => {
    const admin = (await getPrincipal(f.owner, f.adminId))!;
    const route = async (target: string | null) => {
      const routing = { default: { target: null, localOnly: false },
        scopes: { [f.scopeId]: { target, localOnly: true } }, kinds: {} };
      return configureEmbeddingPolicy(f.operator, admin, routing, createHash('sha256').update(JSON.stringify(routing)).digest('hex'));
    };
    await route(null);
    const unavailable = new ScopeEmbeddingRouter(new EmbeddingRegistry([]), { default: 'local-only' });
    const capture = input(f), key = 'accepted-local-block';
    const accepted = await captureMemory(f.app, unavailable, f.principal, capture, {}, { idempotencyKey: key });
    expect(accepted).toMatchObject({ embeddingStatus: 'blocked_policy', embedded: false });
    expect((await f.owner.query('SELECT target_fingerprint,state FROM embedding_jobs WHERE memory_id=$1', [accepted.memory.id])).rows)
      .toEqual([{ target_fingerprint: null, state: 'blocked_policy' }]);
    expect((await f.owner.query('SELECT active FROM embedding_scope_admission WHERE scope_id=$1', [f.scopeId])).rows[0].active).toBe(1);
    expect(await controlEmbeddingJobs(f.operator, admin, 'reconcile', f.target.fingerprint, 10)).toMatchObject({ processed: 0 });
    expect(f.adapter.invoke).not.toHaveBeenCalled();
    const policy = await route(f.target.fingerprint);
    expect(await controlEmbeddingJobs(f.operator, admin, 'reconcile', f.target.fingerprint, 10)).toMatchObject({ processed: 1 });
    expect((await f.owner.query('SELECT active FROM embedding_scope_admission WHERE scope_id=$1', [f.scopeId])).rows[0].active).toBe(1);
    expect((await f.owner.query('SELECT state FROM embedding_jobs WHERE memory_id=$1 AND target_fingerprint IS NULL', [accepted.memory.id])).rows[0].state).toBe('superseded');
    expect(await processEmbeddingJobs(new SqlEmbeddingJobStore(f.worker), f.target, policy, f.provider, f.profile, randomUUID())).toBe('processed');
    expect(await readEmbeddingStatus(f.app, f.actorId, accepted.memory.id)).toMatchObject({ embeddingStatus: 'ready', embedded: true });
    expect((await f.owner.query('SELECT active FROM embedding_scope_admission WHERE scope_id=$1', [f.scopeId])).rows[0].active).toBe(0);
    const router = Object.assign(staticEmbeddingRouter(f.provider), { queuePolicy: policy });
    const replay = await captureMemory(f.app, router, f.principal, capture, {}, { idempotencyKey: key });
    expect(replay.memory.id).toBe(accepted.memory.id); expect(replay.replayed).toBe(true);
    expect(f.adapter.invoke).toHaveBeenCalledOnce(); expect(f.provider.embed).not.toHaveBeenCalled();
  });
}, 120000);
