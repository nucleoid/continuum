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
      /DELETE FROM coordination_leases[\s\S]+NOT EXISTS[\s\S]+cleanup_eligible_at/i,
    );
    expect(migration).not.toMatch(/count\(receipt\.\*\)[\s\S]+GROUP BY principal\.id/i);
  });

  it('documents the unavoidable 0061 maintenance boundary and versioned re-scrub', async () => {
    const docs = await readFile(join(root, 'docs/coordination.md'), 'utf8');
    expect(docs).toMatch(/0061[\s\S]+maintenance window/i);
    expect(docs).toMatch(/privacy version 2/i);
    expect(docs).toMatch(/role[\s\S]+other user scope/i);
    expect(docs).toMatch(/restart/i);
  });
});
