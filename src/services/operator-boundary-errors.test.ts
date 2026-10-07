import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { Principal } from '../types.js';
import { runAuditRetention } from '../maintenance/audit-retention.js';
import {
  provisionEntraGroupBinding, revokeEntraGroupBinding,
} from './membership-sync.js';
import { mapOwnedUserScope, offboardPrincipal } from './offboarding.js';
import { disablePrincipal, reactivatePrincipal } from './principal-admin.js';
import { ServiceError } from './errors.js';

const ACTOR_ID = '10000000-0000-4000-8000-000000000001';
const TARGET_ID = '20000000-0000-4000-8000-000000000001';
const SCOPE_ID = '30000000-0000-4000-8000-000000000001';
const GROUP_ID = '40000000-0000-4000-8000-000000000001';

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
      if (guardedCall.test(sql)) {
        guardedCalls += 1;
        throw failure;
      }
      if (/FROM scopes WHERE kind = \$1 AND name = \$2/.test(sql)) {
        return { rowCount: 1, rows: [{
          id: SCOPE_ID, kind: 'org', name: '', created_at: new Date('2026-01-01T00:00:00Z'),
        }] };
      }
      if (/FROM scope_memberships m JOIN principals p/.test(sql)) {
        return { rowCount: 1, rows: [{
          principal_id: ACTOR_ID, scope_id: SCOPE_ID, role: 'admin',
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
          acknowledged_evidence_hash: 'unused-before-guard', approval_id: '1',
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
      expect(release, path.name).toHaveBeenCalledOnce();
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
      await expect(path.invoke(pool), path.name).rejects.toBe(failure);
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
