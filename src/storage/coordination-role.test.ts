import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg, { type PoolConfig } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireLease, releaseLease } from '../services/coordination.js';
import { canonicalOperationHash } from '../coordination/model.js';
import { addMembership } from './memberships.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { makeTestPool, resetData } from './test-helpers.js';

const quoteRole = (role: string) => `"${role.replaceAll('"', '""')}"`;

async function applyGrantScript(
  pool: pg.Pool,
  filename: string,
  variables: Record<string, string>,
): Promise<void> {
  const source = await readFile(join(process.cwd(), 'scripts', filename), 'utf8');
  const schema = String((await pool.query(
    'SELECT current_schema() AS schema',
  )).rows[0].schema);
  let sql = source.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n')
    .replaceAll(':"continuum_schema"', quoteRole(schema));
  for (const [name, value] of Object.entries(variables)) {
    sql = sql.replaceAll(':"' + name + '"', quoteRole(value));
    sql = sql.replaceAll(":'" + name + "'", "'" + value.replaceAll("'", "''") + "'");
  }
  await pool.query(sql);
}

describe('coordination database role profiles', () => {
  let pool: pg.Pool;
  const roles: string[] = [];

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  }, 30_000);

  afterAll(async () => {
    for (const role of roles.reverse()) {
      await pool.query('DROP OWNED BY ' + quoteRole(role));
      await pool.query('REVOKE ' + quoteRole(role) + ' FROM CURRENT_USER CASCADE');
      await pool.query('DROP ROLE ' + quoteRole(role));
    }
    await pool?.end();
  });

  async function rolePool(role: string): Promise<pg.Pool> {
    await pool.query(
      'GRANT ' + quoteRole(role)
      + ' TO CURRENT_USER WITH ADMIN OPTION, SET FALSE, INHERIT FALSE',
    );
    const schema = String((await pool.query(
      'SELECT current_schema() AS schema',
    )).rows[0].schema);
    return new pg.Pool({
      ...(pool as unknown as { options: PoolConfig }).options,
      max: 2,
      options: `-c search_path=${schema},public -c role=${role}`,
    });
  }

  async function createApplicationRole(): Promise<{ role: string; connection: pg.Pool }> {
    const role = `coord_app_${Date.now()}_${roles.length}`;
    roles.push(role);
    await pool.query('CREATE ROLE ' + quoteRole(role) + ' NOLOGIN');
    await applyGrantScript(pool, 'grant-application-role.sql', {
      continuum_app_role: role,
    });
    return { role, connection: await rolePool(role) };
  }

  it('reprofiles 0060-era table-wide coordination UPDATE grants to exact columns', async () => {
    const role = `coord_upgrade_${Date.now()}_${roles.length}`;
    roles.push(role);
    await pool.query('CREATE ROLE ' + quoteRole(role) + ' NOLOGIN');
    await pool.query(
      `GRANT UPDATE ON coordination_resources, coordination_leases TO ${quoteRole(role)}`,
    );
    await expect(applyGrantScript(pool, 'grant-application-role.sql', {
      continuum_app_role: role,
    })).resolves.toBeUndefined();
    expect((await pool.query(
      `SELECT has_table_privilege($1, 'coordination_resources', 'UPDATE') AS resources,
              has_table_privilege($1, 'coordination_leases', 'UPDATE') AS leases,
              has_column_privilege($1, 'coordination_resources', 'resource', 'UPDATE') AS resource_key,
              has_column_privilege($1, 'coordination_resources', 'fencing_token', 'UPDATE') AS fencing_token,
              has_column_privilege($1, 'coordination_leases', 'principal_id', 'UPDATE') AS lease_principal,
              has_column_privilege($1, 'coordination_leases', 'expires_at', 'UPDATE') AS expires_at`,
      [role],
    )).rows[0]).toEqual({
      resources: false, leases: false, resource_key: false,
      fencing_token: true, lease_principal: false, expires_at: true,
    });
  });

  it('runs acquire, renew-state release, and exact verification as the provisioned app role', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'service:app-role-coordination', kind: 'service', displayName: 'App',
    });
    const scope = await createScope(pool, { kind: 'project', name: 'app-role' });
    await addMembership(pool, principal.id, scope.id, 'writer');
    const app = await createApplicationRole();
    try {
      const profile = await app.connection.query<{
        schema: string; relation: string | null; select_allowed: boolean;
      }>(
        `SELECT current_schema() AS schema,
                to_regclass('coordination_operation_receipts')::text AS relation,
                has_table_privilege(
                  current_user, 'coordination_operation_receipts', 'SELECT'
                ) AS select_allowed`,
      );
      expect(profile.rows).toEqual([{
        schema: String((await pool.query('SELECT current_schema() AS schema')).rows[0].schema),
        relation: 'coordination_operation_receipts',
        select_allowed: true,
      }]);
      const redacted = await pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT continuum_offboarding_expected_audit_metadata($1::jsonb) AS metadata`,
        [JSON.stringify({
          operation: 'lock_acquire', outcome: 'acquired', request_id: randomUUID(),
          lease_id: randomUUID(), fencing_token: '9', resource_bytes: 12,
          resource_sha256: '0'.repeat(64), resource: 'guessable-ticket-7',
          transport: 'rest', unexpected: 'private',
        })],
      );
      expect(redacted.rows[0]?.metadata).toMatchObject({
        operation: 'lock_acquire', outcome: 'acquired', fencing_token: '9',
        resource_bytes: 12, transport: 'rest',
      });
      expect(redacted.rows[0]?.metadata).not.toHaveProperty('resource_sha256');
      expect(redacted.rows[0]?.metadata).not.toHaveProperty('resource');
      expect(redacted.rows[0]?.metadata).not.toHaveProperty('unexpected');

      const runId = randomUUID();
      const acquired = await acquireLease(app.connection, principal, {
        scope: 'project:app-role', resource: 'role-resource', runId,
        requestId: randomUUID(),
      });
      expect(acquired).toMatchObject({ acquired: true, fencingToken: '1' });
      if (!acquired.acquired) throw new Error('expected acquisition');
      await expect(releaseLease(app.connection, principal, {
        leaseId: acquired.leaseId, runId, requestId: randomUUID(),
      })).resolves.toEqual({ released: true });
      await expect(pool.query(
        'SELECT continuum_assert_application_role_allowlist($1::name)', [app.role],
      )).resolves.toBeDefined();
      expect((await pool.query(
        `SELECT has_function_privilege(
           $1, 'continuum_operator_reclaim_coordination_resource(uuid,uuid,text)',
           'EXECUTE') AS allowed`,
        [app.role],
      )).rows[0]?.allowed).toBe(false);
      expect((await pool.query(
        `SELECT has_table_privilege(
           $1, 'coordination_operation_receipts', 'UPDATE') AS allowed`,
        [app.role],
      )).rows[0]?.allowed).toBe(false);
      await expect(app.connection.query(
        `UPDATE coordination_operation_receipts
            SET payload_hash = payload_hash
          WHERE principal_id = $1`,
        [principal.id],
      )).rejects.toMatchObject({ code: '42501' });
      await expect(app.connection.query(
        `UPDATE coordination_leases SET principal_id = principal_id
          WHERE lease_id = $1`, [acquired.leaseId],
      )).rejects.toMatchObject({ code: '42501' });
      await expect(app.connection.query(
        `UPDATE coordination_resources SET resource = resource
          WHERE scope_id = $1 AND resource = 'role-resource'`, [scope.id],
      )).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.connection.end();
    }
  });

  it('preserves every retained release replay when later releases reach quota', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'service:release-replay-quota', kind: 'service', displayName: 'Replay',
    });
    const scope = await createScope(pool, { kind: 'project', name: 'release-replay-quota' });
    await addMembership(pool, principal.id, scope.id, 'writer');
    const app = await createApplicationRole();
    try {
      const firstRun = randomUUID();
      const firstRequest = randomUUID();
      const first = await acquireLease(app.connection, principal, {
        scope: 'project:release-replay-quota', resource: 'first', runId: firstRun,
        requestId: randomUUID(),
      });
      if (!first.acquired) throw new Error('expected first acquisition');
      await releaseLease(app.connection, principal, {
        leaseId: first.leaseId, runId: firstRun, requestId: firstRequest,
      });
      const secondRun = randomUUID();
      const second = await acquireLease(app.connection, principal, {
        scope: 'project:release-replay-quota', resource: 'second', runId: secondRun,
        requestId: randomUUID(),
      });
      if (!second.acquired) throw new Error('expected second acquisition');
      await pool.query(
        `UPDATE coordination_principal_usage SET mutation_receipt_count = 10000
          WHERE principal_id = $1`, [principal.id],
      );
      await releaseLease(app.connection, principal, {
        leaseId: second.leaseId, runId: secondRun, requestId: randomUUID(),
      });
      await expect(releaseLease(app.connection, principal, {
        leaseId: first.leaseId, runId: firstRun, requestId: firstRequest,
      })).resolves.toEqual({ released: true, alreadyReleased: true });
    } finally {
      await app.connection.end();
    }
  });

  it('classifies an unprovisioned application role as dependency unavailable', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'service:unprovisioned-coordination', kind: 'service', displayName: 'No grants',
    });
    const scope = await createScope(pool, { kind: 'project', name: 'unprovisioned' });
    await addMembership(pool, principal.id, scope.id, 'writer');
    const role = `coord_ungranted_${Date.now()}_${roles.length}`;
    roles.push(role);
    await pool.query('CREATE ROLE ' + quoteRole(role) + ' NOLOGIN');
    const connection = await rolePool(role);
    try {
      await expect(acquireLease(connection, principal, {
        scope: 'project:unprovisioned', resource: 'x',
        runId: randomUUID(), requestId: randomUUID(),
      })).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    } finally {
      await connection.end();
    }
  });

  it('restricts maintenance to an approval-bound operator and preserves fencing on reclaim', async () => {
    const operatorPrincipal = await createPrincipal(pool, {
      externalId: 'operator:coordination', kind: 'user', displayName: 'Operator',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, operatorPrincipal.id, org.id, 'admin');
    const scope = await createScope(pool, { kind: 'project', name: 'operator-role' });
    await addMembership(pool, operatorPrincipal.id, scope.id, 'writer');

    const operator = await createApplicationRole();
    await applyGrantScript(pool, 'grant-operator-role.sql', {
      continuum_operator_role: operator.role,
      continuum_principal_id: operatorPrincipal.id,
    });
    try {
      const lowRunId = randomUUID();
      const low = await acquireLease(operator.connection, operatorPrincipal, {
        scope: 'project:operator-role', resource: 'preexisting-low-token', runId: lowRunId,
        requestId: randomUUID(),
      });
      if (!low.acquired) throw new Error('expected low-token acquisition');
      await releaseLease(operator.connection, operatorPrincipal, {
        leaseId: low.leaseId, runId: lowRunId, requestId: randomUUID(),
      });
      const runId = randomUUID();
      const first = await acquireLease(operator.connection, operatorPrincipal, {
        scope: 'project:operator-role', resource: 'reclaim-me', runId,
        requestId: randomUUID(),
      });
      expect(first).toMatchObject({ acquired: true, fencingToken: '1' });
      if (!first.acquired) throw new Error('expected acquisition');
      await releaseLease(operator.connection, operatorPrincipal, {
        leaseId: first.leaseId, runId, requestId: randomUUID(),
      });
      await pool.query(
        `UPDATE coordination_operation_receipts
            SET server_time = clock_timestamp() - interval '2 seconds',
                retain_until = clock_timestamp() - interval '1 second'
          WHERE principal_id = $1`,
        [operatorPrincipal.id],
      );
      await pool.query(
        `UPDATE coordination_resources SET fencing_token = 500
          WHERE scope_id = $1 AND resource = 'reclaim-me'`, [scope.id],
      );
      await expect(operator.connection.query(
        'SELECT continuum_operator_reclaim_coordination_resource($1, $2, $3)',
        [operatorPrincipal.id, scope.id, 'reclaim-me'],
      )).resolves.toBeDefined();
      const lowAgain = await acquireLease(operator.connection, operatorPrincipal, {
        scope: 'project:operator-role', resource: 'preexisting-low-token',
        runId: randomUUID(), requestId: randomUUID(),
      });
      expect(lowAgain).toMatchObject({ acquired: true, fencingToken: '2' });
      await expect(operator.connection.query(
        'SELECT continuum_operator_set_coordination_scope_quota($1, $2, 12000)',
        [operatorPrincipal.id, scope.id],
      )).resolves.toBeDefined();
      await expect(operator.connection.query(
        `SELECT continuum_operator_set_coordination_principal_quota(
           $1, $1, 12000, 2000
         )`, [operatorPrincipal.id],
      )).resolves.toBeDefined();
      const second = await acquireLease(operator.connection, operatorPrincipal, {
        scope: 'project:operator-role', resource: 'different-reclaimed-key', runId: randomUUID(),
        requestId: randomUUID(),
      });
      expect(second).toMatchObject({ acquired: true, fencingToken: '501' });
      await expect(operator.connection.query(
        'UPDATE coordination_scope_usage SET resource_limit = 999999 WHERE scope_id = $1',
        [scope.id],
      )).rejects.toMatchObject({ code: '42501' });
      await expect(operator.connection.query(
        'UPDATE coordination_principal_usage SET acquire_receipt_count = 0 WHERE principal_id = $1',
        [operatorPrincipal.id],
      )).rejects.toMatchObject({ code: '42501' });
      await expect(operator.connection.query(
        'SELECT * FROM coordination_fencing_floors',
      )).rejects.toMatchObject({ code: expect.stringMatching(/42P01|42501/) });
      expect((await pool.query(
        'SELECT resource_limit FROM coordination_scope_usage WHERE scope_id = $1',
        [scope.id],
      )).rows[0]?.resource_limit).toBe(12000);
      expect((await pool.query(
        `SELECT acquire_receipt_limit, contended_receipt_limit
           FROM coordination_principal_usage WHERE principal_id = $1`,
        [operatorPrincipal.id],
      )).rows[0]).toEqual({
        acquire_receipt_limit: 12000, contended_receipt_limit: 2000,
      });
      expect((await pool.query(
        `SELECT metadata->>'operation' AS operation FROM audit_log
          WHERE principal_id = $1 AND scope_id = $2
            AND metadata->>'operation' IN (
              'coordination_resource_reclaimed', 'coordination_scope_quota_changed'
            ) ORDER BY id`,
        [operatorPrincipal.id, scope.id],
      )).rows).toEqual([
        { operation: 'coordination_resource_reclaimed' },
        { operation: 'coordination_scope_quota_changed' },
      ]);

      const inactivePrincipal = await createPrincipal(pool, {
        externalId: 'service:inactive-coordination', kind: 'service', displayName: 'Inactive',
      });
      const inactiveScope = await createScope(pool, {
        kind: 'project', name: 'inactive-reclaim',
      });
      await addMembership(pool, inactivePrincipal.id, inactiveScope.id, 'writer');
      const inactiveRunId = randomUUID();
      const inactiveLease = await acquireLease(operator.connection, inactivePrincipal, {
        scope: 'project:inactive-reclaim', resource: 'abandoned-key',
        runId: inactiveRunId, requestId: randomUUID(),
      });
      if (!inactiveLease.acquired) throw new Error('expected inactive acquisition');
      await releaseLease(operator.connection, inactivePrincipal, {
        leaseId: inactiveLease.leaseId, runId: inactiveRunId, requestId: randomUUID(),
      });
      await pool.query(
        `UPDATE coordination_operation_receipts
            SET server_time = clock_timestamp() - interval '2 seconds',
                retain_until = clock_timestamp() - interval '1 second'
          WHERE principal_id = $1`,
        [inactivePrincipal.id],
      );
      await pool.query(
        'UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1',
        [inactivePrincipal.id],
      );
      await expect(operator.connection.query(
        'SELECT continuum_operator_reclaim_coordination_resource($1, $2, $3)',
        [operatorPrincipal.id, inactiveScope.id, 'abandoned-key'],
      )).resolves.toBeDefined();
      expect((await pool.query(
        `SELECT acquire_receipt_count, mutation_receipt_count
           FROM coordination_principal_usage WHERE principal_id = $1`,
        [inactivePrincipal.id],
      )).rows).toEqual([{ acquire_receipt_count: 0, mutation_receipt_count: 0 }]);

      const userScope = await createScope(pool, {
        kind: 'user', name: 'person@example.test',
      });
      await addMembership(pool, operatorPrincipal.id, userScope.id, 'writer');
      const personal = await acquireLease(operator.connection, operatorPrincipal, {
        scope: 'user:person@example.test', resource: 'ticket:person@example.test',
        runId: randomUUID(), requestId: randomUUID(),
      });
      expect(personal).toMatchObject({ acquired: true, fencingToken: '1' });
      if (!personal.acquired) throw new Error('expected personal acquisition');
      const originalPayloadHash = canonicalOperationHash('acquire', [
        'user:person@example.test', 'ticket:person@example.test',
        personal.runId, '300',
      ]);
      await expect(operator.connection.query(
        'SELECT continuum_operator_pseudonymize_scope($1, $2, $3)',
        [operatorPrincipal.id, userScope.id, 'offboarded-scope'],
      )).rejects.toThrow(/privacy v2.*upgrade/i);
      await expect(operator.connection.query(
        'SELECT continuum_operator_pseudonymize_scope_v2($1, $2, $3)',
        [operatorPrincipal.id, userScope.id, 'offboarded-scope'],
      )).rejects.toThrow(/active memberships/i);
      await releaseLease(operator.connection, operatorPrincipal, {
        leaseId: personal.acquired ? personal.leaseId : '',
        runId: personal.acquired ? personal.runId : '',
        requestId: randomUUID(),
      });
      await expect(operator.connection.query(
        'SELECT continuum_operator_pseudonymize_scope_v2($1, $2, $3)',
        [operatorPrincipal.id, userScope.id, 'offboarded-scope'],
      )).rejects.toThrow(/active memberships/i);
      await pool.query(
        `UPDATE scope_memberships SET active = FALSE
          WHERE principal_id = $1 AND scope_id = $2`,
        [operatorPrincipal.id, userScope.id],
      );
      for (let phase = 0; phase < 3; phase += 1) {
        await operator.connection.query(
          'SELECT continuum_operator_pseudonymize_scope_v2($1, $2, $3)',
          [operatorPrincipal.id, userScope.id, 'offboarded-scope'],
        );
      }
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM coordination_resources
          WHERE scope_id = $1`, [userScope.id],
      )).rows).toEqual([{ count: 0 }]);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM coordination_leases
          WHERE scope_id = $1`, [userScope.id],
      )).rows).toEqual([{ count: 0 }]);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM coordination_operation_receipts
          WHERE scope_id = $1`, [userScope.id],
      )).rows).toEqual([{ count: 0 }]);
      expect(originalPayloadHash).toMatch(/^[0-9a-f]{64}$/);
      expect((await pool.query(
        'SELECT fencing_floor::text AS floor FROM coordination_scope_fencing_floors WHERE scope_id = $1',
        [userScope.id],
      )).rows).toEqual([{ floor: '1' }]);
      const events = await pool.query(
        `SELECT metadata->>'phase' AS phase FROM coordination_operator_events
          WHERE scope_id = $1 ORDER BY id`, [userScope.id],
      );
      expect(events.rows).toEqual([{ phase: 'started' }, { phase: 'completed' }]);
      await expect(pool.query(
        `UPDATE coordination_operator_events SET metadata = '{}'::jsonb
          WHERE scope_id = $1`, [userScope.id],
      )).rejects.toThrow(/immutable/i);

      const liveScope = await createScope(pool, {
        kind: 'user', name: 'live-person@example.test',
      });
      await addMembership(pool, operatorPrincipal.id, liveScope.id, 'writer');
      const live = await acquireLease(operator.connection, operatorPrincipal, {
        scope: 'user:live-person@example.test', resource: 'live-resource',
        runId: randomUUID(), requestId: randomUUID(), ttlSeconds: 300,
      });
      if (!live.acquired) throw new Error('expected live acquisition');
      await pool.query(
        `UPDATE scope_memberships SET active = FALSE
          WHERE principal_id = $1 AND scope_id = $2`,
        [operatorPrincipal.id, liveScope.id],
      );
      await expect(operator.connection.query(
        'SELECT continuum_operator_pseudonymize_scope_v2($1, $2, $3)',
        [operatorPrincipal.id, liveScope.id, 'offboarded-live-scope'],
      )).rejects.toThrow(/live coordination leases/i);
      await pool.query(
        `UPDATE coordination_leases
            SET acquired_at = clock_timestamp() - interval '2 seconds',
                expires_at = clock_timestamp() - interval '1 second'
          WHERE lease_id = $1`, [live.leaseId],
      );
      await expect(operator.connection.query(
        'SELECT continuum_operator_pseudonymize_scope_v2($1, $2, $3)',
        [operatorPrincipal.id, liveScope.id, 'offboarded-live-scope'],
      )).resolves.toBeDefined();
    } finally {
      await operator.connection.end();
    }
  });

  it('locks membership changes only while privacy progress exists and skips no-op updates', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'service:privacy-lock', kind: 'service', displayName: 'Privacy lock',
    });
    const scope = await createScope(pool, { kind: 'project', name: 'privacy-lock' });
    await addMembership(pool, principal.id, scope.id, 'writer');
    await pool.query(
      `UPDATE scope_memberships SET active = FALSE
        WHERE principal_id = $1 AND scope_id = $2`, [principal.id, scope.id],
    );
    await pool.query(
      `INSERT INTO coordination_scope_privacy_progress (scope_id, pseudonym)
       VALUES ($1, 'privacy-lock')`, [scope.id],
    );
    const locker = await pool.connect();
    const contender = await pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 761))`, [scope.id],
      );
      await expect(contender.query(
        `UPDATE scope_memberships SET active = FALSE
          WHERE principal_id = $1 AND scope_id = $2`, [principal.id, scope.id],
      )).resolves.toMatchObject({ rowCount: 1 });
      await contender.query("SET lock_timeout = '100ms'");
      await expect(contender.query(
        `UPDATE scope_memberships SET active = TRUE
          WHERE principal_id = $1 AND scope_id = $2`, [principal.id, scope.id],
      )).rejects.toMatchObject({ code: '55P03' });
      await contender.query('RESET lock_timeout');
      await locker.query('ROLLBACK');
      await expect(contender.query(
        `UPDATE scope_memberships SET active = TRUE
          WHERE principal_id = $1 AND scope_id = $2`, [principal.id, scope.id],
      )).rejects.toThrow(/cannot gain active memberships/i);
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined);
      locker.release();
      contender.release();
    }
  });

  it('serializes shared-scope scrub with active membership insertion in two sessions', async () => {
    const operatorPrincipal = await createPrincipal(pool, {
      externalId: 'operator:shared-scope-race', kind: 'user', displayName: 'Operator',
    });
    const target = await createPrincipal(pool, {
      externalId: 'user:shared-scope-race-target', kind: 'user', displayName: 'Target',
    });
    const newcomer = await createPrincipal(pool, {
      externalId: 'user:shared-scope-race-new', kind: 'user', displayName: 'New member',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const owned = await createScope(pool, { kind: 'user', name: 'race-owned' });
    const shared = await createScope(pool, { kind: 'project', name: 'race-shared' });
    await addMembership(pool, operatorPrincipal.id, org.id, 'admin');
    await addMembership(pool, target.id, owned.id, 'writer');
    await addMembership(pool, target.id, shared.id, 'writer');
    await pool.query(
      `INSERT INTO principal_user_scopes
         (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
          acknowledged_evidence_hash)
       VALUES ($1, $2, $3, '{}'::uuid[], repeat('a', 64))`,
      [target.id, owned.id, operatorPrincipal.id],
    );
    const operator = await createApplicationRole();
    await applyGrantScript(pool, 'grant-operator-role.sql', {
      continuum_operator_role: operator.role,
      continuum_principal_id: operatorPrincipal.id,
    });
    const held = await acquireLease(operator.connection, target, {
      scope: 'project:race-shared', resource: 'race', runId: randomUUID(),
      requestId: randomUUID(), ttlSeconds: 300,
    });
    if (!held.acquired) throw new Error('expected shared lease');
    await pool.query(
      `UPDATE principals SET disabled_at = clock_timestamp() WHERE id = $1`, [target.id],
    );
    const scrubber = await operator.connection.connect();
    const contender = await pool.connect();
    try {
      await scrubber.query('BEGIN');
      await scrubber.query(
        `SELECT continuum_operator_scrub_coordination_principal($1, $2, $3, 10)`,
        [operatorPrincipal.id, target.id, owned.id],
      );
      await contender.query("SET lock_timeout = '100ms'");
      await expect(contender.query(
        `INSERT INTO scope_memberships (principal_id, scope_id, role)
         VALUES ($1, $2, 'writer')`, [newcomer.id, shared.id],
      )).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await scrubber.query('ROLLBACK').catch(() => undefined);
      await contender.query('RESET lock_timeout').catch(() => undefined);
      scrubber.release();
      contender.release();
      await operator.connection.end();
    }
  });

  it('validates and detaches every shared scope kind without joinable audit identifiers', async () => {
    const operatorPrincipal = await createPrincipal(pool, {
      externalId: 'operator:shared-coordination-privacy',
      kind: 'user', displayName: 'Shared privacy operator',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, operatorPrincipal.id, org.id, 'admin');
    const operator = await createApplicationRole();
    await applyGrantScript(pool, 'grant-operator-role.sql', {
      continuum_operator_role: operator.role,
      continuum_principal_id: operatorPrincipal.id,
    });
    try {
      const target = await createPrincipal(pool, {
        externalId: 'service:shared-coordination-subject',
        kind: 'user', displayName: 'Shared coordination subject',
      });
      const owned = await createScope(pool, {
        kind: 'user', name: 'shared-subject@example.test',
      });
      const team = await createScope(pool, { kind: 'team', name: 'privacy-team' });
      const project = await createScope(pool, { kind: 'project', name: 'privacy-project' });
      const role = await createScope(pool, { kind: 'role', name: 'privacy-role' });
      const otherUser = await createScope(pool, { kind: 'user', name: 'other-user-scope' });
      for (const selected of [owned, team, project, role, otherUser, org]) {
        await addMembership(pool, target.id, selected.id, 'writer');
      }
      await pool.query(
        `INSERT INTO principal_user_scopes
           (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
            acknowledged_evidence_hash)
         VALUES ($1, $2, $3, '{}'::uuid[], repeat('a', 64))`,
        [target.id, owned.id, operatorPrincipal.id],
      );
      const shared = [
        { scope: 'team:privacy-team', id: team.id },
        { scope: 'project:privacy-project', id: project.id },
        { scope: 'role:privacy-role', id: role.id },
        { scope: 'user:other-user-scope', id: otherUser.id },
        { scope: 'org', id: org.id },
      ];
      const originalRuns: string[] = [];
      for (const [index, selected] of shared.entries()) {
        const runId = randomUUID();
        originalRuns.push(runId);
        const held = await acquireLease(operator.connection, target, {
          scope: selected.scope, resource: `shared-resource-${index}`,
          runId, requestId: randomUUID(), ttlSeconds: 300,
        });
        if (!held.acquired) throw new Error('expected shared acquisition');
        await releaseLease(operator.connection, target, {
          leaseId: held.leaseId, runId, requestId: randomUUID(),
        });
      }

      await expect(operator.connection.query(
        `SELECT continuum_operator_scrub_coordination_principal(
           $1, $2, $3, 1
         )`, [operatorPrincipal.id, target.id, owned.id],
      )).rejects.toThrow(/disabled|offboarded/i);
      await pool.query(
        `UPDATE principals SET disabled_at = clock_timestamp()
          WHERE id = $1`, [target.id],
      );

      let complete = false;
      for (let batch = 0; batch < 40 && !complete; batch += 1) {
        const result = await operator.connection.query<{
          result: { complete: boolean };
        }>(
          `SELECT continuum_operator_scrub_coordination_principal(
             $1, $2, $3, 1
           ) AS result`,
          [operatorPrincipal.id, target.id, owned.id],
        );
        complete = result.rows[0]?.result.complete === true;
      }
      expect(complete).toBe(true);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM coordination_leases
          WHERE principal_id = $1`, [target.id],
      )).rows).toEqual([{ count: 0 }]);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM coordination_operation_receipts
          WHERE principal_id = $1`, [target.id],
      )).rows).toEqual([{ count: 0 }]);
      const detached = await pool.query<{ run_id: string }>(
        `SELECT run_id::text FROM coordination_leases
          WHERE principal_id = '00000000-0000-4000-8000-000000000012'
          ORDER BY scope_id`,
      );
      expect(detached.rows).toHaveLength(5);
      expect(detached.rows.every((row) => !originalRuns.includes(row.run_id))).toBe(true);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM coordination_resources
          WHERE scope_id = ANY($1::uuid[])`,
        [shared.map((selected) => selected.id)],
      )).rows).toEqual([{ count: 5 }]);
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM coordination_scope_fencing_floors
          WHERE scope_id = ANY($1::uuid[])`,
        [shared.map((selected) => selected.id)],
      )).rows).toEqual([{ count: 0 }]);
      expect((await pool.query(
        `SELECT count(*)::int AS count
           FROM audit_log audit
          WHERE audit.principal_id = $1 AND (
            EXISTS (SELECT 1 FROM coordination_leases lease
                     WHERE lease.lease_id::text = audit.metadata->>'lease_id')
            OR EXISTS (SELECT 1 FROM coordination_operation_receipts receipt
                       WHERE receipt.request_id::text = audit.metadata->>'request_id')
          )`, [target.id],
      )).rows).toEqual([{ count: 0 }]);
      expect((await pool.query(
        `SELECT acquire_receipt_count, contended_receipt_count, mutation_receipt_count
           FROM coordination_principal_usage WHERE principal_id = $1`, [target.id],
      )).rows).toEqual([{
        acquire_receipt_count: 0, contended_receipt_count: 0, mutation_receipt_count: 0,
      }]);
      expect((await pool.query(
        `SELECT completed_at IS NOT NULL AS complete,
                receipts_scrubbed::int, leases_scrubbed::int
           FROM coordination_principal_privacy_progress
          WHERE principal_id = $1`, [target.id],
      )).rows).toEqual([{
        complete: true, receipts_scrubbed: 10, leases_scrubbed: 5,
      }]);
      expect((await pool.query(
        `SELECT metadata->>'phase' AS phase FROM coordination_operator_events
          WHERE principal_id = $1 AND scope_id = $2
            AND operation = 'coordination_principal_scrub'
          ORDER BY id`, [operatorPrincipal.id, owned.id],
      )).rows).toEqual(expect.arrayContaining([
        { phase: 'started' }, { phase: 'batch' }, { phase: 'completed' },
      ]));
    } finally {
      await operator.connection.end();
    }
  });
});
