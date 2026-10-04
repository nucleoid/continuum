import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';
import {
  createScope,
  ensureScopeRow,
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

  it('ensureScopeRow reports whether it created the scope', async () => {
    const a = await ensureScopeRow(pool, { kind: 'role', name: 'compliance' });
    const b = await ensureScopeRow(pool, { kind: 'role', name: 'compliance' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.scope.id).toBe(a.scope.id);
  });

  it('getOrCreateScope handles concurrent creation without duplicate rows', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        ensureScopeRow(pool, { kind: 'project', name: 'concurrent' })),
    );

    expect(new Set(results.map((result) => result.scope.id))).toHaveLength(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS count
         FROM scopes
        WHERE kind = 'project' AND name = 'concurrent'`,
    );
    expect(rows[0].count).toBe(1);
  });

  it('listScopesByKind returns sorted by name', async () => {
    await createScope(pool, { kind: 'team', name: 'zeta' });
    await createScope(pool, { kind: 'team', name: 'alpha' });
    await createScope(pool, { kind: 'team', name: 'mu' });
    const teams = await listScopesByKind(pool, 'team');
    expect(teams.map((t) => t.name)).toEqual(['alpha', 'mu', 'zeta']);
  });
});
