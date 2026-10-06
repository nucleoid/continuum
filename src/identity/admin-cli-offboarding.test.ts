import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('admin CLI offboarding orchestration', () => {
  it('loops confirmed execution to completion unless --once is requested', async () => {
    const source = await readFile(new URL('./admin-cli.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/const once = args\.includes\('--once'\)/);
    expect(source).toMatch(/while \(!dryRun && !once && !result\.complete\)/);
    expect(source).toMatch(/confirmationScopeId, batchSize/);
  });

  it('exposes durable incomplete-run listing', async () => {
    const source = await readFile(new URL('./admin-cli.ts', import.meta.url), 'utf8');
    expect(source).toContain("operation === 'list-incomplete-offboarding'");
    expect(source).toContain('await listIncompleteOffboardingRuns(pool, actor)');
  });
});
