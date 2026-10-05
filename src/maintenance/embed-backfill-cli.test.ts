import { describe, expect, it } from 'vitest';
import { parseEmbedBackfillCliOptions } from './embed-backfill-cli.js';

describe('parseEmbedBackfillCliOptions', () => {
  it('parses bounded operational controls', () => {
    expect(parseEmbedBackfillCliOptions([
      '--dry-run', '--batch-size', '8', '--max-rows', '50',
      '--provider', 'ollama:model', '--cursor', '00000000-0000-4000-8000-000000000012',
      '--scope', 'team:security', '--max-errors', '4',
    ])).toEqual({
      dryRun: true, countOnly: false, batchSize: 8, maxRows: 50,
      providerId: 'ollama:model', cursor: '00000000-0000-4000-8000-000000000012',
      scope: { kind: 'team', name: 'security' }, maxErrors: 4, retryFailures: false,
    });
    expect(parseEmbedBackfillCliOptions([
      '--provider', 'ollama:model', '--retry-failures',
    ])).toMatchObject({ providerId: 'ollama:model', retryFailures: true });
  });

  it('rejects conflicting preview modes, malformed values, and ambiguous cursors', () => {
    expect(() => parseEmbedBackfillCliOptions(['--dry-run', '--count'])).toThrow(/mutually exclusive/i);
    expect(() => parseEmbedBackfillCliOptions(['--batch-size', '0'])).toThrow(/batch-size/i);
    expect(() => parseEmbedBackfillCliOptions(['--scope', 'team:'])).toThrow(/scope/i);
    expect(() => parseEmbedBackfillCliOptions([
      '--cursor', '00000000-0000-4000-8000-000000000012',
    ])).toThrow(/provider/i);
    expect(() => parseEmbedBackfillCliOptions(['--retry-failures'])).toThrow(/provider/i);
    expect(() => parseEmbedBackfillCliOptions([
      '--provider', 'ollama:model', '--retry-failures', '--dry-run',
    ])).toThrow(/cannot be used/i);
  });
});
