import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestPool } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';

describe('gap-aware evidence invalidation', () => {
  let pool: pg.Pool;
  beforeAll(async () => { pool = await makeTestPool(); }, 30_000);
  afterAll(async () => { await pool?.end(); });
  async function fixture() {
    const actor = await createPrincipal(pool, { externalId: randomUUID(), kind: 'user', displayName: 'Synthetic traversal' });
    const scope = await createScope(pool, { kind: 'project', name: randomUUID() });
    await addMembership(pool, actor.id, scope.id, 'writer');
    const memory = await createMemory(pool, { scopeId: scope.id, scopeKind: scope.kind, authorId: actor.id,
      type: 'decision', title: 'Original', body: 'Managed source payload', source: 'manual' });
    const source = (await pool.query('SELECT continuum_evidence_source($1,$2) AS id', [actor.id, memory.id])).rows[0].id as string;
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await pool.query('SELECT continuum_evidence_register($1,$2,NULL,$3,$4,$5,$6,$7) AS id',
      [actor.id, randomUUID(), scope.id, 'cache', JSON.stringify([{ versionId: source, kind: 'copy' }]),
        { transform: 'copy-v1', model: 'none', prompt: 'none', schema: 'v1' }, 'Managed cache body'])).rows[0].id);
    return { actor, scope, memory, source, ids };
  }
  async function claim() {
    return (await pool.query('SELECT continuum_evidence_claim_dirty($1,30000) AS claim', [randomUUID()])).rows[0].claim;
  }
  async function page(c: { root_id: string; generation: string; owner: string; claim_generation: string }, limit = 2) {
    return (await pool.query('SELECT continuum_evidence_invalidate_page($1,$2,$3,$4,$5) AS result', [c.root_id,c.generation,c.owner,c.claim_generation,limit])).rows[0].result;
  }
  it('materializes bounded pages and retains unresolved locked rows instead of advancing a cursor', async () => {
    const f = await fixture();
    await pool.query("UPDATE memories SET body='Changed' WHERE id=$1", [f.memory.id]);
    let c = await claim();
    while (c.root_id !== f.memory.id) { await page(c, 100); c = await claim(); }
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      const first = (await holder.query('SELECT version_id FROM evidence_closure WHERE root_id=$1 AND generation<2 ORDER BY version_id LIMIT 1', [f.memory.id])).rows[0].version_id;
      await holder.query('SELECT * FROM evidence_state WHERE version_id=$1 FOR UPDATE', [first]);
      const bounded = await pool.connect();
      try {
        await bounded.query("SET lock_timeout='100ms'");
        await expect(bounded.query('SELECT continuum_evidence_invalidate_page($1,$2,$3,$4,2)', [c.root_id,c.generation,c.owner,c.claim_generation])).rejects.toMatchObject({ code: '55P03' });
      } finally { bounded.release(); }
      expect((await pool.query('SELECT cursor FROM evidence_dirty_roots WHERE root_id=$1 AND generation=$2', [c.root_id,c.generation])).rows[0].cursor).toBeNull();
      await holder.query('ROLLBACK');
    } finally { holder.release(); }
    let result = await page(c);
    expect(result.processed).toBeLessThanOrEqual(2);
    expect(result.complete).toBe(false);
    for (let i = 0; !result.complete && i < 10; i++) result = await page(c);
    expect(result.complete).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS n FROM evidence_state WHERE version_id=ANY($1::uuid[]) AND state='quarantined'", [f.ids])).rows[0].n).toBe(7);
    expect((await pool.query('SELECT count(*)::int AS n FROM evidence_repair_jobs WHERE version_id=ANY($1::uuid[])', [f.ids])).rows[0].n).toBe(7);
  });
  it('discovers a transaction committed later even after a later root has completed', async () => {
    const first = await fixture(), second = await fixture(), held = await pool.connect();
    try {
      await held.query('BEGIN');
      await held.query("UPDATE memories SET body='Earlier allocated but delayed commit' WHERE id=$1", [first.memory.id]);
      await pool.query("UPDATE memories SET body='Later committed first' WHERE id=$1", [second.memory.id]);
      for (let i = 0; i < 30; i++) { const c = await claim(); if (!c) break; await page(c,100); }
      expect((await pool.query('SELECT count(*)::int AS n FROM evidence_dirty_roots WHERE root_id=$1', [first.memory.id])).rows[0].n).toBe(0);
      await held.query('COMMIT');
      const late = await claim();
      expect(late.root_id).toBe(first.memory.id);
      expect((await page(late,100)).complete).toBe(true);
      await expect(page({ ...late, claim_generation: String(Number(late.claim_generation)-1) })).rejects.toThrow(/stale/);
    } finally { await held.query('ROLLBACK'); held.release(); }
  });
});
