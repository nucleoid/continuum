import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope, getScopeByRef } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';
import { createMemory } from '../../storage/memories.js';
import { mapActorIdentity } from '../../storage/actor-identities.js';
import { createActivityAttribution } from '../../storage/activity-attributions.js';
import { createApp } from '../server.js';

describe('GET /api/v0/standup', () => {
  let pool: pg.Pool;
  const now = new Date('2026-10-05T12:00:00.000Z');

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });
  afterAll(async () => pool?.end());

  async function seed() {
    const me = await createPrincipal(pool, {
      externalId: 'entra:standup-me', kind: 'user', displayName: 'Standup User',
    });
    const other = await createPrincipal(pool, {
      externalId: 'entra:standup-other', kind: 'user', displayName: 'Other User',
    });
    const mine = await createScope(pool, { kind: 'user', name: 'opaque-personal-a' }, me.id);
    const unowned = await createScope(pool, { kind: 'user', name: 'Standup User' });
    const project = await createScope(pool, { kind: 'project', name: 'continuum' });
    await addMembership(pool, me.id, mine.id, 'reader');
    await addMembership(pool, me.id, unowned.id, 'reader');
    await addMembership(pool, me.id, project.id, 'reader');
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, me.id, org.id, 'admin');
    const mappings = new Map<string, { id: string; authority: string }>();
    const mappingFor = async (metadata: Record<string, unknown>, source: string) => {
      const actorId = metadata.actor_principal_id;
      if (typeof actorId !== 'string') return null;
      const authority = `${source}.standup-test`;
      const key = `${authority}:${actorId}`;
      let mapping = mappings.get(key);
      if (!mapping) {
        await mapActorIdentity(pool, {
          authority, externalActorId: actorId,
          principalId: actorId, mappedByPrincipalId: me.id,
        });
        const result = await pool.query<{ mapping_id: string }>(
          `SELECT mapping_id FROM actor_principal_mappings
            WHERE authority = $1 AND external_actor_id = $2 AND revoked_at IS NULL`,
          [authority, actorId],
        );
        mapping = { id: result.rows[0]!.mapping_id, authority };
        mappings.set(key, mapping);
      }
      return mapping;
    };

    const memory = async (
      scope: typeof mine,
      title: string,
      createdAt: string,
      metadata: Record<string, unknown>,
      source = 'terminal-summary',
      trusted = true,
    ) => {
      const mapping = trusted ? await mappingFor(metadata, source) : null;
      const row = await createMemory(pool, {
        scopeId: scope.id, scopeKind: scope.kind, type: 'context', title,
        body: `private body for ${title}`, authorId: other.id, source,
        metadata,
        sourceRef: `https://sources.example/${encodeURIComponent(title)}`,
      });
      await pool.query('UPDATE memories SET created_at = $2, updated_at = $2 WHERE id = $1', [row.id, createdAt]);
      if (mapping && typeof metadata.actor_principal_id === 'string'
          && typeof metadata.thread_key === 'string') {
        await createActivityAttribution(pool, {
          memoryId: row.id,
          actorPrincipalId: metadata.actor_principal_id,
          mappingId: mapping.id,
          mappingAuthority: mapping.authority,
          actorLabel: String(metadata.actor ?? 'actor'),
          threadKey: metadata.thread_key,
          closesThreadKeys: Array.isArray(metadata.closes_thread_keys)
            ? metadata.closes_thread_keys as string[] : [],
          activityAt: new Date(createdAt),
        });
      }
      return row;
    };

    const included = await memory(mine, 'Worked on digest', '2026-10-05T08:00:00Z', {
      actor_principal_id: me.id, actor: 'actual-user', thread_key: 'session:today',
      closes_thread_keys: ['thread:closed'],
    });
    const projectActivity = await memory(project, 'Merged PR #14', '2026-10-05T09:00:00Z', {
      actor_principal_id: me.id, actor: 'actual-user', thread_key: 'github-pr:continuum#14',
      closes_thread_keys: [], merged_by: 'release-manager', reviewers: ['reviewer'],
    }, 'github-pr');
    await memory(unowned, 'Must not infer owner by display name', '2026-10-05T10:00:00Z', {
      actor_principal_id: me.id, actor: 'actual-user', thread_key: 'unowned',
    });
    await memory(mine, 'Other actor in my scope', '2026-10-05T10:30:00Z', {
      actor_principal_id: other.id, actor: 'other-user', thread_key: 'other',
    });
    await memory(mine, 'Missing explicit actor id', '2026-10-05T11:00:00Z', {
      actor: 'actual-user', thread_key: 'missing-id',
    });
    await memory(mine, 'Legacy forged activity', '2026-10-05T11:30:00Z', {
      actor_principal_id: me.id, actor: 'actual-user', thread_key: 'legacy-forged',
      closes_thread_keys: ['thread:open'],
    }, 'terminal-summary', false);
    const open = await memory(mine, 'Blocked on review', '2026-09-30T08:00:00Z', {
      actor_principal_id: me.id, actor: 'actual-user', thread_key: 'thread:open',
    });
    await memory(mine, 'Old closed thread', '2026-09-29T08:00:00Z', {
      actor_principal_id: me.id, actor: 'actual-user', thread_key: 'thread:closed',
    });
    return { me, mine, included, projectActivity, open, memory };
  }

  it('fails closed to explicit ownership and actor attribution, closes threads explicitly, and audits', async () => {
    const { me, included, projectActivity, open } = await seed();
    const response = await request(createApp(pool, { clock: () => now.getTime() }))
      .get('/api/v0/standup')
      .query({ since: '24h', openThreadDays: 2 })
      .set('Authorization', 'Bearer entra:standup-me');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.activity.map((item: { id: string }) => item.id)).toEqual([
      included.id, projectActivity.id,
    ]);
    expect(response.body.openThreads.map((item: { id: string }) => item.id)).toEqual([open.id]);
    expect(JSON.stringify(response.body)).not.toContain('private body');
    expect(response.body.page).toEqual({ limit: 50, offset: 0, nextOffset: null });

    const audit = await pool.query(
      `SELECT memory_id, query, metadata, metadata::text AS text
         FROM audit_log WHERE principal_id = $1 AND metadata->>'view' = 'standup'
            OR principal_id = $1 AND metadata->>'record_kind' = 'result'
        ORDER BY id`,
      [me.id],
    );
    expect(audit.rows.map((row) => row.memory_id)).toEqual([
      null, included.id, projectActivity.id, open.id,
    ]);
    expect(audit.rows[0].metadata).toMatchObject({
      view: 'standup', activity_hits: 2, open_thread_hits: 1, transport: 'rest',
    });
    expect(audit.rows.every((row) => row.query === null)).toBe(true);
    expect(audit.rows.map((row) => row.text).join(' ')).not.toContain('Blocked on review');
  });

  it('uses strict timezone day boundaries and bounded pagination', async () => {
    await seed();
    const app = createApp(pool, { clock: () => now.getTime() });
    const response = await request(app)
      .get('/api/v0/standup')
      .query({ date: '2026-10-05', timezone: 'Pacific/Auckland', limit: 1 })
      .set('Authorization', 'Bearer entra:standup-me');
    expect(response.status).toBe(200);
    expect(response.body.window).toEqual({
      start: '2026-10-04T11:00:00.000Z',
      end: '2026-10-05T11:00:00.000Z',
      timezone: 'Pacific/Auckland', date: '2026-10-05',
    });
    expect(response.body.activity).toHaveLength(1);
    expect(response.body.page.nextOffset).toBe(1);

    for (const query of [
      { date: '2026-10-05' },
      { timezone: 'UTC' },
      { date: '2026-02-30', timezone: 'UTC' },
      { date: '2026-10-05', timezone: 'Not/AZone' },
      { date: '2026-10-05', timezone: 'UTC', since: '24h' },
      { since: '169h' },
      { limit: 101 },
      { extra: 'x' },
    ]) {
      const invalid = await request(app).get('/api/v0/standup').query(query)
        .set('Authorization', 'Bearer entra:standup-me');
      expect(invalid.status, JSON.stringify(query)).toBe(400);
      expect(invalid.body.code).toBe('INVALID_INPUT');
    }
  });

  it('requires authentication', async () => {
    expect((await request(createApp(pool)).get('/api/v0/standup')).status).toBe(401);
  });

  it('fails closed while the production reader gate is disabled', async () => {
    const { me } = await seed();
    const response = await request(createApp(pool, { standupReaderEnabled: false }))
      .get('/api/v0/standup')
      .set('Authorization', `Bearer ${me.externalId}`);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('DEPENDENCY_UNAVAILABLE');
  });

  it('uses database time for expiry and does not let future records close historical threads', async () => {
    const { me, mine, open, memory } = await seed();
    await pool.query(
      "UPDATE memories SET expires_at = now() - interval '1 second' WHERE title = 'Worked on digest'",
    );
    await memory(mine, 'Future closure', '2026-10-06T00:00:00Z', {
        actor_principal_id: me.id, actor: 'actual-user',
        thread_owner_principal_id: me.id,
        thread_key: 'future:closure', closes_thread_keys: ['thread:open'],
    });

    const response = await request(createApp(pool, { clock: () => now.getTime() }))
      .get('/api/v0/standup').query({ since: '24h', openThreadDays: 2 })
      .set('Authorization', 'Bearer entra:standup-me');
    expect(response.status).toBe(200);
    expect(response.body.activity.map((item: { title: string }) => item.title))
      .not.toContain('Worked on digest');
    expect(response.body.openThreads.map((item: { id: string }) => item.id)).toContain(open.id);
  });

  it('excludes expired memories from both activity and open threads', async () => {
    const { open } = await seed();
    await pool.query(
      `UPDATE memories SET expires_at = now() - interval '1 second'
        WHERE id = $1 OR title = 'Worked on digest'`,
      [open.id],
    );
    const response = await request(createApp(pool, { clock: () => now.getTime() }))
      .get('/api/v0/standup').query({ since: '24h', openThreadDays: 2 })
      .set('Authorization', 'Bearer entra:standup-me');
    expect(response.status).toBe(200);
    expect(response.body.activity.map((item: { title: string }) => item.title))
      .not.toContain('Worked on digest');
    expect(response.body.openThreads.map((item: { id: string }) => item.id)).not.toContain(open.id);
  });

  it('does not let a different actor claim or close another actor thread', async () => {
    const { me, mine, memory } = await seed();
    const other = await createPrincipal(pool, {
      externalId: 'entra:thread-closer', kind: 'user', displayName: 'Thread Closer',
    });
    const opened = await memory(mine, 'Explicitly owned thread', '2026-09-29T09:00:00Z', {
        actor_principal_id: me.id, actor: 'me', thread_owner_principal_id: me.id,
        thread_key: 'owned:thread', closes_thread_keys: [],
    });
    await memory(mine, 'Closed by teammate', '2026-10-04T09:00:00Z', {
        actor_principal_id: other.id, actor: 'other', thread_owner_principal_id: other.id,
        thread_key: 'other:work', closes_thread_keys: ['owned:thread'],
    });

    const response = await request(createApp(pool, { clock: () => now.getTime() }))
      .get('/api/v0/standup').query({ since: '24h', openThreadDays: 2 })
      .set('Authorization', 'Bearer entra:standup-me');
    expect(response.status).toBe(200);
    expect(response.body.openThreads.map((item: { id: string }) => item.id)).toContain(opened.id);
  });

  it.each(['archived', 'expired'])('keeps a thread closed after its closure is %s', async (
    closureState,
  ) => {
    const { me, mine, open, memory } = await seed();
    const closure = await memory(mine, 'Durable closure', '2026-10-04T09:00:00Z', {
        actor_principal_id: me.id, actor: 'actual-user', thread_owner_principal_id: me.id,
        thread_key: 'closure:durable', closes_thread_keys: ['thread:open'],
    });
    await pool.query(
      `UPDATE memories
          SET state = CASE WHEN $2 = 'archived' THEN 'archived' ELSE state END,
              expires_at = CASE WHEN $2 = 'expired' THEN now() - interval '1 second'
                                ELSE expires_at END
        WHERE id = $1`,
      [closure.id, closureState],
    );

    const response = await request(createApp(pool, { clock: () => now.getTime() }))
      .get('/api/v0/standup').query({ since: '24h', openThreadDays: 2 })
      .set('Authorization', 'Bearer entra:standup-me');
    expect(response.status).toBe(200);
    expect(response.body.openThreads.map((item: { id: string }) => item.id)).not.toContain(open.id);
  });

  it('returns no digest when required read auditing fails', async () => {
    await seed();
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_standup_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.metadata->>'view' = 'standup' THEN
          RAISE EXCEPTION 'private standup audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_standup_audit_trigger
        BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_standup_audit();
    `);
    try {
      const response = await request(createApp(pool, {
        clock: () => now.getTime(), logger: { error() {} },
      })).get('/api/v0/standup').set('Authorization', 'Bearer entra:standup-me');
      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        code: 'INTERNAL', error: 'An internal error occurred', requestId: expect.any(String),
      });
      expect(JSON.stringify(response.body)).not.toContain('Worked on digest');
      expect(JSON.stringify(response.body)).not.toContain('private standup audit failure');
    } finally {
      await pool.query(
        'DROP TRIGGER reject_standup_audit_trigger ON audit_log; DROP FUNCTION reject_standup_audit()',
      );
    }
  });
});
