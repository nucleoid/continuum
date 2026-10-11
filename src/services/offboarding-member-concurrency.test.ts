import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrincipal } from '../storage/principals.js';
import { addMembership } from '../storage/memberships.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { mapOwnedUserScope, offboardPrincipal } from './offboarding.js';

describe('offboarding member concurrency review', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => pool?.end());

  async function fixture(active: boolean) {
    const admin = await createPrincipal(pool, { externalId: `admin:${randomUUID()}`, kind: 'user', displayName: 'Admin' });
    const target = await createPrincipal(pool, { externalId: `target:${randomUUID()}`, kind: 'user', displayName: 'Target' });
    const peer = await createPrincipal(pool, { externalId: `peer:${randomUUID()}`, kind: 'user', displayName: 'Peer' });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const owned = await createScope(pool, { kind: 'user', name: `owned:${randomUUID()}` });
    await addMembership(pool, admin.id, org.id, 'admin');
    await addMembership(pool, target.id, owned.id, 'writer');
    await addMembership(pool, peer.id, owned.id, 'reader');
    if (!active) await pool.query(
      'UPDATE scope_memberships SET active=FALSE,deactivated_at=clock_timestamp() WHERE principal_id=$1 AND scope_id=$2',
      [peer.id, owned.id],
    );
    await mapOwnedUserScope(pool, admin, target.id, owned.id, true);
    return { admin, target, peer, owned };
  }

  it.each([true, false])('permits a member audited request while preserving lifecycle serialization, active=%s', async (active) => {
    const value = await fixture(active);
    let parked!: () => void;
    const parkedPromise = new Promise<void>((resolve) => { parked = resolve; });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    const gated = { connect: async () => {
      const client = await pool.connect();
      const originalQuery = client.query.bind(client);
      return { query: async (sql: string, values?: unknown[]) => {
        const result = await originalQuery(sql, values);
        if (/SELECT principal\.id[\s\S]*ORDER BY principal\.id[\s\S]*FOR (?:NO KEY )?UPDATE/.test(sql)) {
          parked(); await resumed;
        }
        return result;
      }, release: client.release.bind(client) } as unknown as pg.PoolClient;
    } } as unknown as pg.Pool;
    const erasure = offboardPrincipal(gated, value.admin, value.target.id, { confirmationScopeId: value.owned.id });
    // Observe failures without leaving an unhandled rejected operation while
    // the peer request runs. Always release the parked actual transaction.
    const settled = erasure.then((result) => ({ result }), (error: unknown) => ({ error }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const writer = await pool.connect();
    try {
      await Promise.race([parkedPromise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('offboarding did not reach its member lock')), 5_000);
      })]);
      await writer.query('BEGIN');
      await writer.query("SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='250ms'");
      // This UPDATE must remain serialized after a lock-mode repair.
      await expect(writer.query('UPDATE principals SET disabled_at=clock_timestamp() WHERE id=$1', [value.peer.id]))
        .rejects.toMatchObject({ code: '55P03' });
      await writer.query('ROLLBACK');
      await writer.query('BEGIN');
      await writer.query("SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='250ms'");
      // Real audit trigger and principal FK acquire key-share protection.
      await expect(writer.query(
        "INSERT INTO audit_log(principal_id,action,query,metadata) VALUES($1,'read','unrelated request','{}'::jsonb)",
        [value.peer.id],
      )).resolves.toMatchObject({ rowCount: 1 });
      await writer.query('ROLLBACK');
    } finally {
      if (timer) clearTimeout(timer);
      try { await writer.query('ROLLBACK'); } finally { writer.release(); resume(); }
      const outcome = await settled;
      if ('error' in outcome) throw outcome.error;
      expect(outcome.result.complete).toBe(true);
    }
  }, 20_000);

  it('rejects an unauthorized caller before installation-wide sync lock contention', async () => {
    const value = await fixture(false);
    const blocker = await pool.connect();
    try {
      await blocker.query('SELECT pg_advisory_lock(834641726154302119::bigint)');
      await expect(offboardPrincipal(pool, value.peer, value.target.id, { confirmationScopeId: value.owned.id }))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await pool.query('SELECT disabled_at FROM principals WHERE id=$1', [value.target.id])).rows[0].disabled_at)
        .toBeNull();
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(834641726154302119::bigint)');
      blocker.release();
    }
  });

  it('truthfully reports authorized sync contention without revoking access', async () => {
    const value = await fixture(false);
    const blocker = await pool.connect();
    try {
      await blocker.query('SELECT pg_advisory_lock(834641726154302119::bigint)');
      expect(await offboardPrincipal(pool, value.admin, value.target.id, { confirmationScopeId: value.owned.id }))
        .toMatchObject({ complete: false, reason: 'lock_busy', progressed: false });
      expect((await pool.query('SELECT disabled_at FROM principals WHERE id=$1', [value.target.id])).rows[0].disabled_at)
        .toBeNull();
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(834641726154302119::bigint)');
      blocker.release();
    }
  });
});
