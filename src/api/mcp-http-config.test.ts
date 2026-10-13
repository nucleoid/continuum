import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { mcpHttpConfigFromEnv, validateMcpHttpRequest } from './mcp-http-config.js';

const production = { CONTINUUM_MCP_HTTP_ENABLED: 'true', CONTINUUM_MCP_PUBLIC_URL: 'https://mcp.example:8443/mcp', CONTINUUM_MCP_TRUSTED_PROXY_CIDRS: '192.0.2.0/24,2001:db8::/32', CONTINUUM_MCP_ALLOWED_ORIGINS: 'https://client.example' };
function request(headers: Record<string, string> = {}, peer = '192.0.2.4', url = '/mcp'): IncomingMessage {
  const merged = { host: 'mcp.example:8443', 'x-forwarded-proto': 'https', ...headers };
  return { headers: merged, rawHeaders: Object.entries(merged).flat(), socket: { remoteAddress: peer }, url } as unknown as IncomingMessage;
}

describe('remote MCP configuration and request authority', () => {
  it('defaults disabled and ignores unused remote settings', () => {
    expect(mcpHttpConfigFromEnv({ CONTINUUM_MCP_PUBLIC_URL: 'bad' }, 'dev')).toBeUndefined();
    expect(mcpHttpConfigFromEnv({ CONTINUUM_MCP_HTTP_ENABLED: 'false' }, 'entra')).toBeUndefined();
  });
  it('requires explicit production authority and proxy trust', () => {
    const config = mcpHttpConfigFromEnv(production, 'entra')!;
    expect(config.authority).toBe('mcp.example:8443');
    expect(config.limits.bodyBytes).toBe(1048576);
    expect(config.limits.sessions).toBe(100);
    expect(() => mcpHttpConfigFromEnv(production, 'dev')).toThrow();
    expect(() => mcpHttpConfigFromEnv({ ...production, CONTINUUM_MCP_TRUSTED_PROXY_CIDRS: '' }, 'entra')).toThrow();
  });
  it.each(['http://mcp.example/mcp', 'https://u:p@mcp.example/mcp', 'https://mcp.example/mcp?q=secret', 'https://mcp.example/other', 'https://mcp.example/mcp#x'])('rejects invalid public URL %s', (url) => {
    expect(() => mcpHttpConfigFromEnv({ ...production, CONTINUUM_MCP_PUBLIC_URL: url }, 'entra')).toThrow();
  });
  it.each(['bad', '192.0.2.1/33', '2001:db8::/129', '192.0.2.0/24,', '192.0.2.0/24/1'])('rejects invalid trust entry %s', (cidr) => {
    expect(() => mcpHttpConfigFromEnv({ ...production, CONTINUUM_MCP_TRUSTED_PROXY_CIDRS: cidr }, 'entra')).toThrow();
  });
  it.each(['0', '-1', 'NaN', 'Infinity', '1e3', '1.5', '9007199254740991', '1000001'])('rejects invalid numeric override %s', (value) => {
    expect(() => mcpHttpConfigFromEnv({ ...production, CONTINUUM_MCP_HTTP_SESSIONS: value }, 'entra')).toThrow();
  });
  it('accepts trusted peers in both address families, including IPv4-mapped sockets', () => {
    const config = mcpHttpConfigFromEnv(production, 'entra')!;
    for (const peer of ['192.0.2.4', '::ffff:192.0.2.4', '2001:db8::1']) expect(validateMcpHttpRequest(request({}, peer), config)).toBe(true);
    expect(validateMcpHttpRequest(request({}, '198.51.100.1'), config)).toBe(false);
  });
  it('validates host and forwarding independently of spoofed caller forwarding', () => {
    const config = mcpHttpConfigFromEnv(production, 'entra')!;
    for (const headers of [{ host: 'evil.example', 'x-forwarded-host': 'mcp.example:8443' }, { host: 'mcp.example' }, { 'x-forwarded-proto': 'http' }, { 'x-forwarded-proto': 'https,http' }, { 'x-forwarded-proto': '' }]) expect(validateMcpHttpRequest(request(headers), config)).toBe(false);
  });
  it('allows absent Origin but fails closed on malformed, unrelated or duplicate origins', () => {
    const config = mcpHttpConfigFromEnv(production, 'entra')!;
    expect(validateMcpHttpRequest(request({ origin: 'https://client.example' }), config)).toBe(true);
    for (const origin of ['null', '', 'http://client.example', 'https://client.example/', 'https://evil.example', 'https://client.example,https://evil.example']) expect(validateMcpHttpRequest(request({ origin }), config)).toBe(false);
    const duplicate = request({ origin: 'https://client.example' });
    duplicate.rawHeaders.push('Origin', 'https://client.example');
    expect(validateMcpHttpRequest(duplicate, config)).toBe(false);
  });
  it('rejects duplicate sensitive headers and oversized values without inspecting credentials', () => {
    const config = mcpHttpConfigFromEnv(production, 'entra')!;
    for (const name of ['host', 'authorization', 'mcp-session-id', 'mcp-protocol-version', 'x-forwarded-proto', 'content-type', 'content-length', 'accept']) {
      const req = request({ [name]: name === 'host' ? 'mcp.example:8443' : 'x' });
      req.rawHeaders.push(name.toUpperCase(), req.headers[name] as string);
      expect(validateMcpHttpRequest(req, config)).toBe(false);
    }
    expect(validateMcpHttpRequest(request({ authorization: 'x'.repeat(16385) }), config)).toBe(false);
    expect(validateMcpHttpRequest(request({ 'mcp-session-id': 'x'.repeat(129) }), config)).toBe(false);
    expect(validateMcpHttpRequest(request({ 'mcp-protocol-version': 'x'.repeat(129) }), config)).toBe(false);
  });
  it('rejects any query and historical replay request', () => {
    const config = mcpHttpConfigFromEnv(production, 'entra')!;
    expect(validateMcpHttpRequest(request({}, undefined, '/mcp?'), config)).toBe(false);
    expect(validateMcpHttpRequest(request({ 'last-event-id': 'old' }), config)).toBe(false);
  });
  it('requires explicit loopback development and a real loopback socket', () => {
    const config = mcpHttpConfigFromEnv({ CONTINUUM_MCP_HTTP_ENABLED: 'true', CONTINUUM_MCP_HTTP_LOOPBACK_DEV: 'true', CONTINUUM_MCP_PUBLIC_URL: 'http://127.0.0.1:4000/mcp' }, 'dev')!;
    expect(validateMcpHttpRequest(request({ host: '127.0.0.1:4000' }, '127.0.0.1'), config)).toBe(true);
    expect(validateMcpHttpRequest(request({ host: '127.0.0.1:4000' }, '192.0.2.4'), config)).toBe(false);
    expect(() => mcpHttpConfigFromEnv({ ...production, CONTINUUM_MCP_HTTP_LOOPBACK_DEV: 'true' }, 'dev')).toThrow();
  });
});

