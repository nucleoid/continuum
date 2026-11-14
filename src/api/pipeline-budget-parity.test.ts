import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Budget, checkedProfile, starterProfile } from '../pipeline/budget.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { recallForPrincipal } from '../services/recall.js';
import { prepareAgentsMdForPrincipal, renderAgentsMdForPrincipal } from '../services/agents-md.js';
import { getReadableMemory } from '../storage/memory-reads.js';
import { RetrievalEnricherRegistry } from '../extensions/retrieval.js';
import { boundedJsonText } from './mcp-http-output.js';

describe('optional pipeline service envelope parity', () => {
  let pool: pg.Pool;
  let principal: Awaited<ReturnType<typeof createPrincipal>>;
  beforeEach(async () => {
    pool ??= await makeTestPool(); await resetData(pool);
    principal = await createPrincipal(pool, { externalId: 'budget-reader', kind: 'user', displayName: 'Reader' });
  }, 30_000);
  afterAll(async () => { await pool?.end(); });
  async function seed(body = 'Budget reference evidence', metadata = {}) {
    const scope = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    return createMemory(pool, { scopeId: scope.id, scopeKind: 'org', type: 'decision', title: 'Budget reference', body, metadata, authorId: principal.id, source: 'manual' });
  }
  it('keeps unconfigured recall and deterministic generator selection and bytes', async () => {
    await seed();
    const baseline = await prepareAgentsMdForPrincipal(pool, principal, {});
    const budget = new Budget(starterProfile);
    const bounded = await prepareAgentsMdForPrincipal(pool, principal, {}, undefined, budget);
    expect(bounded.markdown).toBe(baseline.markdown);
    expect(bounded.hash).toBe(baseline.hash);
    expect(bounded.markdown).not.toContain('receipts');
    expect(budget.snapshot().used.hydratedBytes).toBeGreaterThan(0);
    expect((await recallForPrincipal(pool, null, principal, { query: 'Budget' }, {}, undefined, undefined, new Budget(starterProfile))).results).toHaveLength(1);
  });
  it('denies per-item hydration before content is read and before success audits', async () => {
    const memory = await seed('Budget ' + '界'.repeat(5000));
    const small = checkedProfile({ ...starterProfile, maxItemHydratedBytes: 5000 });
    await expect(renderAgentsMdForPrincipal(pool, principal, {}, {}, undefined, new Budget(small))).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    await expect(recallForPrincipal(pool, null, principal, { query: 'Budget' }, {}, undefined, undefined, new Budget(small))).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    await expect(getReadableMemory(pool, principal.id, memory.id, undefined, new Budget(small))).rejects.toThrow();
    expect((await pool.query("SELECT 1 FROM audit_log WHERE action='read'")).rowCount).toBe(0);
  });
  it('shares hydration across reads and scopes without truncating stored source', async () => {
    const memory = await seed('Budget ' + 'x'.repeat(3000));
    const budget = new Budget(checkedProfile({ ...starterProfile, maxItemHydratedBytes: 9000,
      limits: { ...starterProfile.limits, hydratedBytes: 12_000 } }));
    expect(await getReadableMemory(pool, principal.id, memory.id, undefined, budget)).not.toBeNull();
    await expect(getReadableMemory(pool, principal.id, memory.id, undefined, budget.child())).rejects.toThrow();
    expect((await pool.query('SELECT body FROM memories WHERE id=$1', [memory.id])).rows[0].body.length).toBe(3007);
  });
  it('skips unaccountable optional embeddings/enrichers and never invokes denied or unpriced providers', async () => {
    await seed(); let calls = 0;
    const provider = { id: 'unknown', dim: 768, local: false, embed: async () => { calls++; return [Array(768).fill(1)]; } };
    const registry = new RetrievalEnricherRegistry();
    registry.register({ id: 'unpriced', enrich: async () => { calls++; return [{ leak: true }]; } });
    const result = await recallForPrincipal(pool, provider, principal, { query: 'Budget' }, {}, undefined,
      { registry, options: { timeoutMs: 100, maxBytes: 16384 } }, new Budget(starterProfile));
    expect(result.results).toHaveLength(1);
    expect(result.results[0].enrichments).toBeUndefined();
    expect(result.diagnostics.vector).toBe('failed');
    expect(calls).toBe(0);
    const hidden = await createScope(pool, { kind: 'project', name: 'hidden' });
    await createMemory(pool, { scopeId: hidden.id, scopeKind: 'project', type: 'decision', title: 'Hidden', body: 'Budget', authorId: principal.id, source: 'manual' });
    const before = new Budget(starterProfile);
    expect(await recallForPrincipal(pool, provider, principal, { query: 'Budget', scopes: ['project:hidden'] }, {}, undefined, undefined, before)).toMatchObject({ results: [], diagnostics: { vector: 'disabled' } });
    expect(calls).toBe(0);
    expect(before.snapshot().used.calls).toBe(0);
  });
  it('checks complete MCP double escaping and metadata-heavy envelopes within shared output allowance', async () => {
    await seed('Budget reference', { wrappers: '\u0001"\\'.repeat(1000) });
    const result = await recallForPrincipal(pool, null, principal, { query: 'Budget' });
    const projected = { memories: result.results.map((r) => ({ title: r.memory.title, metadata: r.memory.metadata, citation: r.memory.id })) };
    const wire = boundedJsonText(projected, 100_000, true);
    const envelope = { content: [{ type: 'text', text: wire }] };
    const budget = new Budget(checkedProfile({ ...starterProfile, limits: { ...starterProfile.limits, outputBytes: 5000 } }));
    expect(() => budget.serializeOutput(envelope)).toThrow();
    expect(new Budget(starterProfile).serializeOutput(envelope)).toContain('content');
  });
  it('rechecks growth in the hydration snapshot against its already reserved allocation', async () => {
    const memory = await seed(); let changed = false;
    const observed = { query: (async (sql: string, values?: unknown[]) => {
      const result = await pool.query(sql, values);
      if (!changed && sql.startsWith('SELECT m.id,') && sql.includes('budget_bytes')) {
        changed = true;
        await pool.query('UPDATE memories SET body=$2 WHERE id=$1', [memory.id, 'Budget ' + 'x'.repeat(10_000)]);
      }
      if (sql.startsWith('WITH budget_candidates')) expect(result.rows.every((r) => r.body == null)).toBe(true);
      return result;
    }) as pg.Pool['query'] };
    await expect(getReadableMemory(observed, principal.id, memory.id, undefined, new Budget(starterProfile))).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(changed).toBe(true);
  });
  it('rejects candidate overflow rather than silently narrowing ranked selection', async () => {
    await seed(); await seed();
    const budget = new Budget(checkedProfile({ ...starterProfile, limits: { ...starterProfile.limits, candidates: 1 } }));
    await expect(recallForPrincipal(pool, null, principal, { query: 'Budget' }, {}, undefined, undefined, budget)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect((await pool.query("SELECT 1 FROM audit_log WHERE action='read'")).rowCount).toBe(0);
  });
});
