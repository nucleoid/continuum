import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { standupProducerFixture } from '../standup/test-helpers.js';
import { createMemory } from '../storage/memories.js';
import { createPrincipal, getPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { recallForPrincipal } from './recall.js';
import { testReranking } from '../reranking/test-helpers.js';
import { prepareAgentsMdForPrincipal } from './agents-md.js';
import { RetrievalEnricherRegistry } from '../extensions/retrieval.js';
import { configureReranking } from '../reranking/provider.js';
import { EmbeddingRegistry, ScopeEmbeddingRouter } from '../embeddings/router.js';
import { supersedeDecision } from '../storage/supersede.js';
import { provisionEntraGroupBinding, syncEntraMemberships } from './membership-sync.js';

it('reranks beyond the old final cut with real APP authority and audits only delivered order', async () => {
  await standupProducerFixture(async f => {
    const principal = (await getPrincipal(f.app, f.actorId))!;
    for (let i = 0; i < 3; i++) await createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId,
      type: 'decision', title: `Needle reference ${i}`, body: `Needle ${'other '.repeat(i * 10)}`, source: 'manual', metadata: { related: [{ id: 'hidden-advisory' }] } });
    const input = { query: 'needle', limit: 1 };
    const baseline = await recallForPrincipal(f.app, null, principal, { ...input, limit: 3 });
    expect(baseline.results).toHaveLength(3);
    const target = baseline.results[2];
    const legacy = await recallForPrincipal(f.app, null, principal, input);
    expect(legacy.results[0].memory.id).not.toBe(target.memory.id);
    const sourceBundle = await prepareAgentsMdForPrincipal(f.app, principal, {});
    const { adapter, config } = testReranking(c => c.title === target.memory.title ? 100 : 0);
    const result = await recallForPrincipal(f.app, null, principal, input, {}, undefined, undefined, undefined, config());
    expect(adapter.invoke).toHaveBeenCalledOnce();
    expect(result.results.map(r => r.memory.id)).toEqual([target.memory.id]);
    expect(result.results[0].score).toBe(target.score);
    expect(result.results[0].rerankScore).toBe(100);
    expect(result.results[0].memory.metadata).not.toHaveProperty('related');
    expect(result.diagnostics.reranking).toEqual({ status: 'used' });
    const wire = vi.mocked(adapter.invoke).mock.calls[0][0];
    expect(wire).not.toContain('hidden-advisory');
    for (const r of baseline.results) expect(wire).not.toContain(r.memory.id);
    const summary = (await f.owner.query("SELECT metadata FROM audit_log WHERE query='needle' AND metadata->>'reranking_status'='used' ORDER BY id DESC LIMIT 1")).rows[0].metadata;
    const audit = (await f.owner.query("SELECT memory_id, metadata FROM audit_log WHERE metadata->>'request_id'=$1 AND memory_id IS NOT NULL", [summary.request_id])).rows;
    expect(audit).toHaveLength(1); expect(audit[0].memory_id).toBe(target.memory.id);
    expect(audit[0].metadata).toMatchObject({ rank: 1, score: target.score, rerank_score: 100 });
    const after = await prepareAgentsMdForPrincipal(f.app, principal, {});
    expect(after.markdown).toBe(sourceBundle.markdown); expect(after.etag).toBe(sourceBundle.etag);
    await f.owner.query('UPDATE memories SET body=$2 WHERE id=$1', [target.memory.id, 'Needle current version']);
    const updated = await recallForPrincipal(f.app, null, principal, input, {}, undefined, undefined, undefined, config());
    expect(updated.results[0].memory.body).toBe('Needle current version');
    await f.operator.query("SELECT continuum_operator_evidence_policy($1,$2,'any','deny',NULL,NULL)", [f.adminId, target.memory.id]);
    const denied = await recallForPrincipal(f.app, null, principal, input, {}, undefined, undefined, undefined, config());
    expect(denied.results.map(r => r.memory.id)).not.toContain(target.memory.id);
    expect(adapter.invoke).toHaveBeenCalledTimes(2);
  });
}, 120_000);

