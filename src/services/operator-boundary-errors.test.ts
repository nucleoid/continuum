import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Principal } from '../types.js';
import { runAuditRetention } from '../maintenance/audit-retention.js';
import {
  provisionEntraGroupBinding, revokeEntraGroupBinding,
} from './membership-sync.js';
import { listCoordinationPrivacyRepairPage, mapOwnedUserScope, offboardPrincipal, repairCoordinationPrivacy } from './offboarding.js';
import { disablePrincipal, reactivatePrincipal } from './principal-admin.js';
import { ServiceError } from './errors.js';

const ACTOR_ID = '10000000-0000-4000-8000-000000000001';
const TARGET_ID = '20000000-0000-4000-8000-000000000001';
const SCOPE_ID = '30000000-0000-4000-8000-000000000001';
const GROUP_ID = '40000000-0000-4000-8000-000000000001';
const ORG_SCOPE_ID = '60000000-0000-4000-8000-000000000001';

const actor: Principal = {
  id: ACTOR_ID,
  externalId: 'operator-boundary-admin',
  kind: 'user',
  displayName: 'Operator boundary admin',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

interface DatabaseFailure extends Error { code?: string }

function databaseFailure(message: string, code?: string): DatabaseFailure {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

function guardedPool(
  guardedCall: RegExp,
  failure: unknown,
  rollbackFailure?: unknown,
): {
  pool: pg.Pool;
  release: ReturnType<typeof vi.fn>;
  guardedCalls: () => number;
} {
  const release = vi.fn();
  let guardedCalls = 0;
  const client = {
    query: vi.fn(async (sql: string) => {
      if (/^ROLLBACK/.test(sql) && rollbackFailure !== undefined) throw rollbackFailure;
      if (sql.includes('applicationSchemaProvider')) {
        return { rowCount: 1, rows: [{
          owner: false, usage: true, create: false, functions: true,
          applicationSchemaProvider: false, applicationProfile: true, syncProfile: false,
        }] };
      }
      if (guardedCall.test(sql)) {
        guardedCalls += 1;
        throw failure;
      }
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return { rowCount: 1, rows: [{ locked: true }] };
      }
      if (sql.includes('AS dirty_memories') && sql.includes('AS entra_bindings')) {
        return { rowCount: 1, rows: [{ memories: 0, live_memories: 0, dirty_memories: 0,
          embeddings: 0, memberships: 1, aliases: 0, entra_bindings: 0 }] };
      }
      if (sql.includes('WITH examined AS MATERIALIZED')) {
        return { rowCount: 1, rows: [{ principal: 0, scope: 0, memory: 0, scope_ids: 0,
          total: 0, queries: 0, truncated: false }] };
      }
      if (sql.includes('FROM continuum_coordination_privacy_state')) {
        return { rowCount: 1, rows: [{ privacy_version: 3, principal_complete: true,
          scope_complete: false }] };
      }
      if (sql.includes('continuum_coordination_privacy_schema_ready')) {
        return { rowCount: 1, rows: [{ ready: true, owned_scope_ready: true }] };
      }
      if (/FROM scopes WHERE kind = \$1 AND name = \$2/.test(sql)) {
        return { rowCount: 1, rows: [{
          id: ORG_SCOPE_ID, kind: 'org', name: '', created_at: new Date('2026-01-01T00:00:00Z'),
        }] };
      }
      if (/FROM scope_memberships m JOIN principals p/.test(sql)) {
        return { rowCount: 1, rows: [{
          principal_id: ACTOR_ID, scope_id: ORG_SCOPE_ID, role: 'admin',
          added_at: new Date('2026-01-01T00:00:00Z'), source_kind: 'manual',
          source_id: 'manual', active: true,
        }] };
      }
      if (/audit_log_offboarding_backfill_state/.test(sql)) {
        return { rowCount: 1, rows: [{ completed: true }] };
      }
      if (/FROM principals WHERE id = \$1 AND kind = 'user'/.test(sql)) {
        return { rowCount: 1, rows: [{
          id: TARGET_ID, display_name: 'Target', disabled_at: new Date(),
          offboarded_at: null, reactivated_at: null,
        }] };
      }
      if (/FROM principal_user_scopes pus/.test(sql)) {
        return { rowCount: 1, rows: [{
          scope_id: SCOPE_ID, acknowledged_principal_ids: [],
          acknowledged_evidence_hash: createHash('sha256')
            .update(`${TARGET_ID}\n${SCOPE_ID}`, 'utf8').digest('hex'),
          approval_id: '1',
        }] };
      }
      if (/SELECT name FROM scopes WHERE id/.test(sql)) {
        return { rowCount: 1, rows: [{ name: 'owned' }] };
      }
      if (/role IN \('writer', 'admin'\)/.test(sql)) {
        return { rowCount: 1, rows: [{ '?column?': 1 }] };
      }
      if (/SELECT id FROM scopes WHERE id/.test(sql)) {
        return { rowCount: 1, rows: [{ id: SCOPE_ID }] };
      }
      if (/SELECT id FROM principals WHERE id/.test(sql)) {
        return { rowCount: 1, rows: [{ id: TARGET_ID }] };
      }
      if (/SELECT p.id[\s\S]*WHERE p.external_id/.test(sql)) {
        return { rowCount: 1, rows: [{ id: ACTOR_ID }] };
      }
      if (/SELECT count\(\*\)::int AS count FROM entra_groups/.test(sql)) {
        return { rowCount: 1, rows: [{ count: 0 }] };
      }
      if (/SELECT scope_id, role, active FROM entra_groups/.test(sql)
        || /SELECT 1 FROM entra_groups/.test(sql)
        || /FROM principal_user_scopes[\s\S]*FOR UPDATE/.test(sql)
        || /SELECT DISTINCT .* FROM (?:scope_memberships|memories)/s.test(sql)) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }),
    release,
  };
  return {
    pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool,
    release,
    guardedCalls: () => guardedCalls,
  };
}

const paths: Array<{
  name: string;
  guardedCall: RegExp;
  invoke: (pool: pg.Pool) => Promise<unknown>;
}> = [
  {
    name: 'owned-scope offboarding administration',
    guardedCall: /continuum_create_user_scope_approval/,
    invoke: (pool) => mapOwnedUserScope(pool, actor, TARGET_ID, SCOPE_ID),
  },
  {
    name: 'protected principal disable',
    guardedCall: /continuum_disable_principal/,
    invoke: (pool) => disablePrincipal(pool, actor, TARGET_ID),
  },
  {
    name: 'principal reactivation',
    guardedCall: /continuum_operator_reactivate_principal/,
    invoke: (pool) => reactivatePrincipal(pool, actor, TARGET_ID),
  },
  {
    name: 'principal offboarding',
    guardedCall: /continuum_operator_get_offboarding_run/,
    invoke: (pool) => offboardPrincipal(pool, actor, TARGET_ID, {
      confirmationScopeId: SCOPE_ID,
    }),
  },
  {
    name: 'audit retention',
    guardedCall: /continuum_operator_authorize_audit_retention/,
    invoke: (pool) => runAuditRetention(pool, {
      retentionDays: 30,
      principalExternalId: actor.externalId,
    }),
  },
  {
    name: 'Entra binding provisioning',
    guardedCall: /continuum_upsert_entra_group_binding/,
    invoke: (pool) => provisionEntraGroupBinding(pool, actor, {
      externalId: GROUP_ID, scopeId: SCOPE_ID, role: 'reader',
    }),
  },
  {
    name: 'Entra binding revocation',
    guardedCall: /continuum_operator_revoke_entra_group_binding/,
    invoke: (pool) => revokeEntraGroupBinding(pool, actor, GROUP_ID),
  },
];

describe('operator boundary database errors', () => {
  it.each([
    { reason: 'migration_pending', failure: Object.assign(databaseFailure('contract pending', '55000'),
      { constraint: 'coordination_contract_pending' }) },
    { reason: 'owned_live_lease', failure: Object.assign(databaseFailure('owned lease', '23514'),
      { constraint: 'coordination_scope_live_lease' }) },
  ])('returns a truthful $reason block for an existing disabled scope repair', async ({ reason, failure }) => {
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        let rows: Record<string, unknown>[] = [];
        if (sql.includes('continuum_operator_pseudonymize_scope_v2')) throw failure;
        if (sql.includes('to_regprocedure')) rows = [{ ready: true, owned_scope_ready: true }];
        else if (sql.includes('pg_try_advisory_xact_lock')) rows = [{ locked: true }];
        else if (/FROM scopes WHERE kind = \$1 AND name = \$2/.test(sql)) {
          rows = [{ id: SCOPE_ID, kind: 'org', name: '', created_at: new Date() }];
        } else if (/FROM scope_memberships m JOIN principals p/.test(sql)) {
          rows = [{ principal_id: ACTOR_ID, scope_id: SCOPE_ID, role: 'admin',
            source_kind: 'manual', source_id: 'manual', active: true, added_at: new Date() }];
        } else if (sql.includes('SELECT principal.id, principal.disabled_at')) {
          rows = [{ id: TARGET_ID, scope_id: SCOPE_ID, disabled_at: new Date(), offboarded_at: null }];
        } else if (sql.includes('continuum_operator_list_coordination_privacy_repairs')) {
          rows = [{ repair_state: 'disabled_only' }];
        } else if (sql.includes('FROM continuum_coordination_privacy_state')) {
          rows = [{ privacy_version: 2, principal_complete: false }];
        } else if (sql.includes('continuum_operator_coordination_scope_privacy_state')) {
          rows = [{ repair_exists: true, phase: 'resources', pseudonym: 'erased-existing',
            rows_processed: '1', scope_complete: false, resources_remain: true,
            receipts_remain: false, leases_remain: true, live_lease_until: null }];
        }
        return { rowCount: rows.length, rows };
      }),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool;
    await expect(repairCoordinationPrivacy(pool, actor, TARGET_ID, {
      confirmationScopeId: SCOPE_ID,
    })).resolves.toMatchObject({ complete: false, progressed: false, reason });
  });
  it('preserves the repair lock failure when its fallback snapshot also fails', async () => {
    const original = databaseFailure('could not obtain lock', '55P03');
    const snapshotFailure = databaseFailure('snapshot connection lost', '08006');
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        let rows: Record<string, unknown>[] = [];
        if (sql.includes('SELECT principal.offboarded_at, mapping.scope_id')) throw snapshotFailure;
        if (sql.includes('continuum_operator_list_coordination_privacy_repairs')) throw original;
        if (sql.includes('to_regprocedure')) rows = [{ ready: true, owned_scope_ready: true }];
        else if (sql.includes('pg_try_advisory_xact_lock')) rows = [{ locked: true }];
        else if (/FROM scopes WHERE kind = \$1 AND name = \$2/.test(sql)) {
          rows = [{ id: SCOPE_ID, kind: 'org', name: '', created_at: new Date() }];
        } else if (/FROM scope_memberships m JOIN principals p/.test(sql)) {
          rows = [{ principal_id: ACTOR_ID, scope_id: SCOPE_ID, role: 'admin',
            source_kind: 'manual', source_id: 'manual', active: true, added_at: new Date() }];
        } else if (sql.includes('SELECT principal.id, principal.disabled_at')) {
          rows = [{ id: TARGET_ID, scope_id: SCOPE_ID, disabled_at: new Date(), offboarded_at: null }];
        }
        return { rowCount: rows.length, rows };
      }),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool;
    await expect(repairCoordinationPrivacy(pool, actor, TARGET_ID, {
      confirmationScopeId: SCOPE_ID,
    })).rejects.toBe(original);
  });
  it('does not claim full lifecycle completion for an offboarded privacy-repair caller', async () => {
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        let rows: Record<string, unknown>[] = [];
        if (sql.includes('to_regprocedure')) rows = [{ ready: true, owned_scope_ready: true }];
        else if (sql.includes('pg_try_advisory_xact_lock')) rows = [{ locked: true }];
        else if (/FROM scopes WHERE kind = \$1 AND name = \$2/.test(sql)) {
          rows = [{ id: SCOPE_ID, kind: 'org', name: '', created_at: new Date() }];
        } else if (/FROM scope_memberships m JOIN principals p/.test(sql)) {
          rows = [{ principal_id: ACTOR_ID, scope_id: SCOPE_ID, role: 'admin',
            source_kind: 'manual', source_id: 'manual', active: true, added_at: new Date() }];
        } else if (sql.includes('SELECT principal.id, principal.disabled_at')) {
          rows = [{ id: TARGET_ID, scope_id: SCOPE_ID, disabled_at: new Date(), offboarded_at: new Date() }];
        } else if (sql.includes('FROM continuum_coordination_privacy_state')) {
          rows = [{ privacy_version: 3, principal_complete: true }];
        }
        return { rowCount: rows.length, rows };
      }),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool;
    await expect(repairCoordinationPrivacy(pool, actor, TARGET_ID, {
      confirmationScopeId: SCOPE_ID,
    })).resolves.toMatchObject({ complete: false, reason: 'offboarding_required' });
  });
  it('preserves the original lock failure when the offboarding preview also fails', async () => {
    const original = databaseFailure('could not obtain lock', '55P03');
    const previewFailure = databaseFailure('preview connection lost', '08006');
    const pool = { connect: vi.fn()
      .mockRejectedValueOnce(original).mockRejectedValueOnce(previewFailure) } as unknown as pg.Pool;
    await expect(offboardPrincipal(pool, actor, TARGET_ID, {
      confirmationScopeId: SCOPE_ID,
    })).rejects.toBe(original);
  });
  it('returns a sanitized upgrade dependency when the paged discovery helper is missing', async () => {
    const original = databaseFailure('function private_schema.secret_page(uuid,uuid,integer) does not exist', '42883');
    const fixture = guardedPool(/continuum_operator_list_coordination_privacy_repair_page/, original);
    await expect(listCoordinationPrivacyRepairPage(fixture.pool, actor, 2)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE', status: 503,
      publicMessage: 'coordination privacy discovery paging requires current migrations and operator grants',
      cause: original,
    });
    expect(fixture.guardedCalls()).toBe(1);
  });

  it.each([
    ['DB wording', databaseFailure('operation requires a DB-bound trusted approve identity')],
    ['role/OID wording', databaseFailure('operation requires a role-name/OID-bound trusted approve identity')],
    ['insufficient privilege SQLSTATE', databaseFailure('permission denied', '42501')],
  ])('maps %s to FORBIDDEN only after reaching each guarded wrapper', async (_label, failure) => {
    for (const path of paths) {
      const { pool, release, guardedCalls } = guardedPool(path.guardedCall, failure);
      await expect(path.invoke(pool), path.name).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
      expect(guardedCalls(), path.name).toBe(1);
      if (path.name === 'principal offboarding') {
        expect(release, path.name).toHaveBeenCalled();
      } else {
        expect(release, path.name).toHaveBeenCalledOnce();
      }
    }
  });

  it.each([
    ['deadlock', databaseFailure('deadlock detected', '40P01')],
    ['statement timeout', databaseFailure('canceling statement due to timeout', '57014')],
    ['lock unavailable', databaseFailure('could not obtain lock', '55P03')],
    ['connection failure', databaseFailure('connection terminated unexpectedly', '08006')],
  ])('does not map unrelated %s errors to FORBIDDEN', async (_label, failure) => {
    for (const path of paths) {
      const { pool, guardedCalls } = guardedPool(path.guardedCall, failure);
      if (failure.code === '55P03' && path.name === 'principal offboarding') {
        await expect(path.invoke(pool), path.name).resolves.toMatchObject({
          dryRun: false, complete: false, alreadyOffboarded: false,
          progressed: false, reason: 'lock_busy',
        });
      } else if (failure.code === '57014' && (
        path.name === 'owned-scope offboarding administration' || path.name === 'principal offboarding'
      )) {
        await expect(path.invoke(pool), path.name).rejects.toMatchObject({
          code: 'COORDINATION_TIMEOUT', status: 503,
        });
      } else {
        await expect(path.invoke(pool), path.name).rejects.toBe(failure);
      }
      expect(guardedCalls(), path.name).toBe(1);
    }
  });

  it('preserves existing ServiceErrors instead of reclassifying them', async () => {
    const failure = new ServiceError('CONFLICT', 'business rule rejected the operation');
    for (const path of paths) {
      const { pool } = guardedPool(path.guardedCall, failure);
      await expect(path.invoke(pool), path.name).rejects.toBe(failure);
    }
  });

  it('keeps the last-admin business error as CONFLICT', async () => {
    const failure = databaseFailure('cannot remove the last effective manual org administrator');
    const path = paths.find(({ name }) => name === 'principal offboarding')!;
    const { pool } = guardedPool(path.guardedCall, failure);
    await expect(path.invoke(pool)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
  });

  it.each([
    paths.find(({ name }) => name === 'protected principal disable')!,
    paths.find(({ name }) => name === 'Entra binding provisioning')!,
  ])('preserves $name classification and destroys the client when rollback fails', async (path) => {
    const failure = databaseFailure('operation requires a DB-bound trusted approve identity');
    const rollbackFailure = databaseFailure('connection lost during rollback', '08006');
    const { pool, release } = guardedPool(path.guardedCall, failure, rollbackFailure);
    await expect(path.invoke(pool)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(release).toHaveBeenCalledWith(true);
  });
});
