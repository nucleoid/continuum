import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, lstatSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const digest = text => createHash('sha256').update(text).digest('hex');
let currentStep = 'configuration';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function decodeResult(result) {
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('');
  const value = JSON.parse(text);
  if (result.isError) {
    const error = new Error('UAT tool rejected operation');
    error.code = value.error?.code;
    throw error;
  }
  return value;
}
function privateFile(path) {
  assert(path && resolve(path) === path, 'Private absolute file required');
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536, 'Invalid private file');
  if (process.platform !== 'win32') assert((stat.mode & 0o077) === 0, 'Private file permissions required');
  return readFileSync(path, 'utf8').replace(/(?:\r\n|\n|\r)$/, '');
}
export async function connect(url, key) {
  currentStep = 'session';
  const client = new Client({ name: 'continuum-uat-smoke', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `ApiKey ${key}` } },
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
  });
  await client.connect(transport, { timeout: 20000 });
  const call = async (name, args) => {
    currentStep = name;
    return decodeResult(await client.callTool({ name: `continuum.${name}`, arguments: args }, undefined, { timeout: 20000 }));
  };
  return { client, transport, call };
}

// Uses only synthetic UAT resources. No GitHub or filesystem publication.
export async function leaseSmoke(a, b, scope, options = {}) {
  const resource = `uat:delivery-forge:${randomUUID()}`;
  const runA = randomUUID(), runB = randomUUID();
  const acquire = { scope, resource, run_id: runA, request_id: randomUUID(), ttl_seconds: 30 };
  let own;
  try {
    own = await a('lock_acquire', acquire);
    assert.equal(own.acquired, true);
    assert.match(own.fencing_token, /^[1-9][0-9]*$/);
    const replay = await a('lock_acquire', acquire);
    assert.equal(replay.lease_id, own.lease_id);
    assert.equal(replay.fencing_token, own.fencing_token);
    for (const [call, run] of [[a, runA], [b, runB]]) {
      const contention = await call('lock_acquire', { ...acquire, run_id: run, request_id: randomUUID() });
      assert.equal(contention.acquired, false);
      assert.equal(contention.reason, 'LOCK_HELD');
      assert(contention.retry_after_seconds > 0);
      assert.equal(contention.lease_id, undefined);
      assert.equal(contention.fencing_token, undefined);
    }
    const masked = await b('lock_inspect', { scope, resource });
    assert.equal(masked.held, true);
    assert.equal(masked.lease_id, undefined);
    assert.equal(masked.run_id, undefined);
    const mutation = () => ({ lease_id: own.lease_id, run_id: runA, request_id: randomUUID() });
    await assert.rejects(b('lock_renew', mutation()), { code: 'LEASE_LOST' });
    await assert.rejects(a('lock_release', { ...mutation(), run_id: runB }), { code: 'LEASE_LOST' });
    const renewal = await a('lock_renew', { ...mutation(), ttl_seconds: 30 });
    assert.equal(renewal.fencing_token, own.fencing_token);
    const release = mutation();
    assert.equal((await a('lock_release', release)).released, true);
    assert.equal((await a('lock_release', release)).already_released, true);
    const successor = await b('lock_acquire', { ...acquire, run_id: runB, request_id: randomUUID() });
    assert.equal(successor.acquired, true);
    assert(BigInt(successor.fencing_token) > BigInt(own.fencing_token));
    assert.equal((await a('lock_release', release)).already_released, true);
    await assert.rejects(a('lock_renew', { ...mutation(), ttl_seconds: 30 }), { code: 'LEASE_LOST' });
    assert.equal((await b('lock_inspect', { scope, resource })).lease_id, successor.lease_id);
    // The server's remaining duration, not the client's clock, drives the wait.
    const remaining = Date.parse(successor.expires_at) - Date.parse(successor.server_time);
    assert(remaining > 0 && remaining <= 30000);
    await (options.wait ?? sleep)(remaining + 1000);
    const next = await a('lock_acquire', { ...acquire, request_id: randomUUID() });
    assert.equal(next.acquired, true);
    assert(BigInt(next.fencing_token) > BigInt(successor.fencing_token));
    own = next;
    await assert.rejects(b('lock_release', { lease_id: successor.lease_id, run_id: runB, request_id: randomUUID() }), { code: 'LEASE_LOST' });
    assert.equal((await a('lock_inspect', { scope, resource })).lease_id, next.lease_id);
    assert.equal((await a('lock_release', mutation())).released, true);
    own = undefined;
    return { replay: true, contention: true, masking: true, renew: true, release: true, expiry: true, staleGeneration: true };
  } finally {
    // No blind retry after uncertain mutation; any remaining synthetic lease expires.
    if (own) await a('lock_release', { lease_id: own.lease_id, run_id: own.run_id, request_id: randomUUID() }).catch(() => undefined);
  }
}

