import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from '../storage/migrator.js';
import { reconcilePgvectorProviderGrants, requireCoordinationContractReady } from '../storage/provider-lifecycle.js';

const databaseUrl = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:continuum@localhost:5433/continuum';
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
type Witness = { kind: 'ready'; stderr: string } | { kind: 'exit'; code: number | null; stderr: string };

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port allocation failed');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function observeEntrypoint(kind: 'REST' | 'MCP', env: NodeJS.ProcessEnv): Promise<Witness> {
  const chosenPort = kind === 'REST' ? await port() : undefined;
  const entrypoint = fileURLToPath(new URL(kind === 'REST'
    ? '../../dist/api/server.js' : '../../dist/api/mcp.js', import.meta.url));
  const child = spawn(process.execPath, [entrypoint], {
    env: { ...env, ...(chosenPort === undefined ? {} : { CONTINUUM_API_PORT: String(chosenPort) }) },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  let outputBytes = 0;
  let finished = false;
  let resolve!: (value: Witness) => void;
  let reject!: (error: Error) => void;
  const observed = new Promise<Witness>((done, fail) => { resolve = done; reject = fail; });
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  const finish = (value: Witness) => { if (!finished) { finished = true; resolve(value); } };
  const fail = (error: Error) => { if (!finished) { finished = true; reject(error); } };
  const output = (chunk: Buffer, errorStream: boolean) => {
    outputBytes += chunk.length;
    if (outputBytes > 32 * 1024) { fail(new Error('Compiled startup fixture exceeded its output budget')); return; }
    if (errorStream) { stderr += chunk.toString('utf8'); return; }
    stdout += chunk.toString('utf8');
    if (kind === 'MCP') {
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) break;
        const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
        let message: { id?: number; result?: { serverInfo?: { name: string }; tools?: Array<{ name: string }> } };
        try { message = JSON.parse(line); } catch { fail(new Error('Compiled MCP emitted non-protocol stdout')); return; }
        if (message.id === 1 && message.result?.serverInfo?.name === 'continuum') {
          // main authenticates the configured principal before constructing
          // and connecting this actual stdio server. Initialization is the
          // serving witness; no tool call can mask a missing startup gate.
          finish({ kind: 'ready', stderr });
        }
      }
    }
  };
  child.stdout.on('data', (chunk: Buffer) => output(chunk, false));
  child.stderr.on('data', (chunk: Buffer) => output(chunk, true));
  child.stdin.on('error', () => { /* An early gate exit can close stdin before initialization is consumed. */ });
  child.once('error', fail);
  child.once('exit', (code) => finish({ kind: 'exit', code, stderr }));
  const deadline = setTimeout(() => fail(new Error('Compiled startup fixture exceeded its 8-second deadline')), 8_000);
  if (kind === 'MCP') {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'promotion-startup-review', version: '1' },
    } })}\n`);
  } else {
    void (async () => {
      while (!finished) {
        try {
          const ready = await fetch(`http://127.0.0.1:${chosenPort}/health/ready`, { signal: AbortSignal.timeout(300) });
          if (ready.status === 200 && (await ready.json() as { database?: string }).database === 'ready') {
            const authorized = await fetch(`http://127.0.0.1:${chosenPort}/api/v0/scopes`, {
              headers: { Authorization: `Bearer ${env.CONTINUUM_PRINCIPAL_EXTERNAL_ID}` }, signal: AbortSignal.timeout(300),
            });
            if (authorized.status === 200) { await authorized.arrayBuffer(); finish({ kind: 'ready', stderr }); return; }
          }
        } catch { /* Retry only until the finite child deadline or observed exit. */ }
        await new Promise((done) => setTimeout(done, 20));
      }
    })().catch((error: unknown) => fail(error instanceof Error ? error : new Error('Startup probe failed')));
  }
  try { return await observed; }
  finally {
    clearTimeout(deadline);
    finished = true;
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let force: ReturnType<typeof setTimeout> | undefined;
    try {
      force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1_500);
      let closureDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_done, failure) => {
          closureDeadline = setTimeout(() => failure(new Error('Compiled child did not close after forced cleanup')), 3_000);
        })]);
      } finally { if (closureDeadline) clearTimeout(closureDeadline); }
    } finally { if (force) clearTimeout(force); }
  }
}

