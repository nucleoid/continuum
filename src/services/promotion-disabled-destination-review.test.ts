import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory, getMemory } from '../storage/memories.js';
import { promoteMemoryWithAudit } from '../storage/promote.js';
import { mapOwnedUserScope } from './offboarding.js';
import { disablePrincipal } from './principal-admin.js';
import { promoteForPrincipal } from './lifecycle.js';

describe('promotion disabled destination review', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterAll(async () => { await pool?.end(); });
  async function seed() {
    const admin = await createPrincipal(pool, { externalId: 'disabled-destination-admin', kind: 'user', displayName: 'Admin' });
    const target = await createPrincipal(pool, { externalId: 'disabled-destination-owner', kind: 'user', displayName: 'Private Owner' });
    const writer = await createPrincipal(pool, { externalId: 'disabled-destination-writer', kind: 'user', displayName: 'Acknowledged Writer' });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const team = await createScope(pool, { kind: 'team', name: 'disabled-destination-source' });
    const personal = await createScope(pool, { kind: 'user', name: 'disabled-destination-private' });
    await addMembership(pool, admin.id, org.id, 'admin');
    await addMembership(pool, target.id, personal.id, 'writer');
    await addMembership(pool, writer.id, personal.id, 'writer');
    await addMembership(pool, writer.id, team.id, 'writer');
    const approved = await mapOwnedUserScope(pool, admin, target.id, personal.id, true);
    expect(approved.allowOtherActiveMembers).toBe(true);
    expect(approved.acknowledgedPrincipalIds).toContain(writer.id);
    const first = await createMemory(pool, { scopeId: team.id, scopeKind: 'team', type: 'fact',
      title: 'Valid prior promotion', body: 'Normal promotion.', authorId: writer.id, source: 'manual' });
    const promoted = await promoteMemoryWithAudit(pool, writer.id, first.id, { kind: 'user', name: personal.name });
    await disablePrincipal(pool, admin, target.id);
    const captured = await createMemory(pool, { scopeId: personal.id, scopeKind: 'user', type: 'fact',
      title: 'Capture remains permitted by the acknowledged override', body: 'Core capture control.', authorId: writer.id, source: 'manual' });
    expect(captured.state).toBe('live');
    return { writer, team, personal, promoted };
  }
  it('returns a stable masked forbidden promotion while rolling back all destination work', async () => {
    const value = await seed();
    const source = await createMemory(pool, { scopeId: value.team.id, scopeKind: 'team', type: 'fact',
      title: 'Attempted promotion', body: 'Writer remains active.', authorId: value.writer.id, source: 'manual' });
    const counts = async () => (await pool.query(`SELECT (SELECT count(*) FROM memories)::int AS memories,
      (SELECT count(*) FROM audit_log)::int AS audits,(SELECT count(*) FROM promotion_events)::int AS events`)).rows[0];
    const before = await counts();
    await expect(promoteForPrincipal(pool, value.writer, source.id, { kind: 'user', name: value.personal.name }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', status: 403, publicMessage: 'Target scope is unavailable for promotion' });
    expect(await getMemory(pool, source.id)).toMatchObject({ state: 'live', promotedToId: null });
    expect(await counts()).toEqual(before);
  });
  it('retains the actual canonical direct-SQL disabled-destination guard with a stable machine constraint', async () => {
    const value = await seed();
    await expect(pool.query(`INSERT INTO promotion_events(source_memory_id,destination_memory_id,destination_scope_id,
      destination_scope_kind,destination_scope_name,principal_id)
      SELECT source_memory_id,destination_memory_id,destination_scope_id,destination_scope_kind,destination_scope_name,principal_id
      FROM promotion_events WHERE id=$1::uuid`, [value.promoted.promotionEvent.eventId]))
      .rejects.toMatchObject({ code: '23514', constraint: 'promotion_destination_disabled' });
  });
});
