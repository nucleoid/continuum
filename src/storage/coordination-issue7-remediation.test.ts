import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireLease, releaseLease } from '../services/coordination.js';
import { addMembership } from './memberships.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { makeTestPool, resetData } from './test-helpers.js';

const root = process.cwd();

describe('coordination issue 7 exact-head remediation', () => {
  let pool: pg.Pool;
  let principal: Awaited<ReturnType<typeof createPrincipal>>;
  let scope: Awaited<ReturnType<typeof createScope>>;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
    principal = await createPrincipal(pool, {
      externalId: `service:issue7-red:${randomUUID()}`,
      kind: 'service', displayName: 'Issue 7 RED writer',
    });
    scope = await createScope(pool, { kind: 'project', name: `issue7-${randomUUID()}` });
    await addMembership(pool, principal.id, scope.id, 'writer');
  }, 30_000);

  afterAll(async () => pool?.end());

  it('accepts and clamps a 0056-era contended receipt after schema upgrade', async () => {
    const serverTime = new Date();
    await pool.query(
      `INSERT INTO coordination_resources (scope_id, resource) VALUES ($1, 'mixed-version')`,
      [scope.id],
    );
    await expect(pool.query(
      `INSERT INTO coordination_operation_receipts (
         principal_id, operation, request_id, payload_hash, outcome,
         scope_id, resource, expires_at, server_time, retry_after_seconds, retain_until
       ) VALUES ($1, 'acquire', $2, sha256(convert_to('0056-writer', 'UTF8')),
                 'contended', $3, 'mixed-version', $4, $4, 30,
                 $4::timestamptz + interval '24 hours')`,
      [principal.id, randomUUID(), scope.id, serverTime],
    )).resolves.toBeDefined();
    const retained = await pool.query<{ seconds: number }>(
      `SELECT extract(epoch FROM (retain_until - server_time))::int AS seconds
         FROM coordination_operation_receipts WHERE principal_id = $1`,
      [principal.id],
    );
    expect(retained.rows).toEqual([{ seconds: 90 }]);
  });

  it('enforces the persisted scope fencing floor on direct resource INSERT', async () => {
    await pool.query(
      `INSERT INTO coordination_scope_fencing_floors (scope_id, fencing_floor)
       VALUES ($1, 41)`, [scope.id],
    );
    await pool.query(
      `INSERT INTO coordination_resources (scope_id, resource, fencing_token)
       VALUES ($1, 'old-sql-path', 0)`, [scope.id],
    );
    const result = await pool.query<{ token: string }>(
      `SELECT fencing_token::text AS token FROM coordination_resources
        WHERE scope_id = $1 AND resource = 'old-sql-path'`, [scope.id],
    );
    expect(result.rows).toEqual([{ token: '41' }]);
  });

  it('commits release and retains bounded replay evidence at saturated quota', async () => {
    const runId = randomUUID();
    const requestId = randomUUID();
    const held = await acquireLease(pool, principal, {
      scope: `project:${scope.name}`, resource: 'release-saturation',
      runId, requestId: randomUUID(), ttlSeconds: 300,
    });
    if (!held.acquired) throw new Error('expected acquisition control');
    await pool.query(
      `UPDATE coordination_principal_usage SET mutation_receipt_count = 10000
        WHERE principal_id = $1`, [principal.id],
    );
    await expect(releaseLease(pool, principal, {
      leaseId: held.leaseId, runId, requestId,
    })).resolves.toEqual({ released: true });
    await expect(releaseLease(pool, principal, {
      leaseId: held.leaseId, runId, requestId,
    })).resolves.toEqual({ released: true, alreadyReleased: true });
  });

  it('marks only displaced or released generations cleanup-eligible', async () => {
    const runId = randomUUID();
    const held = await acquireLease(pool, principal, {
      scope: `project:${scope.name}`, resource: 'cleanup-state',
      runId, requestId: randomUUID(), ttlSeconds: 300,
    });
    if (!held.acquired) throw new Error('expected acquisition control');
    const active = await pool.query(
      `SELECT cleanup_eligible_at FROM coordination_leases WHERE lease_id = $1`,
      [held.leaseId],
    );
    expect(active.rows).toEqual([{ cleanup_eligible_at: null }]);
    await pool.query(
      `UPDATE coordination_leases
          SET acquired_at = clock_timestamp() - interval '2 seconds',
              expires_at = clock_timestamp() - interval '1 second'
        WHERE lease_id = $1`, [held.leaseId],
    );
    expect((await pool.query(
      `SELECT cleanup_eligible_at FROM coordination_leases WHERE lease_id = $1`,
      [held.leaseId],
    )).rows).toEqual([{ cleanup_eligible_at: null }]);
    const successor = await acquireLease(pool, principal, {
      scope: `project:${scope.name}`, resource: 'cleanup-state',
      runId: randomUUID(), requestId: randomUUID(), ttlSeconds: 300,
    });
    expect(successor).toMatchObject({ acquired: true, fencingToken: '2' });
    const released = await pool.query(
      `SELECT lease_id = $1 AS displaced,
              cleanup_eligible_at IS NOT NULL AS eligible
         FROM coordination_leases WHERE lease_id IN ($1, $2)
         ORDER BY displaced DESC`,
      [held.leaseId, successor.acquired ? successor.leaseId : null],
    );
    expect(released.rows).toEqual([
      { displaced: true, eligible: true },
      { displaced: false, eligible: false },
    ]);
  });

  it('ships bounded shared-scope detachment for team, project, and org state', async () => {
    const migration = await readFile(
      join(root, 'migrations/0059_coordination_bounded_privacy.sql'), 'utf8',
    );
    expect(migration).toMatch(/coordination_principal_privacy_progress/i);
    expect(migration).toMatch(/continuum_operator_scrub_coordination_principal/i);
    expect(migration).toMatch(/kind IN \('team', 'project', 'org'\)/i);
    expect(migration).toMatch(/batch_limit/i);
    expect(migration).toMatch(/coordination_scope_fencing_floors/i);
  });

  it('uses concurrent indexes, resumable backfill, validation, and restart directives', async () => {
    const files = (await readdir(join(root, 'migrations'))).sort();
    const online = await readFile(join(root, 'migrations/0058_coordination_online_prep.sql'), 'utf8');
    const finish = await readFile(join(root, 'migrations/0060_coordination_online_finish.sql'), 'utf8');
    expect(files).toEqual(expect.arrayContaining([
      '0058_coordination_online_prep.sql', '0059_coordination_bounded_privacy.sql',
      '0060_coordination_online_finish.sql',
    ]));
    expect(online.trimStart()).toMatch(/^-- continuum:no-transaction/);
    expect(online).toMatch(/CREATE INDEX CONCURRENTLY/i);
    expect(finish).toMatch(/backfill-coordination-repair/i);
    expect(finish).toMatch(/VALIDATE CONSTRAINT/i);
  });

  it('makes pseudonymization bounded, resumable, timeout-safe, and membership-safe', async () => {
    const migration = await readFile(
      join(root, 'migrations/0059_coordination_bounded_privacy.sql'), 'utf8',
    );
    expect(migration).toMatch(/coordination_scope_privacy_progress/i);
    expect(migration).toMatch(/LIMIT batch_limit/i);
    expect(migration).toMatch(/scope has active memberships/i);
    expect(migration).toMatch(/scope has live coordination leases/i);
    expect(migration).toMatch(/SET statement_timeout = '5s'/i);
  });

  it('records direct operator pseudonymization in immutable evidence', async () => {
    const migration = await readFile(
      join(root, 'migrations/0059_coordination_bounded_privacy.sql'), 'utf8',
    );
    expect(migration).toMatch(/coordination_operator_events/i);
    expect(migration).toMatch(/BEFORE UPDATE OR DELETE/i);
    expect(migration).toMatch(/coordination operator evidence is immutable/i);
    expect(migration).toMatch(/coordination_scope_pseudonymization/i);
  });

  it('pins 0057 and chains every forward remediation migration', async () => {
    const migrator = await readFile(join(root, 'src/storage/migrator.ts'), 'utf8');
    expect(migrator).toMatch(/0057_coordination_privacy_race_remediation\.sql['"],\s*\n\s*['"][0-9a-f]{64}/);
    expect(migrator).toMatch(/0058_coordination_online_prep\.sql[\s\S]+0057_coordination_privacy_race_remediation\.sql/);
    expect(migrator).toMatch(/0059_coordination_bounded_privacy\.sql[\s\S]+0058_coordination_online_prep\.sql/);
    expect(migrator).toMatch(/0060_coordination_online_finish\.sql[\s\S]+0059_coordination_bounded_privacy\.sql/);
  });

  it('keeps immutable operator evidence outside audit retention and offboarding mutation', async () => {
    const migration = await readFile(
      join(root, 'migrations/0059_coordination_bounded_privacy.sql'), 'utf8',
    );
    const retention = await readFile(join(root, 'src/maintenance/audit-retention.ts'), 'utf8');
    const offboarding = await readFile(join(root, 'src/services/offboarding.ts'), 'utf8');
    expect(migration).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE/i);
    expect(retention).not.toContain('coordination_operator_events');
    expect(offboarding).not.toMatch(/(?:UPDATE|DELETE FROM) coordination_operator_events/i);
  });
});