it.each(['REST', 'MCP'] as const)('compiled %s refuses canonical 88 before serving and accepts the full upgrade', async (kind) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const schema = `promotion_startup_${suffix}`;
  const role = `promotion_startup_app_${suffix}`;
  const password = randomUUID();
  const principal = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'continuum-promotion-startup-'));
  const source = new URL('../../migrations/', import.meta.url);
  const maintenance = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const owner = new pg.Pool({ connectionString: databaseUrl, max: 1,
    options: `-c search_path=${schema} -c statement_timeout=60000 -c lock_timeout=5000` });
  let app: pg.Pool | undefined;
  let roleCreated = false;
  try {
    await maintenance.query(`CREATE SCHEMA ${quote(schema)}`);
    for (const file of (await readdir(source)).sort()) {
      if (/^\d{4}_.+\.sql$/.test(file) && Number(file.slice(0, 4)) <= 88) {
        await copyFile(new URL(file, source), join(directory, file));
      }
    }
    expect((await runMigrations(owner, directory)).at(-1)?.name).toBe('0088_embedding_provider_scan_index_rebuild.sql');
    await owner.query(`INSERT INTO principals(id,external_id,kind,display_name)
      VALUES($1::uuid,$1::uuid::text,'user','Startup Review')`, [principal]);
    await owner.query(`INSERT INTO scope_memberships(principal_id,scope_id,role,source_kind,source_id,active)
      SELECT $1::uuid,id,'admin','manual','manual',TRUE FROM scopes WHERE kind='org' AND name=''`, [principal]);
    await owner.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD ${literal(password)}`);
    roleCreated = true;
    async function grant() {
      let sql = (await readFile(join(process.cwd(), 'scripts/grant-application-role.sql'), 'utf8'))
        .split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\')).join('\n');
      for (const [key, value] of Object.entries({ continuum_schema: schema, continuum_app_role: role })) {
        sql = sql.replaceAll(`:"${key}"`, quote(value)).replaceAll(`:'${key}'`, literal(value));
      }
      const client = await owner.connect();
      try { await client.query(sql); }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    await grant();
    const url = new URL(databaseUrl); url.username = role; url.password = password;
    url.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=1000`);
    app = new pg.Pool({ connectionString: url.toString(), max: 1 });
    expect((await app.query('SELECT current_user AS role')).rows).toEqual([{ role }]);
    await reconcilePgvectorProviderGrants(app, { expectedSchema: schema });
    await requireCoordinationContractReady(app, { expectedSchema: schema });
    expect((await owner.query("SELECT pg_catalog.to_regclass('promotion_events') AS outbox")).rows)
      .toEqual([{ outbox: null }]);
    const env: NodeJS.ProcessEnv = { ...process.env, PGOPTIONS: '', CONTINUUM_DATABASE_URL: url.toString(),
      CONTINUUM_APPLICATION_SCHEMA: schema, CONTINUUM_AUTH_MODE: 'dev', CONTINUUM_EMBEDDING_PROVIDER: 'none',
      CONTINUUM_PRINCIPAL_EXTERNAL_ID: principal, CONTINUUM_BEARER: principal,
      CONTINUUM_DB_POOL_MAX: '1', CONTINUUM_DB_CONNECTION_TIMEOUT_MS: '1000',
      CONTINUUM_SHUTDOWN_TIMEOUT_MS: '1000', CONTINUUM_PROMOTION_SHUTDOWN_WAIT_MS: '500' };
    delete env.CONTINUUM_EMBEDDING_CONFIG;
    for (const key of Object.keys(env)) if (key.startsWith('CONTINUUM_INGEST_') && key.endsWith('_ENABLED')) env[key] = 'false';
    const legacy = await observeEntrypoint(kind, env);
    // Run the same compiled binary with the same valid LOGIN and auth settings
    // after the real owner upgrade/regrant, before judging the negative witness.
    await runMigrations(owner);
    await grant();
    await reconcilePgvectorProviderGrants(app, { expectedSchema: schema });
    await requireCoordinationContractReady(app, { expectedSchema: schema });
    expect((await owner.query("SELECT pg_catalog.to_regclass('promotion_events') IS NOT NULL AS present")).rows)
      .toEqual([{ present: true }]);
    expect((await observeEntrypoint(kind, env)).kind, 'same-binary fully migrated positive readiness witness').toBe('ready');
    expect(legacy.kind, 'new binary must reject the otherwise-valid schema before listening or MCP serving').toBe('exit');
    if (legacy.kind === 'exit') {
      expect(legacy.code).not.toBe(0);
      expect(legacy.stderr).toMatch(/promotion|outbox|0089|migration|DEPENDENCY_UNAVAILABLE/i);
    }
  } finally {
    await app?.end();
    await owner.end();
    await maintenance.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    if (roleCreated) await maintenance.query(`DROP OWNED BY ${quote(role)}; DROP ROLE ${quote(role)}`);
    await maintenance.end();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
