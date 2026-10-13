import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

export interface McpHttpLimits {
  bodyBytes: number; sessions: number; principalSessions: number; initializeMs: number;
  idleMs: number; lifetimeMs: number; streams: number; principalCalls: number; calls: number;
  requestMs: number; streamMs: number; messageRate: number; messageBurst: number;
  peerRate: number; peerBurst: number; peers: number; outputBytes: number;
  buckets: number; batchMessages: number; proxyRate: number; proxyBurst: number; bodyReadMs: number; authentications: number; proxyInitializeRate: number; proxyInitializeBurst: number; unsettledGraceMs: number; cancelledIds: number;
}
export interface McpHttpConfig {
  publicUrl: URL;
  authority: string;
  loopbackDev: boolean;
  allowedOrigins: readonly string[];
  trustedProxy: BlockList;
  limits: McpHttpLimits;
}
export const DEFAULT_MCP_HTTP_LIMITS: Readonly<McpHttpLimits> = Object.freeze({
  bodyBytes: 1048576, sessions: 100, principalSessions: 5, initializeMs: 5000,
  idleMs: 600000, lifetimeMs: 3600000, streams: 100, principalCalls: 4, calls: 20,
  requestMs: 30000, streamMs: 30000, messageRate: 120, messageBurst: 20,
  peerRate: 60, peerBurst: 10, peers: 1000, outputBytes: 1048576,
  buckets: 2000, batchMessages: 20, proxyRate: 6000, proxyBurst: 1000, bodyReadMs: 5000, authentications: 100, proxyInitializeRate: 6, proxyInitializeBurst: 2, unsettledGraceMs: 5000, cancelledIds: 100,
});
export const MAX_MCP_HTTP_LIMITS: Readonly<McpHttpLimits> = Object.freeze({
  bodyBytes: 16777216, sessions: 10000, principalSessions: 100, initializeMs: 30000,
  idleMs: 3600000, lifetimeMs: 86400000, streams: 10000, principalCalls: 100, calls: 1000,
  requestMs: 300000, streamMs: 300000, messageRate: 10000, messageBurst: 1000,
  peerRate: 10000, peerBurst: 1000, peers: 100000, outputBytes: 16777216,
  buckets: 100000, batchMessages: 20, proxyRate: 60000, proxyBurst: 10000, bodyReadMs: 30000, authentications: 1000, proxyInitializeRate: 60, proxyInitializeBurst: 20, unsettledGraceMs: 60000, cancelledIds: 10000,
});

