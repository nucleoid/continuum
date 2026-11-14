import { expect, it } from 'vitest';
import { standupProducerFixture } from '../standup/test-helpers.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { recallForPrincipal } from './recall.js';
import { testReranking } from '../reranking/test-helpers.js';
import { prepareAgentsMdForPrincipal } from './agents-md.js';

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
    expect(result.diagnostics.reranking).toEqual({ status: 'used' });
    const wire = String((adapter.invoke as ReturnType<typeof import('vitest')['vi']['fn']>).mock.calls[0][0]);
    expect(wire).not.toContain('hidden-advisory');
    for (const r of baseline.results) expect(wire).not.toContain(r.memory.id);
    const summary = (await f.owner.query("SELECT metadata FROM audit_log WHERE query='needle' AND metadata->>'reranking_status'='used' ORDER BY id DESC LIMIT 1")).rows[0].metadata;
    const audit = (await f.owner.query("SELECT memory_id, metadata FROM audit_log WHERE metadata->>'request_id'=$1 AND memory_id IS NOT NULL", [summary.request_id])).rows;
    expect(audit).toHaveLength(1); expect(audit[0].memory_id).toBe(target.memory.id);
    expect(audit[0].metadata).toMatchObject({ rank: 1, score: target.score, rerank_score: 100 });
    const after = await prepareAgentsMdForPrincipal(f.app, principal, {});
    expect(after.markdown).toBe(sourceBundle.markdown); expect(after.etag).toBe(sourceBundle.etag);
  });
}, 120_000);
