import { readFile } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { addMembership } from './memberships.js';
import { mapActorIdentity } from './actor-identities.js';
import { createMemory } from './memories.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { makeTestPool, resetData } from './test-helpers.js';

describe('standup mapping enforcement storage', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => pool?.end());

  async function seedMapping() {
    const principal = await createPrincipal(pool, {
      externalId: 'entra:standup-storage', kind: 'user', displayName: 'Standup Storage',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const project = await createScope(pool, { kind: 'project', name: 'standup-storage' });
    await addMembership(pool, principal.id, org.id, 'admin');
    await addMembership(pool, principal.id, project.id, 'writer');
    await mapActorIdentity(pool, {
      authority: 'terminal-summary.storage-test', externalActorId: principal.id,
      principalId: principal.id, mappedByPrincipalId: principal.id,
    });
    const mapping = await pool.query<{ mapping_id: string }>(
      `SELECT mapping_id FROM actor_principal_mappings
        WHERE authority = 'terminal-summary.storage-test' AND external_actor_id = $1`,
      [principal.id],
    );
    return { principal, project, mappingId: mapping.rows[0]!.mapping_id };
  }

  it('strips reserved activity and closure keys from rows without an active exact mapping', async () => {
    const { principal, project, mappingId } = await seedMapping();
    const base = {
      ordinary: 'retained', actor: 'actor', actor_principal_id: principal.id,
      thread_owner_principal_id: principal.id, closes_thread_keys: ['thread:victim'],
      _continuum_activity_provenance: 'capture-v1',
    };
    const trusted = await createMemory(pool, {
      scopeId: project.id, scopeKind: project.kind, type: 'context', title: 'Trusted',
      body: 'trusted body', authorId: principal.id, source: 'terminal-summary',
      metadata: {
        ...base, thread_key: 'thread:trusted',
        _continuum_actor_mapping_id: mappingId,
        _continuum_actor_mapping_authority: 'terminal-summary.storage-test',
      },
    });
    const provenanceOnly = await createMemory(pool, {
      scopeId: project.id, scopeKind: project.kind, type: 'context', title: 'Legacy',
      body: 'legacy body', authorId: principal.id, source: 'terminal-summary',
      metadata: { ...base, thread_key: 'thread:legacy' },
    });
    const forged = await createMemory(pool, {
      scopeId: project.id, scopeKind: project.kind, type: 'context', title: 'Forged',
      body: 'forged body', authorId: principal.id, source: 'terminal-summary',
      metadata: {
        ...base, thread_key: 'thread:forged',
        _continuum_actor_mapping_id: '22222222-2222-4222-8222-222222222222',
        _continuum_actor_mapping_authority: 'terminal-summary.storage-test',
      },
    });

    const migration = await readFile(
      new URL('../../migrations/0010_standup_mapping_enforcement.sql', import.meta.url),
      'utf8',
    );
    await pool.query(migration);

    const result = await pool.query<{ id: string; body: string; metadata: Record<string, unknown> }>(
      'SELECT id, body, metadata FROM memories WHERE id = ANY($1::uuid[]) ORDER BY title',
      [[trusted.id, provenanceOnly.id, forged.id]],
    );
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    expect(byId.get(trusted.id)!.metadata).toMatchObject({
      ordinary: 'retained', thread_key: 'thread:trusted',
      _continuum_actor_mapping_id: mappingId,
    });
    for (const id of [provenanceOnly.id, forged.id]) {
      expect(byId.get(id)!.metadata).toEqual({ ordinary: 'retained' });
      expect(byId.get(id)!.body).toMatch(/body$/);
    }
  });

  it('uses the closure containment index for a selective realistic lookup', async () => {
    const { principal, project, mappingId } = await seedMapping();
    await pool.query(
      `INSERT INTO memories
         (id, scope_id, type, title, body, metadata, author_id, source, state)
       SELECT gen_random_uuid(), $1, 'context', 'Closure ' || n, 'body',
              jsonb_build_object(
                'actor_principal_id', $2::text,
                'thread_key', 'thread:closure:' || n,
                'closes_thread_keys', jsonb_build_array(
                  CASE WHEN n <= 10 THEN 'thread:target' ELSE 'thread:other:' || n END
                ),
                '_continuum_activity_provenance', 'capture-v1',
                '_continuum_actor_mapping_id', $3::text,
                '_continuum_actor_mapping_authority', 'terminal-summary.storage-test'
              ),
              $2::uuid, 'terminal-summary', 'live'
         FROM generate_series(1, 2500) AS n`,
      [project.id, principal.id, mappingId],
    );
    await pool.query('ANALYZE memories');

    const plan = await pool.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (FORMAT JSON)
       SELECT id
         FROM memories
        WHERE metadata->>'_continuum_activity_provenance' = 'capture-v1'
          AND metadata ? 'closes_thread_keys'
          AND metadata->'closes_thread_keys' @> '["thread:target"]'::jsonb`,
    );

    expect(JSON.stringify(plan.rows[0]!['QUERY PLAN']))
      .toContain('memories_standup_closures_gin');
  });
});
