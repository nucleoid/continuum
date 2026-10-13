import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { JSONRPCMessageSchema, isInitializeRequest, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer, type McpDeps, type McpExecutionGuard } from './mcp.js';
import type { Authenticator } from './auth.js';
import { isLifecyclePrincipal } from '../lifecycle/principal.js';
import type { McpHttpConfig } from './mcp-http-config.js';
import { validateMcpHttpRequest, isTrustedMcpProxyPeer } from './mcp-http-config.js';
import { McpHttpSessions, type ExecutionRelease } from './mcp-http-sessions.js';
let pendingAuthentications = 0;
const MAX_PENDING_AUTHENTICATIONS = 100;
let bodyReaders = 0;
let reservedControlReaders = 0;
interface Call { release: ExecutionRelease; started: boolean; done: boolean }
interface Context { deadline: number; abort: AbortController; calls: Map<string | number, Call> }
interface Entry {
  id?: string; binding: string; principal: string; expires: number; idle: number;
  ready: boolean; closed: boolean; release: () => void;
  server: ReturnType<typeof buildMcpServer>; transport: StreamableHTTPServerTransport;
  contexts: Set<Context>; ids: Set<string | number>; stream?: express.Response;
  initializationDeadline: number; protocol?: string;
}
export interface McpHttpDeps extends Omit<McpDeps, 'principal' | 'executionGuard'> {
  authenticator: Authenticator;
  info?: (event: Record<string, unknown>) => void;
}
export function createMcpHttpController(config: McpHttpConfig, deps: McpHttpDeps) {
  const limits = config.limits;
  const admission = new McpHttpSessions(limits);
  const sessions = new Map<string, Entry>();
  const pending = new Set<Entry>();
  const contexts = new WeakMap<AuthInfo, Context>();
  const executing = new Set<Promise<unknown>>();
  const principalReaders = new Map<string, number>();
  const controlReaders = new Map<string, number>();
  const requests = new Map<express.Response, AbortController>();
  let stopped = false;
  const event = (outcome: string, entry?: Entry, extra: Record<string, unknown> = {}) => deps.info?.({
    event: 'mcp_http', correlationId: randomUUID(), action: outcome,
    ...(entry ? { principalId: entry.principal, session: admission.correlation(entry.id ?? 'pending') } : {}), ...extra,
  });
  const close = async (entry: Entry, reason: string) => {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.id) sessions.delete(entry.id);
    pending.delete(entry);
    entry.release();
    for (const ctx of entry.contexts) ctx.abort.abort();
    entry.stream?.destroy();
    event('close', entry, { reason });
    try { await entry.server.close(); } catch { event('cleanup_failed', entry); }
  };
  const sweep = () => {
    const now = Date.now();
    for (const entry of new Set([...sessions.values(), ...pending])) {
      if (now >= entry.expires || now >= entry.idle || (!entry.ready && now >= entry.initializationDeadline)) {
        void close(entry, 'expired');
      }
    }
  };
  const timer = setInterval(sweep, 100); timer.unref();
  const fail = (res: express.Response, status: number, code: string) => {
    event('reject', undefined, { status, code });
    if (!res.headersSent && !res.destroyed) res.status(status).json({ jsonrpc: '2.0', id: null,
      error: { code: -32000, message: code } });
    else if (!res.destroyed) res.destroy();
  };
  const guard: McpExecutionGuard = async (name, extra, execute) => {
    const context = extra.authInfo && contexts.get(extra.authInfo);
    const call = context?.calls.get(extra.requestId);
    if (!context || !call || call.started || Date.now() >= context.deadline || context.abort.signal.aborted) {
      throw new Error('Remote request is no longer authorized');
    }
    call.started = true;
    const started = Date.now();
    const signal = AbortSignal.any([extra.signal, context.abort.signal]);
    const work = Promise.resolve().then(() => { signal.throwIfAborted(); return execute(signal); });
    executing.add(work);
    try {
      const result = await work;
      signal.throwIfAborted();
      return result;
    } finally {
      call.done = true; call.release(); executing.delete(work);
      event('call_complete', undefined, { tool: /^continuum\.[a-z_]+$/.test(name) ? name : 'unknown',
        outcome: signal.aborted ? 'cancelled' : 'settled', durationMs: Date.now() - started });
    }
  };
  const router = express.Router();
  const parse = express.json({ limit: limits.bodyBytes, inflate: false, strict: true,
    type: 'application/json' });
  router.use(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.originalUrl.split('?', 1)[0] !== '/mcp' || req.path !== '/' || !['POST', 'GET', 'DELETE'].includes(req.method)) { fail(res, 405, 'Unsupported method'); return; }
    if (stopped) { fail(res, 503, 'Remote MCP is stopping'); return; }
    if (req.headers['last-event-id']) { fail(res, 400, 'Historical resumption is unsupported'); return; }
    if (!validateMcpHttpRequest(req, config)) { fail(res, 400, 'Invalid remote request'); return; }
    const trustedProxy = isTrustedMcpProxyPeer(req, config);
    if (!trustedProxy && !admission.admitPeer(req.socket.remoteAddress!)) { fail(res, 429, 'Request limit exceeded'); return; }
    const rejectAuth = (message: string) => fail(res, trustedProxy && !admission.admitProxy(req.socket.remoteAddress!) ? 429 : 401, message);
    if (req.method !== 'POST' && (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0)) {
      fail(res, 400, 'Request body is unsupported'); return;
    }
    const header = req.headers.authorization ?? '';
    const match = /^(Bearer|ApiKey) ([^\s]+)$/i.exec(header);
    if (!match) { rejectAuth('Authentication required'); return; }
    const abort = new AbortController();
    requests.set(res, abort);
    let deadline = Date.now() + limits.requestMs;
    const expire = () => { abort.abort(); fail(res, 504, 'Request deadline exceeded');
      if (!req.complete) req.destroy(); };
    let deadlineTimer = setTimeout(expire, limits.requestMs);
    res.once('close', () => { clearTimeout(deadlineTimer); requests.delete(res); abort.abort(); });
    let auth;
    if (pendingAuthentications >= MAX_PENDING_AUTHENTICATIONS) { fail(res, 503, 'Authentication capacity exceeded'); return; }
    pendingAuthentications++;
    try { auth = await deps.authenticator.authenticate(match[1], match[2]); }
    catch { fail(res, 503, 'Authentication unavailable'); return; }
    finally { pendingAuthentications--; }
    if (stopped) { fail(res, 503, 'Remote MCP is stopping'); return; }
    if (abort.signal.aborted || res.destroyed) return;
    if (!auth || isLifecyclePrincipal(auth.principal) || (auth.expiresAt && auth.expiresAt.getTime() <= Date.now())) {
      rejectAuth('Invalid credential'); return;
    }
    req.principal = auth.principal;
    const binding = admission.binding(auth, match[2]);
    deadline = Math.min(deadline, auth.expiresAt?.getTime() ?? Infinity);
    clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(expire, Math.max(1, deadline - Date.now()));
    if (req.method !== 'POST' && (!admission.admit(`control:principal:${auth.principal.id}`, 1) || !admission.admit(`control:credential:${binding}`, 1))) {
      fail(res, 429, 'Message limit exceeded'); return;
    }
    const accepts = (type: string) => (req.headers.accept ?? '').split(',').some((part) => {
      const [media, ...params] = part.trim().split(';').map((value) => value.trim());
      const q = params.find((value) => value.startsWith('q='));
      return media === type && (!q || /^q=(?:1(?:\.0{1,3})?|0(?:\.\d{1,3})?)$/.test(q) && Number(q.slice(2)) > 0);
    });
    if ((req.method === 'POST' && (!accepts('application/json') || !accepts('text/event-stream')))
      || (req.method === 'GET' && !accepts('text/event-stream'))) { fail(res, 406, 'Unsupported content negotiation'); return; }
    const id = req.headers['mcp-session-id'];
    let entry = typeof id === 'string' ? sessions.get(id) : undefined;
    if (id !== undefined && (!entry || entry.closed || entry.binding !== binding || Date.now() >= entry.expires
      || Date.now() >= entry.idle || (!entry.ready && req.method !== 'POST'))) {
      if (entry && (Date.now() >= entry.expires || Date.now() >= entry.idle)) void close(entry, 'expired');
      fail(res, 404, 'Session not found'); return;
    }
    if (req.method !== 'POST' && !entry) { fail(res, 404, 'Session not found'); return; }
    const protocol = req.headers['mcp-protocol-version'];
    if (protocol !== undefined && (typeof protocol !== 'string' || !SUPPORTED_PROTOCOL_VERSIONS.includes(protocol)
      || (entry?.protocol && entry.protocol !== protocol))) { fail(res, 400, 'Invalid protocol version'); return; }
    if (req.method === 'DELETE') {
      await close(entry!, 'deleted');
      res.status(200).end(); return;
    }
    if (req.method === 'GET') {
      if (entry!.stream) { fail(res, 409, 'Stream already open'); return; }
      const release = admission.reserveStream();
      if (!release) { fail(res, 503, 'Stream capacity exceeded'); return; }
      entry!.stream = res;
      entry!.idle = Date.now() + limits.idleMs;
      clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(() => { entry!.transport.closeStandaloneSSEStream(); res.destroy(); },
        Math.max(1, Math.min(limits.streamMs, entry!.expires - Date.now(), deadline - Date.now())));
      res.once('close', () => { release(); if (entry!.stream === res) entry!.stream = undefined; });
      try { await entry!.transport.handleRequest(req, res); } catch { fail(res, 400, 'Invalid MCP stream'); }
      return;
    }
    if (req.headers['content-encoding'] || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
      fail(res, 415, 'Uncompressed application/json required'); return;
    }
    const principal = auth.principal.id;
    const smallBody = Number(req.headers['content-length'] ?? 0) > 0 && Number(req.headers['content-length']) <= 512;
    let usingControlRate = false;
    if (!admission.admit(`principal:${principal}`, 1) || !admission.admit(`credential:${binding}`, 1)) {
      if (!smallBody || !admission.admit(`control:principal:${principal}`, 1)
        || !admission.admit(`control:credential:${binding}`, 1)) { fail(res, 429, 'Message limit exceeded'); return; }
      usingControlRate = true;
    }
    const borrowingControl = bodyReaders >= limits.calls || (principalReaders.get(principal) ?? 0) >= limits.principalCalls;
    if (borrowingControl && (!smallBody || reservedControlReaders >= 4 || controlReaders.has(principal))) {
      fail(res, 503, 'Body admission capacity exceeded'); return;
    }
    const readerMap = borrowingControl ? controlReaders : principalReaders;
    readerMap.set(principal, (readerMap.get(principal) ?? 0) + 1);
    if (borrowingControl) reservedControlReaders++; else bodyReaders++;
    const bodyTimer = setTimeout(expire, Math.min(limits.bodyReadMs, Math.max(1, deadline - Date.now())));
    try { await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(new Error('Body read aborted'));
      abort.signal.addEventListener('abort', aborted, { once: true });
      parse(req, res, (error?: unknown) => { abort.signal.removeEventListener('abort', aborted); error ? reject(error) : resolve(); });
    }); }
    catch (error) { fail(res, (error as { status?: number }).status === 413 ? 413 : 400, 'Invalid JSON body'); return; }
    finally { clearTimeout(bodyTimer); if (borrowingControl) reservedControlReaders--; else bodyReaders--;
      const count = readerMap.get(principal)! - 1; if (count) readerMap.set(principal, count); else readerMap.delete(principal); }
    if (stopped) { fail(res, 503, 'Remote MCP is stopping'); return; }
    if (abort.signal.aborted || res.destroyed) return;
    if (entry && (entry.closed || Date.now() >= entry.expires || Date.now() >= entry.idle)) {
      await close(entry, 'expired'); fail(res, 404, 'Session not found'); return;
    }
    const messages: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
    if (!messages.length || messages.length > limits.batchMessages) { fail(res, 400, 'Invalid message batch'); return; }
    const parsed = messages.map((message) => JSONRPCMessageSchema.safeParse(message));
    if (parsed.some((value) => !value.success)) { fail(res, 400, 'Invalid JSON-RPC message'); return; }
    const rpc = parsed.map((value) => value.data!);
    const control = rpc.every((message) => 'method' in message && ['notifications/initialized', 'notifications/cancelled'].includes(message.method));
    if (usingControlRate && !control) { fail(res, 429, 'Message limit exceeded'); return; }
    if (borrowingControl && !control) { fail(res, 503, 'Reserved control admission required'); return; }
    const prefix = usingControlRate ? 'control:' : '';
    if (!admission.admit(`${prefix}principal:${auth.principal.id}`, messages.length - 1)
      || !admission.admit(`${prefix}credential:${binding}`, messages.length - 1)) { fail(res, 429, 'Message limit exceeded'); return; }
    if (rpc.some((message) => 'id' in message && (typeof message.id === 'string' ? Buffer.byteLength(message.id) > 128
      : !Number.isSafeInteger(message.id)))) { fail(res, 400, 'Invalid request ID'); return; }
    if (rpc.some((message) => 'method' in message && message.method === 'notifications/cancelled'
      && (typeof message.params?.requestId === 'string' ? Buffer.byteLength(message.params.requestId) > 128
        : !Number.isSafeInteger(message.params?.requestId)))) { fail(res, 400, 'Invalid cancellation ID'); return; }
    const initializing = !entry;
    if (initializing && (rpc.length !== 1 || !isInitializeRequest(rpc[0]))) { fail(res, 400, 'Initialize required'); return; }
    if (entry && rpc.some(isInitializeRequest)) { fail(res, 400, 'Session already initialized'); return; }
    if (entry && !entry.ready && !rpc.every((message) => 'method' in message && message.method === 'notifications/initialized')) {
      fail(res, 400, 'Initialization notification required'); return;
    }
    if (rpc.some((message) => 'method' in message && !['initialize', 'notifications/initialized', 'notifications/cancelled',
      'ping', 'tools/list', 'tools/call'].includes(message.method))) { fail(res, 400, 'Unsupported MCP message'); return; }
    if (initializing) {
      const release = admission.reserve(auth.principal.id);
      if (!release) { fail(res, 503, 'Session capacity exceeded'); return; }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
        onsessioninitialized: (sessionId) => { if (entry!.closed || abort.signal.aborted) throw new Error('Initialization expired');
          entry!.id = sessionId; sessions.set(sessionId, entry!); pending.delete(entry!); },
        onsessionclosed: () => { void close(entry!, 'sdk_closed'); } });
      let server: ReturnType<typeof buildMcpServer>;
      try { server = buildMcpServer({ ...deps, logger: { error: () => event('service_error') },
        principal: auth.principal, allowedSource: auth.allowedSource, readBudgetBytes: limits.outputBytes, executionGuard: guard }); }
      catch { release(); await transport.close(); fail(res, 500, 'Initialization failed'); return; }
      entry = { binding, principal: auth.principal.id, expires: Math.min(Date.now() + limits.lifetimeMs,
        auth.expiresAt?.getTime() ?? Infinity), idle: Date.now() + limits.idleMs, ready: false,
        initializationDeadline: Date.now() + limits.initializeMs, closed: false, release, server, transport,
        contexts: new Set(), ids: new Set(), protocol: 'params' in rpc[0]
          && typeof rpc[0].params?.protocolVersion === 'string'
          && SUPPORTED_PROTOCOL_VERSIONS.includes(rpc[0].params.protocolVersion)
          ? rpc[0].params.protocolVersion : LATEST_PROTOCOL_VERSION };
      pending.add(entry);
      try { await server.connect(transport); } catch { await close(entry, 'connect_failed'); fail(res, 500, 'Initialization failed'); return; }
      if (stopped || abort.signal.aborted) { await close(entry, 'stopping'); fail(res, 503, 'Remote MCP is stopping'); return; }
      const sdkClose = transport.onclose;
      transport.onclose = () => { sdkClose?.(); void close(entry!, 'sdk_closed'); };
      event('initialize', entry);
    }
    const selected = entry!;
    const context: Context = { deadline, abort, calls: new Map() };
    const claimed: Array<string | number> = [];
    for (const message of rpc) {
      if (!('id' in message) || message.id === undefined) continue;
      if (selected.ids.has(message.id)) { for (const requestId of claimed) selected.ids.delete(requestId);
        for (const call of context.calls.values()) call.release(); fail(res, 409, 'Request ID already active'); return; }
      selected.ids.add(message.id); claimed.push(message.id);
      if ('method' in message && message.method === 'tools/call') {
        const release = admission.reserveCall(auth.principal.id);
        if (!release) { for (const requestId of claimed) selected.ids.delete(requestId);
          for (const call of context.calls.values()) call.release(); fail(res, 503, 'Execution capacity exceeded'); return; }
        context.calls.set(message.id, { release, started: false, done: false });
      }
    }
    selected.contexts.add(context);
    selected.idle = Date.now() + limits.idleMs;
    const authInfo: AuthInfo = { token: binding, clientId: auth.principal.id, scopes: [],
      expiresAt: Math.floor(deadline / 1000) };
    contexts.set(authInfo, context);
    const authenticatedRequest = req as express.Request & { auth?: AuthInfo }; authenticatedRequest.auth = authInfo;
    // Bound both SDK serialization and Node's queued response bytes. Slow clients lose their session.
    const send = selected.transport.send.bind(selected.transport);
    if (initializing) selected.transport.send = async (message, options) => {
      if (Buffer.byteLength(JSON.stringify(message)) > limits.outputBytes) { void close(selected, 'output_limit'); throw new Error('Response limit exceeded'); }
      return send(message, options);
    };
    const originalWrite = res.write.bind(res);
    let bytes = 0;
    res.write = ((chunk: unknown, ...args: unknown[]) => {
      bytes += Buffer.byteLength(typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk : '');
      if (bytes > limits.outputBytes || res.writableLength > limits.outputBytes) { void close(selected, 'output_limit'); res.destroy(); return false; }
      return Reflect.apply(originalWrite, res, [chunk, ...args]);
    }) as typeof res.write;
    res.once('close', () => {
      selected.contexts.delete(context);
      for (const requestId of claimed) selected.ids.delete(requestId);
      for (const call of context.calls.values()) if (!call.started) call.release();
      if (!res.writableFinished) void close(selected, 'disconnect');
    });
    abort.signal.addEventListener('abort', () => {
      for (const call of context.calls.values()) if (call.started && !call.done) call.release.markUnsettled();
      if (!res.writableFinished) { event('deadline', selected); void close(selected, 'deadline'); }
    }, { once: true });
    if (rpc.some((message) => 'method' in message && message.method === 'notifications/initialized')) selected.ready = true;
    if (protocol) selected.protocol ??= protocol;
    try { await selected.transport.handleRequest(authenticatedRequest, res, req.body); }
    catch { fail(res, 400, 'Invalid MCP request'); if (initializing) await close(selected, 'initialize_failed'); }
    if (initializing && (res.statusCode >= 400 || !selected.id)) await close(selected, 'initialize_failed');
  });
  return { router, isHealthy: () => !stopped && admission.isHealthy(),
    async stop(reason: string) { stopped = true; clearInterval(timer);
      for (const [response, abort] of requests) { abort.abort(); response.destroy(); }
      await Promise.all([...new Set([...sessions.values(), ...pending])].map((entry) => close(entry, 'shutdown')));
      await Promise.allSettled([...executing]); admission.clear();
    } };
}
