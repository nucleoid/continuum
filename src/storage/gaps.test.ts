import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { recordRead } from '../audit/log.js';
import { isGapCurrentlyResolved, selectGapCandidates } from './gaps.js';
import { createMemory } from './memories.js';
import { getScopeByRef } from './scopes.js';

describe('selectGapCandidates', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => { await pool?.end(); });

  it('selects only bounded zero-hit request summaries and aggregates normalized duplicates', async () => {
    const a = await createPrincipal(pool, { externalId: 'a', kind: 'user', displayName: 'A' });
    const b = await createPrincipal(pool, { externalId: 'b', kind: 'user', displayName: 'B' });
    await recordRead(pool, { principalId: a.id, query: '  Rollback\u00a0 PROCEDURE  ', metadata: { hits: 0 }, memories: [] });
    await recordRead(pool, { principalId: b.id, query: 'rollback procedure', metadata: { hits: 0 }, memories: [] });
    await recordRead(pool, { principalId: b.id, query: 'not a gap', metadata: { hits: 1 }, memories: [] });
    await recordRead(pool, { principalId: b.id, query: 'internal secret', metadata: { hits: 0, view: 'insights-gaps' }, memories: [] });
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, query, metadata)
       VALUES ($1, 'read', 'string zero', '{"hits":"0"}'),
              ($1, 'read', 'result detail', '{"hits":0,"record_kind":"result"}'),
              ($1, 'read', '   ', '{"hits":0}')`,
      [a.id],
    );

    const result = await selectGapCandidates(pool, {
      since: new Date(Date.now() - 86_400_000), scanLimit: 50,
      candidateLimit: 10, maxQueryChars: 2_000,
    });

    expect(result.scannedCount).toBeGreaterThanOrEqual(2);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      normalized: 'rollback procedure', frequency: 2, distinctPrincipals: 2,
    });
    expect(result.candidates[0].variants).toEqual(expect.arrayContaining([
      'Rollback PROCEDURE', 'rollback procedure',
    ]));
    expect(JSON.stringify(result)).not.toContain(a.id);
    expect(JSON.stringify(result)).not.toContain(b.id);
  });

  it('caps candidates before embedding and reports truncation with stable ordering', async () => {
    const principal = await createPrincipal(pool, { externalId: 'c', kind: 'user', displayName: 'C' });
    for (const query of ['zeta gap', 'alpha gap', 'middle gap']) {
      await recordRead(pool, { principalId: principal.id, query, metadata: { hits: 0 }, memories: [] });
    }
    const { rows: clockRows } = await pool.query<{ database_now: Date }>(
      `SELECT CURRENT_TIMESTAMP AS database_now`,
    );
    const databaseNow = clockRows[0].database_now;
    await pool.query(`UPDATE audit_log SET at = $1`, [databaseNow]);
    const result = await selectGapCandidates(pool, {
      since: new Date(databaseNow.getTime() - 86_400_000), scanLimit: 50,
      candidateLimit: 2, maxQueryChars: 2_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((item) => item.normalized)).toEqual([
      'alpha gap', 'middle gap',
    ]);
  });

  it('keeps an exact empty scope set distinct and never resolves it globally', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'empty-scopes', kind: 'user', displayName: 'Empty scopes',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await createMemory(pool, {
      scopeId: org.id, scopeKind: 'org', type: 'playbook', title: 'Release rollback guide',
      body: 'Use the documented rollback process.', authorId: principal.id, source: 'manual',
    });
    await recordRead(pool, {
      principalId: principal.id, query: 'release rollback',
      metadata: { hits: 0, scope_ids: [] }, memories: [],
    });

    const selection = await selectGapCandidates(pool, {
      since: new Date(Date.now() - 86_400_000), scanLimit: 50,
      candidateLimit: 10, maxQueryChars: 2_000,
    });

    expect(selection.candidates[0]).toMatchObject({
      scopeIds: [], scopeFidelity: 'exact',
    });
    await expect(isGapCurrentlyResolved(pool, 'release rollback', [])).resolves.toBe(false);
  });

  it('marks grouped searches with different exact scope sets as unknown', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'mixed-scopes', kind: 'user', displayName: 'Mixed scopes',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await recordRead(pool, {
      principalId: principal.id, query: 'same question',
      metadata: { hits: 0, scope_ids: [] }, memories: [],
    });
    await recordRead(pool, {
      principalId: principal.id, query: 'same question',
      metadata: { hits: 0, scope_ids: [org.id] }, memories: [],
    });

    const selection = await selectGapCandidates(pool, {
      since: new Date(Date.now() - 86_400_000), scanLimit: 50,
      candidateLimit: 10, maxQueryChars: 2_000,
    });

    expect(selection.candidates[0]).toMatchObject({
      scopeIds: [], scopeFidelity: 'unknown', frequency: 2,
    });
  });

  it('marks a normalized group mixing legacy and exact scope metadata as unknown', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'legacy-mixed-scopes', kind: 'user', displayName: 'Legacy mixed scopes',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await recordRead(pool, {
      principalId: principal.id, query: 'same legacy question',
      metadata: { hits: 0 }, memories: [],
    });
    await recordRead(pool, {
      principalId: principal.id, query: 'SAME LEGACY QUESTION',
      metadata: { hits: 0, scope_ids: [org.id] }, memories: [],
    });

    const selection = await selectGapCandidates(pool, {
      since: new Date(Date.now() - 86_400_000), scanLimit: 50,
      candidateLimit: 10, maxQueryChars: 2_000,
    });

    expect(selection.candidates[0]).toMatchObject({
      scopeIds: [], scopeFidelity: 'unknown', frequency: 2,
    });
  });

  it('marks mixed non-string scope IDs as unknown', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'invalid-scopes', kind: 'user', displayName: 'Invalid scopes',
    });
    await recordRead(pool, {
      principalId: principal.id, query: 'same question',
      metadata: { hits: 0, scope_ids: ['valid-looking', 42] }, memories: [],
    });
    const selection = await selectGapCandidates(pool, {
      since: new Date(Date.now() - 86_400_000), scanLimit: 50,
      candidateLimit: 10, maxQueryChars: 2_000,
    });
    expect(selection.candidates[0]).toMatchObject({
      scopeIds: [], scopeFidelity: 'unknown',
    });
  });

  it('marks malformed UUID scope IDs as unknown', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'malformed-uuid-scopes', kind: 'user', displayName: 'Malformed UUID scopes',
    });
    await recordRead(pool, {
      principalId: principal.id, query: 'malformed scope question',
      metadata: { hits: 0, scope_ids: ['not-a-uuid'] }, memories: [],
    });

    const selection = await selectGapCandidates(pool, {
      since: new Date(Date.now() - 86_400_000), scanLimit: 50,
      candidateLimit: 10, maxQueryChars: 2_000,
    });

    expect(selection.candidates[0]).toMatchObject({
      scopeIds: [], scopeFidelity: 'unknown',
    });
  });

  it('rejects a query whose NFKC display expands beyond the query bound', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'normalization-expansion', kind: 'user', displayName: 'Normalization expansion',
    });
    await recordRead(pool, {
      principalId: principal.id, query: '\uFDFA', metadata: { hits: 0 }, memories: [],
    });

    const selection = await selectGapCandidates(pool, {
      since: new Date(Date.now() - 86_400_000), scanLimit: 50,
      candidateLimit: 10, maxQueryChars: 10,
    });

    expect(selection.candidates).toEqual([]);
  });
});
