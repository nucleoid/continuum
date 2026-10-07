import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg, { type PoolConfig } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireLease, releaseLease } from '../services/coordination.js';
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
  let sql = source.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n')
    .replaceAll(':"continuum_schema"', '"public"');
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
    return new pg.Pool({
      ...(pool as unknown as { options: PoolConfig }).options,
      max: 2,
      options: '-c role=' + role,
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

  it('runs acquire, renew-state release, and exact verification as the provisioned app role', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'service:app-role-coordination', kind: 'service', displayName: 'App',
    });
    const scope = await createScope(pool, { kind: 'project', name: 'app-role' });
    await addMembership(pool, principal.id, scope.id, 'writer');
    const app = await createApplicationRole();
    try {
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
            SET retain_until = clock_timestamp() - interval '1 second'
          WHERE principal_id = $1`,
        [operatorPrincipal.id],
      );
      await expect(operator.connection.query(
        'SELECT continuum_operator_reclaim_coordination_resource($1, $2, $3)',
        [operatorPrincipal.id, scope.id, 'reclaim-me'],
      )).resolves.toBeDefined();
      await expect(operator.connection.query(
        'SELECT continuum_operator_set_coordination_scope_quota($1, $2, 12000)',
        [operatorPrincipal.id, scope.id],
      )).resolves.toBeDefined();
      const second = await acquireLease(operator.connection, operatorPrincipal, {
        scope: 'project:operator-role', resource: 'reclaim-me', runId: randomUUID(),
        requestId: randomUUID(),
      });
      expect(second).toMatchObject({ acquired: true, fencingToken: '2' });
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

      const userScope = await createScope(pool, {
        kind: 'user', name: 'person@example.test',
      });
      await addMembership(pool, operatorPrincipal.id, userScope.id, 'writer');
      const personal = await acquireLease(operator.connection, operatorPrincipal, {
        scope: 'user:person@example.test', resource: 'ticket:person@example.test',
        runId: randomUUID(), requestId: randomUUID(),
      });
      expect(personal).toMatchObject({ acquired: true, fencingToken: '1' });
      await expect(operator.connection.query(
        'SELECT continuum_operator_pseudonymize_scope($1, $2, $3)',
        [operatorPrincipal.id, userScope.id, 'offboarded-scope'],
      )).rejects.toThrow(/live coordination leases/i);
      await releaseLease(operator.connection, operatorPrincipal, {
        leaseId: personal.acquired ? personal.leaseId : '',
        runId: personal.acquired ? personal.runId : '',
        requestId: randomUUID(),
      });
      await operator.connection.query(
        'SELECT continuum_operator_pseudonymize_scope($1, $2, $3)',
        [operatorPrincipal.id, userScope.id, 'offboarded-scope'],
      );
      const scrubbed = await pool.query<{
        resource: string;
        lease_resource: string;
        receipt_resource: string;
        fencing_token: string;
      }>(
        `SELECT resource.resource,
                lease.resource AS lease_resource,
                receipt.resource AS receipt_resource,
                resource.fencing_token::text AS fencing_token
           FROM coordination_resources resource
           JOIN coordination_leases lease USING (scope_id, resource)
           JOIN coordination_operation_receipts receipt USING (scope_id, resource)
          WHERE resource.scope_id = $1`,
        [userScope.id],
      );
      expect(scrubbed.rows).toEqual([{
        resource: expect.stringMatching(/^offboarded:[0-9a-f-]{36}$/),
        lease_resource: expect.stringMatching(/^offboarded:[0-9a-f-]{36}$/),
        receipt_resource: expect.stringMatching(/^offboarded:[0-9a-f-]{36}$/),
        fencing_token: '1',
      }]);
      expect(JSON.stringify(scrubbed.rows)).not.toContain('person@example.test');
      expect((await pool.query(
        'SELECT fencing_floor::text AS floor FROM coordination_scope_fencing_floors WHERE scope_id = $1',
        [userScope.id],
      )).rows).toEqual([{ floor: '1' }]);
    } finally {
      await operator.connection.end();
    }
  });
});
