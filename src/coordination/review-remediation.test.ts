import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateResourceKey } from './model.js';

const root = process.cwd();

async function source(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8');
}

describe('coordination review remediation contract', () => {
  it('grants the application role exactly the coordination table privileges it needs', async () => {
    const grants = await source('scripts/grant-application-role.sql');
    expect(grants).toMatch(/SELECT, INSERT, UPDATE, DELETE[\s\S]+coordination_operation_receipts/i);
    expect(grants).toMatch(/SELECT, INSERT, UPDATE[\s\S]+coordination_resources/i);
    expect(grants).toMatch(/SELECT, INSERT, UPDATE[\s\S]+coordination_leases/i);
    expect(grants).toMatch(/SELECT, INSERT, UPDATE[\s\S]+coordination_scope_usage/i);
    expect(grants).toMatch(/SELECT, INSERT, UPDATE[\s\S]+coordination_principal_usage/i);
  });

  it('ships a forward migration for grants, indexes, operator maintenance, and offboarding', async () => {
    const migration = await source('migrations/0055_coordination_review_remediation.sql');
    expect(migration).toContain('coordination_resources_current_lease_idx');
    expect(migration).toContain('coordination_leases_principal_terminal_idx');
    expect(migration).toMatch(/continuum_assert_application_role_allowlist[\s\S]+coordination_resources/i);
    expect(migration).toMatch(/continuum_operator_reclaim_coordination_resource/i);
    expect(migration).toMatch(/continuum_operator_set_coordination_scope_quota/i);
    expect(migration).toMatch(/continuum_offboarding_expected_audit_metadata[\s\S]+lock_acquire/i);
    expect(migration).toMatch(/continuum_operator_pseudonymize_scope[\s\S]+coordination_operation_receipts/i);
  });

  it('keeps mutation receipts in a quota class independent from acquire saturation', async () => {
    const migration = await source('migrations/0054_coordination_leases.sql');
    const storage = await source('src/storage/coordination.ts');
    expect(migration).toMatch(/acquire_receipt_count/i);
    expect(migration).toMatch(/mutation_receipt_count/i);
    expect(storage).toMatch(/operation === 'acquire'[\s\S]+acquire_receipt_count/i);
    expect(storage).toMatch(/mutation_receipt_count/i);
  });

  it('serializes idempotency keys and removes an exact expired receipt before reuse', async () => {
    const storage = await source('src/storage/coordination.ts');
    expect(storage).toMatch(/pg_advisory_xact_lock/i);
    expect(storage).toMatch(/retain_until <= clock_timestamp\(\)[\s\S]+request_id = \$3/i);
  });

  it('lets service validation own malformed MCP inputs', async () => {
    const mcp = await source('src/api/mcp.ts');
    const coordination = mcp.slice(
      mcp.indexOf("'continuum.lock_acquire'"),
      mcp.indexOf("'continuum.list_scopes'"),
    );
    expect(coordination).not.toMatch(/z\.string\(\)\.uuid\(\)/);
    expect(coordination).not.toMatch(/z\.number\(\)\.int\(\)\.min\(30\)\.max\(900\)/);
  });

  it('uses a locale-independent database control-character contract', async () => {
    const migration = await source('migrations/0054_coordination_leases.sql');
    expect(migration).not.toContain('[[:cntrl:]]');
    expect(migration).toMatch(/chr\(1\).*chr\(31\).*chr\(127\).*chr\(159\)/s);
    expect(() => validateResourceKey('line\u2028separator')).not.toThrow();
    expect(() => validateResourceKey('paragraph\u2029separator')).not.toThrow();
    expect(() => validateResourceKey('bad\u0001key')).toThrowError(/control/i);
  });

  it('removes unused TypeScript audit-policy placeholders', async () => {
    const offboarding = await source('src/services/offboarding.ts');
    expect(offboarding).not.toMatch(/\{ operation: '(?:acquire|renew|release)', safeFields: \[\] \}/);
  });

  it('documents regrant, mixed-version, reclaim, rollback, and quota behavior', async () => {
    const docs = await source('docs/coordination.md');
    expect(docs).toMatch(/re-?run.+grant-application-role\.sql/is);
    expect(docs).toMatch(/mixed[- ]version/is);
    expect(docs).toMatch(/reclaim/is);
    expect(docs).toMatch(/rollback[\s\S]+re-enable/is);
    expect(docs).toMatch(/independent 10,000 retained renew\/release receipts/is);
  });
});
