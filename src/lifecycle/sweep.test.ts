import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { createMemory, getMemory } from '../storage/memories.js';
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';
import { addMembership } from '../storage/memberships.js';
import { mapOwnedUserScope } from '../services/offboarding.js';
import { LIFECYCLE_PRINCIPAL_ID } from './principal.js';
import { previewLifecycle, sweepLifecycle, sweepLifecycleBatch } from './sweep.js';

describe('lifecycle sweeper', () => {
  let pool: pg.Pool;
  const now = new Date('2026-10-04T12:00:00.000Z');

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function seed(type: 'fact' | 'decision' | 'context' | 'playbook' | 'relationship', expiresAt: Date | null) {
    let author = await createPrincipal(pool, {
      externalId: `author:${type}:${Math.random()}`,
      kind: 'user',
      displayName: 'Author',
    });
    const scope = await createScope(pool, { kind: 'project', name: `${type}-${Math.random()}` });
    const memory = await createMemory(pool, {
      scopeId: scope.id,
      scopeKind: scope.kind,
      type,
      title: type,
      body: 'body',
      authorId: author.id,
      source: 'manual',
    });
    await pool.query(
      `UPDATE memories SET expires_at = $2, created_at = $3, updated_at = $3 WHERE id = $1`,
      [memory.id, expiresAt, new Date('2026-01-01T00:00:00Z')],
    );
    return { memory, scope, author };
  }

  it('transitions only expired live lifecycle types at the exact boundary', async () => {
    const context = await seed('context', now);
    const fact = await seed('fact', new Date(now.getTime() - 1));
    const relationship = await seed('relationship', now);
    const future = await seed('fact', new Date(now.getTime() + 1));
    const decision = await seed('decision', new Date(now.getTime() - 1));
    const playbook = await seed('playbook', new Date(now.getTime() - 1));
    await storeMemoryEmbeddingVector(
      pool, context.memory.id, new Array(768).fill(0), { id: 'stub', dim: 768 },
    );

    const result = await sweepLifecycleBatch(pool, { now, batchSize: 20 });

    expect(result).toEqual({
      selected: 3,
      transitioned: 3,
      counts: { 'archive:context': 1, 'stale:fact': 1, 'stale:relationship': 1 },
    });
    expect((await getMemory(pool, context.memory.id))?.state).toBe('archived');
    expect((await getMemory(pool, fact.memory.id))?.state).toBe('stale');
    expect((await getMemory(pool, relationship.memory.id))?.state).toBe('stale');
    expect((await getMemory(pool, future.memory.id))?.state).toBe('live');
    expect((await getMemory(pool, decision.memory.id))?.state).toBe('live');
    expect((await getMemory(pool, playbook.memory.id))?.state).toBe('live');
    expect((await pool.query('SELECT 1 FROM memory_embeddings WHERE memory_id = $1', [context.memory.id])).rowCount).toBe(0);

    const audits = await pool.query(
      `SELECT p.id AS principal_id, p.external_id, a.action, a.memory_id, a.metadata
         FROM audit_log a JOIN principals p ON p.id = a.principal_id
        ORDER BY a.memory_id`,
    );
    expect(audits.rows).toHaveLength(3);
    expect(audits.rows.every((row) => row.principal_id === LIFECYCLE_PRINCIPAL_ID)).toBe(true);
    expect(audits.rows.every((row) => row.external_id === null)).toBe(true);
    expect(audits.rows.map((row) => row.action).sort()).toEqual(['archive', 'verify', 'verify']);
    expect(audits.rows.every((row) => row.metadata.source === 'lifecycle')).toBe(true);
  });

  it('keeps the lifecycle actor noninteractive and membership-free', async () => {
    const scope = await createScope(pool, { kind: 'project', name: 'reserved-actor' });
    const lifecycle = await pool.query(
      `SELECT id, external_id, kind FROM principals WHERE id = $1`,
      [LIFECYCLE_PRINCIPAL_ID],
    );
    expect(lifecycle.rows).toEqual([{
      id: LIFECYCLE_PRINCIPAL_ID,
      external_id: null,
      kind: 'service',
    }]);
    await expect(addMembership(pool, LIFECYCLE_PRINCIPAL_ID, scope.id, 'reader'))
      .rejects.toThrow('system:lifecycle cannot have scope memberships');
    await expect(createPrincipal(pool, {
      externalId: 'system:lifecycle',
      kind: 'service',
      displayName: 'Impostor',
    })).rejects.toThrow('principals_lifecycle_identity_check');
  });

  it('dry-run reports bounded grouped counts without writes', async () => {
    const first = await seed('context', now);
    const second = await seed('fact', now);
    await seed('relationship', now);

    const result = await sweepLifecycleBatch(pool, { now, batchSize: 2, dryRun: true });

    expect(result.selected).toBe(2);
    expect(result.transitioned).toBe(0);
    expect(Object.values(result.counts).reduce((sum, count) => sum + count, 0)).toBe(2);
    expect((await getMemory(pool, first.memory.id))?.state).toBe('live');
    expect((await getMemory(pool, second.memory.id))?.state).toBe('live');
    expect((await pool.query('SELECT 1 FROM audit_log')).rowCount).toBe(0);
  });

  it('is idempotent and concurrent sweepers claim each memory once', async () => {
    const memories = await Promise.all(Array.from({ length: 8 }, () => seed('fact', now)));
    const [left, right] = await Promise.all([
      sweepLifecycleBatch(pool, { now, batchSize: 4 }),
      sweepLifecycleBatch(pool, { now, batchSize: 4 }),
    ]);
    expect(left.transitioned + right.transitioned).toBe(8);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log WHERE memory_id = ANY($1::uuid[])`,
      [memories.map(({ memory }) => memory.id)],
    )).rows[0].count).toBe(8);
    expect((await sweepLifecycleBatch(pool, { now, batchSize: 20 })).transitioned).toBe(0);
  });

  it('processes a one-shot run in bounded batches and previews all groups', async () => {
    await Promise.all([
      seed('context', now), seed('context', now), seed('fact', now),
      seed('fact', now), seed('relationship', now),
    ]);
    const preview = await previewLifecycle(pool, now);
    expect(preview).toEqual({
      selected: 5,
      transitioned: 0,
      counts: { 'archive:context': 2, 'stale:fact': 2, 'stale:relationship': 1 },
    });

    const result = await sweepLifecycle(pool, { now, batchSize: 2 });
    expect(result).toEqual({
      selected: 5,
      transitioned: 5,
      counts: { 'archive:context': 2, 'stale:fact': 2, 'stale:relationship': 1 },
      batches: 3,
    });
  });

  it('skips fenced owned scopes without stalling eligible scopes', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'sweep-offboarding-admin', kind: 'user', displayName: 'Admin',
    });
    const owner = await createPrincipal(pool, {
      externalId: 'sweep-offboarding-owner', kind: 'user', displayName: 'Owner',
    });
    const org = await pool.query("SELECT id FROM scopes WHERE kind = 'org' AND name = ''");
    const owned = await createScope(pool, { kind: 'user', name: 'fenced-lifecycle' });
    await addMembership(pool, admin.id, org.rows[0].id, 'admin');
    await addMembership(pool, owner.id, owned.id, 'writer');
    await mapOwnedUserScope(pool, admin, owner.id, owned.id);
    const fenced = await createMemory(pool, {
      scopeId: owned.id, scopeKind: 'user', type: 'context', title: 'private', body: 'private',
      authorId: owner.id, source: 'manual',
    });
    await pool.query('UPDATE memories SET expires_at = $2 WHERE id = $1', [fenced.id, now]);
    await pool.query(
      'UPDATE principals SET offboarded_at = now(), disabled_at = now() WHERE id = $1',
      [owner.id],
    );
    const eligible = await seed('context', now);

    const result = await sweepLifecycleBatch(pool, { now, batchSize: 10 });

    expect(result).toMatchObject({ selected: 1, transitioned: 1 });
    expect((await getMemory(pool, fenced.id))?.state).toBe('live');
    expect((await getMemory(pool, eligible.memory.id))?.state).toBe('archived');
  });

  it('rolls back state and embedding deletion when an audit insert fails', async () => {
    const context = await seed('context', now);
    await storeMemoryEmbeddingVector(
      pool, context.memory.id, new Array(768).fill(0), { id: 'stub', dim: 768 },
    );
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_lifecycle_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.metadata->>'source' = 'lifecycle' THEN
          RAISE EXCEPTION 'expected lifecycle audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_lifecycle_audit_trigger
        BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_audit();
    `);
    try {
      await expect(sweepLifecycleBatch(pool, { now, batchSize: 1 }))
        .rejects.toThrow('expected lifecycle audit failure');
      expect((await getMemory(pool, context.memory.id))?.state).toBe('live');
      expect((await pool.query('SELECT 1 FROM memory_embeddings WHERE memory_id = $1', [context.memory.id])).rowCount).toBe(1);
    } finally {
      await pool.query('DROP TRIGGER reject_lifecycle_audit_trigger ON audit_log; DROP FUNCTION reject_lifecycle_audit()');
    }
  });
});
