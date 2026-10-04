import { describe, expect, it } from 'vitest';
import { parseEmbedBackfillCliOptions } from './embed-backfill-cli.js';

describe('parseEmbedBackfillCliOptions', () => {
  it('parses bounded operational controls', () => {
    expect(parseEmbedBackfillCliOptions([
      '--dry-run', '--batch-size', '8', '--max-rows', '50',
      '--provider', 'ollama:model', '--cursor', '00000000-0000-4000-8000-000000000012',
      '--scope', 'team:security', '--max-retries', '3', '--retry-base-ms', '20',
      '--max-errors', '4',
    ])).toEqual({
      dryRun: true, countOnly: false, batchSize: 8, maxRows: 50,
      providerId: 'ollama:model', cursor: '00000000-0000-4000-8000-000000000012',
      scope: { kind: 'team', name: 'security' }, maxRetries: 3,
      retryBaseMs: 20, maxErrors: 4,
    });
  });

  it('rejects conflicting preview modes, malformed values, and ambiguous cursors', () => {
    expect(() => parseEmbedBackfillCliOptions(['--dry-run', '--count'])).toThrow(/mutually exclusive/i);
    expect(() => parseEmbedBackfillCliOptions(['--batch-size', '0'])).toThrow(/batch-size/i);
    expect(() => parseEmbedBackfillCliOptions(['--scope', 'team:'])).toThrow(/scope/i);
    expect(() => parseEmbedBackfillCliOptions([
      '--cursor', '00000000-0000-4000-8000-000000000012',
    ])).toThrow(/provider/i);
  });
});
