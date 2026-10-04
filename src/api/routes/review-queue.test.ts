import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';
import { createMemory } from '../../storage/memories.js';
import { createApp } from '../server.js';

describe('GET /api/v0/review-queue', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });
  afterAll(async () => pool?.end());

  async function seed() {
    const principal = await createPrincipal(pool, {
      externalId: 'entra:reviewer', kind: 'user', displayName: 'Reviewer',
    });
    const scope = await createScope(pool, { kind: 'team', name: 'review' });
    await addMembership(pool, principal.id, scope.id, 'writer');
    const memory = await createMemory(pool, {
      scopeId: scope.id, scopeKind: scope.kind, type: 'fact', title: 'Needs review',
      body: 'secret body must not enter audit', authorId: principal.id, source: 'manual',
    });
    await pool.query(
      `UPDATE memories SET state = 'stale', expires_at = '2026-01-01T00:00:00Z' WHERE id = $1`,
      [memory.id],
    );
    return { principal, scope, memory };
  }

  it('requires authentication and rejects unknown or out-of-range filters', async () => {
    expect((await request(createApp(pool)).get('/api/v0/review-queue')).status).toBe(401);
    expect((await request(createApp(pool))
      .get('/api/v0/review-queue')
      .set('Authorization', 'Bearer system:lifecycle')).status).toBe(401);
    await seed();
    for (const query of [{ extra: 'x' }, { limit: 0 }, { offset: 10001 }, { horizonDays: 366 }, { type: 'unknown' }]) {
      const response = await request(createApp(pool))
        .get('/api/v0/review-queue')
        .query(query)
        .set('Authorization', 'Bearer entra:reviewer');
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_INPUT');
    }
  });

  it('returns the stable contract and audits IDs without content or author identity', async () => {
    const { principal, scope, memory } = await seed();
    const response = await request(createApp(pool))
      .get('/api/v0/review-queue')
      .query({ scope: 'team:review', type: 'fact', limit: 10, offset: 0, horizonDays: 7 })
      .set('Authorization', 'Bearer entra:reviewer');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [{
        id: memory.id, scope: 'team:review', type: 'fact', title: 'Needs review',
        state: 'stale', reason: 'stale', due: '2026-01-01T00:00:00.000Z',
        lastVerified: null,
        author: { id: principal.id, displayName: 'Reviewer' }, canVerify: true,
      }],
      limit: 10, offset: 0, horizonDays: 7,
    });
    const audit = await pool.query(
      `SELECT memory_id, scope_id, query, metadata, metadata::text AS text
         FROM audit_log WHERE action = 'read' ORDER BY id`,
    );
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[0]).toMatchObject({
      memory_id: null,
      scope_id: null,
      query: null,
      metadata: { view: 'review-queue', hits: 1, transport: 'rest', record_kind: 'summary' },
    });
    expect(audit.rows[1]).toMatchObject({
      memory_id: memory.id, scope_id: scope.id, query: null,
      metadata: { rank: 1, transport: 'rest', record_kind: 'result' },
    });
    const serialized = audit.rows.map((row) => row.text).join(' ');
    expect(serialized).not.toContain('Needs review');
    expect(serialized).not.toContain('secret body');
    expect(serialized).not.toContain('Reviewer');
    expect(serialized).not.toContain(principal.id);
  });

  it('does not return identities when required read auditing fails', async () => {
    await seed();
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_review_queue_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.metadata->>'view' = 'review-queue' THEN
          RAISE EXCEPTION 'private review audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_review_queue_audit_trigger
        BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_review_queue_audit();
    `);
    try {
      const response = await request(createApp(pool, { logger: { error() {} } }))
        .get('/api/v0/review-queue')
        .set('Authorization', 'Bearer entra:reviewer');
      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        code: 'INTERNAL', error: 'An internal error occurred', requestId: expect.any(String),
      });
      expect(JSON.stringify(response.body)).not.toContain('Needs review');
      expect(JSON.stringify(response.body)).not.toContain('private review audit failure');
    } finally {
      await pool.query(
        'DROP TRIGGER reject_review_queue_audit_trigger ON audit_log; DROP FUNCTION reject_review_queue_audit()',
      );
    }
  });
});
