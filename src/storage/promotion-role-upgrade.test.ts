import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from './migrator.js';
import { reconcilePgvectorProviderGrants, requireCoordinationContractReady } from './provider-lifecycle.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { createMemory } from './memories.js';
import { promoteMemoryWithAudit } from './promote.js';
import { claimPromotionDeliveries, completePromotionDelivery } from './promotion-events.js';

const databaseUrl = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:continuum@localhost:5433/continuum';
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

it('upgrades canonical 88 to 89 with exact live login profiles and preserves ordinary outbox authority', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const schema = `promotion_roles_${suffix}`;
  const roles = ['app', 'operator', 'sync', 'report'].map((kind) => `promotion_${kind}_${suffix}`);
  const [appRole, operatorRole, syncRole, reportRole] = roles;
  const administrator = randomUUID();
  const syncPrincipal = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'continuum-promotion-roles-'));
  const migrationSource = new URL('../../migrations/', import.meta.url);
  const maintenance = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const owner = new pg.Pool({ connectionString: databaseUrl, max: 1,
    options: `-c search_path=${schema} -c statement_timeout=60000 -c lock_timeout=5000` });
  const createdRoles: string[] = [];
  const passwords = new Map<string, string>();
  const logins = new Map<string, pg.Pool>();
  try {
    await maintenance.query(`CREATE SCHEMA ${quote(schema)}`);
    for (const file of (await readdir(migrationSource)).sort()) {
      if (/^\d{4}_.+\.sql$/.test(file) && Number(file.slice(0, 4)) <= 88) {
        await copyFile(new URL(file, migrationSource), join(directory, file));
      }
    }
    const installed = await runMigrations(owner, directory);
    expect(installed.at(-1)?.name).toBe('0088_embedding_provider_scan_index_rebuild.sql');
    expect((await owner.query("SELECT pg_catalog.to_regclass('promotion_events') AS table_name")).rows)
      .toEqual([{ table_name: null }]);
    await owner.query(`INSERT INTO principals(id,external_id,kind,display_name)
      VALUES($1::uuid,$1::uuid::text,'user','Promotion Administrator'),
            ($2::uuid,$2::uuid::text,'service','Promotion Sync')`, [administrator, syncPrincipal]);
    await owner.query(`INSERT INTO scope_memberships(principal_id,scope_id,role,source_kind,source_id,active)
      SELECT $1::uuid,id,'admin','manual','manual',TRUE FROM scopes WHERE kind='org' AND name=''`, [administrator]);
    for (const role of roles) {
      const password = randomUUID();
      await owner.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD ${literal(password)}`);
      createdRoles.push(role);
      passwords.set(role, password);
    }
    // Run the actual current scripts, substituting their documented psql
    // variables. No registry insert, privileged identity GUC or SET ROLE path.
    async function grant(filename: string, variables: Record<string, string>) {
      let sql = (await readFile(join(process.cwd(), 'scripts', filename), 'utf8'))
        .split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\')).join('\n');
      for (const [key, value] of Object.entries({ continuum_schema: schema, ...variables })) {
        sql = sql.replaceAll(`:"${key}"`, quote(value)).replaceAll(`:'${key}'`, literal(value));
      }
      const client = await owner.connect();
      let discard = false;
      try { await client.query(sql); }
      catch (error) { try { await client.query('ROLLBACK'); } catch { discard = true; } throw error; }
      finally { client.release(discard); }
    }
    await grant('grant-application-role.sql', { continuum_app_role: appRole });
    await grant('grant-application-role.sql', { continuum_app_role: operatorRole });
    await grant('grant-operator-role.sql', { continuum_operator_role: operatorRole, continuum_principal_id: administrator });
    await grant('grant-sync-role.sql', { continuum_sync_role: syncRole, continuum_principal_id: syncPrincipal });
    await owner.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(reportRole)};
      GRANT SELECT ON memories TO ${quote(reportRole)}`);
    await owner.query('SELECT continuum_register_pgvector_reporting_profile($1::name,TRUE)', [reportRole]);
    await owner.query('SELECT continuum_grant_application_vector_functions($1::name)', [reportRole]);
    async function profiles() {
      return (await owner.query(`SELECT database_role_oid,profile_kind,provider_schema_oid
        FROM continuum_pgvector_role_profiles ORDER BY database_role_oid`)).rows;
    }
    async function identities() {
      return (await owner.query(`SELECT database_role,database_role_oid,principal_id,can_approve,can_sync
        FROM continuum_trusted_database_identities ORDER BY database_role_oid`)).rows;
    }
    const originalProfiles = await profiles();
    const originalIdentities = await identities();
    expect(originalProfiles.map((row) => row.profile_kind).sort())
      .toEqual(['application', 'operator', 'reporting', 'sync']);
    expect(originalIdentities).toHaveLength(2);

    const forward = '0089_promotion_outbox.sql';
    await copyFile(new URL(forward, migrationSource), join(directory, forward));
    expect((await runMigrations(owner, directory)).map((migration) => migration.name)).toEqual([forward]);
    expect(await runMigrations(owner, directory)).toEqual([]);
    expect(await profiles()).toEqual(originalProfiles);
    expect(await identities()).toEqual(originalIdentities);
    expect((await owner.query(`SELECT relation.relname,acl.privilege_type
      FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(relation.relacl,pg_catalog.acldefault('r',relation.relowner))) acl
      WHERE namespace.nspname=$1::text AND relation.relname=ANY($2::text[]) AND acl.grantee=0`,
    [schema, ['promotion_events', 'promotion_event_deliveries']])).rows).toEqual([]);

    for (const role of roles) {
      const url = new URL(databaseUrl);
      url.username = role;
      url.password = passwords.get(role)!;
      const connection = new pg.Pool({ connectionString: url.toString(), max: 1,
        options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=1000` });
      logins.set(role, connection);
      expect((await connection.query('SELECT current_user AS role')).rows).toEqual([{ role }]);
      await reconcilePgvectorProviderGrants(connection, { expectedSchema: schema });
      for (const table of ['promotion_events', 'promotion_event_deliveries']) {
        const expected = role === appRole || role === operatorRole
          ? table === 'promotion_events' ? ['SELECT', 'INSERT'] : ['SELECT', 'INSERT', 'UPDATE'] : [];
        // Each actual LOGIN inspects its own effective rights, not the owner
        // claiming that a target role ought to have a privilege.
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          expect((await connection.query('SELECT pg_catalog.has_table_privilege($1::text,$2::text) AS allowed',
            [`${schema}.${table}`, privilege])).rows).toEqual([{ allowed: expected.includes(privilege) }]);
        }
        if (expected.length === 0) {
          await expect(connection.query(`SELECT * FROM ${table} LIMIT 1`)).rejects.toMatchObject({ code: '42501' });
        }
      }
      if (role === appRole || role === operatorRole) {
        await requireCoordinationContractReady(connection, { expectedSchema: schema });
        await expect(connection.query('UPDATE promotion_events SET occurred_at=occurred_at WHERE FALSE'))
          .rejects.toMatchObject({ code: '42501' });
        await expect(connection.query('DELETE FROM promotion_event_deliveries WHERE FALSE'))
          .rejects.toMatchObject({ code: '42501' });
      }
    }
    const app = logins.get(appRole)!;
    const sourceScope = await createScope(owner, { kind: 'team', name: 'role-upgrade-source' });
    const destinationScope = await createScope(owner, { kind: 'project', name: 'role-upgrade-target' });
    await addMembership(owner, administrator, sourceScope.id, 'writer');
    await addMembership(owner, administrator, destinationScope.id, 'writer');
    const memory = await createMemory(owner, { scopeId: sourceScope.id, scopeKind: sourceScope.kind,
      authorId: administrator, type: 'decision', title: 'Role upgrade', body: 'Actual application promotion.', source: 'manual' });
    const promoted = await promoteMemoryWithAudit(app, administrator, memory.id,
      { kind: destinationScope.kind, name: destinationScope.name }, {}, ['upgrade-hook']);
    const claimed = await claimPromotionDeliveries(app, { owner: 'ordinary-application-worker',
      webhookIds: ['upgrade-hook'], limit: 1, leaseMs: 60_000 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].event.eventId).toBe(promoted.promotionEvent.eventId);
    expect(await completePromotionDelivery(app, claimed[0].event.eventId, claimed[0].webhookId,
      'ordinary-application-worker', claimed[0].attemptCount, claimed[0].leaseGeneration)).toBe(true);
    expect((await logins.get(operatorRole)!.query('SELECT state FROM promotion_event_deliveries')).rows)
      .toEqual([{ state: 'delivered' }]);
    await expect(reconcilePgvectorProviderGrants(app, { expectedSchema: 'public' }))
      .rejects.toThrow(/Runtime application schema is not trusted/);

    await owner.query(`GRANT DELETE ON promotion_events TO ${quote(appRole)}`);
    try {
      await expect(reconcilePgvectorProviderGrants(app, { expectedSchema: schema }))
        .rejects.toThrow(/exact.*profile|profile.*drift/i);
      expect((await app.query("SELECT pg_catalog.has_table_privilege('promotion_events','DELETE') AS allowed")).rows)
        .toEqual([{ allowed: true }]);
    } finally { await owner.query(`REVOKE DELETE ON promotion_events FROM ${quote(appRole)}`); }
    await grant('grant-application-role.sql', { continuum_app_role: appRole });
    await grant('grant-operator-role.sql', { continuum_operator_role: operatorRole, continuum_principal_id: administrator });
    await grant('grant-sync-role.sql', { continuum_sync_role: syncRole, continuum_principal_id: syncPrincipal });
    expect(await profiles()).toEqual(originalProfiles);
    expect(await identities()).toEqual(originalIdentities);
    await reconcilePgvectorProviderGrants(app, { expectedSchema: schema });

    // Exercise the real APP -> OP transition using the same role OID and the
    // reviewed scripts, rather than editing the provider/identity registries.
    const appOid = originalProfiles.find((row) => row.profile_kind === 'application')!.database_role_oid;
    await grant('grant-operator-role.sql', { continuum_operator_role: appRole, continuum_principal_id: administrator });
    expect((await owner.query(`SELECT database_role_oid,profile_kind FROM continuum_pgvector_role_profiles
      WHERE database_role_oid=$1::oid`, [appOid])).rows)
      .toEqual([{ database_role_oid: appOid, profile_kind: 'operator' }]);
    expect((await owner.query(`SELECT principal_id,can_approve,can_sync FROM continuum_trusted_database_identities
      WHERE database_role_oid=$1::oid`, [appOid])).rows)
      .toEqual([{ principal_id: administrator, can_approve: true, can_sync: false }]);
    await reconcilePgvectorProviderGrants(app, { expectedSchema: schema });
    await requireCoordinationContractReady(app, { expectedSchema: schema });
    await expect(app.query('SELECT continuum_operator_authorize_audit_retention($1::uuid)', [administrator]))
      .resolves.toBeDefined();
    expect((await app.query("SELECT pg_catalog.has_table_privilege('promotion_events','DELETE') AS allowed")).rows)
      .toEqual([{ allowed: false }]);
  } finally {
    await Promise.all([...logins.values()].map((connection) => connection.end()));
    await owner.end();
    await maintenance.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    for (const role of createdRoles.reverse()) {
      await maintenance.query(`DROP OWNED BY ${quote(role)}; DROP ROLE ${quote(role)}`);
    }
    await maintenance.end();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
