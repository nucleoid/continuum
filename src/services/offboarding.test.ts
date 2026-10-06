import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createAuthenticator } from '../api/auth.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { selectGapCandidates } from '../storage/gaps.js';
import { createPrincipal, upsertPrincipalByExternalId } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import {
  listIncompleteOffboardingRuns, mapOwnedUserScope, MAX_OFFBOARD_AFFECTED_ROWS, MAX_OFFBOARD_MEMORIES,
  offboardPrincipal as serviceOffboardPrincipal, type OffboardingOptions,
} from './offboarding.js';
import { provisionEntraGroupBinding } from './membership-sync.js';
import { disablePrincipal, reactivatePrincipal } from './principal-admin.js';
import { recallForPrincipal } from './recall.js';

async function offboardPrincipal(
  pool: pg.Pool, actor: Parameters<typeof serviceOffboardPrincipal>[1], principalId: string,
  options: boolean | OffboardingOptions = false,
) {
  if (options === true || (typeof options === 'object' && options.dryRun)) {
    return serviceOffboardPrincipal(pool, actor, principalId, options);
  }
  if (typeof options === 'object' && options.confirmationScopeId) {
    return serviceOffboardPrincipal(pool, actor, principalId, options);
  }
  const mapping = await pool.query(
    'SELECT scope_id::text AS scope_id FROM principal_user_scopes WHERE principal_id = $1',
    [principalId],
  );
  return serviceOffboardPrincipal(pool, actor, principalId, {
    ...(typeof options === 'object' ? options : {}),
    confirmationScopeId: mapping.rows[0]?.scope_id,
  });
}

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
        memberPrincipalIds: [],
        authorPrincipalIds: [],
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
    await mapOwnedUserScope(pool, value.admin, value.target.id, value.personal.id, true);
    await offboardPrincipal(pool, value.admin, value.target.id);
    expect((await pool.query(
      'SELECT bool_and(NOT active) AS inactive FROM scope_memberships WHERE scope_id = $1',
      [value.personal.id],
    )).rows[0].inactive).toBe(true);
    await expect(createMemory(pool, {
      scopeId: value.personal.id, scopeKind: 'user', type: 'context', title: 'Late', body: 'Late',
      authorId: delegate.id, source: 'terminal-summary',
    })).rejects.toThrow(/offboarded (principal|owned scope)/i);
    await expect(pool.query(
      `UPDATE memories SET state = 'live' WHERE id = $1`, [value.personalMemory.id],
    )).rejects.toThrow(/offboarded (principal|owned scope)/i);

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

  it('retains the original query count in retry receipts', async () => {
    const value = await fixture();
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, query, metadata) VALUES
       ($1, 'read', 'first private query', '{}'),
       ($1, 'read', 'second private query', '{}')`,
      [value.target.id],
    );
    const erased = await offboardPrincipal(pool, value.admin, value.target.id);
    expect(erased.auditQueries).toBe(2);
    const retry = await offboardPrincipal(pool, value.admin, value.target.id);
    expect(retry.originalOffboarding?.auditQueries).toBe(2);
    expect((await pool.query(
      `SELECT audit_queries FROM principal_offboarding_events
        WHERE principal_id = $1 AND NOT repair`, [value.target.id],
    )).rows).toEqual([{ audit_queries: 2 }]);
  });

  it('uses the online audit indexes for each metadata selection branch', async () => {
    const value = await fixture();
    const requestId = 'plan-request';
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, query, metadata) VALUES
       ($1, 'read', $2, 'scope', '{}'),
       ($1, 'read', NULL, 'scopes', $3::jsonb),
       ($1, 'read', NULL, 'request', $4::jsonb)`,
      [value.admin.id, value.personal.id,
        JSON.stringify({ scope_ids: [value.personal.id] }),
        JSON.stringify({ request_id: requestId })],
    );
    const client = await pool.connect();
    try {
      await client.query('SET enable_seqscan = off');
      const explain = async (sql: string, parameters: unknown[]) => JSON.stringify(
        (await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, parameters)).rows[0],
      );
      expect(await explain(
        `SELECT id FROM audit_log WHERE scope_id = $1 AND scope_id IS NOT NULL`,
        [value.personal.id],
      )).toContain('audit_log_scope_idx');
      expect(await explain(
        `SELECT id FROM audit_log WHERE metadata ? 'scope_ids'
          AND metadata->'scope_ids' @> jsonb_build_array($1::text)`,
        [value.personal.id],
      )).toContain('audit_log_scope_ids_gin_idx');
      expect(await explain(
        `SELECT id FROM audit_log WHERE metadata ? 'request_id'
          AND metadata->>'request_id' = $1`,
        [requestId],
      )).toContain('audit_log_request_id_idx');
      expect(await explain(
        `SELECT pus.principal_id
           FROM jsonb_array_elements_text($1::jsonb) carried(value)
           JOIN principal_user_scopes pus ON pus.scope_id = carried.value::uuid`,
        [JSON.stringify([value.personal.id])],
      )).toContain('principal_user_scopes_scope_id_key');
    } finally {
      client.release();
    }
  });

  it('scrubs free-text audit metadata and scope names and reports dirty retry counts', async () => {
    const value = await fixture();
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, memory_id, scope_id, query, metadata)
       VALUES ($1, 'verify', $2, $3, 'private query', $4::jsonb)`,
      [value.target.id, value.personalMemory.id, value.personal.id, JSON.stringify({
        note: 'private verification note', scope: 'opaque-personal-scope',
        nested: { title: 'Private title' },
      })],
    );
    const preview = await offboardPrincipal(pool, value.admin, value.target.id, true);
    expect(preview).toMatchObject({ dirtyAuditRows: 1, dirtyMemories: 1 });
    const erased = await offboardPrincipal(pool, value.admin, value.target.id);
    expect((await pool.query('SELECT name FROM scopes WHERE id = $1', [value.personal.id])).rows[0].name)
      .toBe(erased.scopePseudonym);
    const audit = await pool.query(
      `SELECT query, metadata FROM audit_log
        WHERE principal_id = $1 OR scope_id = $2 OR memory_id = $3 ORDER BY id`,
      [value.target.id, value.personal.id, value.personalMemory.id],
    );
    expect(JSON.stringify(audit.rows)).not.toContain('private');
    expect(JSON.stringify(audit.rows)).not.toContain('opaque-personal-scope');
    expect(audit.rows.every((row) => row.query === null)).toBe(true);
    await pool.query(
      `UPDATE audit_log SET query = 'retry secret', metadata = '{"note":"retry note"}'
        WHERE principal_id = $1`, [value.target.id],
    );
    const retry = await offboardPrincipal(pool, value.admin, value.target.id);
    expect(retry).toMatchObject({ alreadyOffboarded: false, dirtyAuditRows: 1 });
    expect(JSON.stringify((await pool.query(
      'SELECT query, metadata FROM audit_log WHERE principal_id = $1', [value.target.id],
    )).rows)).not.toContain('retry');
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

  it('requires writer ownership proof and override for any other history or authorship', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'ownership-admin', kind: 'user', displayName: 'Admin',
    });
    const target = await createPrincipal(pool, {
      externalId: 'ownership-target', kind: 'user', displayName: 'Target',
    });
    const other = await createPrincipal(pool, {
      externalId: 'ownership-other', kind: 'user', displayName: 'Other',
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    const personal = await createScope(pool, { kind: 'user', name: 'ownership-scope' });
    await addMembership(pool, admin.id, org!.id, 'admin');
    await addMembership(pool, target.id, personal.id, 'reader');
    await expect(mapOwnedUserScope(pool, admin, target.id, personal.id))
      .rejects.toThrow(/writer or admin membership history/i);
    await addMembership(pool, target.id, personal.id, 'writer');
    await addMembership(pool, other.id, personal.id, 'reader');
    await pool.query(
      `UPDATE scope_memberships SET active = FALSE, deactivated_at = now()
        WHERE principal_id = $1 AND scope_id = $2`, [other.id, personal.id],
    );
    await createMemory(pool, {
      scopeId: personal.id, scopeKind: 'user', type: 'fact', title: 'Other authored',
      body: 'Other authored body', authorId: other.id, source: 'manual',
    });
    await expect(mapOwnedUserScope(pool, admin, target.id, personal.id))
      .rejects.toThrow(/other principal history or authorship/i);
    await mapOwnedUserScope(pool, admin, target.id, personal.id, true);
    const evidence = (await pool.query(
      `SELECT metadata FROM audit_log
        WHERE metadata->>'operation' = 'principal_user_scope_mapped'`,
    )).rows[0].metadata;
    expect(evidence).toMatchObject({
      other_member_principal_ids: [other.id],
      other_author_principal_ids: [other.id],
      other_member_principal_ids_truncated: false,
      other_author_principal_ids_truncated: false,
    });
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

  it('fails an in-flight recall closed after offboarding wins the principal lock', async () => {
    const value = await fixture();
    let releaseEmbedding!: () => void;
    let embeddingStarted!: () => void;
    const started = new Promise<void>((resolve) => { embeddingStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseEmbedding = resolve; });
    const provider: EmbeddingProvider = {
      id: 'blocking-test', dim: 768,
      async embed() {
        embeddingStarted();
        await release;
        return [Array(768).fill(0)];
      },
    };
    const recall = recallForPrincipal(pool, provider, value.target, {
      query: 'Private body', limit: 10,
    });
    await started;
    await offboardPrincipal(pool, value.admin, value.target.id);
    releaseEmbedding();
    await expect(recall).rejects.toMatchObject({ code: 'INTERNAL' });
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE principal_id = $1 AND query IS NOT NULL`, [value.target.id],
    )).rows[0].count).toBe(0);
  });

  it('leaves an exact redacted clean state and durable evidence outside audit retention', async () => {
    const value = await fixture();
    await pool.query(
      `UPDATE memories SET expires_at = now(), last_verified = now() WHERE id = $1`,
      [value.personalMemory.id],
    );
    const result = await offboardPrincipal(pool, value.admin, value.target.id);
    expect((await pool.query(
      `SELECT type, title, body, metadata, tags, source, source_ref, state,
              supersedes_id, promoted_to_id, expires_at, last_verified
         FROM memories WHERE id = $1`, [value.personalMemory.id],
    )).rows[0]).toEqual({
      type: 'context', title: '[erased]', body: '[erased]', metadata: {}, tags: [],
      source: 'erased', source_ref: null, state: 'archived', supersedes_id: null,
      promoted_to_id: null, expires_at: null, last_verified: null,
    });
    expect((await pool.query(
      `SELECT p.display_name, s.name
         FROM principals p JOIN principal_user_scopes pus ON pus.principal_id = p.id
         JOIN scopes s ON s.id = pus.scope_id WHERE p.id = $1`, [value.target.id],
    )).rows[0]).toEqual({ display_name: result.pseudonym, name: result.scopePseudonym });
    const durable = (await pool.query(
      `SELECT memories, embeddings, memberships, audit_rows, evidence
         FROM principal_offboarding_events WHERE principal_id = $1 ORDER BY id`,
      [value.target.id],
    )).rows[0];
    expect(durable).toMatchObject({ memories: 1, embeddings: 1, memberships: 1 });
    expect(durable.evidence).toMatchObject({ memberPrincipalIds: [] });
    await pool.query('DELETE FROM audit_log');
    const retry = await offboardPrincipal(pool, value.admin, value.target.id);
    expect(retry.alreadyOffboarded).toBe(true);
    expect(retry.originalOffboarding).toMatchObject({
      memories: 1, embeddings: 1, memberships: 1,
    });
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

  it.each([
    { scopeName: '%', collateral: 'collateral-percent-match' },
    { scopeName: '_', collateral: 'x' },
    { scopeName: 'a_b', collateral: 'axb' },
  ])('ignores unsupported free-form scope-name metadata "$scopeName" and wildcard collateral', async ({
    scopeName, collateral,
  }) => {
    const value = await fixture();
    await pool.query('UPDATE scopes SET name = $2 WHERE id = $1', [value.personal.id, scopeName]);
    expect((await pool.query(
      'SELECT $2::text LIKE $1::text AS would_match', [scopeName, collateral],
    )).rows[0].would_match).toBe(true);
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, metadata) VALUES
       ($1, 'read', $2::jsonb), ($1, 'read', $3::jsonb)`,
      [value.admin.id, JSON.stringify({ nested: { scope: scopeName } }),
        JSON.stringify({ nested: { scope: collateral }, marker: 'unrelated' })],
    );
    await offboardPrincipal(pool, value.admin, value.target.id);
    const rows = (await pool.query(
      `SELECT metadata FROM audit_log
        WHERE principal_id = $1 AND action = 'read' ORDER BY id`, [value.admin.id],
    )).rows;
    expect(rows[0].metadata).toEqual({ nested: { scope: scopeName } });
    expect(rows[1].metadata).toEqual({ nested: { scope: collateral }, marker: 'unrelated' });
  });

  it('binds shared-scope acknowledgement to the reviewed principal evidence set', async () => {
    const value = await fixture();
    const reviewed = await createPrincipal(pool, {
      externalId: 'reviewed-delegate', kind: 'service', displayName: 'Reviewed',
    });
    await addMembership(pool, reviewed.id, value.personal.id, 'writer');
    await mapOwnedUserScope(pool, value.admin, value.target.id, value.personal.id, true);
    const unreviewed = await createPrincipal(pool, {
      externalId: 'unreviewed-delegate', kind: 'service', displayName: 'Unreviewed',
    });
    await addMembership(pool, unreviewed.id, value.personal.id, 'reader');
    await expect(offboardPrincipal(pool, value.admin, value.target.id))
      .rejects.toThrow(/unacknowledged principal evidence/i);
    await mapOwnedUserScope(pool, value.admin, value.target.id, value.personal.id, true);
    await offboardPrincipal(pool, value.admin, value.target.id);
    const event = (await pool.query(
      `SELECT evidence FROM principal_offboarding_events WHERE principal_id = $1`,
      [value.target.id],
    )).rows[0].evidence;
    expect(event.acknowledgedPrincipalIds).toEqual([reviewed.id, unreviewed.id].sort());
    expect(event.acknowledgedEvidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('quarantines owned-scope Entra bindings and database-rejects later active access', async () => {
    const value = await fixture();
    const groupId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const member = await createPrincipal(pool, {
      externalId: 'entra-member', kind: 'user', displayName: 'Entra member',
    });
    await provisionEntraGroupBinding(pool, value.admin, {
      externalId: groupId, scopeId: value.personal.id, role: 'reader',
    });
    await pool.query(
      `INSERT INTO scope_memberships
         (principal_id, scope_id, role, source_kind, source_id, active)
       VALUES ($1, $2, 'reader', 'entra', $3, TRUE)`,
      [member.id, value.personal.id, groupId],
    );
    await mapOwnedUserScope(pool, value.admin, value.target.id, value.personal.id, true);
    const result = await offboardPrincipal(pool, value.admin, value.target.id);
    expect(result.entraBindings).toBe(1);
    expect((await pool.query(
      `SELECT active, approval_revoked_at IS NOT NULL AS revoked, quarantine_reason
         FROM entra_groups WHERE external_id = $1`, [groupId],
    )).rows[0]).toEqual({
      active: false, revoked: true, quarantine_reason: 'OWNED_SCOPE_OFFBOARDED',
    });
    await expect(pool.query(
      `INSERT INTO scope_memberships
         (principal_id, scope_id, role, source_kind, source_id, active)
       VALUES ($1, $2, 'reader', 'manual', 'manual', TRUE)`,
      [member.id, value.personal.id],
    )).rejects.toThrow(/offboarded owned scope/i);
  });

  it('redacts delegate summaries through scope_ids and request_id linkage', async () => {
    const value = await fixture();
    const delegate = await createPrincipal(pool, {
      externalId: 'audit-delegate', kind: 'user', displayName: 'Audit delegate',
    });
    const requestId = 'linked-request';
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, query, metadata) VALUES
       ($1, 'read', 'scope ids secret', $2::jsonb),
       ($1, 'read', 'linked secret', $3::jsonb)`,
      [delegate.id,
        JSON.stringify({ request_id: requestId, scope_ids: [value.personal.id] }),
        JSON.stringify({ request_id: requestId })],
    );
    await offboardPrincipal(pool, value.admin, value.target.id);
    const rows = (await pool.query(
      `SELECT query, metadata FROM audit_log
        WHERE principal_id = $1 ORDER BY id`, [delegate.id],
    )).rows;
    expect(rows).toEqual([
      { query: null, metadata: { redacted: 'principal_offboarding' } },
      { query: null, metadata: { redacted: 'principal_offboarding' } },
    ]);
    await expect(pool.query(
      `INSERT INTO audit_log (principal_id, action, query, metadata)
       VALUES ($1, 'read', 'late secret', $2::jsonb)`,
      [delegate.id, JSON.stringify({ scope_ids: [value.personal.id] })],
    )).rejects.toThrow(/offboarded owned scope/i);
  });

  it('fails a concurrent delegate audit closed when the owner transition wins', async () => {
    const value = await fixture();
    const delegate = await createPrincipal(pool, {
      externalId: 'concurrent-delegate', kind: 'user', displayName: 'Concurrent delegate',
    });
    const transition = await pool.connect();
    await transition.query('BEGIN');
    await transition.query('SELECT id FROM principals WHERE id = $1 FOR UPDATE', [value.target.id]);
    let settled = false;
    const lateAudit = pool.query(
      `INSERT INTO audit_log (principal_id, action, query, metadata)
       VALUES ($1, 'read', 'late delegate secret', $2::jsonb)`,
      [delegate.id, JSON.stringify({ scope_ids: [value.personal.id] })],
    ).finally(() => { settled = true; });
    const lateAuditError = lateAudit.then(
      () => null,
      (error: unknown) => error as Error,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    await transition.query(
      'UPDATE principals SET offboarded_at = now() WHERE id = $1', [value.target.id],
    );
    await transition.query('COMMIT');
    transition.release();
    expect((await lateAuditError)?.message).toMatch(/offboarded owned scope/i);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE principal_id = $1 AND query = 'late delegate secret'`, [delegate.id],
    )).rows[0].count).toBe(0);
  });

  it('fails a concurrent membership write closed when the owner transition wins', async () => {
    const value = await fixture();
    const member = await createPrincipal(pool, {
      externalId: 'concurrent-member', kind: 'user', displayName: 'Concurrent member',
    });
    const transition = await pool.connect();
    await transition.query('BEGIN');
    await transition.query('SELECT id FROM principals WHERE id = $1 FOR UPDATE', [value.target.id]);
    let settled = false;
    const lateMembership = addMembership(
      pool, member.id, value.personal.id, 'reader',
    ).finally(() => { settled = true; });
    const lateMembershipError = lateMembership.then(
      () => null,
      (error: unknown) => error as Error,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    await transition.query(
      'UPDATE principals SET offboarded_at = now() WHERE id = $1', [value.target.id],
    );
    await transition.query('COMMIT');
    transition.release();
    expect((await lateMembershipError)?.message).toMatch(/offboarded owned scope/i);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM scope_memberships
        WHERE principal_id = $1 AND scope_id = $2 AND active`,
      [member.id, value.personal.id],
    )).rows[0].count).toBe(0);
  });

  it('removes aliases and protects archived tombstones from later content edits', async () => {
    const value = await fixture();
    await pool.query(
      `INSERT INTO principal_aliases (provider, external_actor, principal_id)
       VALUES ('github', 'sensitive-login', $1)`, [value.target.id],
    );
    const preview = await offboardPrincipal(pool, value.admin, value.target.id, true);
    expect(preview.aliases).toBe(1);
    await offboardPrincipal(pool, value.admin, value.target.id);
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM principal_aliases WHERE principal_id = $1',
      [value.target.id],
    )).rows[0].count).toBe(0);
    await expect(pool.query(
      `UPDATE memories SET body = 'restored' WHERE id = $1`, [value.personalMemory.id],
    )).rejects.toThrow(/archived memory content is immutable/i);
  });

  it('starts a bounded fenced batch when more than the former affected-row cap is selected', async () => {
    const value = await fixture();
    await pool.query(
      `INSERT INTO memories
         (id, scope_id, type, title, body, author_id, source)
       SELECT gen_random_uuid(), $1, 'context', 'bulk ' || n, 'private ' || n, $2, 'manual'
         FROM generate_series(1, $3) n`,
      [value.personal.id, value.target.id, MAX_OFFBOARD_MEMORIES],
    );
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, query, metadata)
       SELECT $1, 'read', $2, 'bounded secret', '{}'::jsonb
         FROM generate_series(1, $3)`,
      [value.admin.id, value.personal.id, MAX_OFFBOARD_AFFECTED_ROWS + 1],
    );
    const preview = await offboardPrincipal(pool, value.admin, value.target.id, true);
    expect(preview.memories).toBe(MAX_OFFBOARD_MEMORIES + 1);
    expect(preview.auditRows).toBe(MAX_OFFBOARD_AFFECTED_ROWS + 1);
    const first = await offboardPrincipal(pool, value.admin, value.target.id, { batchSize: 10 });
    expect(first).toMatchObject({ complete: false, progress: { memoriesProcessed: 10 } });
    expect(first.progress.auditRowsProcessed).toBeGreaterThan(0);
    expect(first.progress.auditRowsProcessed).toBeLessThanOrEqual(10);
    expect((await pool.query(
      `SELECT disabled_at IS NOT NULL AS disabled, offboarded_at IS NOT NULL AS fenced
         FROM principals WHERE id = $1`, [value.target.id],
    )).rows[0]).toEqual({ disabled: true, fenced: true });
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM memories
        WHERE scope_id = $1 AND title = '[erased]'`, [value.personal.id],
    )).rows[0].count).toBe(10);
  });

  it('preserves UUID-only administrative audit integrity for the departing actor', async () => {
    const value = await fixture();
    const serviceId = '11111111-1111-4111-8111-111111111111';
    const keyId = '22222222-2222-4222-8222-222222222222';
    const affectedPrincipalId = '33333333-3333-4333-8333-333333333333';
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, query, metadata) VALUES
       ($1, 'write', 'operator free text', $2::jsonb),
       ($1, 'write', NULL, $3::jsonb),
       ($1, 'write', NULL, $4::jsonb)`,
      [value.target.id,
        JSON.stringify({ operation: 'api_key_issued', key_id: keyId,
          service_principal_id: serviceId, note: 'remove me' }),
        JSON.stringify({ operation: 'principal_disabled', principal_id: affectedPrincipalId,
          reason: 'remove me' }),
        JSON.stringify({ operation: 'entra_group_binding_provisioned', group_id: serviceId,
          scope_id: affectedPrincipalId, display_name: 'remove me' })],
    );
    let result = await offboardPrincipal(pool, value.admin, value.target.id, {
      confirmationScopeId: value.personal.id, batchSize: 10,
    });
    while (!result.complete) result = await offboardPrincipal(pool, value.admin, value.target.id, {
      confirmationScopeId: value.personal.id, batchSize: 10,
    });
    expect((await pool.query(
      `SELECT query, metadata FROM audit_log
        WHERE principal_id = $1 AND metadata->>'operation' IN
          ('api_key_issued', 'principal_disabled', 'entra_group_binding_provisioned')
        ORDER BY id`, [value.target.id],
    )).rows).toEqual([
      { query: null, metadata: { operation: 'api_key_issued', key_id: keyId,
        service_principal_id: serviceId } },
      { query: null, metadata: { operation: 'principal_disabled', principal_id: affectedPrincipalId } },
      { query: null, metadata: { operation: 'entra_group_binding_provisioned', group_id: serviceId,
        scope_id: affectedPrincipalId } },
    ]);
  });

  it('requires exact service-layer confirmation for every non-dry-run batch', async () => {
    const value = await fixture();
    await expect(serviceOffboardPrincipal(pool, value.admin, value.target.id))
      .rejects.toThrow(/confirmation scope id is required/i);
    await expect(offboardPrincipal(pool, value.admin, value.target.id, {
      confirmationScopeId: value.shared.id,
    })).rejects.toThrow(/does not match/i);
    await expect(offboardPrincipal(pool, value.admin, value.target.id, {
      confirmationScopeId: value.personal.id,
    })).resolves.toMatchObject({ principalId: value.target.id });
  });

  it('retains linked request IDs and refuses reactivation while erasure is incomplete', async () => {
    const value = await fixture();
    const requestId = 'retained-until-complete';
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, query, metadata) VALUES
       ($1, 'read', 'direct secret', $2::jsonb),
       ($1, 'read', 'linked secret', $3::jsonb)`,
      [value.target.id, JSON.stringify({ request_id: requestId }),
        JSON.stringify({ request_id: requestId })],
    );
    const first = await offboardPrincipal(pool, value.admin, value.target.id, {
      confirmationScopeId: value.personal.id, batchSize: 1,
    });
    expect(first.complete).toBe(false);
    await expect(listIncompleteOffboardingRuns(pool, value.admin)).resolves.toEqual([
      expect.objectContaining({
        principalId: value.target.id, scopeId: value.personal.id, batches: 1,
      }),
    ]);
    expect((await pool.query(
      `SELECT request_id FROM principal_offboarding_audit_requests WHERE principal_id = $1`,
      [value.target.id],
    )).rows).toEqual([{ request_id: requestId }]);
    await expect(reactivatePrincipal(pool, value.admin, value.target.id))
      .rejects.toThrow(/offboarding.*incomplete/i);
    expect((await pool.query(
      `SELECT request_id FROM principal_offboarding_audit_requests WHERE principal_id = $1`,
      [value.target.id],
    )).rows).toEqual([{ request_id: requestId }]);
  });

  it('makes approval evidence and completed erasure receipts immutable to all writes', async () => {
    const value = await fixture();
    let result = await offboardPrincipal(pool, value.admin, value.target.id, {
      confirmationScopeId: value.personal.id,
    });
    while (!result.complete) result = await offboardPrincipal(pool, value.admin, value.target.id, {
      confirmationScopeId: value.personal.id,
    });
    await expect(pool.query(
      `UPDATE principal_offboarding_events SET repair = NOT repair WHERE principal_id = $1`,
      [value.target.id],
    )).rejects.toThrow(/immutable/i);
    await expect(pool.query(
      `DELETE FROM principal_offboarding_events WHERE principal_id = $1`, [value.target.id],
    )).rejects.toThrow(/immutable/i);
    await expect(pool.query('TRUNCATE principal_offboarding_events')).rejects.toThrow(/immutable/i);
    await expect(pool.query('TRUNCATE principal_user_scope_approvals CASCADE'))
      .rejects.toThrow(/immutable/i);
  });

  it('accepts exactly the bounded maximum of other-principal evidence', async () => {
    const value = await fixture();
    await pool.query(
      `INSERT INTO principals (id, external_id, kind, display_name)
       SELECT gen_random_uuid(), 'evidence-' || n, 'service', 'Evidence ' || n
         FROM generate_series(1, 100) n`,
    );
    await pool.query(
      `INSERT INTO scope_memberships (principal_id, scope_id, role, source_kind, source_id, active)
       SELECT id, $1, 'reader', 'manual', external_id, FALSE
         FROM principals WHERE external_id LIKE 'evidence-%'`, [value.personal.id],
    );
    await mapOwnedUserScope(pool, value.admin, value.target.id, value.personal.id, true);
    await expect(offboardPrincipal(pool, value.admin, value.target.id, {
      confirmationScopeId: value.personal.id,
    })).resolves.toMatchObject({ evidence: { memberPrincipalIdsTruncated: false } });
  });

  it('truthfully completes more than 10k memories and 50k audits within each batch cap', async () => {
    const value = await fixture();
    await pool.query(
      `INSERT INTO memories (id, scope_id, type, title, body, author_id, source)
       SELECT gen_random_uuid(), $1, 'context', 'bulk ' || n, 'private ' || n, $2, 'manual'
         FROM generate_series(1, $3) n`,
      [value.personal.id, value.target.id, MAX_OFFBOARD_MEMORIES],
    );
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, query, metadata)
       SELECT $1, 'read', $2, 'bounded secret ' || n, '{}'::jsonb
         FROM generate_series(1, $3) n`,
      [value.admin.id, value.personal.id, MAX_OFFBOARD_AFFECTED_ROWS + 1],
    );
    let priorMemories = 0;
    let priorAudits = 0;
    let result;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      result = await offboardPrincipal(pool, value.admin, value.target.id, {
        confirmationScopeId: value.personal.id, batchSize: 5_000,
      });
      expect(result.progress.memoriesProcessed - priorMemories).toBeLessThanOrEqual(5_000);
      expect(result.progress.auditRowsProcessed - priorAudits).toBeLessThanOrEqual(5_000);
      priorMemories = result.progress.memoriesProcessed;
      priorAudits = result.progress.auditRowsProcessed;
      if (result.complete) break;
    }
    expect(result?.complete).toBe(true);
    expect((await pool.query(
      `SELECT EXISTS (SELECT 1 FROM memories WHERE scope_id = $1 AND title <> '[erased]') AS dirty`,
      [value.personal.id],
    )).rows[0].dirty).toBe(false);
    expect((await pool.query(
      `SELECT EXISTS (SELECT 1 FROM audit_log WHERE scope_id = $1 AND query IS NOT NULL) AS dirty`,
      [value.personal.id],
    )).rows[0].dirty).toBe(false);
  }, 120_000);

  it('does not select unrelated audit metadata merely because it contains a common scope name', async () => {
    const value = await fixture();
    await pool.query('UPDATE scopes SET name = $2 WHERE id = $1', [value.personal.id, 'admin']);
    const unrelated = await pool.query(
      `INSERT INTO audit_log (principal_id, action, metadata)
       VALUES ($1, 'write', '{"operation":"principal_disabled","reason":"admin"}')
       RETURNING id`,
      [value.admin.id],
    );

    const preview = await offboardPrincipal(pool, value.admin, value.target.id, true);
    expect(preview.auditSelection).toMatchObject({ scopeName: 0 });
    await offboardPrincipal(pool, value.admin, value.target.id);

    expect((await pool.query(
      'SELECT metadata FROM audit_log WHERE id = $1', [unrelated.rows[0].id],
    )).rows[0].metadata).toEqual({ operation: 'principal_disabled', reason: 'admin' });
  });

  it('preserves immutable mapping approval evidence after erasure and retry', async () => {
    const value = await fixture();
    const before = (await pool.query(
      `SELECT principal_id, scope_id, approved_by, approved_at,
              acknowledged_principal_ids, acknowledged_evidence_hash
         FROM principal_user_scope_approvals
        WHERE principal_id = $1 ORDER BY id`,
      [value.target.id],
    )).rows;
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      principal_id: value.target.id,
      scope_id: value.personal.id,
      approved_by: value.admin.id,
    });

    await offboardPrincipal(pool, value.admin, value.target.id);
    await offboardPrincipal(pool, value.admin, value.target.id);

    expect((await pool.query(
      `SELECT principal_id, scope_id, approved_by, approved_at,
              acknowledged_principal_ids, acknowledged_evidence_hash
         FROM principal_user_scope_approvals
        WHERE principal_id = $1 ORDER BY id`,
      [value.target.id],
    )).rows).toEqual(before);
    await expect(pool.query(
      'DELETE FROM principal_user_scope_approvals WHERE principal_id = $1', [value.target.id],
    )).rejects.toThrow(/immutable/i);
  });

  it('resumes fenced bounded batches until a principal is completely erased', async () => {
    const value = await fixture();
    await pool.query(
      `INSERT INTO memories
         (id, scope_id, type, title, body, author_id, source)
       SELECT gen_random_uuid(), $1, 'context', 'Private ' || n, 'Body ' || n, $2, 'manual'
         FROM generate_series(1, 3) n`,
      [value.personal.id, value.target.id],
    );
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, query, metadata)
       SELECT $1, 'read', $2, 'private ' || n, '{}'::jsonb
         FROM generate_series(1, 3) n`,
      [value.admin.id, value.personal.id],
    );

    const first = await offboardPrincipal(pool, value.admin, value.target.id, {
      batchSize: 1,
    });
    expect(first).toMatchObject({ complete: false, alreadyOffboarded: false });
    expect(first.progress).toMatchObject({ memoriesProcessed: 1 });
    expect((await pool.query(
      `SELECT disabled_at IS NOT NULL AS disabled, offboarded_at IS NOT NULL AS fenced
         FROM principals WHERE id = $1`, [value.target.id],
    )).rows[0]).toEqual({ disabled: true, fenced: true });

    let current = first;
    for (let attempt = 0; attempt < 10 && !current.complete; attempt += 1) {
      current = await offboardPrincipal(pool, value.admin, value.target.id, { batchSize: 1 });
    }
    expect(current.complete).toBe(true);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM memories
        WHERE scope_id = $1 AND (title <> '[erased]' OR state <> 'archived')`,
      [value.personal.id],
    )).rows[0].count).toBe(0);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE scope_id = $1 AND query IS NOT NULL`, [value.personal.id],
    )).rows[0].count).toBe(0);
  });
});
