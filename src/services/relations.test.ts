import { describe, expect, it } from 'vitest';
import {
  classifyRelation,
  relationThresholdFromEnv,
  safeRelationProviderId,
  validateRelationThreshold,
} from './relations.js';

describe('capture relation classification', () => {
  it('classifies normalized exact title and body as a duplicate', () => {
    expect(classifyRelation(
      { type: 'fact', title: ' Deploy policy ', body: 'No Fridays.\r\n' },
      { type: 'fact', title: 'deploy POLICY', body: ' No   Fridays. ' },
    )).toBe('possible-duplicate');
  });

  it.each([
    ['fact', 'fact', 'possible-conflict'],
    ['decision', 'decision', 'possible-conflict'],
    ['fact', 'decision', 'possible-duplicate'],
    ['context', 'context', 'possible-duplicate'],
  ] as const)('classifies nonidentical %s/%s candidates as %s', (left, right, relation) => {
    expect(classifyRelation(
      { type: left, title: 'Policy', body: 'Deploy Fridays.' },
      { type: right, title: 'Policy', body: 'Never deploy Fridays.' },
    )).toBe(relation);
  });
});

describe('relation threshold configuration', () => {
  it('defaults to 0.92 and accepts an explicit bounded number', () => {
    expect(relationThresholdFromEnv({})).toBe(0.92);
    expect(validateRelationThreshold(0.95)).toBe(0.95);
    expect(relationThresholdFromEnv({ CONTINUUM_RELATION_THRESHOLD: '0.95' })).toBe(0.95);
  });

  it.each([NaN, -0.01, 1.01])('rejects invalid numeric threshold %s', (value) => {
    expect(() => validateRelationThreshold(value)).toThrow(/between 0 and 1/);
  });

  it.each(['', 'nope', '-1', '1.1'])('rejects invalid environment threshold %s', (value) => {
    expect(() => relationThresholdFromEnv({ CONTINUUM_RELATION_THRESHOLD: value }))
      .toThrow(/CONTINUUM_RELATION_THRESHOLD/);
  });
});

describe('relation metadata bounds', () => {
  it('preserves a bounded provider id and redacts unsafe or oversized values', () => {
    expect(safeRelationProviderId('ollama:nomic-embed-text')).toBe('ollama:nomic-embed-text');
    expect(safeRelationProviderId('provider secret=private-value')).toBe('configured');
    expect(safeRelationProviderId(`provider:${'x'.repeat(128)}`)).toBe('configured');
  });
});
