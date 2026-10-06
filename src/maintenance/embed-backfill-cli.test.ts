import { describe, expect, it } from 'vitest';
import { embedBackfillExitCode, parseEmbedBackfillCliOptions } from './embed-backfill-cli.js';

describe('parseEmbedBackfillCliOptions', () => {
  it('parses bounded operational controls', () => {
    expect(parseEmbedBackfillCliOptions([
      '--dry-run', '--batch-size', '8', '--max-rows', '50',
      '--provider', 'ollama:model', '--cursor', '00000000-0000-4000-8000-000000000012',
      '--scope', 'team:security', '--max-errors', '4', '--no-wrap',
    ])).toEqual({
      dryRun: true, countOnly: false, batchSize: 8, maxRows: 50,
      providerId: 'ollama:model', cursor: '00000000-0000-4000-8000-000000000012',
      scope: { kind: 'team', name: 'security' }, maxErrors: 4, retryFailures: false,
      noWrap: true,
    });
    expect(parseEmbedBackfillCliOptions([
      '--provider', 'ollama:model', '--retry-failures',
    ])).toMatchObject({ providerId: 'ollama:model', retryFailures: true });
    expect(parseEmbedBackfillCliOptions([
      '--provider', 'ollama:model', '--mark-failed', '00000000-0000-4000-8000-000000000013',
    ])).toMatchObject({
      providerId: 'ollama:model', markFailed: '00000000-0000-4000-8000-000000000013',
    });
  });

  it('rejects conflicting preview modes, malformed values, and ambiguous cursors', () => {
    expect(() => parseEmbedBackfillCliOptions(['--dry-run', '--count'])).toThrow(/mutually exclusive/i);
    expect(() => parseEmbedBackfillCliOptions(['--batch-size', '0'])).toThrow(/batch-size/i);
    expect(() => parseEmbedBackfillCliOptions(['--scope', 'team:'])).toThrow(/scope/i);
    expect(() => parseEmbedBackfillCliOptions([
      '--cursor', '00000000-0000-4000-8000-000000000012',
    ])).toThrow(/provider/i);
    expect(() => parseEmbedBackfillCliOptions(['--retry-failures'])).toThrow(/provider/i);
    expect(() => parseEmbedBackfillCliOptions(['--no-wrap'])).toThrow(/cursor/i);
    expect(() => parseEmbedBackfillCliOptions([
      '--mark-failed', '00000000-0000-4000-8000-000000000013',
    ])).toThrow(/provider/i);
    expect(() => parseEmbedBackfillCliOptions([
      '--provider', 'ollama:model', '--retry-failures', '--dry-run',
    ])).toThrow(/cannot be used/i);
  });

  it('returns nonzero after printing a partial report or preserved provider error', () => {
    const base = {
      scanned: 1, eligible: 1, embedded: 0, failed: 1, failuresCleared: 0,
      providers: 1, completed: true, cursor: null, dryRun: false, countOnly: false,
      providerReports: [], errorCodes: [],
    };
    expect(embedBackfillExitCode(base)).toBe(0);
    expect(embedBackfillExitCode({ ...base, completed: false })).toBe(1);
    expect(embedBackfillExitCode({ ...base, errorCodes: ['BACKFILL_ERROR_BUDGET'] })).toBe(1);
  });
});
