import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('admin CLI offboarding orchestration', () => {
  it('loops confirmed execution to completion unless --once is requested', async () => {
    const source = await readFile(new URL('./admin-cli.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/const once = args\.includes\('--once'\)/);
    expect(source).toMatch(
      /while \(!dryRun && !once && !result\.complete && !result\.blockedUntil && attempts < 100\)/,
    );
    expect(source).toContain('if (!result.progressed) break');
    expect(source).toMatch(/confirmationScopeId, batchSize, verificationTimeoutMs/);
    expect(source).toContain("args.indexOf('--verification-timeout-ms')");
  });

  it('exposes durable incomplete-run listing', async () => {
    const source = await readFile(new URL('./admin-cli.ts', import.meta.url), 'utf8');
    expect(source).toContain("operation === 'list-incomplete-offboarding'");
    expect(source).toContain('await listIncompleteOffboardingRuns(pool, actor)');
  });

  it('separates bounded coordination privacy repair from destructive offboarding', async () => {
    const source = await readFile(new URL('./admin-cli.ts', import.meta.url), 'utf8');
    expect(source).toContain("operation === 'list-coordination-privacy-repairs'");
    expect(source).toContain("operation === 'repair-coordination-privacy'");
    expect(source).toContain('await listCoordinationPrivacyRepairs(pool, actor');
    expect(source).toContain('await repairCoordinationPrivacy(pool, actor');
  });
});
