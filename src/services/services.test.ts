import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { Principal } from '../types.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { accessibleScopes, canReadScope, canWriteScope } from './access.js';
import { captureMemory } from './capture.js';
import { recallForPrincipal } from './recall.js';
import { renderAgentsMdForPrincipal } from './agents-md.js';
import { ServiceError } from './errors.js';
import { createMemory } from '../storage/memories.js';
import { promoteForPrincipal, verifyForPrincipal } from './lifecycle.js';
import { ensureScopeForPrincipal } from './scopes.js';

describe('shared services', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function seedWriter() {
    const principal = await createPrincipal(pool, {
      externalId: 'entra:user:service',
      kind: 'user',
      displayName: 'Service User',
    });
    const team = await createScope(pool, { kind: 'team', name: 'payments' });
    await addMembership(pool, principal.id, team.id, 'writer');
    return { principal, team };
  }

  async function createOtherAuthor(suffix = 'other') {
    return createPrincipal(pool, {
      externalId: `entra:user:${suffix}`,
      kind: 'user',
      displayName: 'Other Author',
    });
  }

  it('adds implicit org read to the canonical accessible-scope set', async () => {
    const { principal, team } = await seedWriter();
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;

    const scopes = await accessibleScopes(pool, principal.id);

    expect(scopes.get(team.id)).toMatchObject({ label: 'team:payments', role: 'writer' });
    expect(scopes.get(org.id)).toMatchObject({ label: 'org', role: 'reader' });
  });

  it('deduplicates explicit org membership and preserves its role', async () => {
    const { principal } = await seedWriter();
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, principal.id, org.id, 'admin');

    const scopes = await accessibleScopes(pool, principal.id);

    expect([...scopes.values()].filter((scope) => scope.kind === 'org')).toEqual([
      expect.objectContaining({ id: org.id, label: 'org', role: 'admin' }),
    ]);
  });

  it('grants implicit org read without granting write authority', async () => {
    const { principal } = await seedWriter();
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;

    await expect(canReadScope(pool, principal.id, org)).resolves.toBe(true);
    await expect(canWriteScope(pool, principal.id, org.id)).resolves.toBe(false);
  });

  it('rolls scope creation back when its required audit fails', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'entra:user:scope-admin', kind: 'user', displayName: 'Scope Admin',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, principal.id, org.id, 'admin');

    await expect(ensureScopeForPrincipal(
      poolRejecting(pool, 'INSERT INTO audit_log'),
      principal,
      { kind: 'project', name: 'must-roll-back' },
    )).rejects.toMatchObject<ServiceError>({ code: 'INTERNAL' });

    await expect(getScopeByRef(
      pool, { kind: 'project', name: 'must-roll-back' },
    )).resolves.toBeNull();
  });

  it('serializes concurrent authorized ensures through the service transaction', async () => {
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const admins = await Promise.all(['one', 'two'].map(async (suffix) => {
      const principal = await createPrincipal(pool, {
        externalId: `entra:user:scope-admin-${suffix}`,
        kind: 'user',
        displayName: `Scope Admin ${suffix}`,
      });
      await addMembership(pool, principal.id, org.id, 'admin');
      return principal;
    }));

    const results = await Promise.all(admins.map((principal) =>
      ensureScopeForPrincipal(
        pool,
        principal,
        { kind: 'project', name: 'concurrent-service' },
        { transport: 'mcp' },
      )));

    expect(new Set(results.map((result) => result.scope.id))).toHaveLength(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const { rows } = await pool.query(
      `SELECT principal_id, scope_id, action, metadata
         FROM audit_log
        WHERE metadata->>'operation' = 'create_scope'
        ORDER BY principal_id`,
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.principal_id))).toEqual(
      new Set(admins.map((principal) => principal.id)),
    );
    expect(new Set(rows.map((row) => row.scope_id))).toEqual(
      new Set([results[0].scope.id]),
    );
    expect(rows.every((row) => row.action === 'write')).toBe(true);
    expect(rows.every((row) => row.metadata.transport === 'mcp')).toBe(true);
  });

  it('destroys the ensure client after rollback failure and preserves the original error', async () => {
    const original = new Error('original ensure failure');
    const release = vi.fn();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN ISOLATION LEVEL READ COMMITTED') return { rows: [] };
        if (sql === 'ROLLBACK') throw new Error('rollback failure');
        if (sql.includes('FROM scopes')) {
          return { rows: [{ id: 'org', kind: 'org', name: '', created_at: new Date() }] };
        }
        if (sql.includes('FROM scope_memberships')) return { rows: [{ role: 'admin' }] };
        if (sql.includes('INSERT INTO scopes')) throw original;
        throw new Error(`unexpected query: ${sql}`);
      }),
      release,
    };
    const fakePool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as pg.Pool;

    const failure = await ensureScopeForPrincipal(
      fakePool,
      { id: 'principal' } as Principal,
      { kind: 'project', name: 'rollback-failure' },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'INTERNAL', cause: original });
    expect(release).toHaveBeenCalledWith(true);
  });

  it('maps ensure pool connection failures to dependency unavailable', async () => {
    const fakePool = {
      connect: vi.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as pg.Pool;

    await expect(ensureScopeForPrincipal(
      fakePool,
      { id: 'principal' } as Principal,
      { kind: 'project', name: 'connection-failure' },
    )).rejects.toMatchObject<ServiceError>({
      code: 'DEPENDENCY_UNAVAILABLE',
      publicMessage: 'A required dependency is unavailable',
    });
  });

  it('captures metadata, tags and source ref and writes the audit atomically', async () => {
    const { principal, team } = await seedWriter();

    const result = await captureMemory(pool, null, principal, {
      scope: { kind: 'team', name: 'payments' },
      type: 'fact',
      title: 'Retry limit',
      body: 'Three attempts.',
      source: 'manual',
      sourceRef: 'https://example.test/source/1',
      tags: ['checkout'],
      metadata: { branch: 'main' },
    });

    expect(result.embedded).toBe(false);
    expect(result.memory).toMatchObject({
      scopeId: team.id,
      tags: ['checkout'],
      sourceRef: 'https://example.test/source/1',
      metadata: { branch: 'main' },
    });
    const { rows } = await pool.query(
      'SELECT metadata FROM audit_log WHERE memory_id = $1',
      [result.memory.id],
    );
    expect(rows).toEqual([{ metadata: { source: 'manual', type: 'fact', embedded: false } }]);
  });

  it('sanitizes embedding failures in results and audit metadata', async () => {
    const { principal } = await seedWriter();
    const provider: EmbeddingProvider = {
      id: 'test:failing',
      dim: 3,
      async embed() {
        throw new Error('provider secret: api-key-123');
      },
    };

    const result = await captureMemory(pool, provider, principal, {
      scope: { kind: 'team', name: 'payments' },
      type: 'fact',
      title: 'Retry limit',
      body: 'Three attempts.',
      source: 'manual',
    });

    expect(result).toMatchObject({ embedded: false, embedErrorCode: 'EMBEDDING_FAILED' });
    const { rows } = await pool.query(
      'SELECT metadata::text AS metadata FROM audit_log WHERE memory_id = $1',
      [result.memory.id],
    );
    expect(rows[0].metadata).toContain('EMBEDDING_FAILED');
    expect(rows[0].metadata).not.toContain('api-key-123');
  });

  it('recovers from an embedding storage failure and still commits memory plus audit', async () => {
    const { principal } = await seedWriter();
    const provider: EmbeddingProvider = {
      id: 'test:invalid-vector',
      dim: 0,
      async embed() {
        return [[]];
      },
    };

    const result = await captureMemory(pool, provider, principal, {
      scope: { kind: 'team', name: 'payments' },
      type: 'fact',
      title: 'Retry limit',
      body: 'Three attempts.',
      source: 'manual',
    });

    expect(result).toMatchObject({ embedded: false, embedErrorCode: 'EMBEDDING_FAILED' });
    const { rows } = await pool.query(
      `SELECT m.id, a.metadata
         FROM memories m
         JOIN audit_log a ON a.memory_id = m.id
        WHERE m.id = $1`,
      [result.memory.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.embedding_error_code).toBe('EMBEDDING_FAILED');
  });

  it('calls the embedding provider before opening the capture transaction', async () => {
    const { principal } = await seedWriter();
    let transactionOpen = false;
    const wrappedPool = poolWithQueryObserver(pool, (sql) => {
      if (sql === 'BEGIN') transactionOpen = true;
      if (sql === 'COMMIT' || sql === 'ROLLBACK') transactionOpen = false;
    });
    const provider: EmbeddingProvider = {
      id: 'test:timing',
      dim: 3,
      async embed() {
        expect(transactionOpen).toBe(false);
        return [[0.1, 0.2, 0.3]];
      },
    };

    await captureMemory(wrappedPool, provider, principal, {
      scope: { kind: 'team', name: 'payments' },
      type: 'fact', title: 'Timing', body: 'Provider first.', source: 'manual',
    });
  });

  it('does not hold a checked-out client while awaiting the embedding provider', async () => {
    const { principal } = await seedWriter();
    let checkedOutClients = 0;
    const wrappedPool = poolWithClientCount(pool, (count) => {
      checkedOutClients = count;
    });
    let clientsObservedDuringEmbed = -1;
    const provider: EmbeddingProvider = {
      id: 'test:no-client-during-embed', dim: 3,
      async embed() {
        clientsObservedDuringEmbed = checkedOutClients;
        return [[0.1, 0.2, 0.3]];
      },
    };

    await captureMemory(wrappedPool, provider, principal, {
      scope: { kind: 'team', name: 'payments' },
      type: 'fact', title: 'No held client', body: 'Embed first.', source: 'manual',
    });
    expect(clientsObservedDuringEmbed).toBe(0);
  });

  it('rechecks writer authorization after embedding before capture insert', async () => {
    const { principal, team } = await seedWriter();
    const embedStarted = deferred<void>();
    const continueEmbedding = deferred<void>();
    const provider: EmbeddingProvider = {
      id: 'test:revocation-race', dim: 3,
      async embed() {
        embedStarted.resolve();
        await continueEmbedding.promise;
        return [[0.1, 0.2, 0.3]];
      },
    };

    const capture = captureMemory(pool, provider, principal, {
      scope: { kind: 'team', name: 'payments' },
      type: 'fact', title: 'Revoked write', body: 'Must not persist.', source: 'manual',
    });
    await embedStarted.promise;
    await pool.query(
      'DELETE FROM scope_memberships WHERE principal_id = $1 AND scope_id = $2',
      [principal.id, team.id],
    );
    continueEmbedding.resolve();

    await expect(capture).rejects.toMatchObject<ServiceError>({ code: 'FORBIDDEN' });
    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM memories WHERE title = 'Revoked write'`,
    );
    expect(rows[0].count).toBe(0);
  });

  it('rolls capture back when the required write audit fails', async () => {
    const { principal } = await seedWriter();
    const failingPool = poolRejecting(pool, 'INSERT INTO audit_log');

    await expect(captureMemory(failingPool, null, principal, {
      scope: { kind: 'team', name: 'payments' },
      type: 'fact',
      title: 'Must roll back',
      body: 'No unaudited write.',
      source: 'manual',
    })).rejects.toMatchObject<ServiceError>({ code: 'INTERNAL' });

    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM memories WHERE title = 'Must roll back'`,
    );
    expect(rows[0].count).toBe(0);
  });

  it('rolls the embedding row back with the memory when audit fails', async () => {
    const { principal } = await seedWriter();
    const provider: EmbeddingProvider = {
      id: 'test:success',
      dim: 3,
      async embed() { return [[0.1, 0.2, 0.3]]; },
    };

    await expect(captureMemory(
      poolRejecting(pool, 'INSERT INTO audit_log'),
      provider,
      principal,
      {
        scope: { kind: 'team', name: 'payments' },
        type: 'fact', title: 'Atomic vector', body: 'Rollback all.', source: 'manual',
      },
    )).rejects.toMatchObject<ServiceError>({ code: 'INTERNAL' });

    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM memories WHERE title = 'Atomic vector') AS memories,
         (SELECT count(*)::int FROM memory_embeddings) AS embeddings`,
    );
    expect(rows[0]).toEqual({ memories: 0, embeddings: 0 });
  });

  it('destroys the client after rollback failure and preserves the original error', async () => {
    const original = new Error('original database failure');
    const release = vi.fn();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'ROLLBACK') throw new Error('rollback failure');
        throw original;
      }),
      release,
    };
    const fakePool = {
      query: capturePreflightQuery,
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as pg.Pool;
    const principal = { id: 'principal' } as Principal;

    const failure = await captureMemory(fakePool, null, principal, {
      scope: { kind: 'team', name: 'payments' },
      type: 'fact', title: 'x', body: 'y', source: 'manual',
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'INTERNAL', cause: original });
    expect(release).toHaveBeenCalledWith(true);
  });

  it('maps pool connection failures to dependency unavailable', async () => {
    const fakePool = {
      query: capturePreflightQuery,
      connect: vi.fn().mockRejectedValue(new Error('database host private-db')),
    } as unknown as pg.Pool;
    const principal = { id: 'principal' } as Principal;

    await expect(captureMemory(fakePool, null, principal, {
      scope: { kind: 'team', name: 'payments' },
      type: 'fact', title: 'x', body: 'y', source: 'manual',
    })).rejects.toMatchObject<ServiceError>({
      code: 'DEPENDENCY_UNAVAILABLE',
      publicMessage: 'A required dependency is unavailable',
    });
  });

  it('fails recall when its required audit cannot be persisted', async () => {
    const { principal } = await seedWriter();
    const failingPool = poolRejecting(pool, 'INSERT INTO audit_log');

    await expect(recallForPrincipal(failingPool, null, principal, {
      query: 'retry',
    })).rejects.toMatchObject<ServiceError>({ code: 'INTERNAL' });
  });

  it('fails AGENTS.md delivery when its atomic read audit cannot be persisted', async () => {
    const { principal } = await seedWriter();

    await expect(renderAgentsMdForPrincipal(
      poolRejecting(pool, 'INSERT INTO audit_log'),
      principal,
      { team: 'payments' },
    )).rejects.toMatchObject<ServiceError>({ code: 'INTERNAL' });

    const { rows } = await pool.query('SELECT count(*)::int AS count FROM audit_log');
    expect(rows[0].count).toBe(0);
  });

  it('rolls promotion changes back when its required audit fails', async () => {
    const { principal, team } = await seedWriter();
    const project = await createScope(pool, { kind: 'project', name: 'checkout' });
    await addMembership(pool, principal.id, project.id, 'writer');
    const source = await createMemory(pool, {
      scopeId: team.id,
      scopeKind: team.kind,
      type: 'decision',
      title: 'Retry decision',
      body: 'Three attempts.',
      authorId: principal.id,
      source: 'manual',
    });

    await expect(promoteForPrincipal(
      poolRejecting(pool, 'INSERT INTO audit_log'),
      principal,
      source.id,
      { kind: 'project', name: 'checkout' },
    )).rejects.toMatchObject<ServiceError>({ code: 'INTERNAL' });

    const { rows } = await pool.query(
      `SELECT title, state FROM memories ORDER BY created_at`,
    );
    expect(rows).toEqual([{ title: 'Retry decision', state: 'live' }]);
  });

  it('revives a stale memory and renews expiry from one database instant', async () => {
    const { principal, team } = await seedWriter();
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'fact', title: 'Revive fact',
      body: 'Still current.', authorId: principal.id, source: 'manual',
    });
    await pool.query(
      `UPDATE memories
          SET state = 'stale', expires_at = now() - interval '1 day'
        WHERE id = $1`,
      [source.id],
    );

    const verified = await verifyForPrincipal(pool, principal, source.id, true);

    expect(verified.state).toBe('live');
    expect(verified.lastVerified).not.toBeNull();
    expect(verified.expiresAt!.getTime() - verified.lastVerified!.getTime())
      .toBe(90 * 24 * 60 * 60 * 1000);
  });

  it('renews a live memory from the verification instant', async () => {
    const { principal, team } = await seedWriter();
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'fact', title: 'Renew fact',
      body: 'Still current.', authorId: principal.id, source: 'manual',
    });
    await pool.query(
      `UPDATE memories SET expires_at = now() + interval '1 day' WHERE id = $1`,
      [source.id],
    );

    const verified = await verifyForPrincipal(pool, principal, source.id, true);

    expect(verified.state).toBe('live');
    expect(verified.expiresAt!.getTime() - verified.lastVerified!.getTime())
      .toBe(90 * 24 * 60 * 60 * 1000);
  });

  it.each([
    { type: 'fact', scopeKind: 'team', days: 90 },
    { type: 'relationship', scopeKind: 'project', days: 180 },
    { type: 'context', scopeKind: 'user', days: 14 },
    { type: 'context', scopeKind: 'org', days: 60 },
    { type: 'context', scopeKind: 'team', days: 60 },
    { type: 'context', scopeKind: 'project', days: 60 },
    { type: 'context', scopeKind: 'role', days: 60 },
    { type: 'decision', scopeKind: 'team', days: null },
    { type: 'playbook', scopeKind: 'team', days: null },
  ] as const)('applies the $type/$scopeKind verification TTL', async ({
    type, scopeKind, days,
  }) => {
    const { principal } = await seedWriter();
    const scope = scopeKind === 'org'
      ? (await getScopeByRef(pool, { kind: 'org', name: '' }))!
      : await createScope(pool, { kind: scopeKind, name: `ttl-${scopeKind}` });
    await addMembership(pool, principal.id, scope.id, 'writer');
    const source = await createMemory(pool, {
      scopeId: scope.id, scopeKind, type, title: 'TTL matrix', body: 'Verify me.',
      authorId: principal.id, source: 'manual',
    });

    const verified = await verifyForPrincipal(pool, principal, source.id, true);

    if (days === null) {
      expect(verified.expiresAt).toBeNull();
    } else {
      expect(verified.expiresAt!.getTime() - verified.lastVerified!.getTime())
        .toBe(days * 24 * 60 * 60 * 1000);
    }
  });

  it('marks a memory stale without extending its expiry', async () => {
    const { principal, team } = await seedWriter();
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'fact', title: 'Not true',
      body: 'No longer current.', authorId: principal.id, source: 'manual',
    });
    const originalExpiry = new Date('2026-01-02T03:04:05.000Z');
    await pool.query('UPDATE memories SET expires_at = $2 WHERE id = $1', [
      source.id, originalExpiry,
    ]);

    const verified = await verifyForPrincipal(pool, principal, source.id, false);

    expect(verified.state).toBe('stale');
    expect(verified.lastVerified).not.toBeNull();
    expect(verified.expiresAt).toEqual(originalExpiry);
  });

  it('denies a memory author with only reader membership without mutation or audit', async () => {
    const { principal } = await seedWriter();
    const readonly = await createScope(pool, { kind: 'project', name: 'author-reader' });
    await addMembership(pool, principal.id, readonly.id, 'reader');
    const source = await createMemory(pool, {
      scopeId: readonly.id, scopeKind: readonly.kind, type: 'fact', title: 'Owned fact',
      body: 'Authorship does not replace current write authority.',
      authorId: principal.id, source: 'manual',
    });

    await expect(verifyForPrincipal(pool, principal, source.id, false, 'must not persist'))
      .rejects.toMatchObject<ServiceError>({
        code: 'FORBIDDEN',
        publicMessage: 'principal lacks writer role on source scope',
      });
    const { rows } = await pool.query(
      `SELECT state, last_verified,
              (SELECT count(*)::int FROM audit_log WHERE memory_id = $1) AS audits
         FROM memories WHERE id = $1`,
      [source.id],
    );
    expect(rows[0]).toEqual({ state: 'live', last_verified: null, audits: 0 });
  });

  it.each(['writer', 'admin'] as const)(
    'allows a current %s to verify a memory by another author',
    async (role) => {
      const { principal, team } = await seedWriter();
      const author = await createOtherAuthor();
      await addMembership(pool, principal.id, team.id, role);
      const source = await createMemory(pool, {
        scopeId: team.id, scopeKind: team.kind, type: 'fact', title: `${role} fact`,
        body: 'Authorized by scope role.', authorId: author.id, source: 'manual',
      });

      await expect(verifyForPrincipal(pool, principal, source.id, false))
        .resolves.toMatchObject({ state: 'stale' });
    },
  );

  it.each(['promoted', 'archived'] as const)(
    'rejects verification of a %s memory without mutation or audit',
    async (state) => {
      const { principal, team } = await seedWriter();
      const source = await createMemory(pool, {
        scopeId: team.id, scopeKind: team.kind, type: 'fact', title: `${state} fact`,
        body: 'Terminal.', authorId: principal.id, source: 'manual',
      });
      await pool.query(
        'UPDATE memories SET state = $2, updated_at = now() - interval \'1 day\' WHERE id = $1',
        [source.id, state],
      );

      await expect(verifyForPrincipal(pool, principal, source.id, true, 'no-op'))
        .rejects.toMatchObject<ServiceError>({ code: 'CONFLICT', status: 409 });
      const { rows } = await pool.query(
        `SELECT state, last_verified,
                (SELECT count(*)::int FROM audit_log WHERE memory_id = $1) AS audits
           FROM memories WHERE id = $1`,
        [source.id],
      );
      expect(rows[0]).toEqual({ state, last_verified: null, audits: 0 });
    },
  );

  it('rolls verification back when its required audit fails', async () => {
    const { principal, team } = await seedWriter();
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'fact', title: 'Rollback verify',
      body: 'Must stay stale.', authorId: principal.id, source: 'manual',
    });
    const originalExpiry = new Date('2026-02-03T04:05:06.000Z');
    await pool.query(
      `UPDATE memories SET state = 'stale', expires_at = $2 WHERE id = $1`,
      [source.id, originalExpiry],
    );

    await expect(verifyForPrincipal(
      poolRejecting(pool, 'INSERT INTO audit_log'), principal, source.id, true, 'still true',
    )).rejects.toMatchObject<ServiceError>({ code: 'INTERNAL' });

    const { rows } = await pool.query(
      'SELECT state, last_verified, expires_at FROM memories WHERE id = $1',
      [source.id],
    );
    expect(rows[0]).toEqual({
      state: 'stale', last_verified: null, expires_at: originalExpiry,
    });
  });

  it('records verification audit metadata only after a successful update', async () => {
    const { principal, team } = await seedWriter();
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'fact', title: 'Audit verify',
      body: 'Record the review.', authorId: principal.id, source: 'manual',
    });

    await verifyForPrincipal(pool, principal, source.id, false, 'source changed');

    const { rows } = await pool.query(
      `SELECT action, principal_id, memory_id, scope_id, metadata
         FROM audit_log WHERE memory_id = $1`,
      [source.id],
    );
    expect(rows).toEqual([{
      action: 'verify',
      principal_id: principal.id,
      memory_id: source.id,
      scope_id: team.id,
      metadata: { still_true: false, note: 'source changed' },
    }]);
  });

  it('denies verification and promotion to implicit org readers', async () => {
    const { principal } = await seedWriter();
    const author = await createOtherAuthor();
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const orgMemoryToVerify = await createMemory(pool, {
      scopeId: org.id, scopeKind: 'org', type: 'fact', title: 'Org fact',
      body: 'Implicit reads are consistent across surfaces.', authorId: author.id,
      source: 'manual',
    });
    const orgMemoryToPromote = await createMemory(pool, {
      scopeId: org.id, scopeKind: 'org', type: 'fact', title: 'Org promotion source',
      body: 'The destination still needs explicit authority.',
      authorId: principal.id, source: 'manual',
    });

    await expect(verifyForPrincipal(pool, principal, orgMemoryToVerify.id, false))
      .rejects.toMatchObject<ServiceError>({
        code: 'FORBIDDEN',
        publicMessage: 'principal lacks writer role on source scope',
      });
    await expect(promoteForPrincipal(
      pool, principal, orgMemoryToPromote.id, { kind: 'team', name: 'payments' },
    )).rejects.toMatchObject<ServiceError>({
      code: 'FORBIDDEN',
      publicMessage: 'principal lacks writer role on source scope',
    });

    const { rows } = await pool.query(
      `SELECT id, state, last_verified, promoted_to_id
         FROM memories
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[orgMemoryToVerify.id, orgMemoryToPromote.id]],
    );
    expect(rows).toEqual([
      { id: orgMemoryToVerify.id, state: 'live', last_verified: null, promoted_to_id: null },
      { id: orgMemoryToPromote.id, state: 'live', last_verified: null, promoted_to_id: null },
    ].sort((a, b) => a.id.localeCompare(b.id)));
  });

  it('denies verification and promotion to explicit source readers', async () => {
    const { principal } = await seedWriter();
    const author = await createOtherAuthor();
    const readonly = await createScope(pool, { kind: 'project', name: 'readonly-source' });
    await addMembership(pool, principal.id, readonly.id, 'reader');
    const memoryToVerify = await createMemory(pool, {
      scopeId: readonly.id, scopeKind: 'project', type: 'fact', title: 'Reader verify',
      body: 'Readers cannot change verification state.', authorId: author.id,
      source: 'manual',
    });
    const memoryToPromote = await createMemory(pool, {
      scopeId: readonly.id, scopeKind: 'project', type: 'decision', title: 'Reader promote',
      body: 'Readers cannot promote the source.', authorId: principal.id, source: 'manual',
    });

    await expect(verifyForPrincipal(pool, principal, memoryToVerify.id, false))
      .rejects.toMatchObject<ServiceError>({ code: 'FORBIDDEN' });
    await expect(promoteForPrincipal(
      pool, principal, memoryToPromote.id, { kind: 'team', name: 'payments' },
    )).rejects.toMatchObject<ServiceError>({ code: 'FORBIDDEN' });

    const { rows } = await pool.query(
      `SELECT id, state, last_verified, promoted_to_id
         FROM memories
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[memoryToVerify.id, memoryToPromote.id]],
    );
    expect(rows).toEqual([
      { id: memoryToVerify.id, state: 'live', last_verified: null, promoted_to_id: null },
      { id: memoryToPromote.id, state: 'live', last_verified: null, promoted_to_id: null },
    ].sort((a, b) => a.id.localeCompare(b.id)));
  });

  it('requires org admin, not writer, for a promotion destination', async () => {
    const { principal, team } = await seedWriter();
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const writerSource = await createMemory(pool, {
      scopeId: team.id, scopeKind: 'team', type: 'decision', title: 'Writer denied',
      body: 'Org promotion requires approval.', authorId: principal.id, source: 'manual',
    });
    await addMembership(pool, principal.id, org.id, 'writer');

    await expect(promoteForPrincipal(
      pool, principal, writerSource.id, { kind: 'org', name: '' },
    )).rejects.toMatchObject<ServiceError>({ code: 'FORBIDDEN' });

    await addMembership(pool, principal.id, org.id, 'admin');
    await expect(promoteForPrincipal(
      pool, principal, writerSource.id, { kind: 'org', name: '' },
    )).resolves.toMatchObject({ destination: { scopeId: org.id } });
  });

  it('denies an author whose source membership is revoked before authorization', async () => {
    const { principal, team } = await seedWriter();
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: 'team', type: 'fact', title: 'Revoked verify',
      body: 'A concurrent revocation must take effect.', authorId: principal.id,
      source: 'manual',
    });
    const authorizationReached = deferred<void>();
    const continueAuthorization = deferred<void>();
    const verifyPool = poolPausingBeforeMembershipCheck(
      pool, 1, authorizationReached, continueAuthorization,
    );

    const verification = verifyForPrincipal(verifyPool, principal, source.id, true);
    await authorizationReached.promise;
    await pool.query(
      'DELETE FROM scope_memberships WHERE principal_id = $1 AND scope_id = $2',
      [principal.id, team.id],
    );
    continueAuthorization.resolve();

    await expect(verification).rejects.toMatchObject<ServiceError>({ code: 'FORBIDDEN' });
    const { rows } = await pool.query(
      `SELECT state, last_verified,
              (SELECT count(*)::int FROM audit_log WHERE memory_id = $1) AS audits
         FROM memories WHERE id = $1`,
      [source.id],
    );
    expect(rows[0]).toEqual({ state: 'live', last_verified: null, audits: 0 });
  });

  it('denies promotion when destination membership is revoked before authorization', async () => {
    const { principal, team } = await seedWriter();
    const project = await createScope(pool, { kind: 'project', name: 'revoked-target' });
    await addMembership(pool, principal.id, project.id, 'writer');
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: 'team', type: 'decision', title: 'Revoked promotion',
      body: 'No copy may be created after revocation.', authorId: principal.id,
      source: 'manual',
    });
    const authorizationReached = deferred<void>();
    const continueAuthorization = deferred<void>();
    const promotePool = poolPausingBeforeMembershipCheck(
      pool, 2, authorizationReached, continueAuthorization,
    );

    const promotion = promoteForPrincipal(
      promotePool, principal, source.id, { kind: 'project', name: 'revoked-target' },
    );
    await authorizationReached.promise;
    await pool.query(
      'DELETE FROM scope_memberships WHERE principal_id = $1 AND scope_id = $2',
      [principal.id, project.id],
    );
    continueAuthorization.resolve();

    await expect(promotion).rejects.toMatchObject<ServiceError>({ code: 'FORBIDDEN' });
    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM memories
        WHERE metadata->>'promoted_from' = $1`,
      [source.id],
    );
    expect(rows[0].count).toBe(0);
  });

  it('serializes verification before a revocation that starts after authorization', async () => {
    const { principal, team } = await seedWriter();
    const author = await createOtherAuthor();
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: 'team', type: 'fact', title: 'Ordered revocation',
      body: 'The locked authorization order must be stable.', authorId: author.id,
      source: 'manual',
    });
    const authorizationComplete = deferred<void>();
    const continueVerification = deferred<void>();
    const verifyPool = poolPausingAfterMembershipCheck(
      pool, authorizationComplete, continueVerification,
    );
    const revoker = await pool.connect();

    try {
      const verification = verifyForPrincipal(verifyPool, principal, source.id, true);
      await authorizationComplete.promise;
      const pidResult = await revoker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const revocation = revoker.query(
        'DELETE FROM scope_memberships WHERE principal_id = $1 AND scope_id = $2',
        [principal.id, team.id],
      );
      await waitForDatabaseLock(pool, pidResult.rows[0].pid);

      continueVerification.resolve();
      await verification;
      await revocation;
    } finally {
      continueVerification.resolve();
      revoker.release();
    }

    await expect(verifyForPrincipal(pool, principal, source.id, true))
      .rejects.toMatchObject<ServiceError>({ code: 'FORBIDDEN' });
  });

  it('allows only one of two concurrent promotions and creates one destination', async () => {
    const { principal, team } = await seedWriter();
    const project = await createScope(pool, { kind: 'project', name: 'concurrent' });
    await addMembership(pool, principal.id, project.id, 'writer');
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'decision', title: 'Promote once',
      body: 'Only one copy.', authorId: principal.id, source: 'manual',
    });

    const results = await Promise.allSettled([
      promoteForPrincipal(pool, principal, source.id, { kind: 'project', name: 'concurrent' }),
      promoteForPrincipal(pool, principal, source.id, { kind: 'project', name: 'concurrent' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'CONFLICT', status: 409 }),
    });
    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM memories
        WHERE metadata->>'promoted_from' = $1`,
      [source.id],
    );
    expect(rows[0].count).toBe(1);
  });

  it('rejects a sequential repeat promotion without creating another destination', async () => {
    const { principal, team } = await seedWriter();
    const project = await createScope(pool, { kind: 'project', name: 'repeat' });
    await addMembership(pool, principal.id, project.id, 'writer');
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'decision', title: 'Repeat once',
      body: 'Only one copy.', authorId: principal.id, source: 'manual',
    });

    await promoteForPrincipal(pool, principal, source.id, { kind: 'project', name: 'repeat' });
    await expect(promoteForPrincipal(
      pool, principal, source.id, { kind: 'project', name: 'repeat' },
    )).rejects.toMatchObject<ServiceError>({ code: 'CONFLICT', status: 409 });

    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM memories
        WHERE metadata->>'promoted_from' = $1`,
      [source.id],
    );
    expect(rows[0].count).toBe(1);
  });

  it('cannot restore live state when verify(true) races promotion', async () => {
    const { principal, team } = await seedWriter();
    const project = await createScope(pool, { kind: 'project', name: 'verify-race' });
    await addMembership(pool, principal.id, project.id, 'writer');
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'fact', title: 'Race state',
      body: 'Promotion wins eventually.', authorId: principal.id, source: 'manual',
    });
    const rowRead = deferred<void>();
    const releaseVerify = deferred<void>();
    const verifyPool = poolPausingAfterMemoryRead(pool, source.id, rowRead, releaseVerify);

    const verification = verifyForPrincipal(verifyPool, principal, source.id, true);
    await rowRead.promise;
    const promotion = promoteForPrincipal(
      pool, principal, source.id, { kind: 'project', name: 'verify-race' },
    );
    let promotionSettled = false;
    void promotion.finally(() => { promotionSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const settledBeforeVerifyReleased = promotionSettled;
    releaseVerify.resolve();
    await Promise.all([verification, promotion]);

    expect(settledBeforeVerifyReleased).toBe(false);
    const { rows } = await pool.query('SELECT state FROM memories WHERE id = $1', [source.id]);
    expect(rows[0].state).toBe('promoted');
  });

  it('cannot restore live state when verify(true) races archival', async () => {
    const { principal, team } = await seedWriter();
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'fact', title: 'Archive race',
      body: 'Archival wins eventually.', authorId: principal.id, source: 'manual',
    });
    const rowRead = deferred<void>();
    const releaseVerify = deferred<void>();
    const verifyPool = poolPausingAfterMemoryRead(pool, source.id, rowRead, releaseVerify);
    const archiver = await pool.connect();

    try {
      const verification = verifyForPrincipal(verifyPool, principal, source.id, true);
      await rowRead.promise;
      await archiver.query('BEGIN');
      const pidResult = await archiver.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const archive = archiver.query(
        `UPDATE memories SET state = 'archived', updated_at = now() WHERE id = $1`,
        [source.id],
      );
      await waitForDatabaseLock(pool, pidResult.rows[0].pid);

      releaseVerify.resolve();
      await verification;
      await archive;
      await archiver.query('COMMIT');
    } finally {
      releaseVerify.resolve();
      try {
        await archiver.query('ROLLBACK');
      } finally {
        archiver.release();
      }
    }

    const { rows } = await pool.query('SELECT state FROM memories WHERE id = $1', [source.id]);
    expect(rows[0].state).toBe('archived');
  });

  it('maps same-scope promotion to invalid input', async () => {
    const { principal, team } = await seedWriter();
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'fact', title: 'Same scope',
      body: 'Invalid destination.', authorId: principal.id, source: 'manual',
    });

    await expect(promoteForPrincipal(
      pool, principal, source.id, { kind: 'team', name: 'payments' },
    )).rejects.toMatchObject<ServiceError>({ code: 'INVALID_INPUT', status: 400 });
  });

  it('rejects overlong verification notes deterministically', async () => {
    const { principal, team } = await seedWriter();
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'fact', title: 'Bound note',
      body: 'No oversized audit note.', authorId: principal.id, source: 'manual',
    });

    await expect(verifyForPrincipal(
      pool, principal, source.id, true, 'x'.repeat(2001),
    )).rejects.toMatchObject<ServiceError>({ code: 'INVALID_INPUT', status: 400 });

    const { rows } = await pool.query(
      `SELECT last_verified,
              (SELECT count(*)::int FROM audit_log WHERE memory_id = $1) AS audits
         FROM memories WHERE id = $1`,
      [source.id],
    );
    expect(rows[0]).toEqual({ last_verified: null, audits: 0 });
  });

  it.each(['\u0000', '\u0007', '\u007f'])(
    'rejects unsafe verification note control %j without mutation or audit',
    async (control) => {
      const { principal, team } = await seedWriter();
      const source = await createMemory(pool, {
        scopeId: team.id, scopeKind: team.kind, type: 'fact', title: 'Safe note',
        body: 'No unsafe audit note.', authorId: principal.id, source: 'manual',
      });

      await expect(verifyForPrincipal(
        pool, principal, source.id, true, `unsafe${control}note`,
      )).rejects.toMatchObject<ServiceError>({
        code: 'INVALID_INPUT',
        status: 400,
        publicMessage: 'Verification note contains unsupported control characters',
      });

      const { rows } = await pool.query(
        `SELECT last_verified,
                (SELECT count(*)::int FROM audit_log WHERE memory_id = $1) AS audits
           FROM memories WHERE id = $1`,
        [source.id],
      );
      expect(rows[0]).toEqual({ last_verified: null, audits: 0 });
    },
  );

  it('accepts a 2000-character verification note and common whitespace', async () => {
    const { principal, team } = await seedWriter();
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'fact', title: 'Exact note bound',
      body: 'Boundary input.', authorId: principal.id, source: 'manual',
    });
    const note = `${'x'.repeat(1997)}\n\t\r`;

    await expect(verifyForPrincipal(pool, principal, source.id, true, note))
      .resolves.toMatchObject({ state: 'live' });
    const { rows } = await pool.query(
      'SELECT metadata FROM audit_log WHERE memory_id = $1', [source.id],
    );
    expect(rows[0].metadata.note).toBe(note);
  });

  it('rejects malformed recall scopes with a stable service code', async () => {
    const { principal } = await seedWriter();

    await expect(
      recallForPrincipal(pool, null, principal, {
        query: 'retry',
        scopes: ['team'],
      }),
    ).rejects.toMatchObject<ServiceError>({ code: 'INVALID_SCOPE', status: 400 });
  });
});

