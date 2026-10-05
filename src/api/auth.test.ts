import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { authModeFromEnv, entraConfigFromEnv, principalFromClaims } from './auth.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';

describe('authentication configuration and Entra claims', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); });
  afterAll(async () => { await pool?.end(); });

  it('requires auth mode to be explicit', () => {
    expect(() => authModeFromEnv({})).toThrow(/explicitly set/);
    expect(authModeFromEnv({ CONTINUUM_AUTH_MODE: 'dev' })).toBe('dev');
    expect(() => entraConfigFromEnv({ CONTINUUM_ENTRA_TENANT: 'common', CONTINUUM_ENTRA_AUDIENCE: 'api' }))
      .toThrow(/tenant UUID/);
  });

  it('upserts immutable oid identity and rejects a kind change', async () => {
    const oid = '11111111-1111-4111-8111-111111111111';
    const first = await principalFromClaims(pool, { oid, name: 'Old Name' });
    const renamed = await principalFromClaims(pool, { oid, name: 'New Name' });
    expect(renamed?.principal.id).toBe(first?.principal.id);
    expect(renamed?.principal.displayName).toBe('New Name');
    await expect(principalFromClaims(pool, { oid, name: 'App', idtyp: 'app' }))
      .rejects.toThrow(/kind conflicts/);
  });

  it('fails closed without an Entra oid claim', async () => {
    expect(await principalFromClaims(pool, { sub: 'not-an-oid', name: 'Nope' })).toBeNull();
  });
});
