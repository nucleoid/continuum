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
    const next = sessions.reserveCall('b'); expect(next).toBeTypeOf('function'); next!();
  });
  it('distinguishes ordinary capacity from cancelled unsettled fences', () => {
    let now = 0;
    const sessions = new McpHttpSessions({ ...limits, unsettledGraceMs: 10 }, () => now);
    const release = sessions.reserveCall('a')!;
    expect(sessions.isHealthy()).toBe(true);
    release.markUnsettled(100); expect(sessions.isHealthy()).toBe(true);
    now = 109; expect(sessions.isHealthy()).toBe(true);
    now = 110; expect(sessions.isHealthy()).toBe(false);
    release(); expect(sessions.isHealthy()).toBe(true);
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

it('bounds retained SDK response bytes process-wide until explicit release', () => {
  const first = new McpHttpSessions({ ...limits, outputBytes: 10 });
  const second = new McpHttpSessions({ ...limits, outputBytes: 10 });
  const release = first.reserveResponse(7)!;
  expect(second.reserveResponse(4)).toBeUndefined(); first.clear();
  expect(second.reserveResponse(4)).toBeUndefined(); release(); release();
  const recovered = second.reserveResponse(10); expect(recovered).toBeTypeOf('function'); recovered!();
});