it('rejects principal disablement, membership revocation and stale Entra authority at both boundaries', async () => {
  await standupProducerFixture(async f => {
    const scope = await createScope(f.owner, { kind: 'project', name: 'identity-races' });
    const admin = (await getPrincipal(f.owner, f.adminId))!;
    for (let i = 0; i < 3; i++) await createMemory(f.app, { scopeId: scope.id, scopeKind: 'project', authorId: f.actorId,
      type: 'decision', title: `Authority source ${i}`, body: `Authority ${'padding '.repeat(i * 10)}`, source: 'manual' });
    for (const boundary of ['disclosure', 'inference']) for (const mode of ['disabled', 'revoked', 'stale']) {
      const reader = await createPrincipal(f.owner, { externalId: randomUUID(), kind: 'user', displayName: 'Reader' });
      if (mode === 'stale') {
        const groupId = randomUUID();
        await provisionEntraGroupBinding(f.owner, admin, { externalId: groupId, scopeId: scope.id, role: 'reader' });
        await syncEntraMemberships(f.owner, admin, [{ id: groupId, status: 'present', displayName: 'Race', memberObjectIds: [reader.externalId] }]);
      } else await addMembership(f.owner, reader.id, scope.id, 'reader');
      let fired = false;
      const change = async () => {
        if (fired) return; fired = true;
        if (mode === 'disabled') await f.owner.query('UPDATE principals SET disabled_at=clock_timestamp() WHERE id=$1', [reader.id]);
        if (mode === 'revoked') await f.owner.query('UPDATE scope_memberships SET active=FALSE WHERE principal_id=$1', [reader.id]);
        if (mode === 'stale') await f.owner.query("UPDATE entra_sync_state SET last_success_at=clock_timestamp()-interval '49 hours'");
      };
      const t = testReranking(() => 1); const invoke = t.adapter.invoke;
      t.adapter.invoke = vi.fn(async (wire, context) => { if (boundary === 'inference') await change(); return invoke(wire, context); });
      const wrapped = { query: f.app.query.bind(f.app), connect: async () => {
        const client = await f.app.connect();
        return new Proxy(client, { get(object, key) {
          if (key === 'query') return async (...args: unknown[]) => {
            const result = await (client.query as Function).apply(client, args);
            if (boundary === 'disclosure' && args[0] === 'COMMIT') await change(); return result;
          };
          const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
        } });
      } } as unknown as pg.Pool;
      const result = await recallForPrincipal(wrapped, null, reader, { query: 'authority', scopes: ['project:identity-races'], limit: 2 }, {}, undefined, undefined, undefined, t.config());
      expect(fired).toBe(true); expect(result.results).toEqual([]);
      expect(result.diagnostics.reranking).toEqual({ status: 'fallback', reason: 'policy_denied' });
      expect(t.adapter.invoke).toHaveBeenCalledTimes(boundary === 'disclosure' ? 0 : 1);
    }
  });
}, 120_000);

it('rechecks real source versions and authority at disclosure and final delivery, with bounded refill', async () => {
  await standupProducerFixture(async f => {
    const principal = (await getPrincipal(f.app, f.actorId))!;
    const mutations = {
      archive: async (id: string) => { await f.owner.query("UPDATE memories SET state='archived' WHERE id=$1", [id]); },
      expiry: async (id: string) => { await f.owner.query("UPDATE memories SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]); },
      version: async (id: string) => { await f.owner.query("UPDATE memories SET body='Changed source' WHERE id=$1", [id]); },
      supersede: async (id: string) => { await supersedeDecision(f.owner, { principalId: f.actorId, supersededId: id, title: 'Replacement', body: 'New source', source: 'manual' }); },
      policy: async (id: string) => { await f.operator.query("SELECT continuum_operator_evidence_policy($1,$2,'any','deny',NULL,NULL)", [f.adminId, id]); },
      quarantine: async (id: string) => { await f.owner.query("UPDATE evidence_state SET state='quarantined' WHERE version_id=(SELECT current_version FROM evidence_roots WHERE id=$1)", [id]); },
    };
    for (const boundary of ['disclosure', 'inference', 'delivery'] as const) {
      for (const [name, mutate] of Object.entries(mutations)) {
        const query = `probe${boundary}${name}`;
        const memories = [];
        for (let i = 0; i < 3; i++) memories.push(await createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId,
          type: 'decision', title: `${query} source ${i}`, body: `${query} ${'padding '.repeat(i * 10)}`, source: 'manual' }));
        const legacy = await recallForPrincipal(f.app, null, principal, { query, limit: 1 });
        const target = legacy.results[0].memory;
        const t = testReranking(c => c.title === target.title ? 99 : 0);
        let fired = false;
        const change = async () => { if (!fired) { fired = true; await mutate(target.id); } };
        // Wrap only our owned transaction's first COMMIT. Every query still runs
        // through the real APP LOGIN; mutation runs after actual lock release.
        const wrapped = { query: f.app.query.bind(f.app), connect: async () => {
          const client = await f.app.connect();
          return new Proxy(client, { get(object, key) {
            if (key === 'query') return async (...args: Parameters<typeof client.query>) => {
              const result = await (client.query as Function).apply(client, args);
              if (boundary === 'disclosure' && args[0] === 'COMMIT') await change();
              return result;
            };
            const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
          } });
        } } as unknown as pg.Pool;
        const original = t.adapter.invoke;
        t.adapter.invoke = vi.fn(async (wire, context) => { if (boundary === 'inference') await change(); return original(wire, context); });
        const registry = new RetrievalEnricherRegistry();
        registry.register({ id: 'race', async enrich() { throw new Error('Budgeted adapter required'); },
          pipelineAdapter: { ...t.adapter, id: 'race', outputTokens: 64, completionTokens: 64, responseBodyBytes: 1024,
            serialize: ({ results }, caps) => ({ count: results.length, caps }),
            async invoke(wire) { if (boundary === 'delivery') await change(); const value = Array(JSON.parse(wire).count).fill(null); return { value, response: value }; } } });
        const result = await recallForPrincipal(wrapped, null, principal, { query, limit: 2 }, {}, undefined,
          { registry, options: { timeoutMs: 1000, maxBytes: 16_384 } }, undefined, t.config());
        expect(fired, `${boundary}/${name}`).toBe(true);
        expect(result.results.map(r => r.memory.id), `${boundary}/${name}`).not.toContain(target.id);
        expect(result.results).toHaveLength(2);
        expect(result.diagnostics.reranking).toEqual({ status: 'fallback', reason: 'policy_denied' });
        expect(result.results.every(r => r.rerankScore === undefined)).toBe(true);
        if (boundary === 'disclosure') expect(t.adapter.invoke).not.toHaveBeenCalled();
        else expect(t.adapter.invoke).toHaveBeenCalledOnce();
        const summary = (await f.owner.query('SELECT metadata FROM audit_log WHERE query=$1 ORDER BY id DESC LIMIT 1', [query])).rows[0].metadata;
        const audited = (await f.owner.query("SELECT memory_id FROM audit_log WHERE metadata->>'request_id'=$1 AND memory_id IS NOT NULL ORDER BY (metadata->>'rank')::int", [summary.request_id])).rows.map(r => r.memory_id);
        expect(audited).toEqual(result.results.map(r => r.memory.id));
      }
    }
  });
}, 120_000);

