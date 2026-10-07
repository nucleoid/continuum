import { describe, expect, it } from 'vitest';
import {
  canonicalOperationHash,
  validateDecimalFencingToken,
  validateResourceKey,
  validateTtlSeconds,
} from './model.js';

describe('coordination model', () => {
  it('accepts exact opaque Unicode keys through 512 UTF-8 bytes', () => {
    expect(validateResourceKey('A/../a')).toBe('A/../a');
    expect(validateResourceKey('\u00e9')).toBe('\u00e9');
    expect(validateResourceKey('e\u0301')).toBe('e\u0301');
    expect(validateResourceKey('\ud83d\ude80'.repeat(128))).toHaveLength(256);
  });

  it.each([
    '',
    ' leading',
    'trailing\u00a0',
    'line\nfeed',
    'null\u0000byte',
    '\ud800',
    '\udc00',
    '\ud83d\ude80'.repeat(128) + 'x',
  ])('rejects malformed or out-of-contract resource %#', (resource) => {
    expect(() => validateResourceKey(resource)).toThrow();
  });

  it('applies and validates the exact TTL bounds', () => {
    expect(validateTtlSeconds(undefined)).toBe(300);
    expect(validateTtlSeconds(30)).toBe(30);
    expect(validateTtlSeconds(900)).toBe(900);
    expect(() => validateTtlSeconds(29)).toThrow();
    expect(() => validateTtlSeconds(901)).toThrow();
    expect(() => validateTtlSeconds(30.5)).toThrow();
  });

  it('keeps fencing tokens as canonical decimal strings', () => {
    expect(validateDecimalFencingToken('9223372036854775807')).toBe('9223372036854775807');
    expect(() => validateDecimalFencingToken('01')).toThrow();
    expect(() => validateDecimalFencingToken('9223372036854775808')).toThrow();
    expect(() => validateDecimalFencingToken(42 as never)).toThrow();
  });

  it('hashes a length-prefixed normalized semantic tuple deterministically', () => {
    const a = canonicalOperationHash('acquire', ['project:x', 'resource', 'run', '300']);
    const b = canonicalOperationHash('acquire', ['project:x', 'resource', 'run', '300']);
    const ambiguous = canonicalOperationHash('acquire', ['project:x', 'resourcer', 'un', '300']);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(ambiguous);
  });
});
