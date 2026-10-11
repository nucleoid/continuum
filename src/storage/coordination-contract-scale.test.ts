import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPool, resetData } from './test-helpers.js';
import { runMigrations } from './migrator.js';
import { createPrincipal } from './principals.js';
import { createScope, getScopeByRef } from './scopes.js';
import { addMembership } from './memberships.js';
import { mapOwnedUserScope } from '../services/offboarding.js';
import { acquireLease } from '../services/coordination.js';

const databaseUrl = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:continuum@localhost:5433/continuum';
const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
const uuid = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const rowCount = 50_000;

describe('coordination contract scale and recovery', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); }, 30_000);
  afterEach(async () => {
    await pool.query("UPDATE coordination_contract_backfill_state SET phase='complete'");
  });
  afterAll(async () => pool?.end());

  async function seedPrincipals() {
    await pool.query(`INSERT INTO principals(id,external_id,kind,display_name)
      SELECT ('10000000-0000-4000-8000-'||lpad(value::text,12,'0'))::uuid,
        'scale-'||value,'service','Scale' FROM generate_series(1,$1::integer) value`, [rowCount]);
  }

  async function plan(client: pg.PoolClient, sql: string, values: unknown[]) {
    await client.query('SET plan_cache_mode=force_generic_plan');
    const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, values);
    const root = result.rows[0]['QUERY PLAN'][0].Plan;
    return Number(root['Shared Hit Blocks'] ?? 0) + Number(root['Shared Read Blocks'] ?? 0);
  }

  it('seeks a deep usage backfill cursor under forced generic planning', async () => {
    await seedPrincipals();
    await pool.query(`INSERT INTO coordination_principal_usage(principal_id)
      SELECT id FROM principals WHERE external_id LIKE 'scale-%';
      ANALYZE coordination_principal_usage`);
    const client = await pool.connect();
    try {
      await client.query("UPDATE coordination_contract_backfill_state SET phase='usage',principal_cursor=$1", [uuid(49_000)]);
      const buffers = await plan(client, 'SELECT continuum_backfill_coordination_contract($1)', [1]);
      expect((await client.query('SELECT principal_cursor FROM coordination_contract_backfill_state')).rows[0].principal_cursor)
        .toBe(uuid(49_001));
      expect(buffers).toBeLessThan(400);
    } finally { await client.query('RESET plan_cache_mode'); client.release(); }
  }, 120_000);

  it('seeks a deep receipt cursor without rereading the processed prefix', async () => {
    await seedPrincipals();
    const scope = await createScope(pool, { kind: 'project', name: 'scale-receipts' });
    await pool.query("INSERT INTO coordination_resources(scope_id,resource) VALUES($1,'scale')", [scope.id]);
    await pool.query(`INSERT INTO coordination_operation_receipts
      (principal_id,operation,request_id,payload_hash,outcome,scope_id,resource,expires_at,
        retry_after_seconds,server_time,retain_until)
      SELECT id,'acquire',id,decode(repeat('a',64),'hex'),'contended',$1,'scale',
        clock_timestamp()+interval '1 hour',1,clock_timestamp(),clock_timestamp()+interval '25 hours'
      FROM principals WHERE external_id LIKE 'scale-%'`, [scope.id]);
    await pool.query(`INSERT INTO coordination_principal_privacy_progress(principal_id,detached_principal_id,privacy_version)
      SELECT id,'00000000-0000-4000-8000-000000000012'::uuid,2 FROM principals WHERE external_id LIKE 'scale-%';
      ANALYZE coordination_operation_receipts; ANALYZE coordination_principal_privacy_progress`);
    const client = await pool.connect();
    try {
      await client.query(`UPDATE coordination_contract_backfill_state SET phase='receipts',
        receipt_principal_cursor=$1,receipt_operation_cursor='acquire',receipt_request_cursor=$1`, [uuid(49_000)]);
      const receiptBuffers = await plan(client, 'SELECT continuum_backfill_coordination_contract($1)', [1]);
      expect((await client.query('SELECT receipt_principal_cursor FROM coordination_contract_backfill_state')).rows[0].receipt_principal_cursor)
        .toBe(uuid(49_001));
      expect(receiptBuffers).toBeLessThan(400);
    } finally { await client.query('RESET plan_cache_mode'); client.release(); }
  }, 120_000);

  it('seeks a deep repair-page cursor independently of receipt repair', async () => {
    await seedPrincipals();
    await pool.query(`INSERT INTO coordination_principal_privacy_progress(principal_id,detached_principal_id,privacy_version)
      SELECT id,'00000000-0000-4000-8000-000000000012'::uuid,2 FROM principals WHERE external_id LIKE 'scale-%';
      ANALYZE coordination_principal_privacy_progress`);
    const operator = await createPrincipal(pool, { externalId: 'scale-operator', kind: 'user', displayName: 'Operator' });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, operator.id, org.id, 'admin');
    const client = await pool.connect();
    try {
      const buffers = await plan(client,
        'SELECT * FROM continuum_operator_list_coordination_privacy_repair_page($1,$2,$3)',
        [operator.id, uuid(49_000), 2]);
      const page = (await client.query('SELECT * FROM continuum_operator_list_coordination_privacy_repair_page($1,$2,$3)',
        [operator.id,uuid(49_000),2])).rows[0];
      expect(page.scanned_count).toBe(2);
      expect(page.next_cursor).toBe(uuid(49_002));
      expect(buffers).toBeLessThan(400);
    } finally { await client.query('RESET plan_cache_mode'); client.release(); }
  }, 120_000);

  it('makes an owned scope reopened by the backfill discoverable as pending repair', async () => {
    const operator = await createPrincipal(pool, { externalId: 'reopen-operator', kind: 'user', displayName: 'Operator' });
    const target = await createPrincipal(pool, { externalId: 'reopen-target', kind: 'user', displayName: 'Target' });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const owned = await createScope(pool, { kind: 'user', name: 'reopen-owned' });
    await addMembership(pool, operator.id, org.id, 'admin');
    await addMembership(pool, target.id, owned.id, 'writer');
    await mapOwnedUserScope(pool, operator, target.id, owned.id);
    await pool.query(`INSERT INTO coordination_resources(scope_id,resource,fencing_token) VALUES($1,'legacy-residual',901)`, [owned.id]);
    await pool.query('UPDATE principals SET disabled_at=clock_timestamp() WHERE id=$1', [target.id]);
    await pool.query(`INSERT INTO coordination_scope_privacy_progress(scope_id,pseudonym,phase,completed_at)
      VALUES($1,'recorded-erased-scope','complete',clock_timestamp())`, [owned.id]);
    await pool.query(`INSERT INTO coordination_principal_privacy_progress(principal_id,detached_principal_id,privacy_version,completed_at)
      VALUES($1,'00000000-0000-4000-8000-000000000012',3,clock_timestamp())`, [target.id]);
    await pool.query("UPDATE coordination_contract_backfill_state SET phase='scopes',scope_cursor=NULL");
    await pool.query('SELECT continuum_backfill_coordination_contract(1000)');
    expect((await pool.query('SELECT phase FROM coordination_scope_privacy_progress WHERE scope_id=$1', [owned.id])).rows)
      .toEqual([{ phase: 'receipts' }]);
    const page = (await pool.query('SELECT * FROM continuum_operator_list_coordination_privacy_repair_page($1,NULL,100)', [operator.id])).rows[0];
    expect(page.repairs).toContainEqual({ principal_id: target.id, scope_id: owned.id, repair_state: 'disabled_only' });
  });

  it('keeps a 0055-shaped renamed resource generation above its old fencing token on reactivation', async () => {
    const writer = await createPrincipal(pool, { externalId: 'historical-writer', kind: 'user', displayName: 'Writer' });
    const scope = await createScope(pool, { kind: 'user', name: 'historical-reactivation' });
    await addMembership(pool, writer.id, scope.id, 'writer');
    // 0055 renamed resource keys without recording a scope floor or privacy
    // progress. A historical snapshot can still contain precisely this shape.
    await pool.query(`INSERT INTO coordination_resources(scope_id,resource,fencing_token)
      VALUES($1,$2,901)`, [scope.id, `offboarded:${randomUUID()}`]);
    expect((await pool.query('SELECT count(*)::int AS count FROM coordination_scope_fencing_floors WHERE scope_id=$1', [scope.id])).rows)
      .toEqual([{ count: 0 }]);
    expect((await pool.query('SELECT count(*)::int AS count FROM coordination_scope_privacy_progress WHERE scope_id=$1', [scope.id])).rows)
      .toEqual([{ count: 0 }]);
    const acquired = await acquireLease(pool, writer, { scope: 'user:historical-reactivation',
      resource: 'original-key', runId: randomUUID(), requestId: randomUUID(), ttlSeconds: 300 });
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) throw new Error('historical scope acquisition unexpectedly contended');
    expect(BigInt(acquired.fencingToken)).toBeGreaterThan(901n);
  });

  it('accepts privacy negotiation from a direct quoted login without parsing its name as regrole', async () => {
    const role = `Quoted-Operator@${randomUUID().slice(0, 8)}`;
    const password = randomUUID();
    const namespace = (await pool.query('SELECT current_schema() AS name')).rows[0].name as string;
    let login: pg.Pool | undefined;
    try {
      await pool.query(`CREATE ROLE ${quoted(role)} LOGIN PASSWORD '${password}'`);
      await pool.query(`GRANT USAGE ON SCHEMA ${quoted(namespace)} TO ${quoted(role)};
        GRANT EXECUTE ON FUNCTION ${quoted(namespace)}.continuum_require_coordination_privacy_client_v4() TO ${quoted(role)}`);
      const url = new URL(databaseUrl); url.username = role; url.password = password;
      login = new pg.Pool({ connectionString: url.toString(), max: 1 });
      await login.query("SELECT set_config('continuum.client_coordination_privacy_version','4',false)");
      expect((await login.query('SELECT session_user AS name,current_setting(\'role\') AS selected')).rows)
        .toEqual([{ name: role, selected: 'none' }]);
      await expect(login.query(`SELECT ${quoted(namespace)}.continuum_require_coordination_privacy_client_v4()`))
        .resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await login?.end();
      await pool.query(`DROP OWNED BY ${quoted(role)}; DROP ROLE ${quoted(role)}`);
    }
  });

  it('backfills receipts as the non-superuser function owner with database TEMP revoked', async () => {
    const database = `contract_temp_${randomUUID().replaceAll('-', '')}`;
    const owner = `contract_owner_${randomUUID().replaceAll('-', '')}`;
    const root = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    let target: pg.Pool | undefined;
    let ownerPool: pg.Pool | undefined;
    try {
      await root.query(`CREATE ROLE ${quoted(owner)} NOLOGIN`);
      await root.query(`CREATE DATABASE ${quoted(database)}`);
      const url = new URL(databaseUrl); url.pathname = `/${database}`;
      target = new pg.Pool({ connectionString: url.toString(), max: 1 });
      await target.query(`CREATE SCHEMA application_data AUTHORIZATION ${quoted(owner)};
        CREATE SCHEMA continuum_extensions; CREATE EXTENSION vector WITH SCHEMA continuum_extensions;
        GRANT USAGE ON SCHEMA continuum_extensions TO ${quoted(owner)};
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA continuum_extensions TO ${quoted(owner)};
        GRANT TEMP ON DATABASE ${quoted(database)} TO ${quoted(owner)}`);
      ownerPool = new pg.Pool({ connectionString: url.toString(), max: 1,
        options: `-c search_path=application_data -c role=${owner}` });
      await runMigrations(ownerPool);
      await target.query(`REVOKE TEMP ON DATABASE ${quoted(database)} FROM PUBLIC,${quoted(owner)}`);
      expect((await ownerPool.query("SELECT has_database_privilege(current_user,current_database(),'TEMP') AS allowed")).rows[0].allowed)
        .toBe(false);
      await ownerPool.query("UPDATE coordination_contract_backfill_state SET phase='receipts',receipt_principal_cursor=NULL");
      await expect(ownerPool.query('SELECT continuum_backfill_coordination_contract(1) AS completed'))
        .resolves.toMatchObject({ rows: [{ completed: true }] });
    } finally {
      await ownerPool?.end(); await target?.end();
      await root.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      await root.query(`DROP ROLE IF EXISTS ${quoted(owner)}`);
      await root.end();
    }
  }, 120_000);
});
