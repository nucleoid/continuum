import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestPool } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { createMemory } from './memories.js';

describe('immutable evidence and synchronous eligibility', () => {
  let pool: pg.Pool;
  beforeAll(async () => { pool = await makeTestPool(); }, 30_000);
  afterAll(async () => { await pool?.end(); });
  async function fixture() {
    const actor = await createPrincipal(pool, { externalId: randomUUID(), kind: 'user', displayName: 'Evidence synthetic' });
    const scope = await createScope(pool, { kind: 'project', name: randomUUID() });
    await addMembership(pool, actor.id, scope.id, 'writer');
    const memory = await createMemory(pool, { scopeId: scope.id, scopeKind: scope.kind, authorId: actor.id,
      type: 'fact', title: 'Original', body: 'Canonical source', source: 'manual' });
    const source = (await pool.query('SELECT continuum_evidence_source($1,$2) AS id', [actor.id, memory.id])).rows[0].id as string;
    return { actor, scope, memory, source };
  }
  async function derive(f: Awaited<ReturnType<typeof fixture>>, parents = [f.source], node = randomUUID(), expected: string | null = null) {
    return (await pool.query('SELECT continuum_evidence_register($1,$2,$3,$4,$5,$6,$7,$8) AS id',
      [f.actor.id, node, expected, f.scope.id, 'derived-observation', JSON.stringify(parents.map(versionId => ({ versionId, kind: 'derivation' }))),
        { transform: 'synthetic-v1', model: 'none', prompt: 'none', schema: 'v1' }, 'Derived private prose'])).rows[0].id as string;
  }
  const eligible = async (actor: string, version: string) =>
    (await pool.query('SELECT continuum_evidence_eligible($1,$2,NULL) AS allowed', [actor, version])).rows[0].allowed;
  it('invalidates an entire diamond at source commit before any materialization', async () => {
    const f = await fixture(), left = await derive(f), right = await derive(f), tip = await derive(f, [left, right]);
    expect(await eligible(f.actor.id, tip)).toBe(true);
    expect((await pool.query('SELECT count(*)::int AS n FROM evidence_closure WHERE version_id=$1', [tip])).rows[0].n).toBe(4);
    await pool.query("UPDATE memories SET body='Changed by an older direct writer' WHERE id=$1", [f.memory.id]);
    expect(await eligible(f.actor.id, tip)).toBe(false);
    expect((await pool.query('SELECT state FROM evidence_state WHERE version_id=$1', [tip])).rows[0].state).toBe('active');
    await expect(derive(f, [tip])).rejects.toThrow(/unavailable/);
    expect((await pool.query('SELECT payload FROM evidence_payloads WHERE version_id=$1', [f.source])).rows[0].payload).toContain('Canonical source');
  });
  it('ignores operational metadata, creates immutable substantive versions and never renews the captured expiry', async () => {
    const f = await fixture(), derivative = await derive(f);
    await pool.query("UPDATE memories SET metadata=metadata||'{\"related\":[]}'::jsonb,updated_at=clock_timestamp() WHERE id=$1", [f.memory.id]);
    expect(await eligible(f.actor.id, derivative)).toBe(true);
    const old = (await pool.query('SELECT expires_at FROM evidence_versions WHERE id=$1', [f.source])).rows[0].expires_at;
    await pool.query("UPDATE memories SET expires_at=expires_at+interval '30 days' WHERE id=$1", [f.memory.id]);
    expect(await eligible(f.actor.id, derivative)).toBe(false);
    const fresh = (await pool.query('SELECT continuum_evidence_source($1,$2) AS id', [f.actor.id, f.memory.id])).rows[0].id;
    expect(fresh).not.toBe(f.source);
    expect((await pool.query('SELECT expires_at FROM evidence_versions WHERE id=$1', [fresh])).rows[0].expires_at).toEqual(old);
    await expect(pool.query("UPDATE evidence_versions SET kind='cache' WHERE id=$1", [f.source])).rejects.toThrow(/immutable/);
  });
  it('denies clock expiry, current membership loss and corrupt missing closure without hydrating', async () => {
    const f = await fixture(), derivative = await derive(f);
    await pool.query('UPDATE scope_memberships SET active=FALSE WHERE principal_id=$1 AND scope_id=$2', [f.actor.id, f.scope.id]);
    expect(await eligible(f.actor.id, derivative)).toBe(false);
    await addMembership(pool, f.actor.id, f.scope.id, 'writer');
    await pool.query('DELETE FROM evidence_closure WHERE version_id=$1 AND root_id=$2', [derivative, f.memory.id]);
    expect(await eligible(f.actor.id, derivative)).toBe(false);
    const other = await fixture(), timed = await derive(other);
    await pool.query("UPDATE memories SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [other.memory.id]);
    expect(await eligible(other.actor.id, timed)).toBe(false);
  });
  it('bounds parents and depth and fences current pointer compare-and-swap', async () => {
    const f = await fixture(), node = randomUUID(), first = await derive(f, [f.source], node);
    await expect(derive(f, [f.source], node)).rejects.toThrow(/current/);
    const next = await derive(f, [f.source], node, first);
    expect(await eligible(f.actor.id, first)).toBe(false);
    expect(await eligible(f.actor.id, next)).toBe(true);
    await expect(derive(f, Array(65).fill(f.source))).rejects.toThrow(/bounds/);
    await expect(derive(f, [f.source, f.source])).rejects.toThrow(/duplicate/);
    let parent = f.source;
    for (let depth = 1; depth <= 16; depth++) parent = await derive(f, [parent]);
    await expect(derive(f, [parent])).rejects.toThrow(/bounds/);
    await expect(derive(f, [next], node, next)).rejects.toThrow(/cycle/);
  });
});
