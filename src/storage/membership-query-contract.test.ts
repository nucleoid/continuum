import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const authorizationSources = [
  '../storage/supersede.ts',
  '../storage/memory-reads.ts',
  '../storage/review-queue.ts',
  '../maintenance/audit-retention.ts',
] as const;

describe('membership authorization query contract', () => {
  it.each(authorizationSources)('%s keeps active in every membership read', (relativePath) => {
    const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
    const reads = [...source.matchAll(/(?:FROM|JOIN) scope_memberships\s+(\w+)/g)];
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      const alias = read[1];
      const queryTail = source.slice(read.index, read.index + 700);
      expect(queryTail, `${relativePath} membership read for ${alias} must require active`)
        .toMatch(new RegExp(`\\b${alias}\\.active\\b`));
    }
  });
});