it('denies mixed hosted disclosure, preserves fallback, and never bypasses hard output or audit failure', async () => {
  await standupProducerFixture(async f => {
    const principal = (await getPrincipal(f.app, f.actorId))!;
    const sources = [];
    for (let i = 0; i < 3; i++) sources.push(await createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId,
      type: 'decision', title: `Locality needle ${i}`, body: `Locality ${'padding '.repeat(i * 10)}`, source: 'manual' }));
    const input = { query: 'locality', limit: 2 };
    const legacy = await recallForPrincipal(f.app, null, principal, input);
    const t = testReranking(() => 1); const profile = t.config().profile; t.adapter.local = false;
    const hosted = configureReranking(t.adapter, profile, { candidateLimit: 20,
      evidence: { kind: 'operator-qualified', adapterId: t.adapter.id, version: t.adapter.version, model: t.adapter.model,
        profile: t.adapter.profile, reportSha256: 'a'.repeat(64) }, providerAuthority: now => ({ decision: 'allow', checkedAt: now, validUntil: now + 1000 }) });
    const routing = new ScopeEmbeddingRouter(new EmbeddingRegistry([]), { default: 'local-only' });
    const fallback = await recallForPrincipal(f.app, routing, principal, input, {}, undefined, undefined, undefined, hosted);
    expect(t.adapter.invoke).not.toHaveBeenCalled();
    expect(fallback.results.map(r => r.memory.id)).toEqual(legacy.results.map(r => r.memory.id));
    expect(fallback.diagnostics.reranking).toEqual({ status: 'fallback', reason: 'policy_denied' });
    const source = sources[2];
    await f.app.query('SELECT continuum_evidence_source($1,$2)', [f.actorId, source.id]);
    await f.operator.query("SELECT continuum_operator_evidence_policy($1,$2,'local-only','not-required',NULL,NULL)", [f.adminId, source.id]);
    const mixed = await recallForPrincipal(f.app, null, principal, input, {}, undefined, undefined, undefined, hosted);
    expect(mixed.results).toHaveLength(2); expect(t.adapter.invoke).not.toHaveBeenCalled();
    t.adapter.local = true;
    const local = t.config();
    expect((await recallForPrincipal(f.app, null, principal, input, {}, undefined, undefined, undefined, local)).diagnostics.reranking).toEqual({ status: 'used' });
    const denied = sources[0];
    await f.operator.query("SELECT continuum_operator_evidence_policy($1,$2,'any','deny',NULL,NULL)", [f.adminId, denied.id]);
    vi.mocked(t.adapter.invoke).mockClear();
    const safe = await recallForPrincipal(f.app, null, principal, input, {}, undefined, undefined, undefined, local);
    expect(safe.results.map(r => r.memory.id)).not.toContain(denied.id); expect(t.adapter.invoke).not.toHaveBeenCalled();
    expect(JSON.stringify(safe.diagnostics)).not.toContain(denied.id);
    const before = (await f.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE query='locality'")).rows[0].n;
    const registry = new RetrievalEnricherRegistry();
    await expect(recallForPrincipal(f.app, null, principal, input, {}, undefined, { registry, options: { timeoutMs: 1000, maxBytes: 16_384 },
      validateResult: () => { throw new Error('required output gate'); } }, undefined, local)).rejects.toMatchObject({ code: 'INTERNAL' });
    expect((await f.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE query='locality'")).rows[0].n).toBe(before);
    await f.owner.query(`CREATE FUNCTION reject_rerank_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.query='locality' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_rerank_read BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_rerank_read()`);
    await expect(recallForPrincipal(f.app, null, principal, input, {}, undefined, undefined, undefined, local)).rejects.toMatchObject({ code: 'INTERNAL' });
  });
}, 120_000);
