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
    const other = await createPrincipal(pool, { externalId: 'other', kind: 'user', displayName: 'Other' });
    for (const [principalId, query] of [
      [me.id, 'deploy rollback'], [other.id, 'deployment rollback'], [me.id, 'deploy rollback'],
      [other.id, 'lunch menu'],
    ]) await recordRead(pool, { principalId, query, metadata: { hits: 0 }, memories: [] });
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
    await recordRead(pool, { principalId: me.id, query: 'token=private-value', metadata: { hits: 0 }, memories: [] });
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
    expect(report.gaps).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain('provider failed');
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
});
