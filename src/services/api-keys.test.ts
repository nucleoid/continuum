import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createAuthenticator } from '../api/auth.js';
import { issueApiKey, rotateApiKey } from './api-keys.js';

describe('service API keys', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); });
  afterAll(async () => { await pool?.end(); });

  it('issues only a hash, enforces source binding, and invalidates the old key on rotation', async () => {
    const admin = await createPrincipal(pool, { externalId: 'admin', kind: 'user', displayName: 'Admin' });
    const service = await createPrincipal(pool, { externalId: 'svc', kind: 'service', displayName: 'CI' });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    const issued = await issueApiKey(pool, admin, service.id, 'github-pr');
    const stored = await pool.query('SELECT key_hash, prefix, last_four FROM service_api_keys WHERE id = $1', [issued.id]);
    expect(stored.rows[0].key_hash.toString('utf8')).not.toContain(issued.key);
    const auth = createAuthenticator(pool, 'entra', {
      tenant: '22222222-2222-4222-8222-222222222222', audience: 'api://continuum',
    });
    expect(await auth.authenticate('ApiKey', issued.key)).toMatchObject({
      principal: { id: service.id }, allowedSource: 'github-pr', credential: 'api-key',
    });
    const rotated = await rotateApiKey(pool, admin, issued.id);
    expect(await auth.authenticate('ApiKey', issued.key)).toBeNull();
    expect((await auth.authenticate('ApiKey', rotated.key))?.principal.id).toBe(service.id);
    const audit = await pool.query("SELECT metadata FROM audit_log WHERE metadata->>'key_rotated_at' IS NOT NULL");
    expect(audit.rowCount).toBe(1);
  });
});
