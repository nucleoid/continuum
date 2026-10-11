import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPool, resetData, promoteWithConfiguredWebhooksForTest } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';
import { createMemory } from './memories.js';
import { mapOwnedUserScope, offboardPrincipal } from '../services/offboarding.js';
import { abandonPromotionDeliveries, claimPromotionDeliveries, failPromotionDelivery, manualRetryPromotionDelivery } from './promotion-events.js';

describe('promotion disabled dispatch review', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => { await pool?.end(); });
  async function fixture(deadLetter: boolean) {
    const admin = await createPrincipal(pool, { externalId: 'dispatch-admin', kind: 'user', displayName: 'Admin' });
    const target = await createPrincipal(pool, { externalId: 'dispatch-target', kind: 'user', displayName: 'Private Person' });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const source = await createScope(pool, { kind: 'team', name: 'dispatch-source' });
    const owned = await createScope(pool, { kind: 'user', name: 'private-disabled-personal-name' });
    const shared = await createScope(pool, { kind: 'project', name: 'dispatch-shared-control' });
    const unmapped = await createScope(pool, { kind: 'user', name: 'dispatch-unmapped-control' });
    await addMembership(pool, admin.id, org.id, 'admin');
    for (const scope of [source, owned, shared, unmapped]) await addMembership(pool, target.id, scope.id, 'writer');
    await mapOwnedUserScope(pool, admin, target.id, owned.id);
    const events: string[] = [];
    for (const scope of [owned, shared, unmapped]) {
      const memory = await createMemory(pool, { scopeId: source.id, scopeKind: 'team', type: 'decision',
        title: 'Legitimate promotion', body: 'Normal source.', source: 'manual', authorId: target.id });
      const promotion = await promoteWithConfiguredWebhooksForTest(pool, target.id, memory.id,
        { kind: scope.kind, name: scope.name }, {}, ['dispatch-hook']);
      events.push(promotion.promotionEvent.eventId);
    }
    // Enabled mapped destinations are eligible, and every row is genuinely claimed.
    const active = await claimPromotionDeliveries(pool, { owner: 'enabled-control', webhookIds: ['dispatch-hook'],
      limit: 10, perWebhookLimit: 10, leaseMs: 60_000 });
    expect(active).toHaveLength(3);
    if (deadLetter) {
      for (const delivery of active) expect(await failPromotionDelivery(pool, delivery.event.eventId, delivery.webhookId,
        'enabled-control', { maxAttempts: 1, retryDelayMs: 1000, error: new Error('actual consumer failure'),
          attemptCount: delivery.attemptCount, leaseGeneration: delivery.leaseGeneration })).toBe('dead_letter');
    } else {
      expect(await abandonPromotionDeliveries(pool, 'enabled-control', active)).toBe(3);
    }
    await pool.query("UPDATE coordination_contract_backfill_state SET phase='usage' WHERE singleton");
    const pending = await offboardPrincipal(pool, admin, target.id, { confirmationScopeId: owned.id });
    expect(pending).toMatchObject({ complete: false, reason: 'migration_pending' });
    expect((await pool.query('SELECT disabled_at IS NOT NULL AS disabled,offboarded_at IS NOT NULL AS offboarded FROM principals WHERE id=$1::uuid',
      [target.id])).rows).toEqual([{ disabled: true, offboarded: false }]);
    expect((await pool.query('SELECT destination_scope_name FROM promotion_events WHERE id=$1::uuid', [events[0]])).rows)
      .toEqual([{ destination_scope_name: owned.name }]);
    return { events, owned };
  }

  it('does not dispatch retained personal names after durable access revocation while erasure is pending', async () => {
    try {
      const value = await fixture(false);
      const before = (await pool.query('SELECT * FROM promotion_event_deliveries WHERE event_id=$1::uuid', [value.events[0]])).rows;
      const claimed = await claimPromotionDeliveries(pool, { owner: 'after-disable', webhookIds: ['dispatch-hook'],
        limit: 10, perWebhookLimit: 10, leaseMs: 60_000 });
      expect(claimed.some((delivery) => delivery.event.destinationScope.name === value.owned.name)).toBe(false);
      // Disabled authors do not suppress shared or unmapped destination controls.
      expect(claimed.map((delivery) => delivery.event.eventId).sort()).toEqual(value.events.slice(1).sort());
      expect((await pool.query('SELECT * FROM promotion_event_deliveries WHERE event_id=$1::uuid', [value.events[0]])).rows).toEqual(before);
    } finally { await pool.query("UPDATE coordination_contract_backfill_state SET phase='complete' WHERE singleton"); }
  });

  it('does not reset a disabled mapped destination dead letter while allowing shared and unmapped retries', async () => {
    try {
      const value = await fixture(true);
      const before = (await pool.query('SELECT * FROM promotion_event_deliveries WHERE event_id=$1::uuid', [value.events[0]])).rows;
      expect(await manualRetryPromotionDelivery(pool, value.events[0], 'dispatch-hook')).toBe(false);
      expect((await pool.query('SELECT * FROM promotion_event_deliveries WHERE event_id=$1::uuid', [value.events[0]])).rows).toEqual(before);
      for (const event of value.events.slice(1)) expect(await manualRetryPromotionDelivery(pool, event, 'dispatch-hook')).toBe(true);
      const claimed = await claimPromotionDeliveries(pool, { owner: 'after-retry', webhookIds: ['dispatch-hook'],
        limit: 10, perWebhookLimit: 10, leaseMs: 60_000 });
      expect(claimed.map((delivery) => delivery.event.eventId).sort()).toEqual(value.events.slice(1).sort());
      expect(claimed.some((delivery) => delivery.event.destinationScope.name === value.owned.name)).toBe(false);
    } finally { await pool.query("UPDATE coordination_contract_backfill_state SET phase='complete' WHERE singleton"); }
  });
});
