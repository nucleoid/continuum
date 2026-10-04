import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function fixture(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

describe('scope provisioning operator contract', () => {
  it('names the real audit evidence for every admin-only capability', () => {
    const runbook = fixture('../../docs/scope-provisioning.md');

    expect(runbook).not.toContain('promote_membership');
    expect(runbook).toContain("action='promote'");
    expect(runbook).toContain("metadata->>'operation' = 'create_scope'");
    expect(runbook).toContain("metadata->>'view' = 'audit'");
  });

  it('locks only membership rows while protecting the last org admin', () => {
    for (const script of [
      fixture('../../scripts/demote-org-admin.sql'),
      fixture('../../scripts/remove-org-admin.sql'),
    ]) {
      expect(script).toContain('FOR UPDATE OF sm');
      expect(script).not.toMatch(/FOR UPDATE\s*\n/);
    }
  });
});