function enabled(value: string | undefined, name: string): boolean {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be true or false`);
}
const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');
function addressAllowed(list: BlockList, address: string | undefined): boolean {
  if (!address) return false;
  const family = isIP(address);
  return family !== 0 && list.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
function loopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || addressAllowed(loopback, hostname.replace(/^\[|\]$/g, ''));
}
function strictUrl(value: string | undefined, name: string): URL {
  if (!value || value.length > 2048 || value.trim() !== value || /[\s\\?#]/.test(value)) throw new Error(`${name} must be an explicit URL without credentials, query or fragment`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a valid URL`); }
  if (url.username || url.password || !url.host) throw new Error(`${name} must not contain credentials`);
  return url;
}
function commaList(value: string | undefined, name: string): string[] {
  if (!value) return [];
  const values = value.split(',').map((item) => item.trim());
  if (values.length > 100 || values.some((item) => !item)) throw new Error(`${name} must contain at most 100 nonempty entries`);
  return [...new Set(values)];
}
export function mcpHttpConfigFromEnv(env: NodeJS.ProcessEnv, authMode: string): McpHttpConfig | undefined {
  if (!enabled(env.CONTINUUM_MCP_HTTP_ENABLED, 'CONTINUUM_MCP_HTTP_ENABLED')) return undefined;
  const loopbackDev = enabled(env.CONTINUUM_MCP_HTTP_LOOPBACK_DEV, 'CONTINUUM_MCP_HTTP_LOOPBACK_DEV');
  const publicUrl = strictUrl(env.CONTINUUM_MCP_PUBLIC_URL, 'CONTINUUM_MCP_PUBLIC_URL');
  if (publicUrl.pathname !== '/mcp') throw new Error('CONTINUUM_MCP_PUBLIC_URL must use the /mcp path');
  if (loopbackDev) {
    if (publicUrl.protocol !== 'http:' || !loopbackHostname(publicUrl.hostname) || !['dev', 'entra'].includes(authMode)) throw new Error('Loopback MCP development requires an HTTP loopback URL and configured authentication');
  } else if (publicUrl.protocol !== 'https:' || authMode !== 'entra') {
    throw new Error('Remote MCP requires HTTPS and entra authentication');
  }
  const allowedOrigins = commaList(env.CONTINUUM_MCP_ALLOWED_ORIGINS, 'CONTINUUM_MCP_ALLOWED_ORIGINS');
  for (const origin of allowedOrigins) {
    const url = strictUrl(origin, 'CONTINUUM_MCP_ALLOWED_ORIGINS');
    if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('MCP allowed origins must be exact HTTPS origins');
  }
  const trustedProxy = new BlockList();
  const entries = commaList(env.CONTINUUM_MCP_TRUSTED_PROXY_CIDRS, 'CONTINUUM_MCP_TRUSTED_PROXY_CIDRS');
  if (!loopbackDev && entries.length === 0) throw new Error('Remote MCP requires explicit trusted proxy IP addresses or CIDRs');
  for (const entry of entries) {
    const parts = entry.split('/');
    const family = isIP(parts[0]);
    if (!family || parts.length > 2 || (parts.length === 2 && (!/^\d{1,3}$/.test(parts[1]) || Number(parts[1]) > (family === 4 ? 32 : 128)))) throw new Error('MCP trusted proxy entries must be valid IP addresses or CIDRs');
    if (parts.length === 1) trustedProxy.addAddress(parts[0], family === 4 ? 'ipv4' : 'ipv6');
    else trustedProxy.addSubnet(parts[0], Number(parts[1]), family === 4 ? 'ipv4' : 'ipv6');
  }
  const limits: McpHttpLimits = { ...DEFAULT_MCP_HTTP_LIMITS };
  for (const key of Object.keys(limits) as (keyof McpHttpLimits)[]) {
    const name = `CONTINUUM_MCP_HTTP_${key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
    const raw = env[name];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > MAX_MCP_HTTP_LIMITS[key]) throw new Error(`${name} must be an integer from 1 through ${MAX_MCP_HTTP_LIMITS[key]}`);
    limits[key] = value;
  }
  if (limits.principalSessions > limits.sessions || limits.principalCalls > limits.calls || limits.idleMs > limits.lifetimeMs) throw new Error('MCP principal and idle limits must not exceed their global or lifetime limits');
  return { publicUrl, authority: publicUrl.host, loopbackDev, allowedOrigins, trustedProxy, limits };
}

const sensitive = new Set(['host', 'authorization', 'origin', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'content-type', 'content-length', 'transfer-encoding', 'content-encoding', 'accept']);
function headerLimit(name: string): number {
  if (name === 'authorization') return 16384;
  if (['mcp-session-id', 'mcp-protocol-version', 'last-event-id'].includes(name)) return 128;
  if (name === 'host') return 256;
  if (name === 'origin') return 2048;
  return 4096;
}
/** Runs before authentication and JSON parsing; callers return only a fixed safe error. */
export function validateMcpHttpRequest(req: Pick<IncomingMessage, 'headers' | 'rawHeaders' | 'url' | 'socket'>, config: McpHttpConfig): boolean {
  if (!req.url || req.url.includes('?') || req.url.includes('#')) return false;
  const seen = new Set<string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    const value = req.rawHeaders[i + 1];
    if (typeof value !== 'string' || Buffer.byteLength(value) > headerLimit(name) || /[\x00-\x1f\x7f]/.test(value)) return false;
    if (sensitive.has(name) && seen.has(name)) return false;
    seen.add(name);
  }
  for (const name of sensitive) {
    const value = req.headers[name];
    if (value !== undefined && (typeof value !== 'string' || Buffer.byteLength(value) > headerLimit(name) || /[\x00-\x1f\x7f]/.test(value))) return false;
  }
  const host = req.headers.host;
  if (!host || host.toLowerCase() !== config.authority) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && !config.allowedOrigins.includes(origin)) return false;
  if (req.headers['last-event-id']) return false;
  if (config.loopbackDev) return addressAllowed(loopback, req.socket.remoteAddress);
  return isTrustedMcpProxyPeer(req, config) && req.headers['x-forwarded-proto'] === 'https';
}

/** Proxy aggregation uses only the direct socket peer; forwarded client addresses are untrusted. */
export function isTrustedMcpProxyPeer(req: Pick<IncomingMessage, 'socket'>, config: McpHttpConfig): boolean {
  return !config.loopbackDev && addressAllowed(config.trustedProxy, req.socket.remoteAddress);
}
