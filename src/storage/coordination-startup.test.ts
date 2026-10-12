import { dropIsolatedTestDatabase } from './test-helpers.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrator.js';

const baseUrl = process.env.CONTINUUM_TEST_DATABASE_URL ?? 'postgres://continuum:continuum@localhost:5433/continuum';
const q = (value: string) => '"' + value.replaceAll('"', '""') + '"';

async function startup(transport: 'server' | 'mcp', url: string, principal: string) {
  const child = spawn(process.execPath, [join(process.cwd(), `dist/api/${transport}.js`)], {
    env: { ...process.env, CONTINUUM_DATABASE_URL: url, CONTINUUM_DB_POOL_MAX: '1',
      CONTINUUM_API_PORT: '0', CONTINUUM_AUTH_MODE: 'dev', CONTINUUM_EMBEDDING_PROVIDER: 'none',
      CONTINUUM_PRINCIPAL_EXTERNAL_ID: principal, CONTINUUM_DB_IDLE_TIMEOUT_MS: '100',
      CONTINUUM_EMBEDDING_CONFIG: undefined }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; let errorOutput = ''; let exit: number | null = null;
  const closed = new Promise<void>((resolve) => child.once('close', (code) => { exit = code; resolve(); }));
  const observed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('Continuum API listening') || output.includes('"protocolVersion"')) resolve();
    });
    child.stderr.on('data', (chunk) => {
      errorOutput += String(chunk);
      if (errorOutput.includes('startup_failed') || errorOutput.includes('continuum-mcp fatal')) resolve();
    });
    child.once('close', () => resolve());
  });
  if (transport === 'mcp') child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1,
    method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'startup-regression', version: '1' } } }) + '\n');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([observed, new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error('startup observation timed out: ' + errorOutput)), 10_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
    await closed;
  }
  return { output, errorOutput, exit };
}

const isolatedCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of isolatedCleanups.splice(0)) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Isolated fixture cleanup failed');
}, 120_000);

async function fixture(run: (owner: pg.Pool, url: string, principal: string) => Promise<void>) {
  const admin = new pg.Pool({ connectionString: baseUrl, max: 1 });
  const database = 'startup_' + randomUUID().replaceAll('-', '');
  const role = 'startup_app_' + randomUUID().replaceAll('-', '');
  const password = randomUUID();
  const url = new URL(baseUrl); url.pathname = '/' + database;
  let owner: pg.Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE ${q(database)}`);
    await admin.query(`CREATE ROLE ${q(role)} LOGIN PASSWORD '${password}'`);
    owner = new pg.Pool({ connectionString: url.toString(), max: 1 });
    await runMigrations(owner);
    let script = (await readFile(join(process.cwd(), 'scripts/grant-application-role.sql'), 'utf8'))
      .split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\')).join('\n');
    script = script.replaceAll(':"continuum_schema"', '"public"').replaceAll(":'continuum_schema'", "'public'")
      .replaceAll(':"continuum_app_role"', q(role)).replaceAll(":'continuum_app_role'", "'" + role + "'");
    await owner.query(script);
    const principal = 'startup:' + randomUUID();
    await owner.query(`INSERT INTO principals(id,external_id,kind,display_name) VALUES(gen_random_uuid(),$1,'service','Startup')`, [principal]);
    url.username = role; url.password = password;
    await run(owner, url.toString(), principal);
  } finally {
    await owner?.end();
    isolatedCleanups.push(async () => {
      try {
        await dropIsolatedTestDatabase(admin, database);
        await admin.query(`DROP ROLE IF EXISTS ${q(role)}`);
      } finally { await admin.end(); }
    });
  }
}

describe('coordination runtime startup contract', () => {
  it.each(['server', 'mcp'] as const)('refuses %s startup when contract repair is pending', async (transport) => {
    await fixture(async (owner, url, principal) => {
      await owner.query("UPDATE coordination_contract_backfill_state SET phase='receipts'");
      const result = await startup(transport, url, principal);
      expect(result.output).not.toMatch(/Continuum API listening|"protocolVersion"/);
      expect(result.errorOutput).toMatch(/Coordination contract repair is incomplete; finish migrations/);
    });
  }, 60_000);

  it.each(['server', 'mcp'] as const)('refuses %s startup when contract readiness helper is missing', async (transport) => {
    await fixture(async (owner, url, principal) => {
      await owner.query('DROP FUNCTION IF EXISTS continuum_coordination_contract_is_ready()');
      const result = await startup(transport, url, principal);
      expect(result.output).not.toMatch(/Continuum API listening|"protocolVersion"/);
      // The exact application profile includes the readiness helper, so the
      // provider-first profile gate rejects this missing capability before it
      // can reach the separate readiness check.
      expect(result.errorOutput).toMatch(/does not hold an exact Continuum application or operator profile/);
    });
  }, 60_000);

  it.each(['server', 'mcp'] as const)('starts %s under least application privileges after completed repair', async (transport) => {
    await fixture(async (_owner, url, principal) => {
      const result = await startup(transport, url, principal);
      expect(result.errorOutput).not.toMatch(/startup_failed|continuum-mcp fatal/);
      expect(result.output).toMatch(/Continuum API listening|"protocolVersion"/);
    });
  }, 60_000);
});