function poolWithQueryObserver(
  pool: pg.Pool,
  observe: (sql: string) => void,
): pg.Pool {
  return {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return async (...args: unknown[]) => {
              if (typeof args[0] === 'string') observe(args[0]);
              return (target.query as (...queryArgs: unknown[]) => unknown)(...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as pg.Pool;
}

async function capturePreflightQuery(sql: string) {
  if (sql.includes('FROM scopes')) {
    return {
      rows: [{ id: 'scope', kind: 'team', name: 'payments', created_at: new Date() }],
    };
  }
  if (sql.includes('FROM scope_memberships')) {
    return {
      rows: [{
        principal_id: 'principal', scope_id: 'scope', role: 'writer', added_at: new Date(),
      }],
    };
  }
  throw new Error(`unexpected preflight query: ${sql}`);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function poolWithClientCount(pool: pg.Pool, onCount: (count: number) => void): pg.Pool {
  let count = 0;
  return {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      count += 1;
      onCount(count);
      const release = client.release.bind(client);
      client.release = ((destroy?: boolean) => {
        count -= 1;
        onCount(count);
        release(destroy);
      }) as typeof client.release;
      return client;
    },
  } as unknown as pg.Pool;
}

function poolPausingAfterMemoryRead(
  pool: pg.Pool,
  memoryId: string,
  rowRead: ReturnType<typeof deferred<void>>,
  releaseRead: ReturnType<typeof deferred<void>>,
): pg.Pool {
  return {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return async (...args: unknown[]) => {
              const result = await (target.query as (...queryArgs: unknown[]) => Promise<unknown>)(...args);
              const sql = typeof args[0] === 'string' ? args[0] : '';
              const params = args[1] as unknown[] | undefined;
              if (sql.includes('FROM memories') && sql.includes('WHERE id = $1')
                && params?.[0] === memoryId) {
                rowRead.resolve();
                await releaseRead.promise;
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as pg.Pool;
}

function poolPausingBeforeMembershipCheck(
  pool: pg.Pool,
  targetCheck: number,
  checkReached: ReturnType<typeof deferred<void>>,
  releaseCheck: ReturnType<typeof deferred<void>>,
): pg.Pool {
  return {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      let membershipChecks = 0;
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return async (...args: unknown[]) => {
              const sql = typeof args[0] === 'string' ? args[0] : '';
              if (sql.includes('FROM scope_memberships') && sql.includes('FOR UPDATE')) {
                membershipChecks += 1;
                if (membershipChecks === targetCheck) {
                  checkReached.resolve();
                  await releaseCheck.promise;
                }
              }
              return (target.query as (...queryArgs: unknown[]) => unknown)(...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as pg.Pool;
}

function poolPausingAfterMembershipCheck(
  pool: pg.Pool,
  checkComplete: ReturnType<typeof deferred<void>>,
  releaseCheck: ReturnType<typeof deferred<void>>,
): pg.Pool {
  return {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return async (...args: unknown[]) => {
              const result = await (target.query as (...queryArgs: unknown[]) => Promise<unknown>)(
                ...args,
              );
              const sql = typeof args[0] === 'string' ? args[0] : '';
              if (sql.includes('FROM scope_memberships') && sql.includes('FOR UPDATE')) {
                checkComplete.resolve();
                await releaseCheck.promise;
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as pg.Pool;
}

async function waitForDatabaseLock(pool: pg.Pool, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await pool.query(
      'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid],
    );
    if (rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('revocation did not wait for the authorization lock');
}

function poolRejecting(pool: pg.Pool, sqlFragment: string): pg.Pool {
  const reject = (text: unknown): void => {
    if (typeof text === 'string' && text.includes(sqlFragment)) {
      throw new Error('database detail that must stay private');
    }
  };
  return {
    query: (async (...args: unknown[]) => {
      reject(args[0]);
      return (pool.query as (...queryArgs: unknown[]) => unknown)(...args);
    }) as pg.Pool['query'],
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return async (...args: unknown[]) => {
              reject(args[0]);
              return (target.query as (...queryArgs: unknown[]) => unknown)(...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as pg.Pool;
}
