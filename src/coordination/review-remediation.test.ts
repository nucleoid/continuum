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
    expect(grants).toMatch(/SELECT, INSERT, DELETE[\s\S]+coordination_operation_receipts/i);
    expect(grants).toMatch(/REVOKE UPDATE, TRUNCATE[\s\S]+coordination_operation_receipts/i);
    expect(grants).toMatch(/SELECT, INSERT, UPDATE[\s\S]+coordination_resources/i);
    expect(grants).toMatch(/SELECT, INSERT, UPDATE[\s\S]+coordination_leases/i);
    expect(grants).not.toMatch(/GRANT[\s\S]{0,80}UPDATE[\s\S]{0,160}coordination_scope_usage/i);
    expect(grants).not.toMatch(/GRANT[\s\S]{0,80}UPDATE[\s\S]{0,160}coordination_principal_usage/i);
    expect(grants).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE[\s\S]+coordination_scope_usage[\s\S]+coordination_principal_usage/i);
    expect(grants).toMatch(/continuum\.application_grant_schema/);
    expect(grants).not.toMatch(/schema_name TEXT := current_schema\(\)/);
  });

  it('ships a forward migration for grants, indexes, operator maintenance, and offboarding', async () => {
    const migration = await source('migrations/0055_coordination_review_remediation.sql')
      + await source('migrations/0056_coordination_final_remediation.sql')
      + await source('migrations/0057_coordination_privacy_race_remediation.sql');
    expect(migration).toContain('coordination_resources_current_lease_idx');
    expect(migration).toContain('coordination_leases_principal_terminal_idx');
    expect(migration).toMatch(/continuum_assert_application_role_allowlist[\s\S]+coordination_resources/i);
    expect(migration).toMatch(/continuum_operator_reclaim_coordination_resource/i);
    expect(migration).toMatch(/continuum_operator_set_coordination_scope_quota/i);
    expect(migration).toContain('coordination_receipts_resource_idx');
    expect(migration).toContain('coordination_scope_fencing_floors');
    expect(migration).toMatch(/DROP TABLE coordination_fencing_floors/i);
    expect(migration).toMatch(/continuum_operator_sweep_coordination_state/i);
    expect(migration).toMatch(/statement_timeout/);
    expect(migration).toMatch(/continuum_operator_pseudonymize_scope[\s\S]+coordination_operation_receipts/i);
  });

  it('excludes short-lived renew receipts from the release quota', async () => {
    const migration = await source('migrations/0056_coordination_final_remediation.sql')
      + await source('migrations/0057_coordination_privacy_race_remediation.sql');
    const storage = await source('src/storage/coordination.ts');
    expect(migration).toMatch(/operation = 'release'/i);
    expect(storage).toMatch(/input\.operation === 'renew'[\s\S]+make_interval/i);
    expect(storage).not.toMatch(/operation <> 'acquire'/i);
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
    expect(coordination).not.toMatch(/z\.string\(\)/);
    expect(coordination).toMatch(/z\.unknown\(\)/);
    expect(coordination).toMatch(/strictCoordinationInput/);
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
    expect(docs).toMatch(/renew receipts[\s\S]+100 retained/is);
    expect(docs).toMatch(/ever-created.+reclaim/is);
  });

  it('pins coordination migration bytes and requires the forward remediation', async () => {
    const migrator = await source('src/storage/migrator.ts');
    expect(migrator).toMatch(/0054_coordination_leases\.sql[\s\S]+[0-9a-f]{64}/);
    expect(migrator).toMatch(/0055_coordination_review_remediation\.sql[\s\S]+[0-9a-f]{64}/);
    expect(migrator).toMatch(/0056_coordination_final_remediation\.sql['"],\s*['"]0055_coordination_review_remediation\.sql/);
    expect(migrator).toMatch(/0057_coordination_privacy_race_remediation\.sql[\s\S]+0056_coordination_final_remediation\.sql/);
  });
});
