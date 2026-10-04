import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { addMembership, removeMembership } from './memberships.js';
import { createMemory } from './memories.js';
import { listReviewQueue } from './review-queue.js';

describe('review queue storage', () => {
  let pool: pg.Pool;
  const now = new Date('2026-10-04T12:00:00Z');

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });
  afterAll(async () => pool?.end());

  async function memory(scopeId: string, scopeKind: 'org' | 'team', authorId: string, input: {
    type: 'fact' | 'relationship' | 'playbook' | 'context' | 'decision';
    state?: 'live' | 'stale';
    expiresAt?: Date | null;
    createdAt?: Date;
    lastVerified?: Date | null;
    title: string;
  }) {
    const row = await createMemory(pool, {
      scopeId, scopeKind, type: input.type, title: input.title, body: 'private body',
      authorId, source: 'manual',
    });
    await pool.query(
      `UPDATE memories SET state = $2, expires_at = $3, created_at = $4,
         updated_at = $4, last_verified = $5 WHERE id = $1`,
      [row.id, input.state ?? 'live', input.expiresAt ?? null,
        input.createdAt ?? now, input.lastVerified ?? null],
    );
    return row;
  }

  it('returns only readable actionable author or writer/admin work and reacts to revocation', async () => {
    const caller = await createPrincipal(pool, { externalId: 'caller', kind: 'user', displayName: 'Caller' });
    const other = await createPrincipal(pool, { externalId: 'other', kind: 'user', displayName: 'Other' });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const writable = await createScope(pool, { kind: 'team', name: 'writable' });
    const readable = await createScope(pool, { kind: 'team', name: 'readable' });
    const inaccessible = await createScope(pool, { kind: 'team', name: 'secret' });
    await addMembership(pool, caller.id, writable.id, 'writer');
    await addMembership(pool, caller.id, readable.id, 'reader');

    const authoredOrg = await memory(org.id, 'org', caller.id, { type: 'fact', state: 'stale', title: 'authored org' });
    await memory(org.id, 'org', other.id, { type: 'fact', state: 'stale', title: 'implicit org excluded' });
    const writableOther = await memory(writable.id, 'team', other.id, { type: 'relationship', state: 'stale', title: 'writer task' });
    const readableOwn = await memory(readable.id, 'team', caller.id, { type: 'fact', state: 'stale', title: 'reader authored' });
    await memory(readable.id, 'team', other.id, { type: 'fact', state: 'stale', title: 'reader other excluded' });
    await memory(inaccessible.id, 'team', caller.id, { type: 'fact', state: 'stale', title: 'authored inaccessible' });

    expect((await listReviewQueue(pool, caller.id, { now })).map((item) => item.id).sort())
      .toEqual([authoredOrg.id, writableOther.id, readableOwn.id].sort());

    await removeMembership(pool, caller.id, writable.id);
    expect((await listReviewQueue(pool, caller.id, { now })).map((item) => item.id).sort())
      .toEqual([authoredOrg.id, readableOwn.id].sort());
  });

  it('orders oldest debt first and applies exact horizon, filters, limit, and offset', async () => {
    const caller = await createPrincipal(pool, { externalId: 'caller', kind: 'user', displayName: 'Caller' });
    const team = await createScope(pool, { kind: 'team', name: 'queue' });
    await addMembership(pool, caller.id, team.id, 'admin');
    const oldStale = await memory(team.id, 'team', caller.id, {
      type: 'fact', state: 'stale', title: 'old stale', expiresAt: new Date('2026-01-01T00:00:00Z'),
    });
    const duePlaybook = await memory(team.id, 'team', caller.id, {
      type: 'playbook', title: 'due playbook', createdAt: new Date('2026-04-07T12:00:00Z'),
    });
    const boundary = await memory(team.id, 'team', caller.id, {
      type: 'context', title: 'boundary', expiresAt: new Date('2026-10-18T12:00:00Z'),
    });
    await memory(team.id, 'team', caller.id, {
      type: 'context', title: 'outside', expiresAt: new Date('2026-10-18T12:00:00.001Z'),
    });
    await memory(team.id, 'team', caller.id, { type: 'decision', title: 'decision' });

    const all = await listReviewQueue(pool, caller.id, { now, horizonDays: 14 });
    expect(all.map((item) => item.id)).toEqual([oldStale.id, duePlaybook.id, boundary.id]);
    expect(all.map((item) => item.reason)).toEqual(['stale', 'playbook_review_due', 'expiring_soon']);
    expect(all.every((item) => item.canVerify)).toBe(true);

    const page = await listReviewQueue(pool, caller.id, {
      now, horizonDays: 14, scopeLabels: ['team:queue'],
      types: ['playbook', 'context'], limit: 1, offset: 1,
    });
    expect(page.map((item) => item.id)).toEqual([boundary.id]);
  });
});
