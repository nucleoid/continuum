import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';

const root = process.cwd();

describe('coordination final review forward repair', () => {
  let pool: pg.Pool;
  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  }, 30_000);
  afterAll(async () => pool?.end());

  it('ships only post-0062 forward migrations for bounded privacy and online indexes', async () => {
    const files = (await readdir(join(root, 'migrations'))).sort();
    expect(files).toEqual(expect.arrayContaining([
      '0063_coordination_final_privacy_repair.sql',
      '0064_coordination_final_online_indexes.sql',
    ]));
    const repair = await readFile(
      join(root, 'migrations/0063_coordination_final_privacy_repair.sql'), 'utf8',
    );
    const online = await readFile(
      join(root, 'migrations/0064_coordination_final_online_indexes.sql'), 'utf8',
    );
    expect(repair).toMatch(/audit_cursor_id/i);
    expect(repair).toMatch(/privacy_version/i);
    expect(repair).toMatch(/FOR UPDATE[\s\S]+principals/i);
    expect(repair).toMatch(/LIMIT 100[\s\S]+FOR UPDATE/i);
    expect(repair).toMatch(/pg_advisory_xact_lock[\s\S]+761/i);
    expect(online.trimStart()).toMatch(/^-- continuum:no-transaction/);
    expect(online).toMatch(/audit_log_coordination_privacy_idx/i);
    expect(online).toMatch(/CREATE INDEX CONCURRENTLY/i);
  });

  it('bounds expired acquire deletion in the insert trigger to 100 rows', async () => {
    const principal = await createPrincipal(pool, {
      externalId: `service:bounded-trigger:${randomUUID()}`,
      kind: 'service', displayName: 'Bounded trigger',
    });
    const scope = await createScope(pool, { kind: 'project', name: `bounded-${randomUUID()}` });
    await pool.query(
      `INSERT INTO coordination_resources (scope_id, resource) VALUES ($1, 'bounded')`,
      [scope.id],
    );
    await pool.query(
      `INSERT INTO coordination_operation_receipts
         (principal_id, operation, request_id, payload_hash, outcome, scope_id,
          resource, expires_at, server_time, retry_after_seconds, retain_until)
       SELECT $1, 'acquire', gen_random_uuid(), sha256(convert_to(g::text, 'UTF8')),
              'contended', $2, 'bounded', clock_timestamp() + interval '1 minute',
              clock_timestamp(), 1, clock_timestamp() + interval '1 minute'
         FROM generate_series(1, 150) g`,
      [principal.id, scope.id],
    );
    await pool.query(
      `UPDATE coordination_operation_receipts
          SET server_time = clock_timestamp() - interval '2 minutes',
              retain_until = clock_timestamp() - interval '1 minute'
        WHERE principal_id = $1`, [principal.id],
    );
    await pool.query(
      `INSERT INTO coordination_operation_receipts
         (principal_id, operation, request_id, payload_hash, outcome, scope_id,
          resource, expires_at, server_time, retry_after_seconds, retain_until)
       VALUES ($1, 'acquire', gen_random_uuid(), sha256(convert_to('new', 'UTF8')),
               'contended', $2, 'bounded', clock_timestamp() + interval '1 minute',
               clock_timestamp(), 1, clock_timestamp() + interval '1 minute')`,
      [principal.id, scope.id],
    );
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM coordination_operation_receipts
        WHERE principal_id = $1`, [principal.id],
    )).rows).toEqual([{ count: 51 }]);
  });

  it('uses indexed bounded production cleanup shapes', async () => {
    const migration = await readFile(
      join(root, 'migrations/0063_coordination_final_privacy_repair.sql'), 'utf8',
    );
    expect(migration).toMatch(
      /DELETE FROM coordination_operation_receipts[\s\S]+retain_until <= clock_timestamp\(\)[\s\S]+LIMIT 100/i,
    );
    expect(migration).toMatch(
      /cleanup_eligible_at[\s\S]+NOT EXISTS[\s\S]+DELETE FROM coordination_leases/i,
    );
    expect(migration).not.toMatch(/count\(receipt\.\*\)[\s\S]+GROUP BY principal\.id/i);
  });

  it('plans production cleanup against 100k leases and 10k receipts with indexes', async () => {
    const principal = await createPrincipal(pool, {
      externalId: `service:plan-owner:${randomUUID()}`,
      kind: 'service', displayName: 'Plan owner',
    });
    const scope = await createScope(pool, { kind: 'project', name: `plan-${randomUUID()}` });
    await pool.query('ALTER TABLE coordination_resources DISABLE TRIGGER USER');
    await pool.query('ALTER TABLE coordination_operation_receipts DISABLE TRIGGER USER');
    try {
      await pool.query(
        `INSERT INTO coordination_resources (scope_id, resource)
         SELECT $1, 'bulk-' || g FROM generate_series(1, 100000) g`, [scope.id],
      );
      await pool.query(
        `INSERT INTO coordination_leases
           (lease_id, scope_id, resource, principal_id, run_id, fencing_token,
            acquired_at, expires_at, released_at, cleanup_eligible_at)
         SELECT md5('lease-' || g)::uuid, $1, 'bulk-' || g, $2,
                md5('run-' || g)::uuid, 1,
                clock_timestamp() - interval '3 days',
                clock_timestamp() - interval '2 days',
                clock_timestamp() - interval '2 days',
                clock_timestamp() - interval '2 days'
           FROM generate_series(1, 100000) g`, [scope.id, principal.id],
      );
      await pool.query(
        `INSERT INTO coordination_operation_receipts
           (principal_id, operation, request_id, payload_hash, outcome, scope_id,
            resource, lease_id, run_id, fencing_token, expires_at, server_time,
            retry_after_seconds, retain_until, created_at)
         SELECT $1, 'acquire', md5('receipt-' || g)::uuid,
                sha256(convert_to(g::text, 'UTF8')), 'acquired', $2,
                'bulk-' || g, md5('lease-' || g)::uuid, md5('run-' || g)::uuid,
                1, clock_timestamp() - interval '2 days',
                clock_timestamp() - interval '3 days', NULL,
                clock_timestamp() - interval '1 day',
                clock_timestamp() - interval '3 days'
           FROM generate_series(1, 10000) g`, [principal.id, scope.id],
      );
    } finally {
      await pool.query('ALTER TABLE coordination_operation_receipts ENABLE TRIGGER USER');
      await pool.query('ALTER TABLE coordination_resources ENABLE TRIGGER USER');
    }
    await pool.query('ANALYZE coordination_operation_receipts');
    await pool.query('ANALYZE coordination_leases');
    const receiptPlan = await pool.query(
      `EXPLAIN (FORMAT JSON)
       WITH doomed AS MATERIALIZED (
         SELECT principal_id, operation, request_id
           FROM coordination_operation_receipts
          WHERE principal_id = $1 AND operation = 'acquire'
            AND retain_until <= clock_timestamp()
          ORDER BY retain_until, request_id LIMIT 100 FOR UPDATE
       )
       DELETE FROM coordination_operation_receipts receipt USING doomed
        WHERE receipt.principal_id = doomed.principal_id
          AND receipt.operation = doomed.operation
          AND receipt.request_id = doomed.request_id`, [principal.id],
    );
    const leasePlan = await pool.query(
      `EXPLAIN (FORMAT JSON)
       WITH doomed AS MATERIALIZED (
         SELECT lease.lease_id FROM coordination_leases lease
          WHERE lease.cleanup_eligible_at <= clock_timestamp() - interval '24 hours'
            AND NOT EXISTS (
              SELECT 1 FROM coordination_operation_receipts receipt
               WHERE receipt.lease_id = lease.lease_id)
          ORDER BY lease.cleanup_eligible_at, lease.lease_id
          LIMIT 100 FOR UPDATE OF lease SKIP LOCKED
       )
       DELETE FROM coordination_leases lease USING doomed
        WHERE lease.lease_id = doomed.lease_id`,
    );
    expect(JSON.stringify(receiptPlan.rows[0]['QUERY PLAN']))
      .toContain('coordination_receipts_acquire_expiry_idx');
    const leaseJson = JSON.stringify(leasePlan.rows[0]['QUERY PLAN']);
    expect(leaseJson).toContain('coordination_leases_cleanup_ready_idx');
    expect(leaseJson).toContain('coordination_receipts_lease_idx');
  }, 60_000);

  it('documents the unavoidable 0061 maintenance boundary and versioned re-scrub', async () => {
    const docs = await readFile(join(root, 'docs/coordination.md'), 'utf8');
    expect(docs).toMatch(/0061[\s\S]+maintenance window/i);
    expect(docs).toMatch(/privacy version 2/i);
    expect(docs).toMatch(/role[\s\S]+other user(?:'s)? scope/i);
    expect(docs).toMatch(/restart/i);
  });
});
