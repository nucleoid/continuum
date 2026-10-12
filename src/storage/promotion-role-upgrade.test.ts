import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from './migrator.js';
import { reconcilePgvectorProviderGrants, requireCoordinationContractReady, requirePromotionOutboxReady } from './provider-lifecycle.js';
import { createScope } from './scopes.js';
import { createPrincipal, getPrincipal } from './principals.js';
import { mapOwnedUserScope, offboardPrincipal } from '../services/offboarding.js';
import { addMembership } from './memberships.js';
import { createMemory } from './memories.js';
import { promoteMemoryWithAudit } from './promote.js';
import { claimPromotionDeliveries, completePromotionDelivery } from './promotion-events.js';

const databaseUrl = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:continuum@localhost:5433/continuum';
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function roleUpgradeAcceptance(review?: 'poison' | 'null' | 'regrant' | 'event-identity' | 'hook-identity') {
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
    [schema, ['promotion_events', 'promotion_event_deliveries', 'promotion_webhook_registry']])).rows).toEqual([]);

    for (const role of roles) {
      const url = new URL(databaseUrl);
      url.username = role;
      url.password = passwords.get(role)!;
      const connection = new pg.Pool({ connectionString: url.toString(), max: 1,
        options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=1000` });
      logins.set(role, connection);
      expect((await connection.query('SELECT current_user AS role')).rows).toEqual([{ role }]);
      await reconcilePgvectorProviderGrants(connection, { expectedSchema: schema });
      expect((await connection.query(`SELECT pg_catalog.has_function_privilege(
        'continuum_operator_scrub_promotion_scope(uuid,uuid,uuid,integer)','EXECUTE') AS allowed`)).rows)
        .toEqual([{ allowed: role === operatorRole }]);
      if (role !== operatorRole) await expect(connection.query(
        'SELECT continuum_operator_scrub_promotion_scope($1::uuid,$2::uuid,$3::uuid,1::integer)',
        [administrator, administrator, randomUUID()])).rejects.toMatchObject({ code: '42501' });
      for (const table of ['promotion_events', 'promotion_event_deliveries', 'promotion_webhook_registry']) {
        const expected = table !== 'promotion_webhook_registry' && (role === appRole || role === operatorRole)
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
        await requirePromotionOutboxReady(connection, { expectedSchema: schema });
        await expect(connection.query('UPDATE promotion_events SET occurred_at=occurred_at WHERE FALSE'))
          .rejects.toMatchObject({ code: '42501' });
        await expect(connection.query('DELETE FROM promotion_event_deliveries WHERE FALSE'))
          .rejects.toMatchObject({ code: '42501' });
      }
    }
    for (const [role, connection] of logins) {
      expect((await connection.query(`SELECT pg_catalog.has_function_privilege(
        'continuum_operator_set_promotion_webhook_ids(uuid,text[])','EXECUTE') AS allowed`)).rows)
        .toEqual([{ allowed: role === operatorRole }]);
      expect((await connection.query(`SELECT pg_catalog.has_function_privilege(
        'continuum_promotion_webhook_ids()','EXECUTE') AS allowed`)).rows)
        .toEqual([{ allowed: role === appRole || role === operatorRole }]);
    }
    const app = logins.get(appRole)!;
    const sourceScope = await createScope(owner, { kind: 'team', name: 'role-upgrade-source' });
    const destinationScope = await createScope(owner, { kind: 'project', name: 'role-upgrade-target' });
    await addMembership(owner, administrator, sourceScope.id, 'writer');
    await addMembership(owner, administrator, destinationScope.id, 'writer');
    const memory = await createMemory(owner, { scopeId: sourceScope.id, scopeKind: sourceScope.kind,
      authorId: administrator, type: 'decision', title: 'Role upgrade', body: 'Actual application promotion.', source: 'manual' });
    await logins.get(operatorRole)!.query(
      'SELECT continuum_operator_set_promotion_webhook_ids($1::uuid,$2::text[])',
      [administrator, ['upgrade-hook']],
    );
    await expect(app.query('SELECT * FROM promotion_webhook_registry')).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('SELECT continuum_operator_set_promotion_webhook_ids($1::uuid,$2::text[])',
      [administrator, ['forged-hook']])).rejects.toMatchObject({ code: '42501' });
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

    const operator = logins.get(operatorRole)!;
    if (review === 'regrant') {
      const before = (await owner.query('SELECT webhook_ids FROM promotion_webhook_registry WHERE singleton')).rows;
      await expect(operator.query('SELECT continuum_operator_set_promotion_webhook_ids($1::uuid,$2::text[])',
        [administrator, null])).rejects.toMatchObject({ code: '23514' });
      await expect(operator.query('SELECT continuum_operator_set_promotion_webhook_ids($1::uuid,$2::text[])',
        [administrator, ['Invalid ID']])).rejects.toMatchObject({ code: '23514' });
      await owner.query(`CREATE FUNCTION reject_registry_configuration_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.metadata->>'operation'='promotion_webhook_registry_configured' THEN
          RAISE EXCEPTION 'expected registry audit failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_registry_configuration_audit BEFORE INSERT ON audit_log
          FOR EACH ROW EXECUTE FUNCTION reject_registry_configuration_audit()`);
      try {
        await expect(operator.query('SELECT continuum_operator_set_promotion_webhook_ids($1::uuid,$2::text[])',
          [administrator, ['replacement-hook']])).rejects.toThrow('expected registry audit failure');
      } finally {
        await owner.query('DROP TRIGGER reject_registry_configuration_audit ON audit_log; DROP FUNCTION reject_registry_configuration_audit()');
      }
      expect((await owner.query('SELECT webhook_ids FROM promotion_webhook_registry WHERE singleton')).rows).toEqual(before);
      const reader = await owner.connect();
      let configure: Promise<pg.QueryResult> | undefined;
      try {
        await reader.query('BEGIN');
        const readerPid = (await reader.query('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0].pid;
        const operatorPid = (await operator.query('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0].pid;
        expect((await reader.query('SELECT continuum_promotion_webhook_ids() AS ids')).rows[0].ids).toEqual(['upgrade-hook']);
        configure = operator.query('SELECT continuum_operator_set_promotion_webhook_ids($1::uuid,$2::text[])',
          [administrator, ['upgrade-hook', 'upgrade-hook']]);
        void configure.catch(() => undefined);
        const deadline = Date.now() + 1_000;
        let blocked = false;
        while (!blocked && Date.now() < deadline) {
          blocked = (await maintenance.query('SELECT $1::integer=ANY(pg_catalog.pg_blocking_pids($2::integer)) AS blocked',
            [readerPid, operatorPid])).rows[0].blocked;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(blocked).toBe(true);
      } finally {
        try { await reader.query('ROLLBACK'); } finally { reader.release(); }
        if (configure) await configure;
      }
      expect((await owner.query('SELECT webhook_ids FROM promotion_webhook_registry WHERE singleton')).rows).toEqual(before);

    }

    const admin = (await getPrincipal(owner, administrator))!;
    const target = await createPrincipal(owner, { externalId: `promotion-private-${suffix}`, kind: 'user', displayName: 'Private Person' });
    const personal = await createScope(owner, { kind: 'user', name: `personal-${suffix}` });
    await addMembership(owner, target.id, sourceScope.id, 'writer');
    await addMembership(owner, target.id, personal.id, 'writer');
    await mapOwnedUserScope(operator, admin, target.id, personal.id);
    const privateSource = await createMemory(owner, { scopeId: sourceScope.id, scopeKind: 'team', authorId: target.id,
      type: 'fact', title: 'Owned destination', body: 'Normal role-bound promotion.', source: 'manual' });
    await operator.query('SELECT continuum_operator_set_promotion_webhook_ids($1::uuid,$2::text[])',
      [administrator, ['private-hook']]);
    const privatePromotion = await promoteMemoryWithAudit(app, target.id, privateSource.id,
      { kind: 'user', name: personal.name }, {}, ['private-hook']);
    await expect(operator.query('UPDATE promotion_events SET destination_scope_name=destination_scope_name WHERE id=$1::uuid',
      [privatePromotion.promotionEvent.eventId])).rejects.toMatchObject({ code: '42501' });
    await expect(operator.query('SELECT continuum_operator_scrub_promotion_scope($1::uuid,$2::uuid,$3::uuid,1::integer)',
      [target.id, target.id, personal.id])).rejects.toMatchObject({ code: 'P0001',
        message: expect.stringMatching(/DB-bound trusted approve identity|role-name\/OID-bound trusted approve identity/i) });
    if (review === 'poison') {
      await app.query(`SELECT pg_catalog.set_config('continuum.promotion_privacy_actor',$1::text,FALSE),
        pg_catalog.set_config('continuum.promotion_privacy_scope',$2::text,FALSE)`, [administrator, personal.id]);
      await expect(app.query(`UPDATE promotion_event_deliveries SET state='privacy_cancelled',
        last_error='private poisoning payload',lease_owner='unstarted-poison',lease_expires_at=pg_catalog.clock_timestamp()+interval '1 minute'
        WHERE event_id=$1::uuid`, [privatePromotion.promotionEvent.eventId])).rejects.toMatchObject({ code: '23514' });
      // Trusted historical import, with ordinary triggers still enabled.
      // The real OP capability must repair this dirty terminal shape.
      await owner.query(`INSERT INTO promotion_event_deliveries(event_id,webhook_id,state,last_error,lease_owner,lease_expires_at)
        VALUES($1::uuid,'historical-dirty','privacy_cancelled','private historical error','historical-owner',pg_catalog.clock_timestamp()+interval '1 minute')`,
        [privatePromotion.promotionEvent.eventId]);
    }
    let privacy = await offboardPrincipal(operator, admin, target.id, { confirmationScopeId: personal.id,
      ...(review === 'poison' ? { batchSize: 1 } : {}) });
    if (review === 'poison') {
      const bounded = (await operator.query('SELECT continuum_operator_scrub_promotion_scope($1::uuid,$2::uuid,$3::uuid,1::integer) AS privacy',
        [administrator, target.id, personal.id])).rows[0].privacy;
      expect(bounded.processed).toBeGreaterThan(0);
      expect(bounded.processed).toBeLessThanOrEqual(2);
    }
    for (let attempt = 0; !privacy.complete && attempt < 5; attempt += 1) {
      privacy = await offboardPrincipal(operator, admin, target.id, { confirmationScopeId: personal.id });
    }
    expect(privacy.complete).toBe(true);
    if (review === 'event-identity' || review === 'hook-identity') {
      // Legitimate active promotion plus an owner-imported pending delivery.
      // Normal triggers remain enabled and its destination is not disabled.
      await owner.query(`INSERT INTO promotion_event_deliveries(event_id,webhook_id)
        VALUES($1::uuid,'identity-hook')`, [promoted.promotionEvent.eventId]);
      const before = (await owner.query('SELECT * FROM promotion_event_deliveries ORDER BY event_id,webhook_id')).rows;
      if (review === 'event-identity') {
        await expect(app.query(`UPDATE promotion_event_deliveries SET event_id=$1::uuid
          WHERE event_id=$2::uuid AND webhook_id='identity-hook'`,
          [privatePromotion.promotionEvent.eventId, promoted.promotionEvent.eventId]))
          .rejects.toMatchObject({ code: '23514' });
      } else {
        await expect(app.query(`UPDATE promotion_event_deliveries SET webhook_id='moved-hook'
          WHERE event_id=$1::uuid AND webhook_id='identity-hook'`, [promoted.promotionEvent.eventId]))
          .rejects.toMatchObject({ code: '23514' });
      }
      expect((await owner.query('SELECT * FROM promotion_event_deliveries ORDER BY event_id,webhook_id')).rows).toEqual(before);
    }

    const receipt = (await owner.query(`SELECT id,metadata FROM audit_log WHERE scope_id=$1::uuid
      AND metadata->>'operation'='principal_promotion_privacy_repaired' ORDER BY id DESC LIMIT 1`, [personal.id])).rows[0];
    expect(receipt.metadata).toMatchObject({ operation: 'principal_promotion_privacy_repaired', principal_id: target.id,
      approval_id: expect.any(String), run_id: expect.any(String), rows_processed: expect.any(Number) });
    for (const forger of [app, operator]) {
      await expect(forger.query(`INSERT INTO audit_log(principal_id,action,scope_id,metadata)
        VALUES($1::uuid,'archive',$2::uuid,$3::jsonb)`, [administrator, personal.id, JSON.stringify(receipt.metadata)]))
        .rejects.toMatchObject({ code: '42501' });
    }
    await expect(owner.query(`UPDATE audit_log SET metadata=metadata WHERE id=$1::bigint`, [receipt.id]))
      .rejects.toMatchObject({ code: '23514' });

    if (review === 'poison') expect((await owner.query(`SELECT state,last_error,lease_owner,lease_expires_at FROM promotion_event_deliveries
      WHERE event_id=$1::uuid AND webhook_id='historical-dirty'`, [privatePromotion.promotionEvent.eventId])).rows)
      .toEqual([{ state: 'privacy_cancelled', last_error: null, lease_owner: null, lease_expires_at: null }]);
    if (review === 'null') {
      const before = (await owner.query('SELECT * FROM promotion_event_deliveries WHERE event_id=$1::uuid', [privatePromotion.promotionEvent.eventId])).rows;
      const beforeEvents = (await owner.query('SELECT * FROM promotion_events ORDER BY id')).rows;
      const beforeAudits = (await owner.query('SELECT count(*)::int AS count FROM audit_log')).rows;
      for (const limit of [0, 1001, null]) {
        await expect(operator.query('SELECT continuum_operator_scrub_promotion_scope($1::uuid,$2::uuid,$3::uuid,$4::integer)',
          [administrator, target.id, personal.id, limit])).rejects.toMatchObject({ code: '23514' });
        expect((await owner.query('SELECT * FROM promotion_event_deliveries WHERE event_id=$1::uuid', [privatePromotion.promotionEvent.eventId])).rows).toEqual(before);
        expect((await owner.query('SELECT * FROM promotion_events ORDER BY id')).rows).toEqual(beforeEvents);
        expect((await owner.query('SELECT count(*)::int AS count FROM audit_log')).rows).toEqual(beforeAudits);
      }
    }
    expect((await owner.query('SELECT destination_scope_name FROM promotion_events WHERE id=$1::uuid',
      [privatePromotion.promotionEvent.eventId])).rows[0].destination_scope_name).not.toBe(personal.name);
    // A trusted historical restore can dirty a completed receipt. The actual
    // physical predicate must reject that receipt and the next approved retry
    // must commit bounded repair before claiming completion again.
    await owner.query('UPDATE promotion_events SET destination_scope_name=$1::text WHERE id=$2::uuid',
      [personal.name, privatePromotion.promotionEvent.eventId]);
    const reopened = await offboardPrincipal(operator, admin, target.id, { confirmationScopeId: personal.id });
    expect(reopened).toMatchObject({ complete: false, progressed: true });
    expect((await offboardPrincipal(operator, admin, target.id, { confirmationScopeId: personal.id })).complete).toBe(true);
    await expect(operator.query('SELECT continuum_operator_scrub_promotion_scope($1::uuid,$2::uuid,$3::uuid,1::integer)',
      [administrator, target.id, destinationScope.id])).rejects.toMatchObject({ code: '42501' });

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
    if (review === 'regrant') {
      const operatorOid = originalProfiles.find((row) => row.profile_kind === 'operator')!.database_role_oid;
      for (const step of ['application', 'operator', 'application'] as const) {
        if (step === 'operator') await grant('grant-operator-role.sql', { continuum_operator_role: operatorRole, continuum_principal_id: administrator });
        else await grant('grant-application-role.sql', { continuum_app_role: operatorRole });
        expect((await owner.query('SELECT database_role_oid,profile_kind FROM continuum_pgvector_role_profiles WHERE database_role_oid=$1::oid',
          [operatorOid])).rows).toEqual([{ database_role_oid: operatorOid, profile_kind: step }]);
        await owner.query('SELECT continuum_assert_application_role_allowlist($1::name,$2::boolean)', [operatorRole, step === 'operator']);
        await reconcilePgvectorProviderGrants(operator, { expectedSchema: schema });
        expect((await operator.query(`SELECT pg_catalog.has_function_privilege(
          'continuum_operator_scrub_promotion_scope(uuid,uuid,uuid,integer)','EXECUTE') AS allowed`)).rows)
          .toEqual([{ allowed: step === 'operator' }]);
        if (step === 'application') await expect(operator.query('SELECT continuum_operator_scrub_promotion_scope($1::uuid,$2::uuid,$3::uuid,1::integer)',
          [administrator, target.id, personal.id])).rejects.toMatchObject({ code: '42501' });
      }
    }
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
 }

it('upgrades canonical 88 to 89 with exact live login profiles and preserves ordinary outbox authority',
  () => roleUpgradeAcceptance(), 180_000);
it('promotion privacy boundary review: rejects application poisoning of the terminal cancellation state',
  () => roleUpgradeAcceptance('poison'), 180_000);
it('promotion privacy boundary review: rejects NULL and out-of-range batch limits without mutation',
  () => roleUpgradeAcceptance('null'), 180_000);
it('promotion operator regrant review: reapplies APP then OP then APP on the same bound role OID',
  () => roleUpgradeAcceptance('regrant'), 180_000);

it('promotion delivery identity review: cannot move a pending APP delivery onto an erased event',
  () => roleUpgradeAcceptance('event-identity'), 180_000);
it('promotion delivery identity review: cannot rewrite a pending APP delivery webhook identity',
  () => roleUpgradeAcceptance('hook-identity'), 180_000);
