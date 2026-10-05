import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';
import {
  createPrincipal,
  getPrincipal,
  getPrincipalByExternalId,
  upsertPrincipalByExternalId,
} from './principals.js';

describe('principals repository', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('creates and retrieves a principal', async () => {
    const created = await createPrincipal(pool, {
      externalId: 'entra:user:1',
      kind: 'user',
      displayName: 'Mitch',
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    const fetched = await getPrincipal(pool, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.displayName).toBe('Mitch');
  });

  it('looks up by external id', async () => {
    await createPrincipal(pool, {
      externalId: 'entra:user:2',
      kind: 'user',
      displayName: 'Cass',
    });
    const fetched = await getPrincipalByExternalId(pool, 'entra:user:2');
    expect(fetched?.displayName).toBe('Cass');
  });

  it('canonicalizes UUID-shaped identities on writes and lookups', async () => {
    const lower = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const principal = await createPrincipal(pool, {
      externalId: lower.toUpperCase(), kind: 'user', displayName: 'Canonical',
    });
    expect(principal.externalId).toBe(lower);
    expect((await getPrincipalByExternalId(pool, lower.toUpperCase()))?.id).toBe(principal.id);
    await expect(pool.query(
      `INSERT INTO principals (id, external_id, kind, display_name)
       VALUES (gen_random_uuid(), $1, 'user', 'Invalid')`,
      ['BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB'],
    )).rejects.toThrow();
  });

  it('upsert returns existing principal unchanged when display name matches', async () => {
    const a = await upsertPrincipalByExternalId(pool, {
      externalId: 'svc:github-pr',
      kind: 'service',
      displayName: 'github-pr capture',
    });
    const before = (await pool.query(
      'SELECT xmin::text AS xmin FROM principals WHERE id = $1', [a.id],
    )).rows[0].xmin;
    const b = await upsertPrincipalByExternalId(pool, {
      externalId: 'svc:github-pr',
      kind: 'service',
      displayName: 'github-pr capture',
    });
    expect(b.id).toBe(a.id);
    expect((await pool.query(
      'SELECT xmin::text AS xmin FROM principals WHERE id = $1', [a.id],
    )).rows[0].xmin).toBe(before);
  });

  it('upsert updates display name', async () => {
    const a = await upsertPrincipalByExternalId(pool, {
      externalId: 'entra:user:3',
      kind: 'user',
      displayName: 'Old Name',
    });
    const b = await upsertPrincipalByExternalId(pool, {
      externalId: 'entra:user:3',
      kind: 'user',
      displayName: 'New Name',
    });
    expect(b.id).toBe(a.id);
    expect(b.displayName).toBe('New Name');
  });

  it('rejects duplicate external id via createPrincipal', async () => {
    await createPrincipal(pool, {
      externalId: 'entra:user:4',
      kind: 'user',
      displayName: 'A',
    });
    await expect(
      createPrincipal(pool, {
        externalId: 'entra:user:4',
        kind: 'user',
        displayName: 'B',
      }),
    ).rejects.toThrow();
  });
});
