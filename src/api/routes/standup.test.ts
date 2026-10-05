import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';
import { createMemory } from '../../storage/memories.js';
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

    const memory = async (
      scope: typeof mine,
      title: string,
      createdAt: string,
      metadata: Record<string, unknown>,
      source = 'terminal-summary',
    ) => {
      const row = await createMemory(pool, {
        scopeId: scope.id, scopeKind: scope.kind, type: 'context', title,
        body: `private body for ${title}`, authorId: other.id, source, metadata,
        sourceRef: `https://sources.example/${encodeURIComponent(title)}`,
      });
      await pool.query('UPDATE memories SET created_at = $2, updated_at = $2 WHERE id = $1', [row.id, createdAt]);
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
    const open = await memory(mine, 'Blocked on review', '2026-09-30T08:00:00Z', {
      actor_principal_id: me.id, actor: 'actual-user', thread_key: 'thread:open',
    });
    await memory(mine, 'Old closed thread', '2026-09-29T08:00:00Z', {
      actor_principal_id: me.id, actor: 'actual-user', thread_key: 'thread:closed',
    });
    return { me, included, projectActivity, open };
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
