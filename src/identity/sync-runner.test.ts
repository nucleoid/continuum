import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg, { type PoolConfig } from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { provisionEntraGroupBinding, syncEntraMemberships } from '../services/membership-sync.js';
import { MembershipSnapshotTooLargeError } from './graph-membership.js';
import { runMembershipSync } from './sync-runner.js';

describe('membership sync CLI runner', () => {
  let pool: pg.Pool;
  const roles: string[] = [];
  const rolePools: pg.Pool[] = [];

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => {
    await Promise.all(rolePools.splice(0).map((connection) => connection.end()));
    for (const role of roles.reverse()) {
      await pool.query(`DROP OWNED BY "${role}"`);
      await pool.query(`REVOKE "${role}" FROM CURRENT_USER`);
      await pool.query(`DROP ROLE "${role}"`);
    }
    await pool?.end();
  });

  async function syncRolePool(principalId: string): Promise<pg.Pool> {
    const role = `continuum_sync_runner_${Date.now()}_${roles.length}`;
    roles.push(role);
    await pool.query(`CREATE ROLE "${role}" NOLOGIN`);
    let sql = await readFile(join(process.cwd(), 'scripts/grant-sync-role.sql'), 'utf8');
    sql = sql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\')).join('\n')
      .replaceAll(':"continuum_schema"', '"public"')
      .replaceAll(':"continuum_sync_role"', `"${role}"`)
      .replaceAll(":'continuum_sync_role'", `'${role}'`)
      .replaceAll(":'continuum_principal_id'", `'${principalId}'`);
    await pool.query(sql);
    await pool.query(
      `ALTER ROLE "${role}" LOGIN PASSWORD 'continuum-test-password'`,
    );
    const base = (pool as unknown as { options: PoolConfig }).options;
    const directUrl = new URL(base.connectionString!);
    directUrl.username = role;
    directUrl.password = 'continuum-test-password';
    const connection = new pg.Pool({
      connectionString: directUrl.toString(),
      max: 1,
    });
    rolePools.push(connection);
    return connection;
  }

  it('audits a production Graph overflow and fail-closes stale access before surfacing its code', async () => {
    const admin = await createPrincipal(pool, {
      externalId: 'sync-admin', kind: 'user', displayName: 'Sync admin',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, admin.id, org.id, 'admin');
    const user = await createPrincipal(pool, {
      externalId: '11111111-1111-4111-8111-111111111111', kind: 'user', displayName: 'User',
    });
    const scope = await createScope(pool, { kind: 'team', name: 'overflow' });
    const groupId = '22222222-2222-4222-8222-222222222222';
    await provisionEntraGroupBinding(pool, admin, {
      externalId: groupId, scopeId: scope.id, role: 'reader',
    });
    await syncEntraMemberships(pool, admin, [{
      id: groupId, status: 'present', displayName: 'Overflow group',
      memberObjectIds: [user.externalId],
    }]);
    await pool.query(
      `UPDATE entra_sync_state SET last_success_at = now() - interval '25 hours'`,
    );
    const syncService = await createPrincipal(pool, {
      externalId: 'sync-overflow-service', kind: 'service', displayName: 'Sync service',
    });
    const syncPool = await syncRolePool(syncService.id);

    await expect(runMembershipSync(syncPool, {
      CONTINUUM_ENTRA_MEMBERSHIP_SYNC: 'true',
      CONTINUUM_GRAPH_ACCESS_TOKEN: 'x'.repeat(32),
      CONTINUUM_MEMBERSHIP_SYNC_ACTOR: syncService.externalId!,
      CONTINUUM_ENTRA_MAX_STALENESS_HOURS: '24',
    }, async () => { throw new MembershipSnapshotTooLargeError(); }))
      .rejects.toMatchObject({
        code: 'PAYLOAD_TOO_LARGE', publicMessage: 'Entra snapshot exceeds the whole-run limit',
      });

    expect((await pool.query(
      `SELECT active FROM scope_memberships
        WHERE principal_id = $1 AND scope_id = $2 AND source_kind = 'entra'`,
      [user.id, scope.id],
    )).rows).toEqual([{ active: false }]);
    expect((await pool.query(
      `SELECT metadata->>'reason' AS reason
         FROM audit_log WHERE metadata->>'operation' = 'entra_membership_sync_rejected'`,
    )).rows).toEqual([{ reason: 'SNAPSHOT_TOO_LARGE' }]);
  });

  it('rejects a non-manual sync actor before making a Graph request', async () => {
    const breakGlass = await createPrincipal(pool, {
      externalId: 'break-glass', kind: 'user', displayName: 'Break glass',
    });
    const actor = await createPrincipal(pool, {
      externalId: '11111111-1111-4111-8111-111111111111', kind: 'user', displayName: 'Entra admin',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, breakGlass.id, org.id, 'admin');
    const groupId = '22222222-2222-4222-8222-222222222222';
    await provisionEntraGroupBinding(pool, breakGlass, {
      externalId: groupId, scopeId: org.id, role: 'admin',
    });
    await syncEntraMemberships(pool, breakGlass, [{
      id: groupId, status: 'present', displayName: 'Entra admins',
      memberObjectIds: [actor.externalId],
    }]);
    const fetchSnapshot = vi.fn(async () => []);

    await expect(runMembershipSync(pool, {
      CONTINUUM_ENTRA_MEMBERSHIP_SYNC: 'true',
      CONTINUUM_GRAPH_ACCESS_TOKEN: 'x'.repeat(32),
      CONTINUUM_MEMBERSHIP_SYNC_ACTOR: actor.externalId,
    }, fetchSnapshot)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      publicMessage: 'membership sync requires the DB-bound sync service identity',
    });
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });
});
