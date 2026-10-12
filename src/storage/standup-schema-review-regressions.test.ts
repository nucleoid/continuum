import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { expect, it } from 'vitest';
import { standupProducerFixture as fixture, quoteStandupIdentifier as quote } from '../standup/test-helpers.js';
import { createMemory } from './memories.js';

const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";

it('accepts the actual PostgreSQL 16 non-superuser creator ADMIN edge for producer context and recording', async () => {
  await fixture(async (value) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const creatorRole = `standup_creator_${suffix}`, producerRole = `standup_created_${suffix}`;
    const password = randomUUID();
    const schema = (await value.owner.query('SELECT current_schema() AS schema')).rows[0].schema;
    const originalOwner = (await value.owner.query('SELECT current_user AS role')).rows[0].role;
    const connectionString = process.env.CONTINUUM_TEST_DATABASE_URL ?? 'postgres://continuum:continuum@localhost:5433/continuum';
    const creatorUrl = new URL(connectionString); creatorUrl.username = creatorRole; creatorUrl.password = password;
    const creator = new pg.Pool({ connectionString: creatorUrl.toString(), max: 1,
      options: `-c search_path=${schema} -c statement_timeout=60000 -c lock_timeout=5000` });
    const producerUrl = new URL(connectionString); producerUrl.username = producerRole; producerUrl.password = password;
    const producer = new pg.Pool({ connectionString: producerUrl.toString(), max: 1,
      options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=1000` });
    let producerCreated = false;
    let primaryFailure: unknown;
    await value.owner.query(`CREATE ROLE ${quote(creatorRole)} LOGIN CREATEROLE PASSWORD ${literal(password)}`);
    try {
      // Model a supported ownership handoff using real DDL, not catalog edits.
      for (const row of (await value.owner.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind IN ('r','p')`, [schema])).rows) {
        await value.owner.query(`ALTER TABLE ${quote(schema)}.${quote(row.relname)} OWNER TO ${quote(creatorRole)}`);
      }
      for (const row of (await value.owner.query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1`, [schema])).rows) {
        await value.owner.query(`ALTER FUNCTION ${quote(schema)}.${quote(row.proname)}(${row.args}) OWNER TO ${quote(creatorRole)}`);
      }
      await value.owner.query(`ALTER SCHEMA ${quote(schema)} OWNER TO ${quote(creatorRole)}`);
      // The provider owner delegates only the extension capabilities required
      // by the documented grant refresher, not schema CREATE or ownership.
      const provider = (await value.owner.query(`SELECT n.nspname,t.typname FROM pg_extension e
        JOIN pg_namespace n ON n.oid=e.extnamespace JOIN pg_type t ON t.typnamespace=n.oid
        WHERE e.extname='vector' AND t.typname='vector'`)).rows[0];
      expect(provider).toBeDefined();
      await value.owner.query(`GRANT USAGE ON SCHEMA ${quote(provider.nspname)} TO ${quote(creatorRole)} WITH GRANT OPTION`);
      await value.owner.query(`GRANT USAGE ON TYPE ${quote(provider.nspname)}.${quote(provider.typname)} TO ${quote(creatorRole)} WITH GRANT OPTION`);
      for (const row of (await value.owner.query(`SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_extension e JOIN pg_depend d ON d.refobjid=e.oid AND d.refclassid='pg_extension'::regclass AND d.deptype='e'
        JOIN pg_proc p ON p.oid=d.objid AND d.classid='pg_proc'::regclass
        JOIN pg_namespace n ON n.oid=p.pronamespace WHERE e.extname='vector'`)).rows) {
        await value.owner.query(`GRANT EXECUTE ON FUNCTION ${quote(row.nspname)}.${quote(row.proname)}(${row.args}) TO ${quote(creatorRole)} WITH GRANT OPTION`);
      }
      expect((await creator.query('SELECT rolsuper,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows)
        .toEqual([{ rolsuper: false, rolcreaterole: true }]);
      await creator.query(`CREATE ROLE ${quote(producerRole)} LOGIN PASSWORD ${literal(password)}`);
      producerCreated = true;
      expect((await value.owner.query(`SELECT e.admin_option,e.set_option,e.inherit_option FROM pg_auth_members e
        JOIN pg_roles r ON r.oid=e.roleid JOIN pg_roles m ON m.oid=e.member WHERE r.rolname=$1 AND m.rolname=$2`,
      [producerRole, creatorRole])).rows).toEqual([{ admin_option: true, set_option: false, inherit_option: false }]);
      let sql = (await readFile('scripts/grant-application-role.sql', 'utf8'))
        .split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\')).join('\n');
      for (const [key, val] of Object.entries({ continuum_schema: schema, continuum_app_role: producerRole }))
        sql = sql.replaceAll(`:"${key}"`, quote(val)).replaceAll(`:'${key}'`, literal(val));
      await creator.query(sql);
      expect((await value.operator.query('SELECT continuum_operator_bind_standup_producer($1::uuid,$2::name,$3::uuid,$4::text,$5::text) AS binding',
        [value.adminId, producerRole, value.producerId, value.namespace, 'github'])).rows[0].binding).toEqual(expect.any(String));
      expect((await producer.query('SELECT continuum_standup_producer_context() AS context')).rows[0].context)
        .toMatchObject({ principal_id: value.producerId });
      const memory = await createMemory(producer, { scopeId: value.scopeId, scopeKind: 'user', authorId: value.producerId,
        type: 'context', title: 'Creator profile source', body: 'Source', source: 'github-branch' });
      expect((await producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded',
        [memory.id, { external_actor_id: '42', repository_id: '100', branch: 'creator-branch' }])).rows)
        .toEqual([{ recorded: true }]);
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      const cleanupFailures: unknown[] = [];
      for (const result of await Promise.allSettled([producer.end(), creator.end()])) {
        if (result.status === 'rejected') cleanupFailures.push(result.reason);
      }
      try {
        // Restore this fixture's objects before dropping its creator defaults.
        // The latter can themselves hold privileges referencing the producer.
        await value.owner.query(`REASSIGN OWNED BY ${quote(creatorRole)} TO ${quote(originalOwner)}`);
        await value.owner.query(`DROP OWNED BY ${quote(creatorRole)}`);
        if (producerCreated) {
          await value.owner.query(`DROP OWNED BY ${quote(producerRole)}`);
          await value.owner.query(`DROP ROLE ${quote(producerRole)}`);
        }
        await value.owner.query(`DROP ROLE ${quote(creatorRole)}`);
      } catch (error) { cleanupFailures.push(error); }
      if (cleanupFailures.length) throw new AggregateError(
        [...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanupFailures],
        'Creator fixture failed with retained primary and cleanup evidence', { cause: primaryFailure });
    }
  });
}, 180_000);

it('rejects an absent actor mapping revocation without writing a success audit', async () => {
  await fixture(async (value) => {
    const before = (await value.owner.query("SELECT count(*)::integer AS n FROM audit_log WHERE metadata->>'operation'='standup_actor_mapping_changed'")).rows;
    await expect(value.operator.query('SELECT continuum_operator_map_standup_actor($1::uuid,$2::text,$3::text,NULL::uuid,$4::text)',
      [value.adminId, value.namespace, '999999', 'Revoke reviewed identity'])).rejects.toMatchObject({ code: '23514' });
    expect((await value.owner.query("SELECT count(*)::integer AS n FROM audit_log WHERE metadata->>'operation'='standup_actor_mapping_changed'")).rows).toEqual(before);
  });
}, 180_000);

it('leaves a captured memory unattributed when a bound source time cannot be parsed', async () => {
  await fixture(async (value) => {
    const memory = await createMemory(value.producer, { scopeId: value.scopeId, scopeKind: 'user', authorId: value.producerId,
      type: 'context', title: 'Valid capture', body: 'Source', source: 'github-branch' });
    expect((await value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded',
      [memory.id, { external_actor_id: '42', repository_id: '100', branch: 'valid-branch', event_time: 'not-a-time' }])).rows)
      .toEqual([{ recorded: false }]);
    expect((await value.app.query('SELECT id FROM memories WHERE id=$1', [memory.id])).rows).toEqual([{ id: memory.id }]);
    expect((await value.app.query('SELECT memory_id FROM memory_activity_attributions WHERE memory_id=$1', [memory.id])).rows).toEqual([]);
  });
}, 180_000);
