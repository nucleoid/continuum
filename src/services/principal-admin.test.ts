import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createAuthenticator } from '../api/auth.js';
import { addMembership } from '../storage/memberships.js';
import { createPrincipal } from '../storage/principals.js';
import { getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { issueApiKey } from './api-keys.js';
import {
  disablePrincipal, provisionServicePrincipal, reactivatePrincipal,
} from './principal-admin.js';

describe('principal administration', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); });
  afterAll(async () => { await pool?.end(); });

  it('requires audited explicit service provisioning and reactivation without restoring access', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'break-glass-admin', kind: 'user', displayName: 'Break glass',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    const externalId = '11111111-1111-4111-8111-111111111111';
    const service = await provisionServicePrincipal(pool, admin, externalId, 'Deployment service');
    await expect(provisionServicePrincipal(pool, admin, externalId, 'Duplicate'))
      .rejects.toThrow('already exists');
    await addMembership(pool, service.id, org!.id, 'reader');
    const issued = await issueApiKey(pool, admin, service.id, 'deploy-event');
    const authenticator = createAuthenticator(pool, 'entra', {
      tenant: '22222222-2222-4222-8222-222222222222',
      audience: 'api://continuum', userScope: 'Continuum.User',
      serviceAppRole: 'Continuum.Service', allowedClientIds: [],
    });
    expect(await authenticator.authenticate('ApiKey', issued.key)).not.toBeNull();

    await disablePrincipal(pool, admin, service.id);
    expect(await authenticator.authenticate('ApiKey', issued.key)).toBeNull();
    expect((await pool.query(
      'SELECT active FROM scope_memberships WHERE principal_id = $1', [service.id],
    )).rows).toEqual([{ active: false }]);
    expect((await pool.query(
      'SELECT revoked_at IS NOT NULL AS revoked FROM service_api_keys WHERE id = $1', [issued.id],
    )).rows).toEqual([{ revoked: true }]);

    await reactivatePrincipal(pool, admin, service.id);
    expect(await authenticator.authenticate('ApiKey', issued.key)).toBeNull();
    expect((await pool.query(
      'SELECT active FROM scope_memberships WHERE principal_id = $1', [service.id],
    )).rows).toEqual([{ active: false }]);
    const replacement = await issueApiKey(pool, admin, service.id, 'deploy-event');
    expect(await authenticator.authenticate('ApiKey', replacement.key)).not.toBeNull();

    const operations = (await pool.query(
      `SELECT metadata->>'operation' AS operation FROM audit_log
        WHERE metadata->>'operation' IN
          ('service_principal_provisioned', 'principal_disabled', 'principal_reactivated')
        ORDER BY id`,
    )).rows.map((row) => row.operation);
    expect(operations).toEqual([
      'service_principal_provisioned', 'principal_disabled', 'principal_reactivated',
    ]);
  });

  it('marks reactivation of an offboarded principal and reopens its lifecycle state', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'reactivation-admin', kind: 'user', displayName: 'Admin',
    });
    const target = await createPrincipal(pool, {
      externalId: 'reactivation-target', kind: 'user', displayName: 'Target',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    await pool.query(
      'UPDATE principals SET disabled_at = now(), offboarded_at = now() WHERE id = $1', [target.id],
    );
    await reactivatePrincipal(pool, admin, target.id);
    expect((await pool.query(
      'SELECT disabled_at, offboarded_at, reactivated_at IS NOT NULL AS reactivated FROM principals WHERE id = $1',
      [target.id],
    )).rows[0]).toEqual({ disabled_at: null, offboarded_at: null, reactivated: true });
    expect((await pool.query(
      `SELECT metadata->>'previously_offboarded' AS previously_offboarded
         FROM audit_log WHERE metadata->>'operation' = 'principal_reactivated'`,
    )).rows).toEqual([{ previously_offboarded: 'true' }]);
  });
});
