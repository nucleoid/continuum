import { describe, expect, it } from 'vitest';
import { parseScopeString, scopeToString, sortScopesForRead } from './model.js';

describe('scope model', () => {
  it('parses org', () => {
    expect(parseScopeString('org')).toEqual({ kind: 'org', name: '' });
  });

  it('parses kinded scopes', () => {
    expect(parseScopeString('team:payments')).toEqual({
      kind: 'team',
      name: 'payments',
    });
    expect(parseScopeString('project:booking-engine')).toEqual({
      kind: 'project',
      name: 'booking-engine',
    });
  });

  it('rejects unknown kinds', () => {
    expect(() => parseScopeString('squad:x')).toThrow();
  });

  it('round-trips', () => {
    const cases = ['org', 'team:payments', 'user:abc', 'role:security'];
    for (const c of cases) {
      expect(scopeToString(parseScopeString(c))).toBe(c);
    }
  });

  it('orders scopes user-first for read', () => {
    const ordered = sortScopesForRead([
      { kind: 'org', name: '' },
      { kind: 'user', name: 'me' },
      { kind: 'team', name: 'payments' },
    ]);
    expect(ordered[0].kind).toBe('user');
    expect(ordered[ordered.length - 1].kind).toBe('org');
  });
});
