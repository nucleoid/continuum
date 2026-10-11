import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { reactivatePrincipal } from '../services/principal-admin.js';
import { issueApiKey } from '../services/api-keys.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';
import { makeTestPool, resetData } from './test-helpers.js';

const detached = '00000000-0000-4000-8000-000000000012';

describe('reserved detached coordination principal', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => pool?.end());
  async function admin() {
    const actor = await createPrincipal(pool, { externalId: randomUUID(), kind: 'user', displayName: 'Admin' });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, actor.id, org.id, 'admin');
    return actor;
  }

  it('rejects approved reactivation while keeping the detached sink disabled', async () => {
    const actor = await admin();
    await expect(reactivatePrincipal(pool, actor, detached)).rejects.toThrow(/system|detached|reserved/i);
    expect((await pool.query('SELECT disabled_at IS NOT NULL AS disabled FROM principals WHERE id=$1', [detached])).rows)
      .toEqual([{ disabled: true }]);
  });

  it('rejects manual scope authority for the detached sink at the database boundary', async () => {
    await admin();
    const scope = await createScope(pool, { kind: 'project', name: randomUUID() });
    await expect(addMembership(pool, detached, scope.id, 'writer')).rejects.toThrow(/system|detached|reserved/i);
    expect((await pool.query('SELECT count(*)::int AS count FROM scope_memberships WHERE principal_id=$1', [detached])).rows)
      .toEqual([{ count: 0 }]);
  });

  it('rejects direct API key material for the detached sink at the database boundary', async () => {
    await admin();
    await expect(pool.query(`INSERT INTO service_api_keys(id,principal_id,key_hash,prefix,last_four)
      VALUES(gen_random_uuid(),$1,sha256(convert_to(gen_random_uuid()::text,'UTF8')),'ctm_test','test')`, [detached]))
      .rejects.toThrow(/system|detached|reserved/i);
    expect((await pool.query('SELECT count(*)::int AS count FROM service_api_keys WHERE principal_id=$1', [detached])).rows)
      .toEqual([{ count: 0 }]);
  });

  it('blocks credential issuance after an approved attempt to reactivate the sink', async () => {
    const actor = await admin();
    await reactivatePrincipal(pool, actor, detached).catch((error: Error) => {
      expect(error.message).toMatch(/system|detached|reserved/i);
    });
    await expect(issueApiKey(pool, actor, detached)).rejects.toThrow();
  });

  it('blocks trusted sync binding after an approved attempt to reactivate the sink', async () => {
    const actor = await admin();
    await reactivatePrincipal(pool, actor, detached).catch((error: Error) => {
      expect(error.message).toMatch(/system|detached|reserved/i);
    });
    const role = 'sink_sync_' + randomUUID().replaceAll('-', '');
    await pool.query(`CREATE ROLE "${role}" LOGIN`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(client.query('SELECT continuum_register_trusted_database_identity($1::name,$2::uuid,FALSE,TRUE)', [role, detached]))
        .rejects.toThrow();
    } finally {
      await client.query('ROLLBACK'); client.release();
      await pool.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    }
  });

  it('keeps ordinary disabled service reactivation and key issuance supported', async () => {
    const actor = await admin();
    const ordinary = await createPrincipal(pool, { externalId: randomUUID(), kind: 'service', displayName: 'Ordinary' });
    await pool.query('UPDATE principals SET disabled_at=clock_timestamp() WHERE id=$1', [ordinary.id]);
    await expect(reactivatePrincipal(pool, actor, ordinary.id)).resolves.toBeUndefined();
    await expect(issueApiKey(pool, actor, ordinary.id)).resolves.toMatchObject({ id: expect.any(String) });
  });
});
