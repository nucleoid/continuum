import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import {
  authModeFromEnv, createAuthenticator, entraConfigFromEnv, principalFromClaims, warnOnDevAuthMode,
} from './auth.js';
import { createApp } from './server.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { addMembership } from '../storage/memberships.js';
import { getScopeByRef } from '../storage/scopes.js';

describe('authentication configuration and Entra claims', () => {
  let pool: pg.Pool;
  const contract = {
    tenant: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userScope: 'Continuum.User', serviceAppRole: 'Continuum.Service',
    allowedClientIds: ['44444444-4444-4444-8444-444444444444'],
  };
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); });
  afterAll(async () => { await pool?.end(); });

  it('requires auth mode and the complete token contract to be explicit', () => {
    expect(() => authModeFromEnv({})).toThrow(/explicitly set/);
    expect(authModeFromEnv({ CONTINUUM_AUTH_MODE: 'dev' })).toBe('dev');
    expect(() => entraConfigFromEnv({
      CONTINUUM_ENTRA_TENANT: contract.tenant, CONTINUUM_ENTRA_AUDIENCE: 'api',
    })).toThrow(/user scope/);
    expect(entraConfigFromEnv({
      CONTINUUM_ENTRA_TENANT: contract.tenant.toUpperCase(),
      CONTINUUM_ENTRA_AUDIENCE: 'api://continuum',
      CONTINUUM_ENTRA_USER_SCOPE: contract.userScope,
      CONTINUUM_ENTRA_SERVICE_APP_ROLE: contract.serviceAppRole,
      CONTINUUM_ENTRA_ALLOWED_CLIENT_IDS: contract.allowedClientIds[0],
    })).toMatchObject(contract);
  });

  it('emits a loud warning only for development authentication', () => {
    const write = vi.fn();
    warnOnDevAuthMode('dev', write);
    warnOnDevAuthMode('entra', write);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/WARNING.*untrusted network/));
  });

  it('admits tenant members and guests only through an allow-listed client with active membership', async () => {
    const oid = '11111111-1111-4111-8111-111111111111';
    const valid = { oid, name: 'User', tid: contract.tenant, ver: '2.0', idtyp: 'user',
      azp: contract.allowedClientIds[0],
      scp: `openid ${contract.userScope}`, acct: 0, exp: 2_000_000_000 };
    expect(await principalFromClaims(pool, valid, contract)).toBeNull();
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM principals WHERE external_id = $1', [oid],
    )).rows[0].count).toBe(0);
    const principal = (await pool.query(
      `INSERT INTO principals (id, external_id, kind, display_name)
       VALUES (gen_random_uuid(), $1, 'user', $1) RETURNING id`, [oid],
    )).rows[0];
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, principal.id, org!.id, 'reader');
    expect((await principalFromClaims(pool, valid, contract))?.principal.kind).toBe('user');
    expect((await principalFromClaims(pool, { ...valid, acct: 1 }, contract))?.principal.kind)
      .toBe('user');
    await pool.query('UPDATE scope_memberships SET active = FALSE WHERE principal_id = $1', [principal.id]);
    expect(await principalFromClaims(pool, { ...valid, acct: 1 }, contract)).toBeNull();
    await pool.query('UPDATE scope_memberships SET active = TRUE WHERE principal_id = $1', [principal.id]);
    await pool.query('UPDATE scope_memberships SET active = FALSE WHERE principal_id = $1', [principal.id]);
    expect(await principalFromClaims(pool, { ...valid, acct: 1 }, contract)).toBeNull();
    await pool.query('UPDATE scope_memberships SET active = TRUE WHERE principal_id = $1', [principal.id]);
    for (const claims of [
      { ...valid, tid: '33333333-3333-4333-8333-333333333333' },
      { ...valid, scp: 'openid profile' },
      { ...valid, azp: '55555555-5555-4555-8555-555555555555' },
      { ...valid, idtyp: undefined },
      { ...valid, acct: 2 },
    ]) expect(await principalFromClaims(pool, claims, contract)).toBeNull();
  });

  it('normalizes Entra object IDs before principal lookup', async () => {
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const lower = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const existing = (await pool.query(
      `INSERT INTO principals (id, external_id, kind, display_name)
       VALUES (gen_random_uuid(), $1, 'user', 'Existing') RETURNING id`, [lower],
    )).rows[0];
    await addMembership(pool, existing.id, org!.id, 'reader');
    const result = await principalFromClaims(pool, {
      oid: lower.toUpperCase(), tid: contract.tenant, ver: '2.0', idtyp: 'user', acct: 0,
      azp: contract.allowedClientIds[0], scp: contract.userScope,
    }, contract);
    expect(result?.principal.id).toBe(existing.id);
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM principals WHERE lower(external_id) = $1', [lower],
    )).rows[0].count).toBe(1);
  });

  it('accepts only service access tokens assigned the configured app role', async () => {
    const oid = '11111111-1111-4111-8111-111111111111';
    const valid = { oid, tid: contract.tenant, ver: '2.0', idtyp: 'app',
      azp: '44444444-4444-4444-8444-444444444444', roles: [contract.serviceAppRole] };
    expect((await principalFromClaims(pool, valid, contract))?.principal.kind).toBe('service');
    expect(await principalFromClaims(pool, { ...valid, roles: ['Other.Role'] }, contract)).toBeNull();
    expect(await principalFromClaims(pool, { ...valid, azp: 'unauthorized' }, contract)).toBeNull();
    expect(await principalFromClaims(pool, {
      ...valid, azp: '55555555-5555-4555-8555-555555555555',
    }, contract)).toBeNull();
  });

  it('upserts immutable oid identity and maps a kind conflict to invalid credentials', async () => {
    const oid = '11111111-1111-4111-8111-111111111111';
    const userClaims = { oid, tid: contract.tenant, ver: '2.0', idtyp: 'user',
      azp: contract.allowedClientIds[0], scp: contract.userScope };
    const first = await principalFromClaims(pool, { ...userClaims, name: 'Old Name' }, contract);
    const renamed = await principalFromClaims(pool, { ...userClaims, name: 'New Name' }, contract);
    expect(renamed?.principal.id).toBe(first?.principal.id);
    await expect(principalFromClaims(pool, {
      oid, name: 'App', tid: contract.tenant, ver: '2.0', idtyp: 'app',
      azp: '44444444-4444-4444-8444-444444444444', roles: [contract.serviceAppRole],
    }, contract))
      .resolves.toBeNull();
  });

  it('bounds discovery fetches, evicts rejected metadata, and maps all credential failures to 401', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('temporary discovery failure'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        issuer: `https://login.microsoftonline.com/${contract.tenant}/v2.0`,
        jwks_uri: `https://login.microsoftonline.com/${contract.tenant}/discovery/v2.0/keys`,
      }), { status: 200 }));
    const authenticator = createAuthenticator(pool, 'entra', {
      ...contract, audience: 'api://continuum', fetcher,
    });
    expect(await authenticator.authenticate('Bearer', 'malformed')).toBeNull();
    expect(await authenticator.authenticate('Bearer', 'still-malformed')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
    const response = await request(createApp(pool, { authenticator }))
      .get('/api/v0/agents-md').set('Authorization', 'Bearer attacker-input');
    expect(response.status).toBe(401);
  });

  it('fails closed without an Entra oid claim', async () => {
    expect(await principalFromClaims(pool, { sub: 'not-an-oid', name: 'Nope' }, contract)).toBeNull();
  });
});
