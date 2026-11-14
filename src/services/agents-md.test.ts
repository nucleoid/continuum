import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership, removeMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { auditAgentsMdRead, prepareAgentsMdForPrincipal, renderAgentsMdForPrincipal } from './agents-md.js';

describe('bounded remote AGENTS.md reads', () => {
  let pool: pg.Pool;
  let reader: Awaited<ReturnType<typeof createPrincipal>>;
  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
    reader = await createPrincipal(pool, { externalId: 'bundle-reader', kind: 'user', displayName: 'Reader' });
  });
  afterAll(async () => { await pool?.end(); });
  it('keeps derived payloads outside source selection, exact bytes and freshness audits', async () => {
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const project = await createScope(pool, { kind: 'project', name: 'restricted-evidence' });
    const personal = await createScope(pool, { kind: 'user', name: 'personal-evidence' });
    await addMembership(pool, reader.id, project.id, 'reader');
    await addMembership(pool, reader.id, personal.id, 'reader');
    const source = await createMemory(pool, { scopeId: org.id, scopeKind: 'org', type: 'decision',
      title: 'Authorized source', body: 'Source reference data', authorId: reader.id, source: 'manual' });
    for (const [scope, type] of [[org, 'context'], [personal, 'decision']] as const) {
      await createMemory(pool, { scopeId: scope.id, scopeKind: scope.kind, type,
        title: 'Excluded prose', body: 'private pipeline prose', authorId: reader.id, source: 'manual' });
    }
    const hidden = await createMemory(pool, { scopeId: project.id, scopeKind: 'project', type: 'decision',
      title: 'Restricted source', body: 'Restricted evidence', authorId: reader.id, source: 'manual' });
    const before = await prepareAgentsMdForPrincipal(pool, reader, { project: project.name });
    const payloads = { assertions: ['forged assertion'], brief: 'forged brief', connector: 'forged connector',
      activity: 'personal activity', coordination: 'lease payload', enrichments: { hostile: 'tool instruction' },
      related: [{ id: hidden.id }], citations: [{ source: 'inaccessible citation' }],
      reranking: { score: 99, receipt: 'hidden-reranker-prose' } };
    await pool.query('UPDATE memories SET metadata=$2::jsonb WHERE id=$1', [source.id, JSON.stringify(payloads)]);
    const unchanged = await prepareAgentsMdForPrincipal(pool, reader, { project: project.name });
    expect(unchanged.hash).toBe(before.hash);
    expect(unchanged.markdown).toBe(before.markdown);
    expect(unchanged.memories.map(memory => memory.id).sort()).toEqual([source.id, hidden.id].sort());
    expect(unchanged.markdown).not.toMatch(/forged|private pipeline|lease payload|inaccessible citation/);
    await auditAgentsMdRead(pool, reader, {}, unchanged, false, { conditional: true });
    await auditAgentsMdRead(pool, reader, {}, unchanged, false, { freshness: true });
    expect((await pool.query("SELECT memory_id,metadata->>'hits' AS hits FROM audit_log WHERE action='read'"))
      .rows).toEqual([{ memory_id: null, hits: '0' }, { memory_id: null, hits: '0' }]);
    await removeMembership(pool, reader.id, project.id);
    const revoked = await prepareAgentsMdForPrincipal(pool, reader, { project: project.name });
    expect(revoked.memories.map(memory => memory.id)).toEqual([source.id]);
    expect(revoked.hash).not.toBe(before.hash);
    await pool.query('UPDATE memories SET body=$2 WHERE id=$1', [hidden.id, 'Hidden changed text']);
    expect((await prepareAgentsMdForPrincipal(pool, reader, { project: project.name })).hash).toBe(revoked.hash);
    await renderAgentsMdForPrincipal(pool, reader, { project: project.name });
    expect((await pool.query("SELECT memory_id FROM audit_log WHERE metadata->>'record_kind'='result'"))
      .rows).toEqual([{ memory_id: source.id }]);
  });
  it('rejects aggregate oversized generator data before body hydration and success read audit', async () => {
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    for (let index = 0; index < 10; index++) await createMemory(pool, {
      scopeId: org.id, scopeKind: 'org', type: 'decision', title: `Large ${index}`, body: '界'.repeat(40000), authorId: reader.id, source: 'manual',
    });
    const sql: string[] = [];
    const observed = observing(pool, sql);
    await expect(renderAgentsMdForPrincipal(observed, reader, {}, {}, 1048576)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', status: 413 });
    expect(sql.some((value) => value.includes('octet_length(m.body)'))).toBe(true);
    expect(sql.some((value) => value.includes('SELECT m.id, m.scope_id'))).toBe(false);
    expect((await pool.query('SELECT 1 FROM audit_log')).rowCount).toBe(0);
    await expect(prepareAgentsMdForPrincipal(observed, reader, {}, 1048576)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
  it('rejects actual escaped Markdown wire growth before generator delivery audit', async () => {
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await createMemory(pool, { scopeId: org.id, scopeKind: 'org', type: 'decision', title: 'Escaping',
      body: '\u0001'.repeat(150000), authorId: reader.id, source: 'manual' });
    await expect(renderAgentsMdForPrincipal(pool, reader, {}, {}, 1048576)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect((await pool.query('SELECT 1 FROM audit_log')).rowCount).toBe(0);
  });
  it('admits default org plus project bundles of forty ordinary 2 KiB memories', async () => {
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const project = await createScope(pool, { kind: 'project', name: 'ordinary' });
    await addMembership(pool, reader.id, project.id, 'reader');
    for (const scope of [org, project]) for (let index = 0; index < 20; index++) await createMemory(pool, {
      scopeId: scope.id, scopeKind: scope.kind, type: 'decision', title: `Reference ${index}`,
      body: 'Ordinary reference text with punctuation. '.repeat(52), authorId: reader.id, source: 'manual',
    });
    const ordinary = await prepareAgentsMdForPrincipal(pool, reader, { project: 'ordinary' });
    const bounded = await prepareAgentsMdForPrincipal(pool, reader, { project: 'ordinary' }, 1048576);
    expect(bounded.memories).toHaveLength(40);
    expect(bounded.markdown).toBe(ordinary.markdown);
    expect(bounded.hash).toBe(ordinary.hash);
    expect(await renderAgentsMdForPrincipal(pool, reader, { project: 'ordinary' }, {}, 1048576)).toBe(ordinary.markdown);
    expect((await pool.query('SELECT 1 FROM audit_log')).rowCount).toBeGreaterThan(0);
  });
  it('keeps exact normal generated bytes and freshness hash for a fitting remote bundle', async () => {
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await createMemory(pool, { scopeId: org.id, scopeKind: 'org', type: 'decision', title: 'Title **escaped**', body: '界\n\\\t[reference]', authorId: reader.id, source: 'manual' });
    const ordinary = await prepareAgentsMdForPrincipal(pool, reader, {});
    const bounded = await prepareAgentsMdForPrincipal(pool, reader, {}, 1048576);
    expect(bounded.markdown).toBe(ordinary.markdown);
    expect(bounded.hash).toBe(ordinary.hash);
    expect(bounded.memories).toEqual(ordinary.memories);
    expect(Buffer.byteLength(bounded.markdown)).toBeLessThan(1048576);
  });
  it('charges scope names before hydrating an unbounded set of accessible role scopes', async () => {
    for (let index = 0; index < 8; index++) {
      const scope = await createScope(pool, { kind: 'role', name: `role-${index}-${'x'.repeat(80)}` });
      await addMembership(pool, reader.id, scope.id, 'reader');
    }
    const sql: string[] = [];
    await expect(prepareAgentsMdForPrincipal(observing(pool, sql), reader, {}, 4096)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('scope_budget');
    expect((await pool.query('SELECT 1 FROM audit_log')).rowCount).toBe(0);
  });
});
function observing(pool: pg.Pool, queries: string[]): pg.Pool {
  return { query: async (sql: string, ...args: unknown[]) => {
    queries.push(sql);
    return (pool.query as (...queryArgs: unknown[]) => unknown)(sql, ...args);
  } } as unknown as pg.Pool;
}