export async function runUatSmoke(env, phase = 'smoke', options = {}) {
  currentStep = 'configuration';
  assert(process.platform !== 'win32', 'SDK fixture requires POSIX private file permissions');
  const url = new URL(env.CONTINUUM_UAT_URL);
  assert((url.protocol === 'https:' || (options.allowLoopback === true && url.protocol === 'http:' && url.hostname === '127.0.0.1')) && url.pathname === '/mcp' && !url.username && !url.password && !url.search && !url.hash, 'Canonical HTTPS MCP URL required');
  const project = env.CONTINUUM_UAT_PROJECT;
  assert(project && project.length <= 500, 'Approved project required');
  const keyA = privateFile(env.CONTINUUM_UAT_KEY_A_FILE), keyB = privateFile(env.CONTINUUM_UAT_KEY_B_FILE);
  assert(keyA.startsWith('ctm_') && keyB.startsWith('ctm_') && keyA !== keyB, 'Distinct service credentials required');
  const sessions = [];
  assert(['smoke', 'checkpoint', 'recover'].includes(phase), 'Unknown phase');
  assert(phase !== 'checkpoint' || process.platform !== 'win32', 'Checkpoint requires a POSIX private filesystem');
  try {
    const a = await connect(url, keyA); sessions.push(a);
    const b = await connect(url, keyB); sessions.push(b);
    currentStep = 'discovery';
    const tools = (await a.client.listTools()).tools.map(tool => tool.name);
    for (const name of ['capture','recall','get_memory','verify','agents_md','agents_md_fresh','lock_acquire','lock_renew','lock_release','lock_inspect']) assert(tools.includes(`continuum.${name}`));
    const scope = `project:${project}`;
    if (phase === 'recover') {
      const state = JSON.parse(privateFile(env.CONTINUUM_UAT_STATE_FILE));
      assert(state.endpointHash === digest(url.href) && state.project === project, 'Wrong checkpoint target');
      assert(/^uat:delivery-forge:[0-9a-f-]{36}$/.test(state.resource), 'Synthetic resource required');
      assert(typeof state.bodyHash === 'string' && /^[a-f0-9]{64}$/.test(state.bodyHash));
      assert(typeof state.expiresAt === 'string' && Number.isFinite(Date.parse(state.expiresAt)));
      assert(state.memoryState === 'live' && typeof state.lastVerified === 'string');
      const memory = await a.call('get_memory', { memory_id: state.memoryId });
      assert.equal(memory.id, state.memoryId);
      assert.equal(digest(memory.body), state.bodyHash);
      assert.equal(memory.expires_at, state.expiresAt);
      assert.equal(memory.state, state.memoryState);
      assert.equal(memory.last_verified, state.lastVerified);
      const current = await a.call('lock_inspect', { scope, resource: state.resource });
      assert.equal(current.lease_id, state.lease.lease_id);
      assert.equal(current.fencing_token, state.lease.fencing_token);
      const renewed = await a.call('lock_renew', { lease_id: current.lease_id, run_id: state.lease.run_id, request_id: randomUUID(), ttl_seconds: 30 });
      assert.equal(renewed.fencing_token, current.fencing_token);
      assert.equal((await a.call('lock_release', { lease_id: current.lease_id, run_id: state.lease.run_id, request_id: randomUUID() })).released, true);
      await assert.rejects(a.call('lock_renew', { lease_id: current.lease_id, run_id: state.lease.run_id, request_id: randomUUID() }), { code: 'LEASE_LOST' });
      return { ok: true, restartPersistence: true, freshSessions: true };
    }
    const marker = `Continuum UAT ${randomUUID()}`;
    const input = { scope_kind: 'project', scope_name: project, type: 'fact', title: marker, body: `${marker}. Synthetic reference: a bicycle is stored inside the garden shed.`, source: 'manual', tags: ['decision'], metadata: { uat_marker: marker } };
    const captured = await a.call('capture', input);
    assert(captured.id && captured.expires_at, 'Fact must have a fixed expiry');
    const fetched = await a.call('get_memory', { memory_id: captured.id });
    assert.equal(fetched.body, input.body);
    const recalled = await a.call('recall', { query: marker, scopes: [scope], limit: 10 });
    assert(recalled.some(memory => memory.id === captured.id));
    await assert.rejects(a.call('capture', { ...input, tags: ['unknown-uat-tag'] }), { code: 'UNKNOWN_TAGS' });
    await a.call('verify', { memory_id: captured.id, still_true: true, note: 'Synthetic UAT confirmation' });
    currentStep = 'bundle';
    const bundle = await a.client.callTool({ name: 'continuum.agents_md', arguments: { project } });
    assert(!bundle.isError);
    const text = bundle.content.filter(item => item.type === 'text').map(item => item.text).join('');
    assert(text.includes('garden shed'));
    assert.equal((await a.call('agents_md_fresh', { project, hash: digest(text) })).fresh, true);
    if (phase === 'checkpoint') {
      const persisted = await a.call('get_memory', { memory_id: captured.id });
      assert(typeof persisted.expires_at === 'string' && Number.isFinite(Date.parse(persisted.expires_at)));
      assert(Date.parse(persisted.expires_at) >= Date.parse(captured.expires_at));
      assert.equal(persisted.state, 'live');
      assert(typeof persisted.last_verified === 'string' && Number.isFinite(Date.parse(persisted.last_verified)));
      const resource = `uat:delivery-forge:${randomUUID()}`;
      const lease = await a.call('lock_acquire', { scope, resource, run_id: randomUUID(), request_id: randomUUID(), ttl_seconds: 300 });
      assert(lease.acquired);
      const stateFile = env.CONTINUUM_UAT_STATE_FILE;
      assert(stateFile && resolve(stateFile) === stateFile, 'Private absolute state path required');
      writeFileSync(stateFile, JSON.stringify({ endpointHash: digest(url.href), project, memoryId: captured.id, bodyHash: digest(persisted.body), expiresAt: persisted.expires_at, memoryState: persisted.state, lastVerified: persisted.last_verified, resource, lease }), { flag: 'wx', mode: 0o600 });
      return { ok: true, checkpoint: true, recoverWithinSeconds: 300 };
    }
    let semantic = 'not-qualified';
    if (env.CONTINUUM_UAT_SEMANTIC_PROVIDER) {
      assert.equal(captured.embedded, true);
      currentStep = 'semantic_recall';
      const result = await a.client.callTool({ name: 'continuum.recall', arguments: { query: 'Where do we keep the pedal-powered two-wheeled vehicle?', scopes: [scope], limit: 10 } });
      const memories = decodeResult(result);
      assert(memories.some(memory => memory.id === captured.id));
      const diagnostics = result._meta?.diagnostics;
      assert.equal(diagnostics?.vector, 'used');
      assert(diagnostics.groups.some(group => group.provider === env.CONTINUUM_UAT_SEMANTIC_PROVIDER && group.dim === 768 && group.status === 'used'));
      semantic = 'used';
    }
    currentStep = 'audit_rest';
    const audit = await fetch(new URL(`/api/v0/audit?memoryId=${captured.id}&limit=100`, url), { headers: { Authorization: `ApiKey ${keyA}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
    assert.equal(audit.status, 200);
    const entries = (await audit.json()).entries;
    for (const action of ['write','read','verify']) assert(entries.some(entry => entry.action === action));
    await a.call('verify', { memory_id: captured.id, still_true: false });
    assert(!(await a.call('recall', { query: marker, scopes: [scope] })).some(memory => memory.id === captured.id));
    const leases = await leaseSmoke(a.call, b.call, scope);
    return { ok: true, memory: true, fixedExpiry: true, tags: true, verification: true, audit: true, bundleFreshness: true, semantic, leases };
  } finally {
    for (const session of sessions.reverse()) {
      await session.transport.terminateSession().catch(() => undefined);
      await session.client.close().catch(() => undefined);
    }
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const timer = setTimeout(() => { process.stderr.write(JSON.stringify({ ok: false, step: currentStep, code: 'DEADLINE_EXCEEDED', reconcileBeforeRetry: true }) + '\n'); process.exit(1); }, 180000);
  try { console.log(JSON.stringify(await runUatSmoke(process.env, process.argv[2] ?? 'smoke'))); } catch (error) {
    const codes = new Set(['LEASE_LOST','SCOPE_NOT_FOUND','FORBIDDEN','UNKNOWN_TAGS','MEMORY_NOT_FOUND','INVALID_INPUT','QUOTA_EXCEEDED']);
    const code = codes.has(error?.code) ? error.code : error?.code === 'ERR_ASSERTION' ? 'ASSERTION_FAILED' : 'REQUEST_FAILED';
    process.stderr.write(JSON.stringify({ ok: false, step: currentStep, code, reconcileBeforeRetry: true }) + '\n');
    process.exitCode = 1;
  }
  finally { clearTimeout(timer); }
}
