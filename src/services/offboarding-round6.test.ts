import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function text(path: string): Promise<string> {
  return readFile(join(ROOT, path), 'utf8');
}

describe('offboarding round-six safety contract', () => {
  it('keeps audit classification in the database rather than TypeScript placeholders', async () => {
    const offboarding = await text('src/services/offboarding.ts');
    const migration = await text('migrations/0055_coordination_review_remediation.sql');
    expect(offboarding).not.toContain('AUDIT_OPERATION_POLICIES');
    expect(offboarding).not.toContain('AUDIT_SOURCE_POLICIES');
    for (const operation of ['lock_acquire', 'lock_inspect', 'lock_release', 'lock_renew']) {
      expect(migration).toContain(`''${operation}''`);
    }
    expect(migration).toContain('continuum_offboarding_expected_audit_metadata');
    expect(migration).not.toMatch(/''resource_sha256''/);
    expect(offboarding).not.toMatch(/jsonb_typeof\(entry\.value\) IN \('number', 'boolean'\)/);
    expect(offboarding).not.toMatch(/item\.value !~\*/);
  });

  it('starts immutable authorization evidence before fences and completes it append-only', async () => {
    const service = await text('src/services/offboarding.ts');
    const migration = await text('migrations/0026_offboarding_round6_hardening.sql');
    const startedEvent = service.indexOf('await startOffboardingRunEvent(');
    expect(startedEvent).toBeGreaterThan(-1);
    expect(startedEvent).toBeLessThan(
      service.indexOf('continuum_operator_pseudonymize_scope'),
    );
    expect(startedEvent).toBeLessThan(
      service.indexOf('continuum_operator_offboard_scope_access'),
    );
    expect(startedEvent).toBeLessThan(service.indexOf("'set_fence'"));
    expect(service).toMatch(/phase[^\n]+started/i);
    expect(service).toMatch(/phase[^\n]+completed/i);
    expect(service).toMatch(/initiated_by[\s\S]+finalized_by/i);
    expect(service).not.toMatch(/SET initiated_by = \$2/);
    expect(migration).toMatch(/principal_offboarding_run_events[\s\S]+run_id[\s\S]+approval_evidence_hash/i);
    expect(migration).toMatch(/BEFORE UPDATE OR DELETE[\s\S]+offboarding run event evidence is immutable/i);
  });

  it('uses bounded online cleanup and cursor-shaped indexes', async () => {
    const cleanup = await text('migrations/0024_offboarding_embedding_cleanup.sql');
    const indexes = await text('migrations/0025_offboarding_audit_indexes.sql');
    expect(cleanup).not.toMatch(/^\s*DELETE\s+FROM/im);
    expect(cleanup).toMatch(/procedure|maintenance/i);
    expect(cleanup).toMatch(/LIMIT|batch/i);
    expect(indexes).toMatch(/audit_log\s*\(principal_id,\s*id\)/i);
    expect(indexes).toMatch(/audit_log\s*\(scope_id,\s*id\)/i);
    expect(indexes).toMatch(/audit_log\s*\(memory_id,\s*id\)/i);
    expect(indexes).toMatch(/metadata->>'request_id'[^\n]*,\s*id/i);
    expect(indexes).toMatch(/scope_ids[\s\S]+USING gin/i);
  });

  it('separates lock-free bounded preview from fenced execution and truthful finalization', async () => {
    const service = await text('src/services/offboarding.ts');
    expect(service).toMatch(/if \(dryRun\)[\s\S]{0,180}previewOffboarding/);
    expect(service.indexOf('if (dryRun)')).toBeLessThan(service.indexOf('pg_advisory_xact_lock'));
    expect(service).not.toContain('auditSelectionCounts(');
    expect(service).toMatch(/finalizeOffboardingRun/);
    expect(service).toMatch(/completed_at[\s\S]+principal_offboarding_run_events/);
    expect(service).not.toMatch(/const complete = !remaining\.memories[\s\S]+!remainingAudit;/);
  });

  it('database-enforces reactivation and documents rollback safety', async () => {
    const migration = await text('migrations/0026_offboarding_round6_hardening.sql');
    const principalAdmin = await text('src/services/principal-admin.ts');
    const docs = await text('docs/offboarding.md');
    expect(migration).toMatch(/disabled_at[\s\S]+completed_at IS NULL/i);
    expect(migration).toMatch(/reactivation.*same transaction|reactivation guard/i);
    expect(principalAdmin).toMatch(/continuum_operator_reactivate_principal/);
    expect(docs).toMatch(/zero incomplete.*run/i);
    expect(docs).toMatch(/rollback/i);
  });
});
