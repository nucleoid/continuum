import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { promoteMemoryWithAudit } from '../storage/promote.js';
import { claimPromotionDeliveries, releasePromotionDeliveries, completePromotionDelivery, manualRetryPromotionDelivery } from '../storage/promotion-events.js';
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
      let held: Awaited<ReturnType<typeof claimPromotionDeliveries>> = [];
      if (leased) {
        const claimed = await claimPromotionDeliveries(pool, { owner: 'privacy-review',
          webhookIds: ['privacy-review'], limit: 1, leaseMs: 1_000 });
        held = claimed;
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
        const terminal = await pool.query('SELECT state,lease_owner,last_error FROM promotion_event_deliveries WHERE event_id=$1::uuid', [promoted.promotionEvent.eventId]);
        expect(terminal.rows).toEqual([{ state: 'privacy_cancelled', lease_owner: null, last_error: null }]);
        expect(await manualRetryPromotionDelivery(pool, promoted.promotionEvent.eventId, 'privacy-review')).toBe(false);
        expect(await claimPromotionDeliveries(pool, { owner: 'after-erasure', webhookIds: ['privacy-review'], limit: 1, leaseMs: 1_000 })).toEqual([]);
        if (held[0]) expect(await completePromotionDelivery(pool, promoted.promotionEvent.eventId, 'privacy-review',
          'privacy-review', held[0].attemptCount, held[0].leaseGeneration)).toBe(false);
        const retried = await offboardPrincipal(pool, admin, target.id, { confirmationScopeId: personal.id });
        expect(retried.complete).toBe(true);
      } finally {
        await releasePromotionDeliveries(pool, 'privacy-review');
      }
    });
  }
  it('rolls back approved access revocation and outbox mutation when the mandatory privacy audit sink fails', async () => {
    const admin = await createPrincipal(pool, { externalId: 'privacy-audit-admin', kind: 'user', displayName: 'Admin' });
    const target = await createPrincipal(pool, { externalId: 'privacy-audit-target', kind: 'user', displayName: 'Private Person' });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const shared = await createScope(pool, { kind: 'team', name: 'shared-audit-source' });
    const personal = await createScope(pool, { kind: 'user', name: 'private-audit-owner' });
    await addMembership(pool, admin.id, org.id, 'admin');
    await addMembership(pool, target.id, shared.id, 'writer');
    await addMembership(pool, target.id, personal.id, 'writer');
    await mapOwnedUserScope(pool, admin, target.id, personal.id);
    const source = await createMemory(pool, { scopeId: shared.id, scopeKind: 'team', type: 'fact',
      title: 'Audit rollback', body: 'Normal promoted memory.', authorId: target.id, source: 'manual' });
    const promoted = await promoteMemoryWithAudit(pool, target.id, source.id, { kind: 'user', name: personal.name }, {}, ['privacy-audit']);
    await pool.query(`CREATE FUNCTION reject_promotion_privacy_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='archive' AND NEW.metadata=continuum_offboarding_expected_audit_metadata('{}'::jsonb) THEN
        RAISE EXCEPTION 'expected mandatory promotion privacy audit failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_promotion_privacy_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_promotion_privacy_audit()`);
    try {
      await expect(offboardPrincipal(pool, admin, target.id, { confirmationScopeId: personal.id }))
        .rejects.toThrow('expected mandatory promotion privacy audit failure');
    } finally {
      await pool.query('DROP TRIGGER reject_promotion_privacy_audit ON audit_log; DROP FUNCTION reject_promotion_privacy_audit()');
    }
    const principal = await pool.query('SELECT disabled_at,offboarded_at FROM principals WHERE id=$1::uuid', [target.id]);
    expect(principal.rows[0]).toEqual({ disabled_at: null, offboarded_at: null });
    const scope = await pool.query('SELECT name FROM scopes WHERE id=$1::uuid', [personal.id]);
    expect(scope.rows[0].name).toBe(personal.name);
    const event = await pool.query('SELECT destination_scope_name FROM promotion_events WHERE id=$1::uuid', [promoted.promotionEvent.eventId]);
    expect(event.rows[0].destination_scope_name).toBe(personal.name);
    expect((await pool.query('SELECT state,attempt_count FROM promotion_event_deliveries WHERE event_id=$1::uuid', [promoted.promotionEvent.eventId])).rows)
      .toEqual([{ state: 'pending', attempt_count: 0 }]);
    const result = await offboardPrincipal(pool, admin, target.id, { confirmationScopeId: personal.id });
    expect(result.complete).toBe(true);
  });

});
