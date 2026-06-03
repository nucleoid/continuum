import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';
import {
  createScope,
  getOrCreateScope,
  getScope,
  getScopeByRef,
  listScopesByKind,
} from './scopes.js';

describe('scopes repository', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('creates a team scope and retrieves by id and ref', async () => {
    const s = await createScope(pool, { kind: 'team', name: 'payments' });
    const byId = await getScope(pool, s.id);
    const byRef = await getScopeByRef(pool, { kind: 'team', name: 'payments' });
    expect(byId?.id).toBe(s.id);
    expect(byRef?.id).toBe(s.id);
  });

  it('rejects org scope with a name', async () => {
    await expect(
      createScope(pool, { kind: 'org', name: 'global' }),
    ).rejects.toThrow();
  });

  it('rejects non-org scope without a name', async () => {
    await expect(createScope(pool, { kind: 'team', name: '' })).rejects.toThrow();
  });

  it('enforces uniqueness on (kind, name)', async () => {
    await createScope(pool, { kind: 'project', name: 'booking' });
    await expect(
      createScope(pool, { kind: 'project', name: 'booking' }),
    ).rejects.toThrow();
  });

  it('getOrCreateScope returns existing or new', async () => {
    const a = await getOrCreateScope(pool, { kind: 'role', name: 'security' });
    const b = await getOrCreateScope(pool, { kind: 'role', name: 'security' });
    expect(b.id).toBe(a.id);
  });

  it('listScopesByKind returns sorted by name', async () => {
    await createScope(pool, { kind: 'team', name: 'zeta' });
    await createScope(pool, { kind: 'team', name: 'alpha' });
    await createScope(pool, { kind: 'team', name: 'mu' });
    const teams = await listScopesByKind(pool, 'team');
    expect(teams.map((t) => t.name)).toEqual(['alpha', 'mu', 'zeta']);
  });
});
