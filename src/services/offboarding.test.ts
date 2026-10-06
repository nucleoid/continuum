import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createAuthenticator } from '../api/auth.js';
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { selectGapCandidates } from '../storage/gaps.js';
import { createPrincipal, upsertPrincipalByExternalId } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { mapOwnedUserScope, offboardPrincipal } from './offboarding.js';
import { disablePrincipal, reactivatePrincipal } from './principal-admin.js';

describe('offboarding and erasure', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); });
  afterAll(async () => { await pool?.end(); });

  async function fixture() {
    const admin = await createPrincipal(pool, {
      externalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'user', displayName: 'Admin',
    });
    const target = await createPrincipal(pool, {
      externalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'user', displayName: 'Private Name',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const personal = await createScope(pool, { kind: 'user', name: 'opaque-personal-scope' });
    const shared = await createScope(pool, { kind: 'team', name: 'shared' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    await addMembership(pool, target.id, personal.id, 'writer');
    await addMembership(pool, target.id, shared.id, 'writer');
    await mapOwnedUserScope(pool, admin, target.id, personal.id);
    const personalMemory = await createMemory(pool, {
      scopeId: personal.id, scopeKind: 'user', type: 'fact', title: 'Private title',
      body: 'Private body', metadata: { private: 'value' }, tags: ['private'],
      authorId: target.id, source: 'manual', sourceRef: 'private-ref',
    });
    const sharedMemory = await createMemory(pool, {
      scopeId: shared.id, scopeKind: 'team', type: 'fact', title: 'Shared title',
      body: 'Shared body', authorId: target.id, source: 'manual',
    });
    await storeMemoryEmbeddingVector(
      pool, personalMemory.id, Array(768).fill(0), { id: 'test', dim: 768 },
    );
    return { admin, target, personal, shared, personalMemory, sharedMemory };
  }

  it('previews, atomically redacts the owned scope, preserves shared memory, and retries safely', async () => {
    const value = await fixture();
    const preview = await offboardPrincipal(pool, value.admin, value.target.id, true);
    expect(preview).toMatchObject({
      memories: 1, embeddings: 1, memberships: 1, liveMemories: 1,
      auditQueries: 0, dryRun: true,
      evidence: {
        memberPrincipalIds: [value.target.id],
        authorPrincipalIds: [value.target.id],
        memberPrincipalIdsTruncated: false,
        authorPrincipalIdsTruncated: false,
      },
    });
    expect((await pool.query('SELECT disabled_at FROM principals WHERE id = $1', [value.target.id])).rows[0].disabled_at).toBeNull();

    const erased = await offboardPrincipal(pool, value.admin, value.target.id);
    expect(erased).toMatchObject({ memories: 1, embeddings: 1, alreadyOffboarded: false });
    expect((await pool.query(
      `SELECT title, body, metadata, tags, source, source_ref, state
         FROM memories WHERE id = $1`, [value.personalMemory.id],
    )).rows[0]).toEqual({
      title: '[erased]', body: '[erased]', metadata: {}, tags: [], source: 'erased',
      source_ref: null, state: 'archived',
    });
    expect((await pool.query('SELECT title, body, state FROM memories WHERE id = $1', [value.sharedMemory.id])).rows[0])
      .toEqual({ title: 'Shared title', body: 'Shared body', state: 'live' });
    expect((await pool.query('SELECT count(*)::int AS count FROM memory_embeddings')).rows[0].count).toBe(0);
    expect((await pool.query(
      'SELECT display_name, disabled_at IS NOT NULL AS disabled FROM principals WHERE id = $1',
      [value.target.id],
    )).rows[0]).toEqual({ display_name: erased.pseudonym, disabled: true });
    expect((await pool.query(
      'SELECT bool_and(NOT active) AS inactive FROM scope_memberships WHERE principal_id = $1',
      [value.target.id],
    )).rows[0].inactive).toBe(true);

    const retry = await offboardPrincipal(pool, value.admin, value.target.id);
    expect(retry.alreadyOffboarded).toBe(true);
    expect(retry).toMatchObject({
      liveMemories: 0, embeddings: 0, memberships: 0,
      originalOffboarding: { memories: 1, embeddings: 1, memberships: 1 },
    });
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE metadata->>'operation' = 'principal_offboarded'`,
    )).rows[0].count).toBe(1);
    expect((await pool.query(
      `SELECT memory_id FROM audit_log
        WHERE metadata->>'operation' = 'principal_memory_erased'`,
    )).rows).toEqual([{ memory_id: value.personalMemory.id }]);

    const authenticator = createAuthenticator(pool, 'dev');
    expect(await authenticator.authenticate('Bearer', value.target.externalId)).toBeNull();
    await expect(upsertPrincipalByExternalId(pool, {
      externalId: value.target.externalId, kind: 'user', displayName: 'Restored silently',
    })).rejects.toThrow('principal kind conflicts');
  });

  it('fully erases again after explicit reactivation, membership restoration, and new capture', async () => {
    const value = await fixture();
    await offboardPrincipal(pool, value.admin, value.target.id);
    await reactivatePrincipal(pool, value.admin, value.target.id);
    await addMembership(pool, value.target.id, value.personal.id, 'writer');
    const recaptured = await createMemory(pool, {
      scopeId: value.personal.id, scopeKind: 'user', type: 'context',
      title: 'Restored private title', body: 'Restored private body',
      authorId: value.target.id, source: 'terminal-summary',
    });
    await storeMemoryEmbeddingVector(pool, recaptured.id, Array(768).fill(1), { id: 'test', dim: 768 });
    const erasedAgain = await offboardPrincipal(pool, value.admin, value.target.id);
    expect(erasedAgain.alreadyOffboarded).toBe(false);
    expect((await pool.query(
      'SELECT title, body, state FROM memories WHERE id = $1', [recaptured.id],
    )).rows[0]).toEqual({ title: '[erased]', body: '[erased]', state: 'archived' });
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM memory_embeddings WHERE memory_id = $1', [recaptured.id],
    )).rows[0].count).toBe(0);
    expect((await pool.query(
      `SELECT disabled_at IS NOT NULL AS disabled, offboarded_at IS NOT NULL AS offboarded,
              reactivated_at FROM principals WHERE id = $1`, [value.target.id],
    )).rows[0]).toEqual({ disabled: true, offboarded: true, reactivated_at: null });
  });

  it('closes the whole owned scope, blocks later live writes, and repairs dirty retries', async () => {
    const value = await fixture();
    const delegate = await createPrincipal(pool, {
      externalId: 'delegate', kind: 'service', displayName: 'Delegate',
    });
    await addMembership(pool, delegate.id, value.personal.id, 'writer');
    await pool.query(
      'UPDATE principal_user_scopes SET allow_other_active_members = TRUE WHERE principal_id = $1',
      [value.target.id],
    );
    await offboardPrincipal(pool, value.admin, value.target.id);
    expect((await pool.query(
      'SELECT bool_and(NOT active) AS inactive FROM scope_memberships WHERE scope_id = $1',
      [value.personal.id],
    )).rows[0].inactive).toBe(true);
    await expect(createMemory(pool, {
      scopeId: value.personal.id, scopeKind: 'user', type: 'context', title: 'Late', body: 'Late',
      authorId: delegate.id, source: 'terminal-summary',
    })).rejects.toThrow(/offboarded principal/i);
    await expect(pool.query(
      `UPDATE memories SET state = 'live' WHERE id = $1`, [value.personalMemory.id],
    )).rejects.toThrow(/offboarded principal/i);

    await pool.query('ALTER TABLE memories DISABLE TRIGGER require_open_owned_user_scope');
    const dirty = await createMemory(pool, {
      scopeId: value.personal.id, scopeKind: 'user', type: 'context', title: 'Dirty', body: 'Dirty',
      authorId: delegate.id, source: 'manual',
    });
    await pool.query('ALTER TABLE memories ENABLE TRIGGER require_open_owned_user_scope');
    await pool.query('ALTER TABLE memory_embeddings DISABLE TRIGGER require_embeddable_memory');
    await pool.query(
      `INSERT INTO memory_embeddings (memory_id, provider, dim, embedding)
       VALUES ($1, 'test', 768, $2::vector)`,
      [dirty.id, `[${Array(768).fill(0).join(',')}]`],
    );
    await pool.query('ALTER TABLE memory_embeddings ENABLE TRIGGER require_embeddable_memory');
    const repaired = await offboardPrincipal(pool, value.admin, value.target.id);
    expect(repaired).toMatchObject({ alreadyOffboarded: false, liveMemories: 1, embeddings: 1 });
    expect((await pool.query('SELECT title, state FROM memories WHERE id = $1', [dirty.id])).rows[0])
      .toEqual({ title: '[erased]', state: 'archived' });
    expect((await pool.query('SELECT 1 FROM memory_embeddings WHERE memory_id = $1', [dirty.id])).rowCount)
      .toBe(0);
  });

  it('tombstones target audit queries atomically so gaps cannot expose them', async () => {
    const value = await fixture();
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, query, metadata)
       VALUES ($1, 'read', 'private search text', '{"hits":0}')`,
      [value.target.id],
    );
    const preview = await offboardPrincipal(pool, value.admin, value.target.id, true);
    expect(preview.auditQueries).toBe(1);
    await offboardPrincipal(pool, value.admin, value.target.id);
    expect((await pool.query(
      `SELECT query FROM audit_log WHERE principal_id = $1 AND action = 'read'`, [value.target.id],
    )).rows).toEqual([{ query: null }]);
    const gaps = await selectGapCandidates(pool, {
      since: new Date(Date.now() - 86_400_000), scanLimit: 50,
      candidateLimit: 10, maxQueryChars: 2_000,
    });
    expect(gaps.candidates).toEqual([]);
  });

  it('requires membership history and explicit override for another active scope member', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'mapping-admin', kind: 'user', displayName: 'Admin',
    });
    const target = await createPrincipal(pool, {
      externalId: 'mapping-target', kind: 'user', displayName: 'Target',
    });
    const other = await createPrincipal(pool, {
      externalId: 'mapping-other', kind: 'user', displayName: 'Other',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const personal = await createScope(pool, { kind: 'user', name: 'mapping-scope' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    await expect(mapOwnedUserScope(pool, admin, target.id, personal.id))
      .rejects.toThrow(/membership history/i);
    await addMembership(pool, target.id, personal.id, 'writer');
    await addMembership(pool, other.id, personal.id, 'writer');
    await expect(mapOwnedUserScope(pool, admin, target.id, personal.id))
      .rejects.toThrow(/other active members/i);
    await expect(mapOwnedUserScope(pool, admin, target.id, personal.id, true))
      .resolves.toMatchObject({ created: true, allowOtherActiveMembers: true });
  });

  it('offboards an already disabled principal and denies membership reprovisioning', async () => {
    const value = await fixture();
    await disablePrincipal(pool, value.admin, value.target.id);
    await offboardPrincipal(pool, value.admin, value.target.id);
    await expect(addMembership(pool, value.target.id, value.shared.id, 'writer'))
      .rejects.toThrow(/active membership requires an active principal/i);
  });

  it('rolls back redaction, disablement, and embedding deletion when audit fails', async () => {
    const value = await fixture();
    await pool.query(`
      CREATE FUNCTION issue4_reject_offboarding_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.metadata->>'operation' = 'principal_memory_erased' THEN
          RAISE EXCEPTION 'forced offboarding audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER issue4_reject_offboarding_audit
      BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION issue4_reject_offboarding_audit();
    `);
    try {
      await expect(offboardPrincipal(pool, value.admin, value.target.id))
        .rejects.toThrow(/forced offboarding audit failure/i);
    } finally {
      await pool.query(`
        DROP TRIGGER issue4_reject_offboarding_audit ON audit_log;
        DROP FUNCTION issue4_reject_offboarding_audit();
      `);
    }
    expect((await pool.query(
      'SELECT title, state FROM memories WHERE id = $1', [value.personalMemory.id],
    )).rows[0]).toEqual({ title: 'Private title', state: 'live' });
    expect((await pool.query(
      'SELECT disabled_at, offboarded_at FROM principals WHERE id = $1', [value.target.id],
    )).rows[0]).toEqual({ disabled_at: null, offboarded_at: null });
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM memory_embeddings WHERE memory_id = $1',
      [value.personalMemory.id],
    )).rows[0].count).toBe(1);
  });

  it('serializes with membership sync and refuses removal of the final manual org admin', async () => {
    const value = await fixture();
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(`SELECT pg_advisory_xact_lock(834641726154302119::bigint)`);
    let settled = false;
    const pending = offboardPrincipal(pool, value.admin, value.target.id).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    await blocker.query('COMMIT');
    blocker.release();
    await pending;

    await resetData(pool);
    const onlyAdmin = await createPrincipal(pool, {
      externalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', kind: 'user', displayName: 'Only admin',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const personal = await createScope(pool, { kind: 'user', name: 'only-admin-scope' });
    await addMembership(pool, onlyAdmin.id, org!.id, 'admin');
    await addMembership(pool, onlyAdmin.id, personal.id, 'writer');
    await mapOwnedUserScope(pool, onlyAdmin, onlyAdmin.id, personal.id);
    await expect(offboardPrincipal(pool, onlyAdmin, onlyAdmin.id)).rejects.toThrow(/last effective manual org administrator/i);
    expect((await pool.query('SELECT disabled_at FROM principals WHERE id = $1', [onlyAdmin.id])).rows[0].disabled_at).toBeNull();
  });

  it('orders embedding writes with archive and removes either race winner', async () => {
    const value = await fixture();
    const archiver = await pool.connect();
    await archiver.query('BEGIN');
    await archiver.query(`UPDATE memories SET state = 'archived' WHERE id = $1`, [value.personalMemory.id]);
    const lateEmbedding = storeMemoryEmbeddingVector(
      pool, value.personalMemory.id, Array(768).fill(1), { id: 'test', dim: 768 },
    );
    await archiver.query('COMMIT');
    archiver.release();
    await expect(lateEmbedding).rejects.toThrow(/embedding requires a live memory/i);
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM memory_embeddings WHERE memory_id = $1',
      [value.personalMemory.id],
    )).rows[0].count).toBe(0);
  });
});
