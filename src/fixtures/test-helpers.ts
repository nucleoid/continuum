import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../storage/migrator.js';
import { dropIsolatedTestDatabase } from '../storage/test-helpers.js';

const SCHEMA = 'continuum_fixture';
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
interface OwnedDatabase { name: string; oid: number; owner: number; roles: { name: string; oid: number }[] }
export interface ConsumerTemplate {
  run: string; directory: string; seed: OwnedDatabase; fingerprint: string; baseline: string;
}
declare module 'vitest' { interface ProvidedContext { consumerTemplate?: ConsumerTemplate } }

export function consumerTemplateEnabled(): boolean {
  const value = process.env.CONTINUUM_TEST_CONSUMER_TEMPLATE;
  if (!value || value === '0') return false;
  if (value !== '1') throw new Error('Consumer template opt-in must be 0 or 1');
  return true;
}
function baseUrl(): string {
  const value = process.env.CONTINUUM_TEST_DATABASE_URL;
  if (!value) throw new Error('Consumer templates require an explicit isolated test database URL');
  return value;
}
function databaseUrl(database: string): string {
  const url = new URL(baseUrl()); url.pathname = '/' + database; return url.toString();
}
function maintenance(): pg.Pool {
  return new pg.Pool({ connectionString: baseUrl(), max: 1, connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=5000 -c lock_timeout=1000' });
}
async function fingerprint(): Promise<string> {
  const names = ['vitest.config.ts', 'package.json', 'src/storage/migrator.ts', 'src/storage/migration-execution.ts',
    'src/fixtures/test-helpers.ts', 'src/standup/test-helpers.ts', 'src/extraction/test-helpers.ts', 'src/connectors/test-helpers.ts'];
  for (const directory of ['migrations', 'scripts']) for (const name of (await readdir(directory)).sort()) {
    if (name.endsWith('.sql')) names.push(join(directory, name));
  }
  const hash = createHash('sha256');
  for (const name of names.sort()) { hash.update(name.replaceAll('\\', '/')); hash.update('\0'); hash.update(await readFile(name)); }
  return hash.digest('hex');
}
async function baseline(pool: pg.Pool): Promise<string> {
  const row = (await pool.query<{ digest: string; empty: boolean }>(`SELECT
    md5(jsonb_build_object('migrations',(SELECT jsonb_agg(to_jsonb(m) ORDER BY name) FROM _continuum_migrations m),
      'execution',(SELECT jsonb_agg(to_jsonb(e) ORDER BY attempt_id) FROM _continuum_migration_execution e),
      'org',continuum_org_scope_id())::text) AS digest,
    NOT EXISTS(SELECT 1 FROM memories) AND NOT EXISTS(SELECT 1 FROM scope_memberships)
      AND NOT EXISTS(SELECT 1 FROM audit_log) AND NOT EXISTS(SELECT 1 FROM evidence_roots)
      AND NOT EXISTS(SELECT 1 FROM evidence_versions) AND NOT EXISTS(SELECT 1 FROM pipeline_budget_workflows)
      AND NOT EXISTS(SELECT 1 FROM standup_producer_bindings) AND NOT EXISTS(SELECT 1 FROM actor_principal_mappings)
      AND NOT EXISTS(SELECT 1 FROM extraction_runs) AND NOT EXISTS(SELECT 1 FROM continuum_pgvector_role_profiles) AS empty`)).rows[0];
  if (!row.empty) throw new Error('Consumer template contains runtime fixture state');
  return row.digest;
}
async function record(template: ConsumerTemplate, database: OwnedDatabase): Promise<void> {
  await writeFile(join(template.directory, database.name + '.json'), JSON.stringify(database) + '\n');
}
async function createDatabase(pool: pg.Pool, name: string, source: string): Promise<OwnedDatabase> {
  // A successful CREATE acknowledgment, not a name prefix, establishes ownership.
  await pool.query(`CREATE DATABASE ${quote(name)} TEMPLATE ${quote(source)}`);
  const row = (await pool.query<{ oid: number; owner: number }>(
    'SELECT oid,datdba AS owner FROM pg_database WHERE datname=$1', [name])).rows[0];
  return { name, ...row, roles: [] };
}
async function dispose(pool: pg.Pool, template: ConsumerTemplate, database: OwnedDatabase): Promise<void> {
  if (!database.name.startsWith(`ct_fx_${template.run}_`) || database.name === new URL(baseUrl()).pathname.slice(1)) {
    throw new Error('Refusing cleanup of a database outside this fixture run');
  }
  const current = (await pool.query<{ oid: number; owner: number }>(
    'SELECT oid,datdba AS owner FROM pg_database WHERE datname=$1', [database.name])).rows[0];
  if (current) {
    if (current.oid !== database.oid || current.owner !== database.owner) throw new Error('Fixture database ownership changed');
    await dropIsolatedTestDatabase(pool, database.name);
  }
  const failures: unknown[] = [];
  for (const role of [...database.roles].reverse()) {
    try {
      const currentRole = (await pool.query<{ oid: number }>('SELECT oid FROM pg_roles WHERE rolname=$1', [role.name])).rows[0];
      if (!currentRole) continue;
      if (currentRole.oid !== role.oid) throw new Error('Fixture role identity changed');
      await pool.query(`DROP ROLE ${quote(role.name)}`);
    } catch (error) { failures.push(error); }
  }
  await record(template, database);
  if (failures.length) throw new AggregateError(failures, 'Consumer fixture role cleanup failed');
}

/** Runs inside the timed Vitest command. No runtime roles or business data seed. */
export default async function setup(project: TestProject): Promise<(() => Promise<void>) | undefined> {
  if (!consumerTemplateEnabled()) return;
  const pool = maintenance();
  const run = randomUUID().replaceAll('-', '').slice(0, 16);
  const directory = join(process.cwd(), '.fire-off', 'consumer-template', run);
  const template: ConsumerTemplate = { run, directory, fingerprint: await fingerprint(), baseline: '',
    seed: { name: `ct_fx_${run}_seed`, oid: 0, owner: 0, roles: [] } };
  await mkdir(directory, { recursive: true });
  let owner: pg.Pool | undefined;
  try {
    const authority = (await pool.query<{ allowed: boolean }>(`SELECT
      current_user=session_user AND (rolsuper OR rolcreatedb) AND (rolsuper OR rolcreaterole) AS allowed
      FROM pg_roles WHERE rolname=session_user`)).rows[0];
    if (!authority.allowed) throw new Error('Consumer templates require the existing test owner CREATEDB and CREATEROLE authority');
    template.seed = await createDatabase(pool, template.seed.name, 'template0');
    await record(template, template.seed);
    owner = new pg.Pool({ connectionString: databaseUrl(template.seed.name), max: 1, connectionTimeoutMillis: 5000,
      options: `-c search_path=${SCHEMA} -c statement_timeout=60000 -c lock_timeout=5000` });
    await owner.query(`CREATE SCHEMA ${quote(SCHEMA)}`);
    await runMigrations(owner);
    template.baseline = await baseline(owner);
    const versions = (await owner.query(`SELECT version(),(SELECT extversion FROM pg_extension WHERE extname='vector') AS vector,
      (SELECT oid FROM pg_roles WHERE rolname=session_user) AS owner`)).rows[0];
    await owner.end(); owner = undefined;
    await pool.query(`ALTER DATABASE ${quote(template.seed.name)} ALLOW_CONNECTIONS false`);
    if ((await pool.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1', [template.seed.name])).rowCount) {
      throw new Error('Consumer template sockets did not drain');
    }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...template, versions,
      provenance: 'Migrations executed in seed; consumers use physical clones, never relabelled migration execution' }, null, 2) + '\n');
    project.provide('consumerTemplate', template);
  } catch (error) {
    await owner?.end();
    try { if (template.seed.oid) await dispose(pool, template, template.seed); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Consumer template setup and cleanup failed'); }
    finally { await pool.end(); }
    throw error;
  }
  await pool.end();
  return async () => {
    const cleanup = maintenance(); const failures: unknown[] = [];
    try {
      const names = (await readdir(directory)).filter(name => name.endsWith('.json') && name !== 'manifest.json'
        && name !== template.seed.name + '.json');
      for (const name of names) {
        try { await dispose(cleanup, template, JSON.parse(await readFile(join(directory, name), 'utf8')) as OwnedDatabase); }
        catch (error) { failures.push(error); }
      }
      try { await dispose(cleanup, template, template.seed); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Consumer template teardown failed');
    } finally { await cleanup.end(); }
  };
}

export async function cloneConsumerDatabase(template: ConsumerTemplate | undefined) {
  if (!template || !/^[a-f0-9]{16}$/.test(template.run)
    || template.seed.name !== `ct_fx_${template.run}_seed`
    || template.directory !== join(process.cwd(), '.fire-off', 'consumer-template', template.run)
    || template.fingerprint !== await fingerprint()) {
    throw new Error('Requested consumer template is missing or does not match current inputs');
  }
  const pool = maintenance(); let database: OwnedDatabase | undefined;
  try {
    const seed = (await pool.query<{ oid: number; owner: number; sealed: boolean }>(
      `SELECT oid,datdba AS owner,NOT datallowconn AND NOT datistemplate
        AND datdba=(SELECT oid FROM pg_roles WHERE rolname=session_user) AS sealed FROM pg_database WHERE datname=$1`,
      [template.seed.name])).rows[0];
    if (!seed?.sealed || seed.oid !== template.seed.oid || seed.owner !== template.seed.owner) throw new Error('Consumer template identity changed');
    const existingRoles = new Set((await pool.query<{ oid: number }>('SELECT oid FROM pg_roles')).rows.map(row => row.oid));
    database = await createDatabase(pool, `ct_fx_${template.run}_${randomUUID().replaceAll('-', '').slice(0, 16)}`, template.seed.name);
    await record(template, database);
    const connectionString = databaseUrl(database.name);
    const probe = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000,
      options: `-c search_path=${SCHEMA} -c statement_timeout=5000 -c lock_timeout=1000` });
    try { if (await baseline(probe) !== template.baseline) throw new Error('Clone migration lineage differs from its pristine seed'); }
    finally { await probe.end(); }
    const owned = database;
    return { connectionString, schema: SCHEMA,
      registerRole: async (name: string) => {
        const role = (await pool.query<{ oid: number }>('SELECT oid FROM pg_roles WHERE rolname=$1', [name])).rows[0];
        if (!role || existingRoles.has(role.oid)) throw new Error('Cannot register a preexisting fixture role');
        if (!owned.roles.some(item => item.oid === role.oid)) owned.roles.push({ name, oid: role.oid });
        await record(template, owned);
      },
      dispose: async () => { try { await dispose(pool, template, owned); } finally { await pool.end(); } },
    };
  } catch (error) {
    try { if (database) await dispose(pool, template, database); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Consumer clone setup and cleanup failed'); }
    finally { await pool.end(); }
    throw error;
  }
}
