import { describe, expect, it } from 'vitest';
import { computeExpiry } from './expiry.js';

describe('computeExpiry', () => {
  const NOW = new Date('2026-01-01T00:00:00Z');

  it('returns null for decisions and playbooks', () => {
    expect(computeExpiry('decision', 'team', NOW)).toBeNull();
    expect(computeExpiry('playbook', 'project', NOW)).toBeNull();
  });

  it('returns 90 days for facts', () => {
    const exp = computeExpiry('fact', 'org', NOW)!;
    expect(exp.getTime() - NOW.getTime()).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it('returns 180 days for relationships', () => {
    const exp = computeExpiry('relationship', 'org', NOW)!;
    expect(exp.getTime() - NOW.getTime()).toBe(180 * 24 * 60 * 60 * 1000);
  });

  it('returns 14 days for user-scope context, 60 days otherwise', () => {
    const userExp = computeExpiry('context', 'user', NOW)!;
    const teamExp = computeExpiry('context', 'team', NOW)!;
    expect(userExp.getTime() - NOW.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
    expect(teamExp.getTime() - NOW.getTime()).toBe(60 * 24 * 60 * 60 * 1000);
  });
});
