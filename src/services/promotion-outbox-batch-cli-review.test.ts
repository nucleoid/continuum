import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../storage/migrator.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { promoteForPrincipal } from './lifecycle.js';
import { mapOwnedUserScope, offboardPrincipal } from './offboarding.js';

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:continuum@localhost:5433/continuum';
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const EVENT_COUNT = 1_001;
const BATCH_SIZE = 5_000; // Memory/audit fit, but the outbox independently caps each phase at 1000.

describe('promotion outbox batch progress reaches the compiled offboarding CLI', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const schema = `outbox_batch_${suffix}`;
  const role = `outbox_batch_op_${suffix}`;
  const password = randomUUID();
  const actorExternalId = `outbox-batch-admin:${suffix}`;
  const maintenance = new pg.Pool({ connectionString: databaseUrl, max: 1,
    options: '-c statement_timeout=60000 -c lock_timeout=1000' });
  const owner = new pg.Pool({ connectionString: databaseUrl, max: 4,
    options: `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=1000` });
  const loginUrl = new URL(databaseUrl);
  loginUrl.username = role;
  loginUrl.password = password;
  loginUrl.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=1000`);
  const operator = new pg.Pool({ connectionString: loginUrl.toString(), max: 4,
    connectionTimeoutMillis: 5_000 });
  let admin: Awaited<ReturnType<typeof createPrincipal>>;
  let schemaCreated = false;
  let roleCreated = false;

  beforeAll(async () => {
    await maintenance.query(`CREATE SCHEMA ${quote(schema)}`);
    schemaCreated = true;
    await runMigrations(owner);
    admin = await createPrincipal(owner, { externalId: actorExternalId,
      kind: 'user', displayName: 'Batch operator' });
    const org = (await getScopeByRef(owner, { kind: 'org', name: '' }))!;
    await addMembership(owner, admin.id, org.id, 'admin');
    await maintenance.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD ${literal(password)}`);
    roleCreated = true;
    for (const [filename, variables] of [
      ['grant-application-role.sql', { continuum_app_role: role }],
      ['grant-operator-role.sql', { continuum_operator_role: role, continuum_principal_id: admin.id }],
    ] as const) {
      let sql = (await readFile(new URL(`../../scripts/${filename}`, import.meta.url), 'utf8'))
        .split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\')).join('\n');
      for (const [key, value] of Object.entries({ continuum_schema: schema, ...variables })) {
        sql = sql.replaceAll(`:"${key}"`, quote(value)).replaceAll(`:'${key}'`, literal(value));
      }
      const client = await owner.connect();
      try { await client.query(sql); }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    expect((await operator.query('SELECT session_user AS role')).rows).toEqual([{ role }]);
    await operator.query('SELECT continuum_operator_set_promotion_webhook_ids($1::uuid,$2::text[])',
      [admin.id, ['batch-hook']]);
  }, 120_000);

  afterAll(async () => {
    await operator.end();
    await owner.end();
    try {
      if (schemaCreated) await maintenance.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
      if (roleCreated) {
        await maintenance.query(`DROP OWNED BY ${quote(role)}`);
        await maintenance.query(`DROP ROLE ${quote(role)}`);
      }
    } finally { await maintenance.end(); }
  }, 90_000);

  async function seed() {
    const target = await createPrincipal(owner, { externalId: `batch-target:${randomUUID()}`,
      kind: 'user', displayName: 'Batch target' });
    const personal = await createScope(owner, { kind: 'user', name: `batch-personal-${randomUUID()}` });
    const shared = await createScope(owner, { kind: 'project', name: `batch-source-${randomUUID()}` });
    await addMembership(owner, target.id, personal.id, 'writer');
    await addMembership(owner, target.id, shared.id, 'writer');
    await mapOwnedUserScope(operator, admin, target.id, personal.id);
    // Compact ordinary source records. Every event below is produced by the
    // unchanged authorized promotion service, not a fabricated outbox row.
    const sources = await owner.query<{ id: string }>(`INSERT INTO memories
      (id,scope_id,type,title,body,author_id,source,expires_at)
      SELECT pg_catalog.gen_random_uuid(),$1::uuid,'fact','Batch source','x',$2::uuid,'manual',clock_timestamp()+interval '90 days'
      FROM generate_series(1,$3::integer) RETURNING id`, [shared.id, target.id, EVENT_COUNT]);
    const deadline = Date.now() + 180_000;
    for (let index = 0; index < sources.rows.length; index += 4) {
      if (Date.now() >= deadline) throw new Error('Bounded promotion fixture exceeded its deadline');
      await Promise.all(sources.rows.slice(index, index + 4).map(({ id }) =>
        promoteForPrincipal(operator, target, id, { kind: 'user', name: personal.name })));
    }
    const counts = await owner.query<{ events: number; deliveries: number }>(`SELECT
      (SELECT count(*)::int FROM promotion_events WHERE destination_scope_id=$1::uuid) AS events,
      (SELECT count(*)::int FROM promotion_event_deliveries delivery JOIN promotion_events event ON event.id=delivery.event_id
        WHERE event.destination_scope_id=$1::uuid) AS deliveries`, [personal.id]);
    expect(counts.rows).toEqual([{ events: EVENT_COUNT, deliveries: EVENT_COUNT }]);
    return { target, personal };
  }

  async function physicalState(value: Awaited<ReturnType<typeof seed>>) {
    return (await owner.query<{ names: number; deliveries: number }>(`SELECT
      (SELECT count(*)::int FROM promotion_events event JOIN scopes scope ON scope.id=event.destination_scope_id
        WHERE scope.id=$1::uuid AND event.destination_scope_name<>scope.name) AS names,
      (SELECT count(*)::int FROM promotion_event_deliveries delivery JOIN promotion_events event ON event.id=delivery.event_id
        WHERE event.destination_scope_id=$1::uuid AND (delivery.state<>'privacy_cancelled'
          OR delivery.lease_owner IS NOT NULL OR delivery.last_error IS NOT NULL)) AS deliveries`, [value.personal.id])).rows[0];
  }

  async function call(value: Awaited<ReturnType<typeof seed>>) {
    return offboardPrincipal(operator, admin, value.target.id,
      { confirmationScopeId: value.personal.id, batchSize: BATCH_SIZE, verificationTimeoutMs: 15_000 });
  }

  async function completeByService(value: Awaited<ReturnType<typeof seed>>) {
    let result = await call(value);
    for (let attempt = 0; !result.complete && attempt < 10; attempt += 1) result = await call(value);
    expect(result.complete).toBe(true);
    expect(await physicalState(value)).toEqual({ names: 0, deliveries: 0 });
  }

  async function restoreHistoricalNames(value: Awaited<ReturnType<typeof seed>>) {
    await completeByService(value);
    // Reopened physical-state fixture: restore only the exact original names
    // on genuine historical events, as a trusted owner restoration could.
    // Approval, completion evidence, event IDs and cancellation fences remain intact.
    const restored = await owner.query(`UPDATE promotion_events SET destination_scope_name=$2::text
      WHERE destination_scope_id=$1::uuid`, [value.personal.id, value.personal.name]);
    expect(restored.rowCount).toBe(EVENT_COUNT);
    const proof = await operator.query<{ erased: boolean }>(`SELECT
      continuum_operator_offboarding_actual_state_is_erased($1::uuid,run_id) AS erased
      FROM principal_offboarding_runs WHERE principal_id=$2::uuid AND completed_at IS NOT NULL`,
    [admin.id, value.target.id]);
    expect(proof.rows).toEqual([{ erased: false }]);
  }

  async function compiledCli(value: Awaited<ReturnType<typeof seed>>) {
    const args = ['--max-old-space-size=128', join(process.cwd(), 'dist/identity/admin-cli.js'),
      'offboard-principal', value.target.id, '--confirm-scope', value.personal.id,
      '--batch-size', String(BATCH_SIZE), '--verification-timeout-ms', '15000'];
    const options = { cwd: process.cwd(), timeout: 90_000, killSignal: 'SIGKILL' as const,
      maxBuffer: 128 * 1024, windowsHide: true, env: { ...process.env,
        CONTINUUM_DATABASE_URL: loginUrl.toString(), CONTINUUM_ADMIN_ACTOR: actorExternalId,
        CONTINUUM_DB_POOL_MAX: '1', CONTINUUM_DB_CONNECTION_TIMEOUT_MS: '5000' } };
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, args, options);
      return { code: 0, stderr, payload: JSON.parse(stdout.trim()) as Record<string, unknown> };
    } catch (error) {
      const failed = error as Error & { code?: number | string; stdout?: string; stderr?: string };
      if (typeof failed.code !== 'number' || !failed.stdout?.trim()) throw error;
      return { code: failed.code, stderr: failed.stderr ?? '',
        payload: JSON.parse(failed.stdout.trim()) as Record<string, unknown> };
    }
  }

  for (const repair of [false, true]) {
    it(`reports unlocked outbox batch exhaustion as progress for ${repair ? 'completed-run repair' : 'initial offboarding'}`, async () => {
      const value = await seed();
      if (repair) await restoreHistoricalNames(value);
      const result = await call(value);
      expect(await physicalState(value)).toEqual({ names: 1, deliveries: repair ? 0 : 1 });
      expect(result).toMatchObject({ complete: false, progressed: true, blockedUntil: null,
        progress: { memoriesRemaining: 0, auditRowsRemaining: 0 } });
      // No other transaction or worker holds a row lock. A full bounded batch
      // needs another invocation and must not manufacture a busy signal.
      expect(result.reason).toBeNull();
      await completeByService(value);
    }, 300_000);

    it(`compiled CLI completes unlocked outbox batches for ${repair ? 'completed-run repair' : 'initial offboarding'}`, async () => {
      const value = await seed();
      if (repair) await restoreHistoricalNames(value);
      const outcome = await compiledCli(value);
      expect(outcome.stderr).toBe('');
      expect(outcome.payload).toMatchObject({ operation: 'offboard-principal', complete: true,
        incompleteReason: null, resumeRecommended: false, reason: null });
      expect(outcome.code).toBe(0);
      expect(Number(outcome.payload.attempts)).toBeGreaterThan(1);
      expect(await physicalState(value)).toEqual({ names: 0, deliveries: 0 });
    }, 300_000);
  }
});
