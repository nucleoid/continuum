import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createAuthenticator } from '../api/auth.js';
import { issueApiKey, revokeApiKey, rotateApiKey } from './api-keys.js';

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
      userScope: 'Continuum.User', serviceAppRole: 'Continuum.Service',
    });
    expect(await auth.authenticate('ApiKey', issued.key)).toMatchObject({
      principal: { id: service.id }, allowedSource: 'github-pr', credential: 'api-key',
    });
    await pool.query('UPDATE principals SET disabled_at = now() WHERE id = $1', [service.id]);
    expect(await auth.authenticate('ApiKey', issued.key)).toBeNull();
    await expect(rotateApiKey(pool, admin, issued.id)).rejects.toThrow('API key not found');
    await pool.query('UPDATE principals SET disabled_at = NULL WHERE id = $1', [service.id]);
    expect(await auth.authenticate('ApiKey', issued.key)).toBeNull();
    const replacement = await issueApiKey(pool, admin, service.id, 'github-pr');
    expect((await auth.authenticate('ApiKey', replacement.key))?.principal.id).toBe(service.id);
    const rotated = await rotateApiKey(pool, admin, replacement.id);
    expect(await auth.authenticate('ApiKey', issued.key)).toBeNull();
    expect((await auth.authenticate('ApiKey', rotated.key))?.principal.id).toBe(service.id);
    await revokeApiKey(pool, admin, rotated.id);
    expect(await auth.authenticate('ApiKey', rotated.key)).toBeNull();
    const audit = await pool.query("SELECT metadata FROM audit_log WHERE metadata->>'key_rotated_at' IS NOT NULL");
    expect(audit.rowCount).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_log WHERE metadata->>'operation' = 'api_key_revoked'")).rows[0].count).toBe(1);
  });
});
