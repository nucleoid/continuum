import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { expect } from 'vitest';
import { runMigrations } from '../storage/migrator.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { mapOwnedUserScope } from '../services/offboarding.js';

const connectionString = process.env.CONTINUUM_TEST_DATABASE_URL ?? 'postgres://continuum:continuum@localhost:5433/continuum';
export const quoteStandupIdentifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";

export async function standupProducerFixture(run: (context: { owner: pg.Pool; producer: pg.Pool; app: pg.Pool;
  operator: pg.Pool; adminId: string; actorId: string; producerId: string; producerRole: string;
  scopeId: string; scopeKind: 'user'; namespace: string; addOperator(actorId: string): Promise<pg.Pool> }) => Promise<void>,
  family: 'github' | 'deploy-event' | 'terminal-summary' = 'github') {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const schema = `standup_roles_${suffix}`;
  const namespace = `${family}.${suffix}`;
  const roles = ['app', 'producer', 'operator'].map((kind) => `standup_${kind}_${suffix}`);
  const maintenance = new pg.Pool({ connectionString, max: 1,
    options: '-c statement_timeout=5000 -c lock_timeout=1000' });
  const owner = new pg.Pool({ connectionString, max: 1, options: `-c search_path=${schema} -c statement_timeout=60000 -c lock_timeout=5000` });
  const logins: pg.Pool[] = [];
  const clientClosures: Promise<void>[] = [];
  const track = (pool: pg.Pool) => pool.on('connect', (client) => {
    clientClosures.push(new Promise<void>((resolve) => client.once('end', () => resolve())));
  });
  track(owner);
  const created: string[] = [];
  try {
    await maintenance.query(`CREATE SCHEMA ${quoteStandupIdentifier(schema)}`);
    await runMigrations(owner);
    const admin = await createPrincipal(owner, { externalId: `admin:${suffix}`, kind: 'user', displayName: 'Administrator' });
    const actor = await createPrincipal(owner, { externalId: `actor:${suffix}`, kind: 'user', displayName: 'Actual Actor' });
    const service = await createPrincipal(owner, { externalId: `producer:${suffix}`, kind: 'service', displayName: 'Producer' });
    const org = (await getScopeByRef(owner, { kind: 'org', name: '' }))!;
    const scope = await createScope(owner, { kind: 'user', name: `personal-${suffix}` });
    await addMembership(owner, admin.id, org.id, 'admin');
    await addMembership(owner, actor.id, scope.id, 'writer');
    await addMembership(owner, service.id, scope.id, 'writer');
    await mapOwnedUserScope(owner, admin, actor.id, scope.id, true);
    async function grant(role: string, actorId?: string) {
      const file = actorId ? 'grant-operator-role.sql' : 'grant-application-role.sql';
      let sql = (await readFile(join(process.cwd(), 'scripts', file), 'utf8'))
        .split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\')).join('\n');
      const variables = actorId ? { continuum_schema: schema, continuum_operator_role: role, continuum_principal_id: actorId }
        : { continuum_schema: schema, continuum_app_role: role };
      for (const [key, value] of Object.entries(variables)) sql = sql
        .replaceAll(`:"${key}"`, quoteStandupIdentifier(value)).replaceAll(`:'${key}'`, literal(value));
      const client = await owner.connect();
      try { await client.query(sql); } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    for (const role of roles) {
      const password = randomUUID();
      await maintenance.query(`CREATE ROLE ${quoteStandupIdentifier(role)} LOGIN PASSWORD ${literal(password)}`);
      created.push(role);
      await grant(role);
      if (role === roles[2]) await grant(role, admin.id);
      const url = new URL(connectionString); url.username = role; url.password = password;
      logins.push(new pg.Pool({ connectionString: url.toString(), max: 1,
        options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=1000` }));
      track(logins.at(-1)!);
    }
    async function addOperator(actorId: string): Promise<pg.Pool> {
      const role = `standup_takeover_${suffix}`;
      const password = randomUUID();
      await maintenance.query(`CREATE ROLE ${quoteStandupIdentifier(role)} LOGIN PASSWORD ${literal(password)}`);
      created.push(role);
      await grant(role); await grant(role, actorId);
      const url = new URL(connectionString); url.username = role; url.password = password;
      const pool = new pg.Pool({ connectionString: url.toString(), max: 1,
        options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=1000` });
      logins.push(pool); track(pool); return pool;
    }
    const [app, producer, operator] = logins;
    expect((await operator.query('SELECT continuum_operator_bind_standup_producer($1::uuid,$2::name,$3::uuid,$4::text,$5::text) AS binding',
      [admin.id, roles[1], service.id, namespace, family])).rows[0].binding).toEqual(expect.any(String));
    await operator.query('SELECT continuum_operator_map_standup_actor($1::uuid,$2::text,$3::text,$4::uuid,$5::text)',
      [admin.id, namespace, '42', actor.id, 'Reviewed source identity']);
    await run({ owner, producer, app, operator, adminId: admin.id, actorId: actor.id,
      producerId: service.id, producerRole: roles[1], scopeId: scope.id, scopeKind: 'user', namespace, addOperator });
  } finally {
    const failures: unknown[] = [];
    const ended = await Promise.allSettled([...logins, owner].map((pool) => pool.end()));
    for (const result of ended) if (result.status === 'rejected') failures.push(result.reason);
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(clientClosures), new Promise<never>((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error('Standup fixture clients did not close within 5 seconds')), 5_000);
      })]);
    } catch (error) { failures.push(error); }
    finally { if (closeTimer) clearTimeout(closeTimer); }
    try {
      await maintenance.query(`DROP SCHEMA IF EXISTS ${quoteStandupIdentifier(schema)} CASCADE`);
      for (const role of created.reverse()) {
        try {
          await maintenance.query(`DROP OWNED BY ${quoteStandupIdentifier(role)}`);
          await maintenance.query(`DROP ROLE ${quoteStandupIdentifier(role)}`);
        } catch (error) { failures.push(error); }
      }
    } catch (error) { failures.push(error); }
    finally {
      try { await maintenance.end(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Standup fixture cleanup failed');
  }
}
