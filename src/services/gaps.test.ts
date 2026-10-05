import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { addMembership } from '../storage/memberships.js';
import { getScopeByRef } from '../storage/scopes.js';
import { recordRead } from '../audit/log.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { getKnowledgeGaps } from './gaps.js';
import { createMemory } from '../storage/memories.js';
import { createScope } from '../storage/scopes.js';
import { EmbeddingRegistry, ScopeEmbeddingRouter } from '../embeddings/router.js';

describe('getKnowledgeGaps', () => {
  let pool: pg.Pool;

  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); });
  afterAll(async () => { await pool?.end(); });

  async function admin() {
    const principal = await createPrincipal(pool, { externalId: 'admin', kind: 'user', displayName: 'Admin' });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, principal.id, org.id, 'admin');
    return principal;
  }

  it('batches unique candidates, clusters deterministically, ranks, and records one non-recursive audit', async () => {
    const me = await admin();
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const other = await createPrincipal(pool, { externalId: 'other', kind: 'user', displayName: 'Other' });
    for (const [principalId, query] of [
      [me.id, 'deploy rollback'], [other.id, 'deployment rollback'], [me.id, 'deploy rollback'],
      [other.id, 'lunch menu'],
    ]) await recordRead(pool, {
      principalId, query, metadata: { hits: 0, scope_ids: [org.id] }, memories: [],
    });
    const embed = vi.fn(async (texts: string[]) => texts.map((text) =>
      text.includes('rollback') ? [1, 0] : [0, 1]));
    const provider: EmbeddingProvider = { id: 'test', dim: 2, embed };

    const report = await getKnowledgeGaps(pool, provider, me, {
      sinceDays: 30, limit: 10, minFrequency: 1, threshold: 0.9,
      candidateLimit: 20, scanLimit: 100, maxQueryChars: 2_000,
      now: new Date('2026-10-04T12:00:00Z'),
    });

    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0]?.[0]).toHaveLength(3);
    expect(report.semanticClustering).toBe(true);
    expect(report.gaps[0]).toMatchObject({ frequency: 3, distinctPrincipals: 2, score: 6 });
    expect(report.gaps[0].capture).toMatchObject({ scope: { kind: 'org', name: '' }, source: 'manual' });
    expect(JSON.stringify(report)).not.toContain(me.id);
    expect(JSON.stringify(report)).not.toContain(other.id);
    const { rows } = await pool.query(`SELECT query, metadata FROM audit_log WHERE metadata->>'view' = 'insights-gaps'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].query).toBeNull();
  });

  it('falls back to exact groups without leaking provider errors', async () => {
    const me = await admin();
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await recordRead(pool, {
      principalId: me.id, query: 'token=private-value',
      metadata: { hits: 0, scope_ids: [org.id] }, memories: [],
    });
    const provider: EmbeddingProvider = {
      id: 'fail', dim: 2,
      async embed() { throw new Error('provider failed on token=private-value'); },
    };
    const report = await getKnowledgeGaps(pool, provider, me, {
      sinceDays: 30, limit: 10, minFrequency: 1, threshold: 0.9,
      candidateLimit: 20, scanLimit: 100, maxQueryChars: 2_000,
      now: new Date('2026-10-04T12:00:00Z'),
    });
    expect(report.semanticClustering).toBe(false);
    expect(report.embedding).toMatchObject({
      status: 'degraded', attemptedGroups: 1, succeededGroups: 0, failedGroups: 1,
    });
    expect(report.gaps).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain('provider failed');
    const { rows } = await pool.query(
      `SELECT metadata FROM audit_log WHERE metadata->>'view' = 'insights-gaps'`,
    );
    expect(rows[0].metadata).toMatchObject({
      semanticClustering: false,
      embedding: { status: 'degraded', attemptedGroups: 1, succeededGroups: 0, failedGroups: 1 },
    });
    expect(JSON.stringify(rows[0].metadata)).not.toContain('private-value');
  });

  it('routes exact-scope candidates independently and never sends local-only queries hosted', async () => {
    const me = await admin();
    const localScope = await createScope(pool, { kind: 'team', name: 'security' });
    const hostedScope = await createScope(pool, { kind: 'project', name: 'public-docs' });
    await recordRead(pool, {
      principalId: me.id, query: 'local secret query',
      metadata: { hits: 0, scope_ids: [localScope.id] }, memories: [],
    });
    await recordRead(pool, {
      principalId: me.id, query: 'hosted safe query',
      metadata: { hits: 0, scope_ids: [hostedScope.id] }, memories: [],
    });
    const localEmbed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const hostedEmbed = vi.fn(async (texts: string[]) => texts.map(() => [0, 1]));
    const local: EmbeddingProvider = { id: 'ollama:local', dim: 2, local: true, embed: localEmbed };
    const hosted: EmbeddingProvider = { id: 'openai:hosted', dim: 2, local: false, embed: hostedEmbed };
    const router = new ScopeEmbeddingRouter(new EmbeddingRegistry([
      ['local', local], ['hosted', hosted],
    ]), {
      default: 'hosted',
      rules: [{ match: { kind: 'team', name: 'security' }, provider: 'local-only' }],
    });

    const report = await getKnowledgeGaps(pool, router, me, {
      sinceDays: 30, limit: 10, minFrequency: 1, threshold: 0.9,
      candidateLimit: 20, scanLimit: 100, maxQueryChars: 2_000,
      now: new Date('2026-10-04T12:00:00Z'),
    });

    expect(localEmbed).toHaveBeenCalledWith(['local secret query'], expect.anything());
    expect(hostedEmbed).toHaveBeenCalledWith(['hosted safe query'], expect.anything());
    expect(JSON.stringify(hostedEmbed.mock.calls)).not.toContain('local secret query');
    expect(report.embedding).toMatchObject({ status: 'succeeded', attemptedGroups: 2 });
  });

  it.each([
    ['mixed local and hosted scopes', 'mixed private query', 'mixed'],
    ['legacy unknown scope fidelity', 'legacy private query', 'legacy'],
  ] as const)('fails closed before hosted embedding for %s', async (_label, query, mode) => {
    const me = await admin();
    const localScope = await createScope(pool, { kind: 'team', name: 'security' });
    const hostedScope = await createScope(pool, { kind: 'project', name: 'public-docs' });
    await recordRead(pool, {
      principalId: me.id, query,
      metadata: mode === 'mixed'
        ? { hits: 0, scope_ids: [localScope.id, hostedScope.id] }
        : { hits: 0 },
      memories: [],
    });
    const hostedEmbed = vi.fn(async () => [[1, 0]]);
    const localEmbed = vi.fn(async () => [[0, 1]]);
    const router = new ScopeEmbeddingRouter(new EmbeddingRegistry([
      ['local', { id: 'ollama:local', dim: 2, local: true, embed: localEmbed }],
      ['hosted', { id: 'openai:hosted', dim: 2, local: false, embed: hostedEmbed }],
    ]), {
      default: 'hosted',
      rules: [{ match: { kind: 'team', name: 'security' }, provider: 'local-only' }],
    });

    const report = await getKnowledgeGaps(pool, router, me, {
      sinceDays: 30, limit: 10, minFrequency: 1, threshold: 0.9,
      candidateLimit: 20, scanLimit: 100, maxQueryChars: 2_000,
      now: new Date('2026-10-04T12:00:00Z'),
    });

    expect(hostedEmbed).not.toHaveBeenCalled();
    expect(localEmbed).not.toHaveBeenCalled();
    expect(report.embedding).toMatchObject({
      status: 'not-requested', attemptedGroups: 0, skippedCandidates: 1,
    });
    expect(report.semanticClustering).toBe(false);
  });

  it('falls back before clustering when provider vectors differ from provider.dim', async () => {
    const me = await admin();
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await recordRead(pool, {
      principalId: me.id, query: 'dimension mismatch',
      metadata: { hits: 0, scope_ids: [org.id] }, memories: [],
    });
    const provider: EmbeddingProvider = {
      id: 'wrong-dimension', dim: 3,
      async embed(texts) { return texts.map(() => [1, 0]); },
    };

    const report = await getKnowledgeGaps(pool, provider, me, {
      sinceDays: 30, limit: 10, minFrequency: 1, threshold: 0.9,
      candidateLimit: 20, scanLimit: 100, maxQueryChars: 2_000,
      now: new Date('2026-10-04T12:00:00Z'),
    });

    expect(report.semanticClustering).toBe(false);
    expect(report.gaps).toHaveLength(1);
  });

  it('fails malformed scope UUIDs closed instead of failing the report', async () => {
    const me = await admin();
    await recordRead(pool, {
      principalId: me.id, query: 'malformed scope report',
      metadata: { hits: 0, scope_ids: ['not-a-uuid'] }, memories: [],
    });

    const report = await getKnowledgeGaps(pool, null, me, {
      sinceDays: 30, limit: 10, minFrequency: 1, threshold: 0.9,
      candidateLimit: 20, scanLimit: 100, maxQueryChars: 2_000,
      now: new Date('2026-10-04T12:00:00Z'),
    });

    expect(report.scopeFidelity).toBe('unknown');
    expect(report.gaps[0].resolution).toEqual({
      status: 'unresolved', scopeFidelity: 'unknown',
    });
  });

  it('bounds semantic embedding by a report deadline and aborts the provider work', async () => {
    const me = await admin();
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await recordRead(pool, {
      principalId: me.id, query: 'slow semantic query',
      metadata: { hits: 0, scope_ids: [org.id] }, memories: [],
    });
    let observedSignal: AbortSignal | undefined;
    const provider: EmbeddingProvider = {
      id: 'slow', dim: 2,
      embed: vi.fn(async (_texts, options) => {
        observedSignal = options?.signal;
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason));
        });
        return [];
      }),
    };
    const report = await getKnowledgeGaps(pool, provider, me, {
      sinceDays: 30, limit: 10, minFrequency: 1, threshold: 0.9,
      candidateLimit: 20, scanLimit: 100, maxQueryChars: 2_000,
      embeddingTimeoutMs: 25, now: new Date('2026-10-04T12:00:00Z'),
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(report.semanticClustering).toBe(false);
    expect(report.gaps).toHaveLength(1);
  });

  it('rejects an unsafe direct candidate cap before querying or clustering', async () => {
    const me = await admin();
    await expect(getKnowledgeGaps(pool, null, me, {
      sinceDays: 30, limit: 10, minFrequency: 1, threshold: 0.9,
      candidateLimit: 501, scanLimit: 1_000, maxQueryChars: 2_000,
      embeddingTimeoutMs: 2_000,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('does not split a surrogate pair when truncating the capture title', async () => {
    const me = await admin();
    const query = `${'a'.repeat(484)}😀tail`;
    await recordRead(pool, { principalId: me.id, query, metadata: { hits: 0 }, memories: [] });
    const report = await getKnowledgeGaps(pool, null, me, {
      sinceDays: 30, limit: 10, minFrequency: 1, threshold: 0.9,
      candidateLimit: 20, scanLimit: 100, maxQueryChars: 2_000,
      embeddingTimeoutMs: 2_000,
      now: new Date('2026-10-04T12:00:00Z'),
    });
    const title = report.gaps[0].capture.title;
    expect(title.length).toBeLessThanOrEqual(500);
    expect(title.charCodeAt(title.length - 1)).not.toBeGreaterThanOrEqual(0xD800);
    expect(title).not.toMatch(/[\uD800-\uDFFF]$/u);
  });

  it('reports exact scope fidelity for an empty report', async () => {
    const me = await admin();
    const report = await getKnowledgeGaps(pool, null, me, {
      sinceDays: 30, limit: 10, minFrequency: 1, threshold: 0.9,
      candidateLimit: 20, scanLimit: 100, maxQueryChars: 2_000,
      embeddingTimeoutMs: 2_000,
      now: new Date('2026-10-04T12:00:00Z'),
    });
    expect(report.scopeFidelity).toBe('exact');
  });

  it('derives resolution without returning memory content and distinguishes exact scope fidelity', async () => {
    const me = await admin();
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await createMemory(pool, {
      scopeId: org.id, scopeKind: 'org', type: 'playbook', title: 'Release rollback guide',
      body: 'private-memory-content must never enter insights', authorId: me.id, source: 'manual',
    });
    await recordRead(pool, {
      principalId: me.id, query: 'release rollback',
      metadata: { hits: 0, scope_ids: [org.id] }, memories: [],
    });
    const report = await getKnowledgeGaps(pool, null, me, {
      sinceDays: 30, limit: 10, minFrequency: 1, threshold: 0.9,
      candidateLimit: 20, scanLimit: 100, maxQueryChars: 2_000,
      now: new Date('2026-10-04T12:00:00Z'),
    });
    expect(report.scopeFidelity).toBe('exact');
    expect(report.gaps[0].resolution).toEqual({ status: 'resolved', scopeFidelity: 'exact' });
    expect(JSON.stringify(report)).not.toContain('private-memory-content');
  });

  it.each([
    ['an exact empty scope set', { hits: 0, scope_ids: [] }, 'exact'],
    ['legacy scope metadata', { hits: 0 }, 'unknown'],
  ] as const)('does not resolve %s from unrelated org memory', async (_label, metadata, fidelity) => {
    const me = await admin();
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await createMemory(pool, {
      scopeId: org.id, scopeKind: 'org', type: 'playbook', title: 'Release rollback guide',
      body: 'private-memory-content', authorId: me.id, source: 'manual',
    });
    await recordRead(pool, {
      principalId: me.id, query: 'release rollback', metadata, memories: [],
    });

    const report = await getKnowledgeGaps(pool, null, me, {
      sinceDays: 30, limit: 10, minFrequency: 1, threshold: 0.9,
      candidateLimit: 20, scanLimit: 100, maxQueryChars: 2_000,
      now: new Date('2026-10-04T12:00:00Z'),
    });

    expect(report.gaps[0].resolution).toEqual({ status: 'unresolved', scopeFidelity: fidelity });
    expect(JSON.stringify(report)).not.toContain('private-memory-content');
  });
});
