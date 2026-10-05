import { readFile } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { addMembership } from './memberships.js';
import { createMemory } from './memories.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { makeTestPool, resetData } from './test-helpers.js';

describe('standup remediation database boundary', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => pool?.end());

  it('rejects reserved provenance written through the legacy memory path', async () => {
    const writer = await createPrincipal(pool, {
      externalId: 'service:legacy-writer', kind: 'service', displayName: 'Legacy writer',
    });
    const project = await createScope(pool, { kind: 'project', name: 'legacy-writer' });
    await addMembership(pool, writer.id, project.id, 'writer');

    await expect(createMemory(pool, {
      scopeId: project.id,
      scopeKind: project.kind,
      type: 'context',
      title: 'Forged activity',
      body: 'An old binary attempts to mint trusted provenance.',
      authorId: writer.id,
      source: 'terminal-summary',
      metadata: {
        actor: 'forged',
        actor_principal_id: writer.id,
        thread_owner_principal_id: writer.id,
        thread_key: 'terminal:forged',
        _continuum_activity_provenance: 'capture-v1',
        _continuum_actor_mapping_id: '11111111-1111-4111-8111-111111111111',
        _continuum_actor_mapping_authority: 'terminal-summary',
      },
    })).rejects.toThrow(/reserved activity provenance/i);
  });

  it('has a separate immutable attribution relation with no metadata backfill', async () => {
    const relation = await pool.query<{ name: string | null }>(
      `SELECT to_regclass('public.memory_activity_attributions')::text AS name`,
    );
    expect(relation.rows[0]?.name).toBe('memory_activity_attributions');
    expect((await pool.query('SELECT * FROM memory_activity_attributions')).rows).toEqual([]);

    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    expect(org.kind).toBe('org');
  });

  it('repairs interrupted concurrent indexes and checks validity', async () => {
    const sql = await readFile(
      new URL('../../migrations/0013_standup_indexes.sql', import.meta.url),
      'utf8',
    );
    expect(sql).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS/);
    expect(sql).toMatch(/indisvalid/);
  });
});
