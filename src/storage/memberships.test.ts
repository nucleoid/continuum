import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import {
  addMembership,
  getMembership,
  getPrincipalsForScope,
  getScopesForPrincipal,
  hasRole,
  removeMembership,
} from './memberships.js';

describe('memberships repository', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('adds, retrieves, and removes a membership', async () => {
    const p = await createPrincipal(pool, {
      externalId: 'u1',
      kind: 'user',
      displayName: 'A',
    });
    const s = await createScope(pool, { kind: 'team', name: 't' });
    await addMembership(pool, p.id, s.id, 'writer');
    const m = await getMembership(pool, p.id, s.id);
    expect(m?.role).toBe('writer');
    const removed = await removeMembership(pool, p.id, s.id);
    expect(removed).toBe(true);
    const after = await getMembership(pool, p.id, s.id);
    expect(after).toBeNull();
  });

  it('upserts role on conflict', async () => {
    const p = await createPrincipal(pool, {
      externalId: 'u2',
      kind: 'user',
      displayName: 'B',
    });
    const s = await createScope(pool, { kind: 'team', name: 't2' });
    await addMembership(pool, p.id, s.id, 'reader');
    await addMembership(pool, p.id, s.id, 'admin');
    const m = await getMembership(pool, p.id, s.id);
    expect(m?.role).toBe('admin');
  });

  it('hasRole respects the reader < writer < admin hierarchy', async () => {
    const p = await createPrincipal(pool, {
      externalId: 'u3',
      kind: 'user',
      displayName: 'C',
    });
    const s = await createScope(pool, { kind: 'project', name: 'x' });
    await addMembership(pool, p.id, s.id, 'writer');
    expect(await hasRole(pool, p.id, s.id, 'reader')).toBe(true);
    expect(await hasRole(pool, p.id, s.id, 'writer')).toBe(true);
    expect(await hasRole(pool, p.id, s.id, 'admin')).toBe(false);
  });

  it('hasRole is false when no membership exists', async () => {
    const p = await createPrincipal(pool, {
      externalId: 'u4',
      kind: 'user',
      displayName: 'D',
    });
    const s = await createScope(pool, { kind: 'project', name: 'y' });
    expect(await hasRole(pool, p.id, s.id, 'reader')).toBe(false);
  });

  it('lists scopes for principal and principals for scope', async () => {
    const p1 = await createPrincipal(pool, {
      externalId: 'p1',
      kind: 'user',
      displayName: 'P1',
    });
    const p2 = await createPrincipal(pool, {
      externalId: 'p2',
      kind: 'user',
      displayName: 'P2',
    });
    const s1 = await createScope(pool, { kind: 'team', name: 'one' });
    const s2 = await createScope(pool, { kind: 'team', name: 'two' });
    await addMembership(pool, p1.id, s1.id, 'admin');
    await addMembership(pool, p1.id, s2.id, 'reader');
    await addMembership(pool, p2.id, s1.id, 'writer');

    const scopesForP1 = await getScopesForPrincipal(pool, p1.id);
    expect(scopesForP1.map((s) => s.name).sort()).toEqual(['one', 'two']);

    const principalsForS1 = await getPrincipalsForScope(pool, s1.id);
    expect(principalsForS1.map((p) => p.displayName).sort()).toEqual([
      'P1',
      'P2',
    ]);
  });

  it('cascade deletes memberships when principal is deleted', async () => {
    const p = await createPrincipal(pool, {
      externalId: 'casc',
      kind: 'user',
      displayName: 'Cascade',
    });
    const s = await createScope(pool, { kind: 'team', name: 'cascade-t' });
    await addMembership(pool, p.id, s.id, 'writer');
    await pool.query('DELETE FROM principals WHERE id = $1', [p.id]);
    const m = await getMembership(pool, p.id, s.id);
    expect(m).toBeNull();
  });
});
