import { describe, expect, it } from 'vitest';
import { McpHttpSessions } from './mcp-http-sessions.js';
const limits = { sessions: 2, principalSessions: 1, calls: 1, principalCalls: 1,
  idleMs: 100, lifetimeMs: 500, messageRate: 120, messageBurst: 20, buckets: 10,
  peerRate: 60, peerBurst: 10, peers: 10, streams: 2 };
describe('remote MCP admission', () => {
  it('reserves pending capacity synchronously and releases once', () => {
    const sessions = new McpHttpSessions(limits, () => 0);
    const release = sessions.reserve('a');
    expect(release).toBeTypeOf('function');
    expect(sessions.reserve('a')).toBeUndefined();
    release!(); release!();
    expect(sessions.reserve('a')).toBeTypeOf('function');
  });
  it('retains execution capacity after session deletion until actual settlement', () => {
    const sessions = new McpHttpSessions(limits, () => 0);
    const release = sessions.reserveCall('a');
    expect(sessions.reserveCall('a')).toBeUndefined();
    sessions.clear();
    expect(sessions.reserveCall('b')).toBeUndefined();
    release!();
    expect(sessions.reserveCall('b')).toBeTypeOf('function');
  });
  it('binds exact credentials with canonical service-key schemes', () => {
    const sessions = new McpHttpSessions(limits, () => 0);
    const auth = { principal: { id: 'a', kind: 'service' }, credential: 'api-key' };
    expect(sessions.binding(auth, 'key')).toBe(sessions.binding(auth, 'key'));
    expect(sessions.binding(auth, 'key')).not.toBe(sessions.binding(auth, 'other'));
    expect(sessions.binding(auth, 'key')).not.toContain('key');
  });
  it('bounds bucket cardinality without evicting active rate limits', () => {
    const sessions = new McpHttpSessions({ ...limits, buckets: 1 }, () => 0);
    expect(sessions.admit('a', 20)).toBe(true);
    expect(sessions.admit('a', 1)).toBe(false);
    expect(sessions.admit('b', 1)).toBe(false);
  });
});
