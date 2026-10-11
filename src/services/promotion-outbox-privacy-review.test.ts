import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { promoteMemoryWithAudit } from '../storage/promote.js';
import { claimPromotionDeliveries, releasePromotionDeliveries } from '../storage/promotion-events.js';
import { mapOwnedUserScope, offboardPrincipal } from './offboarding.js';

describe('promotion outbox privacy review', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => { await pool?.end(); });

  for (const leased of [false, true]) {
    it(`erases a normal promoted owned-scope name before claiming completion with ${leased ? 'leased' : 'queued'} delivery`, async () => {
      const admin = await createPrincipal(pool, { externalId: 'outbox-privacy-admin', kind: 'user', displayName: 'Admin' });
      const target = await createPrincipal(pool, { externalId: 'outbox-privacy-target', kind: 'user', displayName: 'Private Person' });
      const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
      const sourceScope = await createScope(pool, { kind: 'team', name: 'shared-source' });
      const personal = await createScope(pool, { kind: 'user', name: 'private-person-owned-scope' });
      await addMembership(pool, admin.id, org.id, 'admin');
      await addMembership(pool, target.id, sourceScope.id, 'writer');
      await addMembership(pool, target.id, personal.id, 'writer');
      await mapOwnedUserScope(pool, admin, target.id, personal.id);
      const source = await createMemory(pool, { scopeId: sourceScope.id, scopeKind: 'team',
        type: 'fact', title: 'Promote into owned scope', body: 'Shared source remains.',
        authorId: target.id, source: 'manual' });
      const promoted = await promoteMemoryWithAudit(pool, target.id, source.id,
        { kind: 'user', name: personal.name }, {}, ['privacy-review']);
      const initial = await pool.query('SELECT destination_scope_name FROM promotion_events WHERE id=$1::uuid', [promoted.promotionEvent.eventId]);
      expect(initial.rows[0].destination_scope_name).toBe(personal.name);
      if (leased) {
        const claimed = await claimPromotionDeliveries(pool, { owner: 'privacy-review',
          webhookIds: ['privacy-review'], limit: 1, leaseMs: 1_000 });
        expect(claimed).toHaveLength(1);
        expect(claimed[0].event.destinationScope.name).toBe(personal.name);
      }
      try {
        let result = await offboardPrincipal(pool, admin, target.id, { confirmationScopeId: personal.id, batchSize: 2 });
        if (leased) await releasePromotionDeliveries(pool, 'privacy-review');
        for (let attempt = 0; !result.complete && attempt < 5; attempt += 1) {
          result = await offboardPrincipal(pool, admin, target.id, { confirmationScopeId: personal.id, batchSize: 2 });
        }
        expect(result.complete).toBe(true);
        const current = await pool.query('SELECT name FROM scopes WHERE id=$1::uuid', [personal.id]);
        expect(current.rows[0].name).not.toBe(personal.name);
        const retained = await pool.query('SELECT destination_scope_name FROM promotion_events WHERE id=$1::uuid', [promoted.promotionEvent.eventId]);
        // Stable UUID accounting may remain, but an owned personal scope name cannot.
        expect(retained.rows.some((row) => row.destination_scope_name === personal.name)).toBe(false);
        const retried = await offboardPrincipal(pool, admin, target.id, { confirmationScopeId: personal.id });
        expect(retried.complete).toBe(true);
      } finally {
        await releasePromotionDeliveries(pool, 'privacy-review');
      }
    });
  }
});
