import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('PR 13 exact-head trust-boundary review', () => {
  it('ships a forward-only migration for the rejected exact head', async () => {
    const migration = await readFile(
      join(root, 'migrations/0045_offboarding_trust_boundary.sql'), 'utf8',
    );
    expect(migration).toMatch(/continuum_audit_retention_policy/i);
    expect(migration).toMatch(/server-generated request identity/i);
    expect(migration).toMatch(/REVOKE[\s\S]+continuum_write_offboarding_run_internal/i);
    expect(migration).toMatch(/continuum_create_user_scope_approval/i);
    expect(migration).toMatch(/continuum_upsert_entra_group_binding/i);
  });

  it('does not grant the application role direct approval minting or internal progress', async () => {
    const grants = await readFile(join(root, 'scripts/grant-application-role.sql'), 'utf8');
    expect(grants).toMatch(
      /GRANT SELECT ON TABLE[\s\S]*principal_user_scope_approvals/i,
    );
    expect(grants).toMatch(
      /REVOKE ALL ON FUNCTION[\s\S]*continuum_write_offboarding_run_internal/i,
    );
    expect(grants).toMatch(/continuum_create_user_scope_approval/i);
  });

  it('does not derive erasure targets from request-id equality', async () => {
    const service = await readFile(join(root, 'src/services/offboarding.ts'), 'utf8');
    expect(service).not.toMatch(/principal_offboarding_audit_requests/);
    expect(service).not.toMatch(/offboardingLinkedAuditSql/);
    expect(service).not.toMatch(/'linked_request'/);
  });

  it('always mints the linking request identity and retains inbound identity only as metadata', async () => {
    const server = await readFile(join(root, 'src/api/server.ts'), 'utf8');
    expect(server).toMatch(/clientRequestId/);
    expect(server).not.toMatch(/req\.requestId\s*=\s*inbound/);
  });

  it('documents the 0048 maintenance rollout and constrained rollback without mixed versions', async () => {
    const docs = await readFile(join(root, 'docs/offboarding.md'), 'utf8');
    expect(docs).toMatch(/0045_offboarding_trust_boundary\.sql/);
    expect(docs).toMatch(/0046_offboarding_authority_remediation\.sql/);
    expect(docs).toMatch(/0047_offboarding_role_boundary\.sql/);
    expect(docs).toMatch(/0048_offboarding_independent_review\.sql/);
    expect(docs).toMatch(/stop[\s\S]*migrate[\s\S]*regrant[\s\S]*start/i);
    expect(docs).toMatch(/rollback is forward-only[\s\S]*0051-aware binary/i);
    expect(docs).not.toMatch(/old application tolerates/i);
  });
});
