import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { addMembership } from '../storage/memberships.js';
import { createPrincipal } from '../storage/principals.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { getScopeByRef } from '../storage/scopes.js';
import {
  AUDIT_RETENTION_LOCK_KEY,
  exportAuditRows,
  runAuditRetention,
  validateAuditExportDirectory,
} from './audit-retention.js';

describe('audit retention', () => {
  let pool: pg.Pool;
  const directories: string[] = [];
  const now = new Date('2026-10-04T12:00:00.000Z');
  const cutoff = new Date('2026-09-04T12:00:00.000Z');

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, {
      recursive: true, force: true,
    })));
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function exportDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'continuum-audit-retention-'));
    await chmod(directory, 0o700);
    directories.push(directory);
    return directory;
  }

  async function seedPrincipal(externalId: string, role?: 'reader' | 'writer' | 'admin') {
    const principal = await createPrincipal(pool, {
      externalId, kind: 'service', displayName: externalId,
    });
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    if (!org) throw new Error('org scope missing');
    if (role) await addMembership(pool, principal.id, org.id, role);
    return principal;
  }

  async function insertAudit(
    principalId: string,
    at: Date,
    overrides: Partial<{
      action: string; memoryId: string | null; scopeId: string | null;
      query: string | null; metadata: unknown;
    }> = {},
  ): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO audit_log (at, principal_id, action, memory_id, scope_id, query, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id::text`,
      [at, principalId, overrides.action ?? 'read', overrides.memoryId ?? null,
        overrides.scopeId ?? null, overrides.query ?? null,
        JSON.stringify(overrides.metadata ?? null)],
    );
    return result.rows[0].id;
  }

  function options(principalExternalId = 'svc:retention') {
    return {
      retentionDays: 30, batchSize: 2, maxBatches: 10, maxRows: 100,
      principalExternalId, now, runId: '11111111-1111-4111-8111-111111111111',
    };
  }

  it('requires a current org admin before selecting or mutating audit rows', async () => {
    const actor = await seedPrincipal('audit-author');
    await seedPrincipal('svc:retention', 'writer');
    await insertAudit(actor.id, new Date('2026-01-01T00:00:00Z'));

    await expect(runAuditRetention(pool, options())).rejects.toThrow('current org admin');
    await expect(runAuditRetention(pool, options('missing'))).rejects.toThrow('current org admin');
    expect((await pool.query('SELECT count(*)::int AS count FROM audit_log')).rows[0].count).toBe(1);
  });

  it('uses one strict cutoff and stable at/id bounded batches', async () => {
    const admin = await seedPrincipal('svc:retention', 'admin');
    const sameTime = new Date('2026-01-01T00:00:00Z');
    const first = await insertAudit(admin.id, sameTime);
    const second = await insertAudit(admin.id, sameTime);
    const third = await insertAudit(admin.id, new Date('2026-02-01T00:00:00Z'));
    const boundary = await insertAudit(admin.id, cutoff);
    const newer = await insertAudit(admin.id, new Date(cutoff.getTime() + 1));

    const result = await runAuditRetention(pool, { ...options(), maxBatches: 1 });

    expect(result).toMatchObject({ status: 'completed', batches: 1, deleted: 2, exhausted: false });
    const remaining = await pool.query<{ id: string }>(
      `SELECT id::text FROM audit_log
        WHERE metadata->>'source' IS DISTINCT FROM 'audit-retention' ORDER BY at, id`,
    );
    expect(remaining.rows.map((row) => row.id)).toEqual([third, boundary, newer]);
    expect([first, second]).not.toContain(third);
  });

  it('processes multiple batches, respects max rows, and handles an empty rerun', async () => {
    const admin = await seedPrincipal('svc:retention', 'admin');
    for (let index = 0; index < 5; index += 1) {
      await insertAudit(admin.id, new Date(`2026-01-0${index + 1}T00:00:00Z`));
    }
    const bounded = await runAuditRetention(pool, { ...options(), maxRows: 3 });
    expect(bounded).toMatchObject({ status: 'completed', batches: 2, deleted: 3, exhausted: false });

    const resumed = await runAuditRetention(pool, options());
    expect(resumed).toMatchObject({ status: 'completed', batches: 1, deleted: 2, exhausted: true });
    const empty = await runAuditRetention(pool, options());
    expect(empty).toMatchObject({ status: 'completed', batches: 0, deleted: 0, exhausted: true });
  });

  it('previews eligible rows without export, deletion, or summary writes', async () => {
    const admin = await seedPrincipal('svc:retention', 'admin');
    await insertAudit(admin.id, new Date('2026-01-02T00:00:00Z'));
    await insertAudit(admin.id, new Date('2026-01-01T00:00:00Z'));
    await insertAudit(admin.id, cutoff);

    const result = await runAuditRetention(pool, { ...options(), dryRun: true });

    expect(result).toMatchObject({
      status: 'dry-run', eligible: 2, oldestAt: '2026-01-01T00:00:00.000Z',
      batches: 0, deleted: 0,
    });
    expect((await pool.query('SELECT count(*)::int AS count FROM audit_log')).rows[0].count).toBe(3);
  });

  it('exports complete deterministic JSONL with escaping and reuses an identical final file', async () => {
    const directory = await exportDirectory();
    const rows = [{
      id: '9223372036854775806', at: new Date('2026-01-01T00:00:00Z'),
      principal_id: '00000000-0000-4000-8000-000000000001', action: 'read',
      memory_id: '00000000-0000-4000-8000-000000000002',
      scope_id: '00000000-0000-4000-8000-000000000003',
      query: 'line one\n"line two"', metadata: { z: 'last', a: { y: 2, x: 1 } },
    }];

    const first = await exportAuditRows(rows, cutoff, directory, 'run-one', 1);
    const bytes = await readFile(path.join(directory, first.filename), 'utf8');
    expect(bytes.endsWith('\n')).toBe(true);
    expect(bytes.split('\n')).toHaveLength(2);
    expect(JSON.parse(bytes.trim())).toEqual({
      id: rows[0].id, at: rows[0].at.toISOString(), principal_id: rows[0].principal_id,
      action: 'read', memory_id: rows[0].memory_id, scope_id: rows[0].scope_id,
      query: rows[0].query, metadata: { a: { x: 1, y: 2 }, z: 'last' },
    });
    expect((await exportAuditRows(rows, cutoff, directory, 'run-two', 1))).toEqual({
      ...first, reused: true,
    });
  });

  it('refuses a mismatched final file and cleans temporary files', async () => {
    const directory = await exportDirectory();
    const rows = [{
      id: '1', at: new Date('2026-01-01T00:00:00Z'),
      principal_id: '00000000-0000-4000-8000-000000000001', action: 'read',
      memory_id: null, scope_id: null, query: null, metadata: null,
    }];
    const first = await exportAuditRows(rows, cutoff, directory, 'run-one', 1);
    await writeFile(path.join(directory, first.filename), 'corrupt\n');

    await expect(exportAuditRows(rows, cutoff, directory, 'run-two', 1))
      .rejects.toThrow('does not match');
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects unsafe export directories', async () => {
    const directory = await exportDirectory();
    await chmod(directory, 0o755);
    await expect(validateAuditExportDirectory(directory)).rejects.toThrow('owner-only');
    await chmod(directory, 0o700);
    const linked = `${directory}-link`;
    await symlink(directory, linked);
    directories.push(linked);
    await expect(validateAuditExportDirectory(linked)).rejects.toThrow('symlinks');
  });

  it('does not delete when export fails and safely reuses a crash-complete export', async () => {
    const admin = await seedPrincipal('svc:retention', 'admin');
    const oldId = await insertAudit(admin.id, new Date('2026-01-01T00:00:00Z'));
    const directory = await exportDirectory();
    const crashOptions = {
      ...options(), exportDirectory: directory,
      afterExport: async () => { throw new Error('simulated crash'); },
    };
    await expect(runAuditRetention(pool, crashOptions)).rejects.toThrow('simulated crash');
    expect((await pool.query('SELECT 1 FROM audit_log WHERE id = $1', [oldId])).rowCount).toBe(1);
    const files = (await readdir(directory)).filter((name) => name.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
    const finalPath = path.join(directory, files[0]);
    const original = await readFile(finalPath);
    await writeFile(finalPath, 'mismatched export\n');
    await expect(runAuditRetention(pool, { ...options(), exportDirectory: directory }))
      .rejects.toThrow('does not match');
    expect((await pool.query('SELECT 1 FROM audit_log WHERE id = $1', [oldId])).rowCount).toBe(1);
    await writeFile(finalPath, original);

    const retried = await runAuditRetention(pool, {
      ...options(), now: new Date(now.getTime() + 1_000), exportDirectory: directory,
    });
    expect(retried).toMatchObject({ deleted: 1, exports: 1, reusedExports: 1 });
  });

  it('rolls back all deletes on a count mismatch and writes no summary', async () => {
    const admin = await seedPrincipal('svc:retention', 'admin');
    const ids = [
      await insertAudit(admin.id, new Date('2026-01-01T00:00:00Z')),
      await insertAudit(admin.id, new Date('2026-01-02T00:00:00Z')),
    ];
    await pool.query(`
      CREATE FUNCTION skip_one_audit_delete() RETURNS trigger AS $$
      BEGIN
        IF OLD.id = ${ids[1]} THEN RETURN NULL; END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER skip_one_audit_delete_trigger
        BEFORE DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION skip_one_audit_delete();
    `);
    try {
      await expect(runAuditRetention(pool, options())).rejects.toThrow('count did not match');
      expect((await pool.query('SELECT count(*)::int AS count FROM audit_log')).rows[0].count).toBe(2);
    } finally {
      await pool.query(`
        DROP TRIGGER skip_one_audit_delete_trigger ON audit_log;
        DROP FUNCTION skip_one_audit_delete();
      `);
    }
  });

  it('writes one sanitized summary only after a successful delete and rolls back if it cannot', async () => {
    const admin = await seedPrincipal('svc:retention', 'admin');
    await insertAudit(admin.id, new Date('2026-01-01T00:00:00Z'), {
      query: 'secret query', metadata: { token: 'secret-value' },
    });
    await pool.query(`
      CREATE FUNCTION reject_retention_summary() RETURNS trigger AS $$
      BEGIN
        IF NEW.metadata->>'source' = 'audit-retention' THEN
          RAISE EXCEPTION 'summary rejected';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_retention_summary_trigger
        BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_retention_summary();
    `);
    await expect(runAuditRetention(pool, options())).rejects.toThrow('summary rejected');
    expect((await pool.query('SELECT count(*)::int AS count FROM audit_log')).rows[0].count).toBe(1);
    await pool.query(`
      DROP TRIGGER reject_retention_summary_trigger ON audit_log;
      DROP FUNCTION reject_retention_summary();
    `);

    await runAuditRetention(pool, options());
    const summaries = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE metadata->>'source' = 'audit-retention'`,
    );
    expect(summaries.rows).toHaveLength(1);
    expect(summaries.rows[0].metadata).toMatchObject({
      deleted_count: 1, retention_days: 30, export_mode: 'none', batch_number: 1,
    });
    expect(JSON.stringify(summaries.rows[0].metadata)).not.toContain('secret');
  });

  it('returns busy when the dedicated advisory lock is already held', async () => {
    const admin = await seedPrincipal('svc:retention', 'admin');
    await insertAudit(admin.id, new Date('2026-01-01T00:00:00Z'));
    const lockClient = await pool.connect();
    await lockClient.query('SELECT pg_advisory_lock($1::bigint)', [AUDIT_RETENTION_LOCK_KEY]);
    try {
      expect(await runAuditRetention(pool, options())).toMatchObject({
        status: 'busy', batches: 0, deleted: 0,
      });
      expect((await pool.query('SELECT count(*)::int AS count FROM audit_log')).rows[0].count).toBe(1);
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1::bigint)', [AUDIT_RETENTION_LOCK_KEY]);
      lockClient.release();
    }
  });

  it('uses the existing time index for a bounded cutoff scan at scale', async () => {
    const admin = await seedPrincipal('svc:retention', 'admin');
    await pool.query(
      `INSERT INTO audit_log (at, principal_id, action)
       SELECT $1::timestamptz - (n || ' seconds')::interval, $2, 'read'
         FROM generate_series(1, 2500) AS n`,
      [cutoff, admin.id],
    );
    await pool.query('ANALYZE audit_log');
    const plan = await pool.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (FORMAT JSON)
       SELECT id, at
         FROM audit_log
        WHERE at < $1
        ORDER BY at ASC, id ASC
        LIMIT 25`,
      [cutoff],
    );
    expect(JSON.stringify(plan.rows[0]['QUERY PLAN'])).toContain('audit_log_at_idx');

    const result = await runAuditRetention(pool, {
      ...options(), batchSize: 25, maxBatches: 1, maxRows: 25,
    });
    expect(result).toMatchObject({ batches: 1, deleted: 25 });
  });

  it('rechecks admin authority after export and before delete', async () => {
    const admin = await seedPrincipal('svc:retention', 'admin');
    const org = await getScopeByRef(pool, { kind: 'org', name: '' });
    if (!org) throw new Error('org scope missing');
    await insertAudit(admin.id, new Date('2026-01-01T00:00:00Z'));
    const directory = await exportDirectory();

    await expect(runAuditRetention(pool, {
      ...options(), exportDirectory: directory,
      afterExport: async () => {
        await pool.query(
          'DELETE FROM scope_memberships WHERE principal_id = $1 AND scope_id = $2',
          [admin.id, org.id],
        );
      },
    })).rejects.toThrow('current org admin');
    expect((await pool.query('SELECT count(*)::int AS count FROM audit_log')).rows[0].count).toBe(1);
  });
});