it('checks every limit ceiling and preserves positive integer overrides', () => {
  const config = mcpHttpConfigFromEnv({ ...production, CONTINUUM_MCP_HTTP_BODY_BYTES: '2048', CONTINUUM_MCP_HTTP_SESSIONS: '5', CONTINUUM_MCP_HTTP_CALLS: '4' }, 'entra')!;
  expect(config.limits.bodyBytes).toBe(2048);
  expect(config.limits.sessions).toBe(5);
  for (const key of Object.keys(config.limits)) {
    const name = `CONTINUUM_MCP_HTTP_${key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
    expect(() => mcpHttpConfigFromEnv({ ...production, [name]: '1000000000' }, 'entra')).toThrow();
    expect(() => mcpHttpConfigFromEnv({ ...production, [name]: '0' }, 'entra')).toThrow();
  }
});
it.each(['null', 'http://client.example', 'https://client.example/', 'https://user@client.example', 'https://client.example?q=x', 'https://client.example,'])('fails startup for noncanonical origin %s', (origin) => {
  expect(() => mcpHttpConfigFromEnv({ ...production, CONTINUUM_MCP_ALLOWED_ORIGINS: origin }, 'entra')).toThrow();
});
it('validates explicit flags and loopback IPv6 without trusting forwarding', () => {
  expect(() => mcpHttpConfigFromEnv({ ...production, CONTINUUM_MCP_HTTP_ENABLED: 'yes' }, 'entra')).toThrow();
  expect(() => mcpHttpConfigFromEnv({ ...production, CONTINUUM_MCP_HTTP_LOOPBACK_DEV: 'yes' }, 'entra')).toThrow();
  const config = mcpHttpConfigFromEnv({ CONTINUUM_MCP_HTTP_ENABLED: 'true', CONTINUUM_MCP_HTTP_LOOPBACK_DEV: 'true', CONTINUUM_MCP_PUBLIC_URL: 'http://[::1]:4000/mcp' }, 'dev')!;
  expect(validateMcpHttpRequest(request({ host: '[::1]:4000' }, '::1'), config)).toBe(true);
  expect(validateMcpHttpRequest(request({ host: '[::1]:4000', 'x-forwarded-for': '::1' }, '192.0.2.4'), config)).toBe(false);
});
it('rejects array, control-character and overlong noncredential headers', () => {
  const config = mcpHttpConfigFromEnv(production, 'entra')!;
  const req = request();
  req.headers['mcp-session-id'] = ['a', 'b'];
  expect(validateMcpHttpRequest(req, config)).toBe(false);
  expect(validateMcpHttpRequest(request({ origin: 'x'.repeat(2049) }), config)).toBe(false);
  expect(validateMcpHttpRequest(request({ 'x-test': 'value\r\nInjected: value' }), config)).toBe(false);
});
