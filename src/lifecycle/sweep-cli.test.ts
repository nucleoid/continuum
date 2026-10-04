import { describe, expect, it } from 'vitest';
import { parseSweepCliOptions } from './sweep-cli.js';

describe('sweep CLI options', () => {
  it('uses defaults and allows explicit dry-run and batch overrides', () => {
    expect(parseSweepCliOptions([], {})).toEqual({ dryRun: false, batchSize: 100 });
    expect(parseSweepCliOptions(['--dry-run', '--batch-size', '7'], {
      CONTINUUM_LIFECYCLE_BATCH_SIZE: '3',
    })).toEqual({ dryRun: true, batchSize: 7 });
  });

  it.each([
    [['--unknown'], {}],
    [['--batch-size'], {}],
    [[], { CONTINUUM_LIFECYCLE_BATCH_SIZE: '0' }],
    [[], { CONTINUUM_LIFECYCLE_BATCH_SIZE: '1001' }],
    [[], { CONTINUUM_LIFECYCLE_BATCH_SIZE: '1.5' }],
  ] as const)('rejects invalid arguments or environment values', (args, env) => {
    expect(() => parseSweepCliOptions([...args], env)).toThrow();
  });
});
