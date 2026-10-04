import express from 'express';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createApp } from '../server.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope, getScopeByRef } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';
import { record } from '../../audit/log.js';
import { auditRouter } from './audit.js';

describe('GET /api/v0/audit', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
    app = createApp(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function seed(role: 'reader' | 'writer' | 'admin' = 'reader') {
    const alice = await createPrincipal(pool, {
      externalId: 'entra:alice',
      kind: 'user',
      displayName: 'Alice',
    });
    const bob = await createPrincipal(pool, {
      externalId: 'entra:bob',
      kind: 'user',
      displayName: 'Bob',
    });
    const team = await createScope(pool, { kind: 'team', name: 'payments' });
    await addMembership(pool, alice.id, team.id, role);

    await record(pool, { principalId: alice.id, action: 'write', scopeId: team.id });
    await record(pool, { principalId: alice.id, action: 'read', scopeId: team.id });
    await record(pool, { principalId: bob.id, action: 'write', scopeId: team.id });
    return { alice, bob, team };
  }

  it('rejects requests without bearer', async () => {
    const res = await request(app).get('/api/v0/audit');
    expect(res.status).toBe(401);
  });

  it('non-admin principal sees only its own entries even without filter', async () => {
    const { alice } = await seed('reader');
    const res = await request(app)
      .get('/api/v0/audit')
      .set('Authorization', 'Bearer entra:alice');
    expect(res.status).toBe(200);
    expect(res.body.orgAdmin).toBe(false);
    // The audit read itself is logged before the response, so Alice sees
    // her two seeded entries + the meta-audit of this query.
    expect(res.body.entries.length).toBeGreaterThanOrEqual(2);
    for (const e of res.body.entries) {
      expect(e.principalId).toBe(alice.id);
    }
  });

  it('non-admin principal is forbidden from querying another principal', async () => {
    const { bob } = await seed('reader');
    const res = await request(app)
      .get('/api/v0/audit')
      .query({ principalId: bob.id })
      .set('Authorization', 'Bearer entra:alice');
    expect(res.status).toBe(403);
  });

  it('org-admin principal can query any principals audit', async () => {
    const { alice, bob } = await seed('reader');
    const orgScope = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, alice.id, orgScope.id, 'admin');

    const res = await request(app)
      .get('/api/v0/audit')
      .query({ principalId: bob.id })
      .set('Authorization', 'Bearer entra:alice');
    expect(res.status).toBe(200);
    expect(res.body.orgAdmin).toBe(true);
    expect(res.body.entries.length).toBeGreaterThanOrEqual(1);
    for (const e of res.body.entries) {
      expect(e.principalId).toBe(bob.id);
    }
  });

  it('records a meta-audit entry for the query itself', async () => {
    const { alice } = await seed('reader');
    await request(app)
      .get('/api/v0/audit')
      .set('Authorization', 'Bearer entra:alice');

    const { rows } = await pool.query(
      `SELECT metadata FROM audit_log
        WHERE principal_id = $1 AND metadata->>'view' = 'audit'`,
      [alice.id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].metadata.view).toBe('audit');
    expect(rows[0].metadata.orgAdmin).toBe(false);
  });

  it('rejects malformed query params', async () => {
    await seed('reader');
    const res = await request(app)
      .get('/api/v0/audit')
      .query({ principalId: 'not-a-uuid' })
      .set('Authorization', 'Bearer entra:alice');
    expect(res.status).toBe(400);
  });

  it('honors action filter', async () => {
    await seed('reader');
    const res = await request(app)
      .get('/api/v0/audit')
      .query({ action: 'write' })
      .set('Authorization', 'Bearer entra:alice');
    expect(res.status).toBe(200);
    for (const e of res.body.entries) {
      expect(e.action).toBe('write');
    }
  });

  it('accepts Z timestamps and preserves pagination', async () => {
    const { alice } = await seed('reader');
    await pool.query(
      `UPDATE audit_log
          SET at = CASE action
            WHEN 'write' THEN '2026-01-01T00:00:00Z'::timestamptz
            ELSE '2026-01-01T00:45:00Z'::timestamptz
          END
        WHERE principal_id = $1`,
      [alice.id],
    );

    const res = await request(app)
      .get('/api/v0/audit')
      .query({
        since: '2026-01-01T00:00:00Z',
        until: '2026-01-01T01:00:00Z',
        limit: 1,
        offset: 1,
      })
      .set('Authorization', 'Bearer entra:alice');

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('accepts encoded positive and negative offsets and filters by their UTC instants', async () => {
    const { alice } = await seed('reader');
    await pool.query(
      `UPDATE audit_log
          SET at = CASE action
            WHEN 'write' THEN '2026-01-01T00:15:00Z'::timestamptz
            ELSE '2026-01-01T00:45:00Z'::timestamptz
          END
        WHERE principal_id = $1`,
      [alice.id],
    );

    const since = '2026-01-01T12:30:00+12:00';
    const until = '2025-12-31T22:00:00-03:00';
    const res = await request(app)
      .get(`/api/v0/audit?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`)
      .set('Authorization', 'Bearer entra:alice');

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].action).toBe('read');
    expect(res.body.entries[0].at).toBe('2026-01-01T00:45:00.000Z');

    const { rows } = await pool.query(
      `SELECT metadata
         FROM audit_log
        WHERE principal_id = $1 AND metadata->>'view' = 'audit'`,
      [alice.id],
    );
    expect(rows[0].metadata.filter.since).toBe(since);
    expect(rows[0].metadata.filter.until).toBe(until);
  });

  it.each([
    ['since', 'timezone-less', '2026-01-01T00:00:00'],
    ['until', 'timezone-less', '2026-01-01T00:00:00'],
    ['since', 'malformed', 'not-a-timestamp'],
    ['until', 'malformed', 'not-a-timestamp'],
  ])('rejects %s when it is %s', async (parameter, _description, value) => {
    await seed('reader');
    const res = await request(app)
      .get('/api/v0/audit')
      .query({ [parameter]: value })
      .set('Authorization', 'Bearer entra:alice');
    expect(res.status).toBe(400);
  });

  it.each([
    ['equal', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
    ['inverted', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'],
  ])('rejects %s time ranges', async (_description, since, until) => {
    await seed('reader');
    const res = await request(app)
      .get('/api/v0/audit')
      .query({ since, until })
      .set('Authorization', 'Bearer entra:alice');
    expect(res.status).toBe(400);
  });

  it.each([
    ['out-of-range offset hour', '2026-01-01T00:00:00+24:00'],
    ['large offset hour', '2026-01-01T00:00:00+99:59'],
    ['out-of-range offset minute', '2026-01-01T00:00:00+12:99'],
    ['offset without a colon', '2026-01-01T00:00:00+0560'],
    ['timestamp without seconds', '2026-01-01T00:00Z'],
  ])('rejects %s before querying the database', async (_description, since) => {
    const query = vi.fn();
    const validationApp = express();
    validationApp.use((req, _res, next) => {
      req.principal = {
        id: '00000000-0000-4000-8000-000000000001',
        externalId: 'entra:alice',
        kind: 'user',
        displayName: 'Alice',
        createdAt: new Date(),
      };
      next();
    });
    validationApp.use('/api/v0', auditRouter({ query } as unknown as pg.Pool));

    const res = await request(validationApp)
      .get('/api/v0/audit')
      .query({ since });

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
