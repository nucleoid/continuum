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
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';
import {
  promoteForPrincipal,
  VERIFICATION_NOTE_MAX_LENGTH,
  verifyForPrincipal,
} from './lifecycle.js';
import { ensureScopeForPrincipal } from './scopes.js';
import { standupForPrincipal } from './standup.js';
import { mapActorIdentity, revokeActorIdentity } from '../storage/actor-identities.js';

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

  it('rejects caller-supplied reserved relation metadata before side effects', async () => {
    const { principal } = await seedWriter();

    await expect(captureMemory(pool, null, principal, {
      scope: { kind: 'team', name: 'payments' },
      type: 'fact',
      title: 'Forged relation metadata',
      body: 'Must not persist.',
      source: 'manual',
      metadata: { related: [{ id: 'forged' }] },
    })).rejects.toMatchObject<ServiceError>({
      code: 'INVALID_INPUT',
      publicMessage: 'metadata.related is reserved by Continuum',
    });

    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM memories) AS memories,
         (SELECT count(*)::int FROM memory_embeddings) AS embeddings,
         (SELECT count(*)::int FROM audit_log) AS audits`,
    );
    expect(rows[0]).toEqual({ memories: 0, embeddings: 0, audits: 0 });
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

  it('computes once and persists an exact normalized duplicate candidate', async () => {
    const { principal } = await seedWriter();
    const embed = vi.fn(async () => [unitVector(1)]);
    const provider: EmbeddingProvider = { id: 'test:relations', dim: 768, embed };

    const first = await captureMemory(pool, provider, principal, {
      scope: { kind: 'team', name: 'payments' }, type: 'fact',
      title: ' Deploy policy ', body: 'No Fridays.\r\n', source: 'manual',
    });
    const second = await captureMemory(pool, provider, principal, {
      scope: { kind: 'team', name: 'payments' }, type: 'fact',
      title: 'deploy POLICY', body: ' No   Fridays. ', source: 'manual',
    });

    expect(embed).toHaveBeenCalledTimes(2);
    expect(first.related).toEqual([]);
    expect(second.related).toEqual([expect.objectContaining({
      id: first.memory.id, similarity: expect.closeTo(1, 8),
      relation: 'possible-duplicate', provider: provider.id, threshold: 0.92,
      detectedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })]);
    const stored = await pool.query('SELECT metadata FROM memories WHERE id = $1', [second.memory.id]);
    expect(stored.rows[0].metadata.related).toEqual(second.related);
  });

  it('returns the five highest same-family readable candidates and filters unsafe rows', async () => {
    const { principal, team } = await seedWriter();
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const other = await createScope(pool, { kind: 'team', name: 'private' });
    const author = await createOtherAuthor('relation-filter');
    const provider: EmbeddingProvider = {
      id: 'test:relation-filter', dim: 768, async embed() { return [unitVector(1)]; },
    };
    const valid: Array<{ id: string; similarity: number }> = [];
    for (const [index, similarity] of [0.99, 0.98, 0.97, 0.96, 0.95, 0.94].entries()) {
      const scope = index % 2 === 0 ? team : org;
      const memory = await createMemory(pool, {
        scopeId: scope.id, scopeKind: scope.kind, type: 'fact',
        title: `Visible ${index}`, body: `Candidate ${index}`,
        authorId: author.id, source: 'manual',
      });
      await storeMemoryEmbeddingVector(pool, memory.id, unitVector(similarity), provider);
      valid.push({ id: memory.id, similarity });
    }
    const unsafe = [] as Array<Awaited<ReturnType<typeof createMemory>>>;
    for (const [scope, title] of [
      [other, 'private-title-marker'],
      [team, 'stale-title-marker'],
      [team, 'expired-title-marker'],
      [team, 'wrong-provider-title-marker'],
      [team, 'wrong-dimension-title-marker'],
    ] as const) {
      const memory = await createMemory(pool, {
        scopeId: scope.id, scopeKind: scope.kind, type: 'fact', title,
        body: `${title}-body`, authorId: author.id, source: 'manual',
      });
      await storeMemoryEmbeddingVector(pool, memory.id, unitVector(0.999), provider);
      unsafe.push(memory);
    }
    await pool.query("UPDATE memories SET state = 'stale' WHERE id = $1", [unsafe[1].id]);
    await pool.query("UPDATE memories SET expires_at = now() - interval '1 second' WHERE id = $1", [unsafe[2].id]);
    await pool.query("UPDATE memory_embeddings SET provider = 'other:provider' WHERE memory_id = $1", [unsafe[3].id]);
    await pool.query('UPDATE memory_embeddings SET dim = 767 WHERE memory_id = $1', [unsafe[4].id]);

    const result = await captureMemory(pool, provider, principal, {
      scope: { kind: 'team', name: 'payments' }, type: 'fact',
      title: 'Incoming policy', body: 'Incoming candidate body', source: 'manual',
    });

    expect(result.related.map((item) => item.id)).toEqual(valid.slice(0, 5).map((item) => item.id));
    expect(result.related.map((item) => item.similarity)).toEqual(
      valid.slice(0, 5).map((item) => expect.closeTo(item.similarity, 6)),
    );
    expect(result.related.every((item) => item.relation === 'possible-conflict')).toBe(true);
    const serialized = JSON.stringify(result);
    for (const marker of ['private-title-marker', 'stale-title-marker', 'expired-title-marker',
      'wrong-provider-title-marker', 'wrong-dimension-title-marker']) {
      expect(serialized).not.toContain(marker);
    }
  });

  it('honours an explicit threshold and does not return an unrelated candidate', async () => {
    const { principal, team } = await seedWriter();
    const author = await createOtherAuthor('threshold');
    const provider: EmbeddingProvider = {
      id: 'test:threshold', dim: 768, async embed() { return [unitVector(1)]; },
    };
    const candidate = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'context', title: 'Nearby',
      body: 'Below the default.', authorId: author.id, source: 'manual',
    });
    await storeMemoryEmbeddingVector(pool, candidate.id, unitVector(0.91), provider);

    const defaultResult = await captureMemory(pool, provider, principal, {
      scope: { kind: 'team', name: 'payments' }, type: 'context',
      title: 'Default', body: 'No candidate.', source: 'manual',
    });
    const loweredResult = await captureMemory(pool, provider, principal, {
      scope: { kind: 'team', name: 'payments' }, type: 'context',
      title: 'Lowered', body: 'Candidate.', source: 'manual',
    }, {}, { relationThreshold: 0.9 });

    expect(defaultResult.related).toEqual([]);
    expect(loweredResult.related.map((item) => item.id)).toEqual([
      defaultResult.memory.id,
      candidate.id,
    ]);
    expect(loweredResult.related).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: candidate.id, relation: 'possible-duplicate', threshold: 0.9,
      }),
    ]));
  });

  it('commits the provider embedding with empty relations and sanitized audit when probing fails', async () => {
    const { principal } = await seedWriter();
    const provider: EmbeddingProvider = {
      id: 'test:probe-failure', dim: 768, async embed() { return [unitVector(1)]; },
    };

    const result = await captureMemory(
      poolRejecting(pool, 'SELECT m.id, m.type, m.title'), provider, principal,
      {
        scope: { kind: 'team', name: 'payments' }, type: 'fact',
        title: 'Probe fallback', body: 'private-probe-body', source: 'manual',
      },
    );

    expect(result).toMatchObject({
      embedded: true, related: [], relationErrorCode: 'RELATION_DETECTION_FAILED',
    });
    const { rows } = await pool.query(
      `SELECT a.metadata::text AS metadata,
              EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.memory_id = a.memory_id)
                AS embedded
         FROM audit_log a WHERE memory_id = $1`,
      [result.memory.id],
    );
    expect(rows[0].embedded).toBe(true);
    expect(rows[0].metadata).toContain('RELATION_DETECTION_FAILED');
    expect(rows[0].metadata).not.toContain('database detail');
    expect(rows[0].metadata).not.toContain('private-probe-body');
  });

  it('documents the v0 race by allowing concurrent duplicates to miss each other', async () => {
    const { principal } = await seedWriter();
    const provider: EmbeddingProvider = {
      id: 'test:concurrency', dim: 768, async embed() { return [unitVector(1)]; },
    };
    const synchronizedPool = poolSynchronizingRelationProbes(pool, 2);

    const results = await Promise.all(['one', 'two'].map((suffix) => captureMemory(
      synchronizedPool, provider, principal, {
        scope: { kind: 'team', name: 'payments' }, type: 'fact',
        title: 'Concurrent duplicate', body: 'Same content.',
        source: 'manual', sourceRef: suffix,
      },
    )));

    expect(results.map((result) => result.related)).toEqual([[], []]);
    expect(results.every((result) => result.embedded)).toBe(true);
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

  it('recovers when related metadata persistence fails after embedding storage', async () => {
    const { principal } = await seedWriter();
    const provider: EmbeddingProvider = {
      id: 'test:metadata-failure', dim: 768, async embed() { return [unitVector(1)]; },
    };

    const result = await captureMemory(
      poolRejecting(pool, 'UPDATE memories'), provider, principal,
      {
        scope: { kind: 'team', name: 'payments' }, type: 'fact',
        title: 'Metadata fallback', body: 'Capture still commits.', source: 'manual',
      },
    );

    expect(result).toMatchObject({
      embedded: true, related: [], relationErrorCode: 'RELATION_DETECTION_FAILED',
    });
    const { rows } = await pool.query(
      `SELECT m.metadata,
              EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id) AS embedded,
              a.metadata AS audit_metadata
         FROM memories m
         JOIN audit_log a ON a.memory_id = m.id
        WHERE m.id = $1`,
      [result.memory.id],
    );
    expect(rows).toEqual([{
      metadata: { related: [] },
      embedded: true,
      audit_metadata: {
        source: 'manual', type: 'fact', embedded: true,
        embedding: { provider: 'test:metadata-failure', dim: 768, status: 'succeeded' },
        relation_error_code: 'RELATION_DETECTION_FAILED',
      },
    }]);
  });

  it('maps invalid programmatic relation configuration to a safe internal error', async () => {
    const { principal } = await seedWriter();

    await expect(captureMemory(pool, null, principal, {
      scope: { kind: 'team', name: 'payments' }, type: 'fact',
      title: 'Invalid threshold', body: 'Must not persist.', source: 'manual',
    }, {}, { relationThreshold: Number.NaN })).rejects.toMatchObject<ServiceError>({
      code: 'INTERNAL', publicMessage: 'An internal error occurred',
    });

    const { rows } = await pool.query('SELECT count(*)::int AS count FROM memories');
    expect(rows[0].count).toBe(0);
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

  it.each(['live', 'promoted', 'archived'] as const)(
    'returns the same forbidden response to an unauthorized principal for a %s memory',
    async (state) => {
      const { team } = await seedWriter();
      const unauthorized = await createOtherAuthor(`unauthorized-${state}`);
      const author = await createOtherAuthor(`author-${state}`);
      const source = await createMemory(pool, {
        scopeId: team.id, scopeKind: team.kind, type: 'fact', title: `${state} private fact`,
        body: 'Terminal state must not be disclosed.', authorId: author.id, source: 'manual',
      });
      if (state !== 'live') {
        await pool.query('UPDATE memories SET state = $2 WHERE id = $1', [source.id, state]);
      }

      await expect(verifyForPrincipal(pool, unauthorized, source.id, true, 'no-op'))
        .rejects.toMatchObject<ServiceError>({
          code: 'FORBIDDEN',
          status: 403,
          publicMessage: 'principal lacks writer role on source scope',
        });
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

  it('strips scope-bound relation candidates when promoting metadata', async () => {
    const { principal, team } = await seedWriter();
    const project = await createScope(pool, { kind: 'project', name: 'promotion-metadata' });
    await addMembership(pool, principal.id, project.id, 'writer');
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'decision', title: 'Promote safely',
      body: 'Candidate ids are scoped to the source visibility set.',
      authorId: principal.id, source: 'manual',
      metadata: { owner: 'payments', related: [{ id: 'narrow-scope-memory' }] },
    });

    const result = await promoteForPrincipal(
      pool, principal, source.id, { kind: 'project', name: 'promotion-metadata' },
    );

    expect(result.destination.metadata).toEqual({
      owner: 'payments', promoted_from: source.id,
    });
  });

  it('preserves trusted standup activity at its original time and strips forged legacy metadata', async () => {
    const { principal, team } = await seedWriter();
    const project = await createScope(pool, { kind: 'project', name: 'promotion-activity' });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, principal.id, org!.id, 'admin');
    await addMembership(pool, principal.id, project.id, 'writer');
    await mapActorIdentity(pool, {
      authority: 'terminal-summary.producer', externalActorId: 'promotion-actor',
      principalId: principal.id, mappedByPrincipalId: principal.id,
    });
    const mapping = await pool.query<{ mapping_id: string }>(
      `SELECT mapping_id FROM actor_principal_mappings
        WHERE authority = 'terminal-summary.producer' AND external_actor_id = 'promotion-actor'`,
    );
    const mappingId = mapping.rows[0]!.mapping_id;
    const source = await createMemory(pool, {
      // A decision would ordinarily never expire in the project destination. The trusted
      // activity's source expiry must still remain an absolute ceiling after promotion.
      scopeId: team.id, scopeKind: team.kind, type: 'decision', title: 'Old activity',
      body: 'Promotion is knowledge movement, not a new activity event.',
      authorId: principal.id, source: 'terminal-summary',
      metadata: {
        owner: 'payments', actor: 'actor-label', actor_principal_id: principal.id,
        thread_owner_principal_id: principal.id, thread_key: 'terminal:old',
        closes_thread_keys: ['terminal:older'],
        _continuum_activity_provenance: 'capture-v1',
        _continuum_actor_mapping_id: mappingId,
        _continuum_actor_mapping_authority: 'terminal-summary.producer',
      },
    });
    const activityAt = new Date('2026-10-05T08:00:00.000Z');
    const sourceExpiry = new Date('2026-10-07T08:00:00.000Z');
    await pool.query(
      'UPDATE memories SET created_at = $2, updated_at = $2, expires_at = $3 WHERE id = $1',
      [source.id, activityAt, sourceExpiry],
    );

    const result = await promoteForPrincipal(
      pool, principal, source.id, { kind: 'project', name: 'promotion-activity' },
    );

    expect(result.destination.metadata).toMatchObject({
      owner: 'payments', promoted_from: source.id,
      actor: 'actor-label', actor_principal_id: principal.id,
      thread_owner_principal_id: principal.id, thread_key: 'terminal:old',
      closes_thread_keys: ['terminal:older'],
      _continuum_activity_provenance: 'capture-v1',
      _continuum_activity_epoch_ms: activityAt.getTime(),
      _continuum_actor_mapping_id: mappingId,
      _continuum_actor_mapping_authority: 'terminal-summary.producer',
    });
    expect(result.destination.expiresAt).toEqual(sourceExpiry);
    const standup = await standupForPrincipal(pool, principal, { sinceHours: 24 }, {
      now: new Date('2026-10-05T12:00:00.000Z'),
    });
    expect(standup.activity).toEqual([
      expect.objectContaining({ id: result.destination.id, createdAt: activityAt }),
    ]);

    const legacy = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'context', title: 'Forged legacy activity',
      body: 'Legacy caller-owned fields have no internal provenance.',
      authorId: principal.id, source: 'manual',
      metadata: {
        owner: 'payments', actor: 'forged', actor_principal_id: principal.id,
        thread_owner_principal_id: principal.id, thread_key: 'legacy:forged',
        closes_thread_keys: ['victim:thread'],
        _continuum_actor_mapping_id: '22222222-2222-4222-8222-222222222222',
        _continuum_actor_mapping_authority: 'forged.authority',
      },
    });
    const legacyResult = await promoteForPrincipal(
      pool, principal, legacy.id, { kind: 'project', name: 'promotion-activity' },
    );
    expect(legacyResult.destination.metadata).toEqual({
      owner: 'payments', promoted_from: legacy.id,
    });

    const expired = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'context', title: 'Expired activity',
      body: 'Expired activity must not regain standup eligibility through promotion.',
      authorId: principal.id, source: 'terminal-summary',
      metadata: {
        owner: 'payments', actor: 'actor-label', actor_principal_id: principal.id,
        thread_owner_principal_id: principal.id, thread_key: 'terminal:expired',
        closes_thread_keys: [], _continuum_activity_provenance: 'capture-v1',
        _continuum_actor_mapping_id: mappingId,
        _continuum_actor_mapping_authority: 'terminal-summary.producer',
      },
    });
    await pool.query(
      `UPDATE memories SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [expired.id],
    );
    const expiredResult = await promoteForPrincipal(
      pool, principal, expired.id, { kind: 'project', name: 'promotion-activity' },
    );
    expect(expiredResult.destination.metadata).toEqual({
      owner: 'payments', promoted_from: expired.id,
    });

    await revokeActorIdentity(pool, {
      authority: 'terminal-summary.producer', externalActorId: 'promotion-actor',
      revokedByPrincipalId: principal.id,
    });
    const revoked = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'context', title: 'Revoked activity',
      body: 'A revoked mapping is not durable promotion authority.',
      authorId: principal.id, source: 'terminal-summary',
      metadata: {
        owner: 'payments', actor: 'actor-label', actor_principal_id: principal.id,
        thread_owner_principal_id: principal.id, thread_key: 'terminal:revoked',
        _continuum_activity_provenance: 'capture-v1',
        _continuum_actor_mapping_id: mappingId,
        _continuum_actor_mapping_authority: 'terminal-summary.producer',
      },
    });
    const revokedResult = await promoteForPrincipal(
      pool, principal, revoked.id, { kind: 'project', name: 'promotion-activity' },
    );
    expect(revokedResult.destination.metadata).toEqual({
      owner: 'payments', promoted_from: revoked.id,
    });
  });

  it('strips provenance-only standup metadata during promotion', async () => {
    const { principal, team } = await seedWriter();
    const project = await createScope(pool, { kind: 'project', name: 'promotion-unmapped' });
    await addMembership(pool, principal.id, project.id, 'writer');
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'context', title: 'Unmapped activity',
      body: 'A provenance marker alone is not authorization.',
      authorId: principal.id, source: 'terminal-summary',
      metadata: {
        owner: 'payments', actor: 'forged', actor_principal_id: principal.id,
        thread_owner_principal_id: principal.id, thread_key: 'legacy:unmapped',
        closes_thread_keys: ['victim:thread'],
        _continuum_activity_provenance: 'capture-v1',
      },
    });

    const result = await promoteForPrincipal(
      pool, principal, source.id, { kind: 'project', name: 'promotion-unmapped' },
    );

    expect(result.destination.metadata).toEqual({
      owner: 'payments', promoted_from: source.id,
    });
  });

  it('rejects provenance-only activity and forged closure evidence without an exact mapping', async () => {
    const { principal } = await seedWriter();
    const project = await createScope(pool, { kind: 'project', name: 'mapping-required' });
    await addMembership(pool, principal.id, project.id, 'writer');
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    await addMembership(pool, principal.id, org!.id, 'admin');
    await mapActorIdentity(pool, {
      authority: 'terminal-summary.producer', externalActorId: 'standup-real-actor',
      principalId: principal.id, mappedByPrincipalId: principal.id,
    });
    const mapping = await pool.query<{ mapping_id: string }>(
      `SELECT mapping_id FROM actor_principal_mappings
        WHERE authority = 'terminal-summary.producer'
          AND external_actor_id = 'standup-real-actor'`,
    );
    const common = {
      actor: 'actual-user', actor_principal_id: principal.id,
      thread_owner_principal_id: principal.id,
      _continuum_activity_provenance: 'capture-v1',
    };
    const open = await createMemory(pool, {
      scopeId: project.id, scopeKind: project.kind, type: 'context', title: 'Mapped open thread',
      body: 'This thread remains open.', authorId: principal.id, source: 'terminal-summary',
      metadata: {
        ...common, thread_key: 'thread:mapped-open',
        _continuum_actor_mapping_id: mapping.rows[0]!.mapping_id,
        _continuum_actor_mapping_authority: 'terminal-summary.producer',
      },
    });
    const provenanceOnly = await createMemory(pool, {
      scopeId: project.id, scopeKind: project.kind, type: 'context', title: 'Forged activity',
      body: 'No mapping authorizes this row.', authorId: principal.id, source: 'terminal-summary',
      metadata: { ...common, thread_key: 'thread:forged-activity' },
    });
    await createMemory(pool, {
      scopeId: project.id, scopeKind: project.kind, type: 'context', title: 'Forged closure',
      body: 'No mapping authorizes this closure.', authorId: principal.id,
      source: 'terminal-summary', metadata: {
        ...common, thread_key: 'thread:forged-closure',
        closes_thread_keys: ['thread:mapped-open'],
        _continuum_actor_mapping_id: mapping.rows[0]!.mapping_id,
        _continuum_actor_mapping_authority: 'forged.authority',
      },
    });
    await pool.query(
      `UPDATE memories
          SET created_at = CASE
            WHEN id = $1 THEN '2026-09-30T08:00:00Z'::timestamptz
            ELSE '2026-10-05T08:00:00Z'::timestamptz
          END
        WHERE id IN ($1, $2) OR title = 'Forged closure'`,
      [open.id, provenanceOnly.id],
    );

    const digest = await standupForPrincipal(pool, principal, {
      sinceHours: 24, openThreadDays: 2,
    }, { now: new Date('2026-10-05T12:00:00.000Z') });

    expect(digest.activity.map((item) => item.id)).not.toContain(provenanceOnly.id);
    expect(digest.openThreads.map((item) => item.id)).toContain(open.id);
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

  it.each([
    { label: 'lone high surrogate', note: 'unsafe\ud800note' },
    { label: 'lone low surrogate', note: 'unsafe\udc00note' },
  ])('rejects a $label without mutation or audit', async ({ note }) => {
    const { principal, team } = await seedWriter();
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'fact', title: 'Unicode note',
      body: 'No malformed Unicode audit note.', authorId: principal.id, source: 'manual',
    });

    await expect(verifyForPrincipal(
      pool, principal, source.id, true, note,
    )).rejects.toMatchObject<ServiceError>({
      code: 'INVALID_INPUT',
      status: 400,
      publicMessage: 'Verification note contains invalid Unicode',
    });

    const { rows } = await pool.query(
      `SELECT last_verified,
              (SELECT count(*)::int FROM audit_log WHERE memory_id = $1) AS audits
         FROM memories WHERE id = $1`,
      [source.id],
    );
    expect(rows[0]).toEqual({ last_verified: null, audits: 0 });
  });

  it('rejects a trailing lone high surrogate without mutation or audit', async () => {
    const { principal, team } = await seedWriter();
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'fact', title: 'Trailing surrogate note',
      body: 'No malformed Unicode audit note.', authorId: principal.id, source: 'manual',
    });

    await expect(verifyForPrincipal(
      pool, principal, source.id, true, 'unsafe\ud800',
    )).rejects.toMatchObject<ServiceError>({
      code: 'INVALID_INPUT',
      status: 400,
      publicMessage: 'Verification note contains invalid Unicode',
    });

    const { rows } = await pool.query(
      `SELECT last_verified,
              (SELECT count(*)::int FROM audit_log WHERE memory_id = $1) AS audits
         FROM memories WHERE id = $1`,
      [source.id],
    );
    expect(rows[0]).toEqual({ last_verified: null, audits: 0 });
  });

  it('accepts and preserves an astral character at the 2000 UTF-16-unit boundary', async () => {
    const { principal, team } = await seedWriter();
    const source = await createMemory(pool, {
      scopeId: team.id, scopeKind: team.kind, type: 'fact', title: 'Exact note bound',
      body: 'Boundary input.', authorId: principal.id, source: 'manual',
    });
    const note = `${'x'.repeat(1995)}\ud83d\ude00\n\t\r`;
    expect(note.length).toBe(VERIFICATION_NOTE_MAX_LENGTH);

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

function unitVector(similarity: number): number[] {
  const vector = Array(768).fill(0) as number[];
  vector[0] = similarity;
  vector[1] = Math.sqrt(1 - similarity * similarity);
  return vector;
}

function poolSynchronizingRelationProbes(pool: pg.Pool, expected: number): pg.Pool {
  let reached = 0;
  const allReached = deferred<void>();
  return {
    connect: pool.connect.bind(pool),
    query: (async (...args: unknown[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : '';
      if (sql.includes('SELECT m.id, m.type, m.title')) {
        reached += 1;
        if (reached === expected) allReached.resolve();
        await allReached.promise;
      }
      return (pool.query as (...queryArgs: unknown[]) => unknown)(...args);
    }) as pg.Pool['query'],
  } as unknown as pg.Pool;
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
