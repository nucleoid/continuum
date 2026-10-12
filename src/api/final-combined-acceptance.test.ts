import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from '../storage/migrator.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { issueApiKey } from '../services/api-keys.js';
import { mapOwnedUserScope } from '../services/offboarding.js';
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';
import { claimPromotionDeliveries, completePromotionDelivery } from '../storage/promotion-events.js';

// Compiled custom compositions exercise optional extensions. Stock main()
// intentionally has empty registries; its readiness remains separately tested.
// Standup owner readers use the documented dev credential, not service-key SSO.
const databaseUrl = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:continuum@localhost:5433/continuum';
const execFileAsync = promisify(execFile);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function until<T>(probe: () => T | Promise<T>, label: string, ms = 5_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    await sleep(20);
  }
  throw new Error(`${label} was not observed within ${ms}ms`);
}

function observeChild(file: string, mode: 'REST' | 'MCP', env: NodeJS.ProcessEnv,
  databaseDiagnostics: () => Promise<unknown>) {
  const child = spawn(process.execPath, ['--max-old-space-size=96', file, mode], {
    env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  let bytes = 0;
  let stderr = '';
  let stdout = '';
  let stdoutTail = Buffer.alloc(0);
  let fatal: Error | undefined;
  let sequence = 0;
  const messages: Array<Record<string, any>> = [];
  const pending = new Map<number, { resolve(message: any): void; reject(error: Error): void }>();
  const closed = new Promise<void>((resolve) => child.once('close', (code, signal) => {
    for (const request of pending.values()) request.reject(fatal ?? new Error(`Child closed: code=${code} signal=${signal}`));
    resolve();
  }));
  const sanitize = (value: string) => [env.CONTINUUM_BEARER, env.CONTINUUM_DATABASE_URL,
    env.CONTINUUM_INGEST_TERMINAL_SUMMARY_DATABASE_URL]
    .filter((secret): secret is string => Boolean(secret))
    .reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
  const fail = (error: Error) => {
    fatal ??= error;
    for (const request of pending.values()) request.reject(fatal);
    child.kill('SIGKILL');
  };
  child.once('error', fail);
  child.on('message', (message) => {
    if (Buffer.byteLength(JSON.stringify(message)) > 2_048) fail(new Error('Oversized combined child witness'));
    else messages.push(message as Record<string, any>);
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 128 * 1024) { fail(new Error('Combined child output exceeded128KiB')); return; }
    stderr += chunk.toString('utf8');
  });
  child.stdout!.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    stdoutTail = Buffer.concat([stdoutTail, chunk]).subarray(-4_096);
    if (bytes > 128 * 1024) { fail(new Error('Combined child output exceeded128KiB')); return; }
    stdout += chunk.toString('utf8');
    if (mode !== 'MCP') return;
    for (;;) {
      const newline = stdout.indexOf('\n');
      if (newline < 0) break;
      const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (typeof message.id === 'number') pending.get(message.id)?.resolve(message);
      } catch { fail(new Error('MCP emitted non-protocol stdout')); }
    }
  });
  child.stdin!.on('error', fail);
  const check = () => {
    if (fatal) throw fatal;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Combined child exited: ${sanitize(stderr)}`);
  };
  async function rpc(method: string, params: unknown) {
    check();
    const id = ++sequence;
    const toolName = method === 'tools/call' ? (params as { name?: string }).name : undefined;
    const label = `MCP ${toolName ?? method} request=${id}`;
    const result = new Promise<any>((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    try {
      const response = await bounded(result, 5_000, label);
      expect(response.error).toBeUndefined();
      return response.result;
    } catch (error) {
      let sessions: unknown = 'unavailable';
      try { sessions = await bounded(databaseDiagnostics(), 1_000, 'database diagnostics'); }
      catch { /* Diagnostics cannot prolong the request or obscure its failure. */ }
      if (child.connected) child.send({ kind: 'inspect-pool' });
      await sleep(100);
      const pool = messages.filter((message) => message.kind === 'pool-stats').at(-1);
      throw new Error(`${label} failed: ${error instanceof Error ? error.message : 'unknown error'}; fatal=${JSON.stringify(fatal ? sanitize(fatal.message) : null)}; outputBytes=${bytes}; childExit=${child.exitCode}/${child.signalCode}; stdoutTail=${JSON.stringify(sanitize(stdoutTail.toString('utf8')))}; stderr=${JSON.stringify(sanitize(stderr))}; pool=${JSON.stringify(pool ?? null)}; sessions=${JSON.stringify(sessions)}`);
    } finally { pending.delete(id); }
  }
  async function witness(kind: string, ms = 5_000) {
    return until(() => { check(); return messages.find((message) => message.kind === kind); }, kind, ms);
  }
  return { child, closed, rpc, witness, messages, stderr: () => stderr, check };
}

async function stopChild(child: ChildProcess, closed: Promise<void>) {
  if (child.exitCode !== null || child.signalCode !== null) { await bounded(closed, 3_000, 'closed child'); return; }
  child.stdin?.end();
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 1_500);
  try { await bounded(closed, 3_000, 'combined child close'); }
  finally { clearTimeout(kill); }
}

async function command(args: string[], env: NodeJS.ProcessEnv, timeout = 15_000) {
  const tokenIndex = args.indexOf('--token');
  const secrets = [env.CONTINUUM_BEARER, env.CONTINUUM_DATABASE_URL,
    tokenIndex >= 0 ? args[tokenIndex + 1] : undefined].filter((value): value is string => Boolean(value));
  const sanitize = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
  let outcome: { code: number; stdout: string; stderr: string };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath,
      ['--max-old-space-size=96', ...args], { cwd: process.cwd(), env, timeout,
        killSignal: 'SIGKILL', maxBuffer: 128 * 1024, windowsHide: true });
    outcome = { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    if (failed.killed || typeof failed.code !== 'number') {
      throw new Error(`Combined CLI process failed: code=${String(failed.code)} killed=${Boolean(failed.killed)} stderr=${sanitize(failed.stderr ?? '')}`);
    }
    outcome = { code: failed.code, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
  try { return { code: outcome.code, stderr: sanitize(outcome.stderr), payload: JSON.parse(outcome.stdout.trim()) as any }; }
  catch {
    throw new Error(`Combined CLI returned non-JSON stdout: code=${outcome.code} stdout=${JSON.stringify(sanitize(outcome.stdout))} stderr=${JSON.stringify(sanitize(outcome.stderr))}`);
  }
}

it('composes compiled APP transports and real credentials with same-schema approved OP erasure', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const schema = `combined_${suffix}`;
  const appRole = `combined_app_${suffix}`;
  const opRole = `combined_op_${suffix}`;
  const producerRole = `combined_producer_${suffix}`;
  const namespace = `combined.${suffix}`;
  const externalActor = `terminal-owner-${suffix}`;
  const passwords = [randomUUID(), randomUUID(), randomUUID()];
  const directory = await mkdtemp(join(tmpdir(), 'continuum-combined-'));
  const maintenance = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000,
    options: '-c statement_timeout=60000 -c lock_timeout=1000' });
  const owner = new pg.Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000,
    options: `-c search_path=${schema} -c statement_timeout=60000 -c lock_timeout=5000` });
  const logins: pg.Pool[] = [];
  const children: ReturnType<typeof observeChild>[] = [];
  const physicalEnds: Promise<void>[] = [];
  const errors: unknown[] = [];
  const rolesCreated: string[] = [];
  let schemaCreated = false;
  const track = (pool: pg.Pool) => pool.on('connect', (client) => {
    physicalEnds.push(new Promise<void>((resolve) => client.once('end', resolve)));
  });
  track(owner);
  try {
    await maintenance.query(`CREATE SCHEMA ${quote(schema)}`); schemaCreated = true;
    await runMigrations(owner);
    const admin = await createPrincipal(owner, { externalId: `combined-admin:${suffix}`, kind: 'user', displayName: 'Combined admin' });
    const target = await createPrincipal(owner, { externalId: `combined-target:${suffix}`, kind: 'user', displayName: 'Combined target' });
    const actor = await createPrincipal(owner, { externalId: `combined-service:${suffix}`, kind: 'service', displayName: 'Combined capture service' });
    const org = (await getScopeByRef(owner, { kind: 'org', name: '' }))!;
    const shared = await createScope(owner, { kind: 'project', name: `combined-project-${suffix}` });
    const personal = await createScope(owner, { kind: 'user', name: `combined-personal-${suffix}` });
    const forbidden = await createScope(owner, { kind: 'project', name: `combined-protected-${suffix}` });
    await addMembership(owner, admin.id, org.id, 'admin');
    await addMembership(owner, actor.id, shared.id, 'writer');
    await addMembership(owner, actor.id, personal.id, 'writer');
    await addMembership(owner, target.id, personal.id, 'writer');
    for (const [index, role] of [appRole, opRole, producerRole].entries()) {
      await maintenance.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD ${literal(passwords[index])}`);
      rolesCreated.push(role);
    }
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
    await grant('grant-application-role.sql', { continuum_app_role: opRole });
    await grant('grant-application-role.sql', { continuum_app_role: producerRole });
    await grant('grant-operator-role.sql', { continuum_operator_role: opRole, continuum_principal_id: admin.id });
    function login(role: string, password: string) {
      const url = new URL(databaseUrl); url.username = role; url.password = password;
      url.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=1000`);
      const pool = new pg.Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 1_000 });
      track(pool); logins.push(pool); return { url: url.toString(), pool };
    }
    const application = login(appRole, passwords[0]);
    const operator = login(opRole, passwords[1]);
    const producer = login(producerRole, passwords[2]);
    for (const [pool, role] of [[application.pool, appRole], [operator.pool, opRole], [producer.pool, producerRole]] as const) {
      expect((await pool.query('SELECT session_user AS role,current_user AS effective')).rows)
        .toEqual([{ role, effective: role }]);
      expect((await pool.query(`SELECT pg_catalog.has_schema_privilege($1,'CREATE') AS allowed`, [schema])).rows)
        .toEqual([{ allowed: false }]);
    }
    // This acknowledged service member is distinct from the offboarded user.
    // Its retained credential/shared-scope access is not a user SSO witness.
    const mapping = await mapOwnedUserScope(operator.pool, admin, target.id, personal.id, true);
    expect(mapping.acknowledgedPrincipalIds).toContain(actor.id);
    await operator.pool.query('SELECT continuum_operator_set_promotion_webhook_ids($1::uuid,$2::text[])',
      [admin.id, ['combined-hook']]);
    await expect(application.pool.query('SELECT continuum_operator_set_promotion_webhook_ids($1::uuid,$2::text[])',
      [admin.id, ['combined-hook']])).rejects.toMatchObject({ code: '42501' });
    const key = await issueApiKey(operator.pool, admin, actor.id, 'manual');
    const ingestKey = await issueApiKey(operator.pool, admin, actor.id, 'terminal-summary');
    await operator.pool.query('SELECT continuum_operator_bind_standup_producer($1::uuid,$2::name,$3::uuid,$4::text,$5::text)',
      [admin.id, producerRole, actor.id, namespace, 'terminal-summary']);
    const actorMapping = (await operator.pool.query('SELECT continuum_operator_map_standup_actor($1::uuid,$2::text,$3::text,$4::uuid,$5::text) AS id',
      [admin.id, namespace, externalActor, target.id, 'Combined trusted terminal actor'])).rows[0].id as string;

    const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(join(process.cwd(), 'dist', path)).href);
    const childFile = join(directory, 'combined.mjs');
    // IPC carries only bounded fixture witnesses. All operations use the real
    // compiled transports/auth/services; no owner pool is available to children.
    await writeFile(childFile, `
import pg from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'node_modules/pg/lib/index.js')).href)};
import { createApp, createReadinessState } from ${moduleUrl('api/server.js')};
import { buildMcpServer } from ${moduleUrl('api/mcp.js')};
import { createAuthenticator } from ${moduleUrl('api/auth.js')};
import { startRuntime } from ${moduleUrl('api/runtime.js')};
import { reconcilePgvectorProviderGrants, requireCoordinationContractReady, requirePromotionOutboxReady, requireStandupReady } from ${moduleUrl('storage/provider-lifecycle.js')};
import { ingestConfigFromEnv } from ${moduleUrl('ingest/config.js')};
import { producerContext, requireProducerMatch } from ${moduleUrl('standup/activity.js')};
import { RetrievalEnricherRegistry, PromotionWebhookRegistry } from ${moduleUrl('extensions/index.js')};
import { PromotionEventWorker } from ${moduleUrl('workers/promotion-events.js')};
import { StubEmbeddingProvider } from ${moduleUrl('embeddings/stub.js')};
import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js')).href)};
const pool = new pg.Pool({connectionString:process.env.CONTINUUM_DATABASE_URL,max:2,connectionTimeoutMillis:1000,application_name:'combined-'+process.argv[2]});
process.on('message', message => {if (message?.kind === 'inspect-pool') process.send?.({kind:'pool-stats',total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount});});
const gate = {expectedSchema:process.env.CONTINUUM_APPLICATION_SCHEMA};
await reconcilePgvectorProviderGrants(pool,gate);
await requireCoordinationContractReady(pool,gate);
await requirePromotionOutboxReady(pool,gate);
await requireStandupReady(pool,gate);
const readerMode = process.env.COMBINED_READER === 'true';
const authenticator = createAuthenticator(pool,readerMode ? 'dev' : 'entra', {tenant:'11111111-1111-4111-8111-111111111111',audience:'combined',userScope:'memory',serviceAppRole:'memory',allowedClientIds:['22222222-2222-4222-8222-222222222222']});
const auth = await authenticator.authenticate('Bearer',process.env.CONTINUUM_BEARER);
if (!auth || auth.principal.id !== process.env.COMBINED_ACTOR) throw new Error('Real stored credential rejected');
const stub = new StubEmbeddingProvider();
const provider = {id:'combined:provider-a',dim:768,requestTimeoutMs:1000,embed:async(texts) => {
  if (texts.some(text => text === 'combined outage')) throw new Error('PRIVATE_PROVIDER_FAILURE');
  return stub.embed(texts);
}};
const enrichers = new RetrievalEnricherRegistry();
enrichers.register({id:'combined',enrich:async(results) => results.map(result => ({reference:result.memory.id}))});
const hooks = new PromotionWebhookRegistry();
hooks.register({id:'combined-hook',onPromoted:async(event) => {process.send?.({kind:'callback',eventId:event.eventId,sourceId:event.sourceId,destinationId:event.destinationId});}});
const role = (await pool.query('SELECT session_user AS role')).rows[0].role;
const logger = {info:()=>{},warn:()=>{},error:()=>{}};
if (process.argv[2] === 'REST') {
  const ingestConfig = readerMode ? {plugins:{}} : ingestConfigFromEnv();
  let producerPool;
  if (!readerMode) {
    producerPool = new pg.Pool({connectionString:process.env.CONTINUUM_INGEST_TERMINAL_SUMMARY_DATABASE_URL,max:1,connectionTimeoutMillis:1000,application_name:'combined-producer'});
    producerPool.on('error',()=>process.stderr.write('standup_producer_connection_failed\\n'));
    await reconcilePgvectorProviderGrants(producerPool,gate);
    await requireCoordinationContractReady(producerPool,gate);
    await requirePromotionOutboxReady(producerPool,gate);
    await requireStandupReady(producerPool,gate);
    requireProducerMatch(await producerContext(producerPool),auth.principal.id,'terminal-summary');
  }
  const worker = new PromotionEventWorker(pool,hooks,{owner:'combined-worker',pollMs:50,claimBatch:1,leaseMs:10000,callbackTimeoutMs:1000,databaseTimeoutMs:1000,shutdownWaitMs:1000,maxAttempts:3,baseBackoffMs:100,maxBackoffMs:1000,logger});
  const readiness = createReadinessState();
  const app = createApp(pool,{authenticator,readiness,clock:readerMode ? ()=>Date.parse(process.env.COMBINED_READER_NOW) : undefined,ingestConfig,ingestProducerPools:producerPool ? {'terminal-summary':producerPool} : {},embeddingProvider:provider,retrievalEnrichers:enrichers,promotionWebhooks:hooks,enrichment:{timeoutMs:100,maxBytes:1024}});
  const runtime = await startRuntime(app,{host:'127.0.0.1',port:0,readiness,workers:readerMode ? [] : [worker],closePool:async()=>{await producerPool?.end();await pool.end();},shutdownTimeoutMs:1000,logger});
  process.on('message', message => {if (message?.kind === 'stop-worker') void worker.stop().then(()=>process.send?.({kind:'worker-stopped'})).catch(()=>process.exit(1));});
  process.send?.({kind:'ready',role,port:runtime.server.address().port});
} else {
  const server = buildMcpServer({pool,principal:auth.principal,now:readerMode ? ()=>new Date(process.env.COMBINED_READER_NOW) : undefined,allowedSource:auth.allowedSource,embeddingProvider:provider,retrievalEnrichers:enrichers,promotionWebhooks:hooks,enrichment:{timeoutMs:100,maxBytes:1024}});
  await server.connect(new StdioServerTransport());
  process.once('SIGTERM',()=>{void server.close().then(()=>pool.end()).then(()=>process.exit(0)).catch(()=>process.exit(1));});
  process.send?.({kind:'ready',role});
}
`, 'utf8');
    const env = { ...process.env, PGOPTIONS: '', CONTINUUM_DATABASE_URL: application.url,
      CONTINUUM_APPLICATION_SCHEMA: schema, CONTINUUM_AUTH_MODE: 'entra', CONTINUUM_BEARER: key.key, COMBINED_ACTOR: actor.id,
      CONTINUUM_INGEST_TERMINAL_SUMMARY_ENABLED: 'true', CONTINUUM_INGEST_TERMINAL_SUMMARY_PRINCIPAL: actor.externalId,
      CONTINUUM_INGEST_TERMINAL_SUMMARY_DATABASE_URL: producer.url,
      CONTINUUM_INGEST_TERMINAL_SUMMARY_ACTOR_EXTERNAL_ID: externalActor };
    const databaseDiagnostics = async () => (await owner.query({
      text: `SELECT application_name,state,wait_event_type,wait_event,
        xact_start IS NOT NULL AS transaction_open FROM pg_catalog.pg_stat_activity
        WHERE datname=pg_catalog.current_database() AND usename=ANY($1::text[])
        ORDER BY application_name,pid LIMIT 8`,
      values: [[appRole, opRole, producerRole]], query_timeout: 1_000,
    })).rows;
    const rest = observeChild(childFile, 'REST', env, databaseDiagnostics); children.push(rest);
    const ready = await rest.witness('ready', 8_000); expect(ready.role).toBe(appRole);
    const baseUrl = `http://127.0.0.1:${ready.port}`;
    async function http(path: string, method = 'GET', body?: unknown, authenticated = true,
      credential = key.key, extraHeaders: Record<string, string> = {}, origin = baseUrl) {
      const response = await fetch(`${origin}/api/v0${path}`, { method, signal: AbortSignal.timeout(5_000),
        headers: { ...(authenticated ? { Authorization: `Bearer ${credential}` } : {}), 'Content-Type': 'application/json', ...extraHeaders },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const reader = response.body!.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
      try {
        for (;;) { const next = await reader.read(); if (next.done) break;
          bytes += next.value.length; if (bytes > 64 * 1024) throw new Error('Combined HTTP response exceeded64KiB');
          chunks.push(next.value); }
      } finally { await reader.cancel(); }
      const text = Buffer.concat(chunks).toString('utf8');
      return { status: response.status, headers: response.headers, text,
        json: () => JSON.parse(text) as any };
    }
    expect((await http('/scopes', 'GET', undefined, false)).status).toBe(401);
    expect((await http('/scopes')).status).toBe(200);
    let mcp = observeChild(childFile, 'MCP', env, databaseDiagnostics); children.push(mcp);
    async function initialize(child: ReturnType<typeof observeChild>) {
      expect((await child.witness('ready', 8_000)).role).toBe(appRole);
      const initialized = await child.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'combined-real-role', version: '1' } });
      expect(initialized.serverInfo.name).toBe('continuum');
      child.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    }
    await initialize(mcp);
    const recallMcp = mcp;
    async function tool(name: string, args: Record<string, unknown>, expectedError = false) {
      const result = await mcp.rpc('tools/call', { name, arguments: args });
      expect(Boolean(result.isError)).toBe(expectedError);
      return { payload: JSON.parse(result.content.map((part: any) => part.type === 'text' ? part.text : '').join('')) as any,
        meta: result._meta };
    }
    const cli = (args: string[]) => command([join(process.cwd(), 'bin/continuum.mjs'), ...args,
      // ApiClient appends /api/v0 itself; this option is the server origin.
      '--api-url', baseUrl, '--token', key.key, '--timeout', '5000', '--json'], env);
    const captured = await cli(['capture', '--scope', `project:${shared.name}`, '--type', 'fact',
      '--title', 'Combined shared sentinel', '--body', 'combined outage shared reference', '--tags', 'decision']);
    expect(captured.code).toBe(0); const sentinelId = captured.payload.id as string;
    expect(captured.payload.embedded).toBe(true);
    const captureBody = { scope: { kind: 'project', name: shared.name }, type: 'fact',
      title: 'Combined reference', body: 'combined outage reference', source: 'manual', tags: ['decision'] };
    const normal = await http('/capture', 'POST', captureBody); expect(normal.status).toBe(201);
    const privateArgs = { scope_kind: 'project', scope_name: shared.name, type: 'fact',
      title: 'Combined promotion source', body: 'Compact reference', source: 'manual', tags: ['decision'] };
    const mcpSource = (await tool('continuum.capture', privateArgs)).payload.id as string;
    const personalCapture = await http('/capture', 'POST', { ...captureBody,
      scope: { kind: 'user', name: personal.name }, title: 'Combined personal private',
      body: 'PERSONAL_ONLY_sensitive_reference' });
    expect(personalCapture.status).toBe(201); expect(personalCapture.json().embedded).toBe(true);
    expect((await http('/tag-vocabularies?scopeKind=project')).json().entries.some((entry: any) => entry.tag === 'decision')).toBe(true);
    const count = async () => (await owner.query('SELECT count(*)::int AS count FROM memories')).rows[0].count;
    const beforeDenied = await count();
    const unknown = await http('/capture', 'POST', { ...captureBody, tags: ['not-a-real-combined-tag'] });
    // REST flattens the service envelope; MCP retains error.code below.
    expect(unknown.status).toBe(422); expect(unknown.json().code).toBe('UNKNOWN_TAGS');
    expect(unknown.json().unknownTags).toEqual(['not-a-real-combined-tag']);
    const protectedInput = await tool('continuum.capture', { ...privateArgs,
      metadata: { continuum_legacy_tags: ['forged'] } }, true);
    expect(protectedInput.payload.error.code).toBe('INVALID_INPUT');
    const denied = await http('/capture', 'POST', { ...captureBody, scope: { kind: 'project', name: forbidden.name } });
    expect(denied.status).toBe(403); expect(denied.json().code).toBe('FORBIDDEN');
    expect(await count()).toBe(beforeDenied);
    expect((await owner.query('SELECT count(*)::int AS count FROM promotion_events')).rows[0].count).toBe(0);
    const vector = Array(768).fill(0) as number[]; vector[0] = 1;
    expect(await storeMemoryEmbeddingVector(application.pool, sentinelId, vector, { id: 'combined:provider-b', dim: 768 })).toBe(true);
    expect((await owner.query('SELECT provider FROM memory_embeddings WHERE memory_id=$1 ORDER BY provider', [sentinelId])).rows)
      .toEqual([{ provider: 'combined:provider-a' }, { provider: 'combined:provider-b' }]);
    const recalled = await cli(['recall', 'shared reference', '--scopes', `project:${shared.name}`, '--limit', '5']);
    expect(recalled.code).toBe(0); expect(recalled.payload.results.some((row: any) => row.id === sentinelId)).toBe(true);
    expect(recalled.payload.diagnostics.vector).toBe('used');
    const degraded = await http('/recall', 'POST', { query: 'combined outage', scopes: [`project:${shared.name}`], limit: 5 });
    expect(degraded.status).toBe(200);
    expect(degraded.json().diagnostics.vector).toBe('failed');
    expect(degraded.json().results.some((row: any) => row.id === sentinelId)).toBe(true);
    for (const row of degraded.json().results) expect(row.enrichments).toEqual({ combined: { reference: row.id } });
    expect(degraded.text).not.toContain('PRIVATE_PROVIDER_FAILURE');
    const mcpRecall = await tool('continuum.recall', { query: 'combined outage', scopes: [`project:${shared.name}`], limit: 5 });
    expect(mcpRecall.meta.diagnostics.vector).toBe('failed');
    expect(mcpRecall.payload.map((row: any) => row.id)).toEqual(degraded.json().results.map((row: any) => row.id));
    for (const row of mcpRecall.payload) expect(row.enrichments).toEqual({ combined: { reference: row.id } });
    const generator = await cli(['agents-md', '--project', shared.name, '--limit', '5']);
    expect(generator.code).toBe(0);
    const markdown = (await http(`/agents-md?project=${encodeURIComponent(shared.name)}&limit=5`));
    expect(markdown.status).toBe(200); expect(generator.payload.markdown).toBe(markdown.text);
    // agents_md is text, rather than the JSON contract of other MCP tools.
    const mcpBundle = await mcp.rpc('tools/call', { name: 'continuum.agents_md', arguments: { project: shared.name, limit: 5 } });
    expect(mcpBundle.isError).not.toBe(true);
    expect(mcpBundle.content.map((part: any) => part.text ?? '').join('')).toBe(markdown.text);
    const hash = createHash('sha256').update(markdown.text).digest('hex');
    expect(markdown.headers.get('etag')).toBe(`"${hash}"`);
    expect((await http(`/agents-md/freshness?project=${encodeURIComponent(shared.name)}&limit=5&hash=${hash}`)).json().fresh).toBe(true);
    expect(markdown.text).not.toContain('enrichments');
    expect(markdown.text).not.toContain('PERSONAL_ONLY');
    const firstPromotion = (await tool('continuum.promote', { memory_id: mcpSource,
      target_scope_kind: 'user', target_scope_name: personal.name })).payload;
    const callback = await rest.witness('callback'); expect(callback.sourceId).toBe(mcpSource);
    expect(callback.destinationId).toBe(firstPromotion.destination_id);
    await until(async () => (await owner.query(`SELECT 1 FROM promotion_event_deliveries
      WHERE event_id=$1::uuid AND state='delivered'`, [callback.eventId])).rowCount, 'persisted callback ACK');
    rest.child.send({ kind: 'stop-worker' }); await rest.witness('worker-stopped');
    const queuedSource = await http('/capture', 'POST', { ...captureBody, title: 'Combined pending source' });
    const queuedPromotion = await http(`/memories/${queuedSource.json().id}/promote`, 'POST',
      { targetScope: { kind: 'user', name: personal.name } });
    expect(queuedPromotion.status).toBe(201);
    const claimedSource = (await tool('continuum.capture', { ...privateArgs, title: 'Combined claimed source' })).payload.id;
    await tool('continuum.promote', { memory_id: claimedSource, target_scope_kind: 'user', target_scope_name: personal.name });
    const claimed = await claimPromotionDeliveries(application.pool, { owner: 'combined-privacy-claim',
      webhookIds: ['combined-hook'], limit: 1, leaseMs: 30_000 });
    expect(claimed).toHaveLength(1);
    expect((await owner.query('SELECT webhook_id FROM promotion_event_deliveries ORDER BY event_id')).rows)
      .toEqual(Array(3).fill({ webhook_id: 'combined-hook' }));
    const personalMemory = personalCapture.json().id as string;
    expect(await storeMemoryEmbeddingVector(application.pool, personalMemory, vector, { id: 'combined:provider-a', dim: 768 })).toBe(true);
    expect(await storeMemoryEmbeddingVector(application.pool, personalMemory, vector, { id: 'combined:provider-b', dim: 768 })).toBe(true);
    expect((await owner.query('SELECT provider FROM memory_embeddings WHERE memory_id=$1 ORDER BY provider', [personalMemory])).rows)
      .toEqual([{ provider: 'combined:provider-a' }, { provider: 'combined:provider-b' }]);
    const runId = randomUUID();
    expect((await owner.query(`SELECT action,count(*)::int AS count FROM audit_log
      WHERE principal_id=$1 AND memory_id IS NOT NULL AND action IN ('write','promote')
      GROUP BY action ORDER BY action`, [actor.id])).rows)
      .toEqual([{ action: 'promote', count: 3 }, { action: 'write', count: 6 }]);

    // Real bearer ingestion uses a separate bound producer LOGIN. The reader
    // is the mapped USER, authenticated with the documented dev credential.
    // Two days of read-clock advancement exercises inactivity without changing
    // source timestamps or expiry. At most two compiled children stay alive.
    await stopChild(mcp.child, mcp.closed);
    const sourceNow = () => owner.query<{ time: Date }>('SELECT clock_timestamp() AS time');
    const readerTime = new Date((await sourceNow()).rows[0].time.getTime() + 2 * 86_400_000).toISOString();
    const readerEnv = { ...env, CONTINUUM_AUTH_MODE: 'dev', CONTINUUM_BEARER: target.externalId,
      COMBINED_ACTOR: target.id, COMBINED_READER: 'true', COMBINED_READER_NOW: readerTime };
    const readerRest = observeChild(childFile, 'REST', readerEnv, databaseDiagnostics); children.push(readerRest);
    const readerReady = await readerRest.witness('ready', 8_000); expect(readerReady.role).toBe(appRole);
    const readerOrigin = `http://127.0.0.1:${readerReady.port}`;
    const sessionId = `combined-session-${suffix}`;
    const startedAt = (await sourceNow()).rows[0].time.toISOString();
    const terminalEvent = { actor: 'Forged payload actor', sessionId,
      summary: 'STANDUP_PERSONAL_ONLY trusted session summary', startedAt };
    const started = await http('/ingest/terminal-summary', 'POST', terminalEvent, true,
      ingestKey.key, { 'idempotency-key': `combined-open-${suffix}` });
    expect(started.status).toBe(202); expect(started.json().memoryIds).toHaveLength(1);
    const openerId = started.json().memoryIds[0] as string;
    const initialExpiry = (await owner.query('SELECT expires_at FROM memories WHERE id=$1', [openerId])).rows[0].expires_at as Date;
    expect(initialExpiry.getTime()).toBeGreaterThan(Date.parse(readerTime));
    const standupRead = (since: string) => http(`/standup?since=${since}&openThreadDays=1`, 'GET', undefined,
      true, target.externalId, {}, readerOrigin);
    const open = await standupRead('24h'); expect(open.status).toBe(200);
    expect(open.json().openThreads.map((row: any) => row.id)).toEqual([openerId]);
    expect(open.json().openThreads[0].actor).toBe(target.displayName);
    const active = await standupRead('168h'); expect(active.status).toBe(200);
    expect(active.json().activity.map((row: any) => row.id)).toEqual([openerId]);
    expect(JSON.stringify(active.json())).not.toContain('Forged payload actor');
    const finishedAt = (await sourceNow()).rows[0].time.toISOString();
    const finished = await http('/ingest/terminal-summary', 'POST', { ...terminalEvent, finishedAt }, true,
      ingestKey.key, { 'idempotency-key': `combined-close-${suffix}` });
    expect(finished.status).toBe(202); expect(finished.json().memoryIds).toHaveLength(1);
    const closerId = finished.json().memoryIds[0] as string;
    const standupMemoryIds = [openerId, closerId];
    const closed = await standupRead('24h'); expect(closed.status).toBe(200);
    expect(closed.json().openThreads).toEqual([]);
    const completeDigest = await standupRead('168h'); expect(completeDigest.status).toBe(200);
    expect(completeDigest.json().activity.map((row: any) => row.id).sort()).toEqual([...standupMemoryIds].sort());
    expect(completeDigest.json().activity.every((row: any) => row.actor === target.displayName)).toBe(true);
    expect((await owner.query('SELECT expires_at FROM memories WHERE id=$1', [openerId])).rows[0].expires_at).toEqual(initialExpiry);
    expect((await owner.query(`SELECT actor_principal_id,thread_owner_principal_id,mapping_id,
      trust_expires_at=memory.expires_at AS fixed_lifetime FROM memory_activity_attributions attribution
      JOIN memories memory ON memory.id=attribution.memory_id WHERE memory_id=ANY($1::uuid[])`, [standupMemoryIds])).rows)
      .toEqual(Array(2).fill({ actor_principal_id: target.id, thread_owner_principal_id: target.id,
        mapping_id: actorMapping, fixed_lifetime: true }));
    expect((await owner.query('SELECT count(*)::int AS count FROM standup_thread_closures WHERE source_memory_id=$1 AND actor_principal_id=$2', [closerId, target.id])).rows[0].count).toBe(1);
    const replayProof = { external_actor_id: externalActor, artifact_id: sessionId, event_time: startedAt, finished: false };
    await expect(application.pool.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb)', [openerId, replayProof]))
      .rejects.toMatchObject({ code: '42501' });
    await stopChild(readerRest.child, readerRest.closed);
    const readerMcp = observeChild(childFile, 'MCP', readerEnv, databaseDiagnostics); children.push(readerMcp);
    await initialize(readerMcp);
    const ownerDigest = await readerMcp.rpc('tools/call', { name: 'continuum.standup', arguments: { since: '168h', open_thread_days: 1 } });
    expect(ownerDigest.isError).not.toBe(true);
    const digestText = ownerDigest.content.map((part: any) => part.text ?? '').join('');
    for (const id of standupMemoryIds) expect(digestText.replaceAll('\\', '')).toContain(id);
    expect(digestText).not.toContain('Forged payload actor');
    expect(digestText).toContain('No open threads found.');
    const closedMcp = await readerMcp.rpc('tools/call', { name: 'continuum.standup', arguments: { since: '24h', open_thread_days: 1 } });
    expect(closedMcp.isError).not.toBe(true);
    expect(closedMcp.content.map((part: any) => part.text ?? '').join('')).toContain('No open threads found.');
    await stopChild(readerMcp.child, readerMcp.closed);
    expect((await owner.query(`SELECT DISTINCT metadata->>'transport' AS transport FROM audit_log
      WHERE principal_id=$1 AND memory_id IS NULL AND metadata->>'view'='standup' ORDER BY transport`, [target.id])).rows)
      .toEqual([{ transport: 'mcp' }, { transport: 'rest' }]);
    // Restore the original real service-key MCP composition for remaining
    // coordination, offboarding and disabled-destination assertions.
    mcp = observeChild(childFile, 'MCP', env, databaseDiagnostics); children.push(mcp);
    await initialize(mcp);

    const lease = (await tool('continuum.lock_acquire', { scope: `user:${personal.name}`, resource: 'combined-private-resource',
      run_id: runId, request_id: randomUUID(), ttl_seconds: 30 })).payload;
    expect(lease.acquired).toBe(true);
    expect((await tool('continuum.lock_release', { lease_id: lease.lease_id, run_id: runId, request_id: randomUUID() })).payload.released).toBe(true);
    expect((await owner.query('SELECT count(*)::int AS count FROM coordination_resources WHERE scope_id=$1', [personal.id])).rows[0].count).toBe(1);
    expect((await owner.query('SELECT count(*)::int AS count FROM coordination_operation_receipts WHERE scope_id=$1', [personal.id])).rows[0].count).toBe(2);
    const adminEnv = { ...process.env, PGOPTIONS: '', CONTINUUM_DATABASE_URL: operator.url,
      CONTINUUM_ADMIN_ACTOR: admin.externalId, CONTINUUM_DB_POOL_MAX: '1', CONTINUUM_DB_CONNECTION_TIMEOUT_MS: '1000' };
    const adminArgs = [join(process.cwd(), 'dist/identity/admin-cli.js'), 'offboard-principal', target.id,
      '--confirm-scope', personal.id, '--batch-size', '1', '--verification-timeout-ms', '15000'];
    const once = await command([...adminArgs, '--once'], adminEnv, 90_000);
    expect([0, 2, 3]).toContain(once.code); expect(once.payload.principalId).toBe(target.id);
    if (!once.payload.complete) expect(once.payload.progressed).toBe(true);
    const completion = await command(adminArgs, adminEnv, 90_000);
    expect(completion.code).toBe(0); expect(completion.payload.complete).toBe(true);
    expect((await operator.pool.query(`SELECT continuum_operator_offboarding_actual_state_is_erased($1::uuid,run_id) AS erased
      FROM principal_offboarding_runs WHERE principal_id=$2::uuid AND completed_at IS NOT NULL`, [admin.id, target.id])).rows)
      .toEqual([{ erased: true }]);
    expect((await owner.query('SELECT disabled_at IS NOT NULL AS disabled FROM principals WHERE id=$1', [target.id])).rows)
      .toEqual([{ disabled: true }]);
    const tombstones = (await owner.query('SELECT title,body,metadata,tags,source,state FROM memories WHERE scope_id=$1', [personal.id])).rows;
    expect(tombstones).toHaveLength(4 + standupMemoryIds.length);
    for (const row of tombstones) expect(row).toEqual({ title: '[erased]', body: '[erased]', metadata: {}, tags: [], source: 'erased', state: 'archived' });
    expect((await owner.query(`SELECT count(*)::int AS count FROM memory_embeddings vector
      JOIN memories memory ON memory.id=vector.memory_id WHERE memory.scope_id=$1`, [personal.id])).rows[0].count).toBe(0);
    for (const table of ['coordination_resources', 'coordination_leases', 'coordination_operation_receipts']) {
      expect((await owner.query(`SELECT count(*)::int AS count FROM ${table} WHERE scope_id=$1`, [personal.id])).rows[0].count).toBe(0);
    }
    const erasedName = (await owner.query('SELECT name FROM scopes WHERE id=$1', [personal.id])).rows[0].name as string;
    expect(erasedName).not.toBe(personal.name);
    expect((await owner.query(`SELECT event.destination_scope_name,delivery.state,delivery.lease_owner,delivery.last_error
      FROM promotion_events event JOIN promotion_event_deliveries delivery ON delivery.event_id=event.id
      WHERE event.destination_scope_id=$1`, [personal.id])).rows)
      .toEqual(Array(3).fill({ destination_scope_name: erasedName, state: 'privacy_cancelled', lease_owner: null, last_error: null }));
    expect(await completePromotionDelivery(application.pool, claimed[0].event.eventId, claimed[0].webhookId,
      'combined-privacy-claim', claimed[0].attemptCount, claimed[0].leaseGeneration)).toBe(false);
    const postRecall = await http('/recall', 'POST', { query: 'combined personal private', scopes: [`user:${erasedName}`], limit: 5 });
    expect([200, 403]).toContain(postRecall.status);
    if (postRecall.status === 200) expect(postRecall.json().results).toEqual([]);
    const postMcp = await mcp.rpc('tools/call', { name: 'continuum.recall', arguments: { query: 'combined personal private', scopes: [`user:${erasedName}`], limit: 5 } });
    const postPayload = JSON.parse(postMcp.content.map((part: any) => part.text ?? '').join(''));
    if (postMcp.isError) expect(postPayload.error.code).toBe('FORBIDDEN'); else expect(postPayload).toEqual([]);
    expect((await http(`/memories/${sentinelId}/promote`, 'POST', { targetScope: { kind: 'user', name: erasedName } })).status).toBe(403);
    expect((await tool('continuum.promote', { memory_id: sentinelId, target_scope_kind: 'user', target_scope_name: erasedName }, true)).payload.error.code).toBe('FORBIDDEN');
    expect((await owner.query('SELECT title,body,state FROM memories WHERE id=$1', [sentinelId])).rows)
      .toEqual([{ title: 'Combined shared sentinel', body: 'combined outage shared reference', state: 'live' }]);
    expect((await cli(['recall', 'shared reference', '--scopes', `project:${shared.name}`, '--limit', '5'])).code).toBe(0);
    expect((await owner.query('SELECT scope_id,acknowledged_evidence_hash FROM principal_user_scopes WHERE principal_id=$1', [target.id])).rows)
      .toEqual([{ scope_id: personal.id, acknowledged_evidence_hash: mapping.acknowledgedEvidenceHash }]);
    expect((await owner.query('SELECT id FROM principal_user_scope_approvals WHERE id=$1', [mapping.approvalId])).rows)
      .toEqual([{ id: mapping.approvalId }]);
    expect((await owner.query(`SELECT count(*)::int AS count FROM audit_log WHERE principal_id=$1
      AND action='read' AND memory_id IS NOT NULL`, [actor.id])).rows[0].count).toBeGreaterThan(0);
    expect((await owner.query(`SELECT count(*)::int AS count FROM audit_log WHERE principal_id=$1
      AND metadata->>'operation'='principal_offboarded'`, [admin.id])).rows[0].count).toBeGreaterThan(0);
    expect((await owner.query('SELECT actor_label FROM memory_activity_attributions WHERE memory_id=ANY($1::uuid[])', [standupMemoryIds])).rows)
      .toEqual(Array(2).fill({ actor_label: '[erased]' }));
    expect((await owner.query('SELECT revoked_at IS NOT NULL AS revoked,revocation_reason FROM actor_principal_mappings WHERE mapping_id=$1', [actorMapping])).rows)
      .toEqual([{ revoked: true, revocation_reason: '[erased]' }]);
    await expect(producer.pool.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb)', [openerId, replayProof]))
      .rejects.toMatchObject({ code: '42501' });
    expect((await owner.query('SELECT count(*)::int AS count FROM memory_activity_attributions WHERE actor_principal_id=$1 AND actor_label<>$2', [target.id, '[erased]'])).rows[0].count).toBe(0);
    expect(recallMcp.stderr()).toContain('embedding_recall_fallback');
    expect(children.map((child) => child.stderr()).join('')).not.toContain('PRIVATE_PROVIDER_FAILURE');
  } catch (error) { errors.push(error); }
  finally {
    for (const child of children.reverse()) {
      try { await stopChild(child.child, child.closed); } catch (error) { errors.push(error); }
    }
    for (const pool of [...logins, owner]) {
      try { await bounded(pool.end(), 10_000, 'combined pool end'); } catch (error) { errors.push(error); }
    }
    try { await bounded(Promise.all(physicalEnds), 5_000, 'physical fixture clients end'); } catch (error) { errors.push(error); }
    try { if (schemaCreated) await maintenance.query(`DROP SCHEMA ${quote(schema)} CASCADE`); } catch (error) { errors.push(error); }
    for (const role of rolesCreated) {
      try { await maintenance.query(`DROP OWNED BY ${quote(role)}; DROP ROLE ${quote(role)}`); } catch (error) { errors.push(error); }
    }
    try { await bounded(maintenance.end(), 10_000, 'maintenance pool end'); } catch (error) { errors.push(error); }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Combined acceptance or ordinary fixture cleanup failed');
}, 300_000);
