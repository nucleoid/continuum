import type pg from 'pg';
import type { MembershipRole, Principal } from '../types.js';
import { requireOrgAdmin } from './access.js';
import { ServiceError } from './errors.js';

export const MAX_SYNC_GROUPS = 500;
export const MAX_GROUP_MEMBERS = 10_000;
export const MAX_SYNC_MEMBERSHIPS = 50_000;
export const DEFAULT_MAX_DEACTIVATION_PERCENT = 25;
export const DEFAULT_MASS_MEMBERSHIP_DEACTIVATION_COUNT = 100;
const SYNC_LOCK_ID = '834641726154302119';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export interface EntraGroupSnapshot {
  id: string;
  status: 'present' | 'missing' | 'invalid';
  displayName?: string;
  memberObjectIds?: string[];
  errorCode?: string;
}

export interface MembershipSyncOptions {
  allowMassDeactivation?: boolean;
  maxDeactivationPercent?: number;
}

export interface MembershipSyncResult {
  groupsSeen: number;
  groupsSkipped: number;
  membershipsActive: number;
  membershipsDeactivated: number;
  groupsDeactivated: number;
  groupsReactivated: number;
  skipCodes: Record<string, number>;
}

export interface EntraGroupBindingInput {
  externalId: string;
  scopeId: string;
  role: MembershipRole;
  displayName?: string;
}

function uuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new ServiceError('INVALID_INPUT', `${field} must be a UUID`);
}

function role(value: string): asserts value is MembershipRole {
  if (!['reader', 'writer', 'admin'].includes(value)) {
    throw new ServiceError('INVALID_INPUT', 'role is invalid');
  }
}

/** Explicitly creates, updates, or reactivates an immutable group-ID binding. */
export async function provisionEntraGroupBinding(
  pool: pg.Pool,
  actor: Principal,
  input: EntraGroupBindingInput,
): Promise<{ created: boolean; reactivated: boolean }> {
  uuid(input.externalId, 'group id');
  uuid(input.scopeId, 'scope id');
  role(input.role);
  const displayName = input.displayName?.trim().slice(0, 256) || input.externalId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireOrgAdmin(client, actor.id);
    const scope = await client.query('SELECT id FROM scopes WHERE id = $1 FOR SHARE', [input.scopeId]);
    if (!scope.rowCount) throw new ServiceError('INVALID_INPUT', 'scope not found');
    const prior = await client.query(
      `SELECT scope_id, role, active FROM entra_groups WHERE external_id = $1 FOR UPDATE`,
      [input.externalId],
    );
    const created = !prior.rows[0];
    const reactivated = prior.rows[0]?.active === false;
    const changedTarget = prior.rows[0]
      && (prior.rows[0].scope_id !== input.scopeId || prior.rows[0].role !== input.role);
    if (changedTarget) {
      await client.query(
        `UPDATE scope_memberships
            SET active = FALSE, deactivated_at = now(), synced_at = now()
          WHERE source_kind = 'entra' AND source_id = $1 AND active`,
        [input.externalId],
      );
    }
    await client.query(
      `INSERT INTO entra_groups
         (external_id, display_name, scope_id, role, active, approved_by, approved_at,
          deactivated_at, last_seen_at)
       VALUES ($1, $2, $3, $4, TRUE, $5, now(), NULL, NULL)
       ON CONFLICT (external_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         scope_id = EXCLUDED.scope_id,
         role = EXCLUDED.role,
         active = TRUE,
         approved_by = EXCLUDED.approved_by,
         approved_at = now(),
         approval_revoked_by = NULL,
         approval_revoked_at = NULL,
         deactivated_at = NULL`,
      [input.externalId, displayName, input.scopeId, input.role, actor.id],
    );
    await client.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
       VALUES ($1, 'write', $2, $3::jsonb)`,
      [actor.id, input.scopeId, JSON.stringify({
        operation: created ? 'entra_group_binding_provisioned'
          : reactivated ? 'entra_group_binding_reactivated' : 'entra_group_binding_updated',
        group_id: input.externalId,
        role: input.role,
        previous_scope_id: prior.rows[0]?.scope_id ?? null,
        previous_role: prior.rows[0]?.role ?? null,
      })],
    );
    await client.query('COMMIT');
    return { created, reactivated };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

/** Revokes a binding and all access sourced from it in one audited transaction. */
export async function revokeEntraGroupBinding(
  pool: pg.Pool,
  actor: Principal,
  externalId: string,
): Promise<boolean> {
  uuid(externalId, 'group id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireOrgAdmin(client, actor.id);
    const revoked = await client.query(
      `UPDATE entra_groups
          SET active = FALSE, deactivated_at = COALESCE(deactivated_at, now()),
              approval_revoked_by = $2, approval_revoked_at = now()
        WHERE external_id = $1 AND approved_by IS NOT NULL
          AND approval_revoked_at IS NULL
        RETURNING scope_id, role`,
      [externalId, actor.id],
    );
    if (!revoked.rowCount) {
      await client.query('ROLLBACK');
      return false;
    }
    const memberships = await client.query(
      `UPDATE scope_memberships
          SET active = FALSE, deactivated_at = COALESCE(deactivated_at, now()), synced_at = now()
        WHERE source_kind = 'entra' AND source_id = $1 AND active
        RETURNING principal_id`,
      [externalId],
    );
    await requireOrgAdmin(client, actor.id);
    const admins = await client.query(
      `SELECT count(DISTINCT m.principal_id)::int AS count
         FROM scope_memberships m JOIN scopes s ON s.id = m.scope_id
        WHERE s.kind = 'org' AND s.name = '' AND m.active AND m.role = 'admin'`,
    );
    if ((admins.rows[0]?.count ?? 0) < 1) {
      throw new ServiceError('CONFLICT', 'binding revocation cannot remove the last org administrator');
    }
    await client.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
       VALUES ($1, 'write', $2, $3::jsonb)`,
      [actor.id, revoked.rows[0].scope_id, JSON.stringify({
        operation: 'entra_group_binding_revoked', group_id: externalId,
        role: revoked.rows[0].role, memberships_deactivated: memberships.rowCount ?? 0,
      })],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function listBoundEntraGroupIds(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT external_id FROM entra_groups
      WHERE approved_by IS NOT NULL AND approval_revoked_at IS NULL
      ORDER BY external_id`,
  );
  return rows.map((row) => row.external_id as string);
}

function skip(result: MembershipSyncResult, code: string): void {
  result.groupsSkipped += 1;
  result.skipCodes[code] = (result.skipCodes[code] ?? 0) + 1;
}

async function quarantineBinding(
  client: pg.PoolClient,
  externalId: string,
  result: MembershipSyncResult,
): Promise<number> {
  const group = await client.query(
    `UPDATE entra_groups
        SET active = FALSE, deactivated_at = COALESCE(deactivated_at, now())
      WHERE external_id = $1 AND active
      RETURNING external_id`,
    [externalId],
  );
  result.groupsDeactivated += group.rowCount ?? 0;
  const memberships = await client.query(
    `UPDATE scope_memberships
        SET active = FALSE, deactivated_at = COALESCE(deactivated_at, now()), synced_at = now()
      WHERE source_kind = 'entra' AND source_id = $1 AND active
      RETURNING principal_id`,
    [externalId],
  );
  const count = memberships.rowCount ?? 0;
  result.membershipsDeactivated += count;
  return count;
}

async function quarantineOversizedSnapshot(pool: pg.Pool, actor: Principal): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [SYNC_LOCK_ID]);
    await requireOrgAdmin(client, actor.id);
    const groups = await client.query(
      `UPDATE entra_groups
          SET active = FALSE, deactivated_at = COALESCE(deactivated_at, now())
        WHERE approved_by IS NOT NULL AND approval_revoked_at IS NULL AND active
        RETURNING external_id`,
    );
    const memberships = await client.query(
      `UPDATE scope_memberships m
          SET active = FALSE, deactivated_at = COALESCE(m.deactivated_at, now()), synced_at = now()
        WHERE m.source_kind = 'entra' AND m.active
          AND EXISTS (
            SELECT 1 FROM entra_groups g
             WHERE g.external_id = m.source_id
               AND g.approved_by IS NOT NULL AND g.approval_revoked_at IS NULL
          )
        RETURNING principal_id`,
    );
    await requireOrgAdmin(client, actor.id);
    const admins = await client.query(
      `SELECT count(DISTINCT m.principal_id)::int AS count
         FROM scope_memberships m JOIN scopes s ON s.id = m.scope_id
        WHERE s.kind = 'org' AND s.name = '' AND m.active AND m.role = 'admin'`,
    );
    if ((admins.rows[0]?.count ?? 0) < 1) {
      throw new ServiceError('CONFLICT', 'membership sync cannot remove the last org administrator');
    }
    await client.query(
      `INSERT INTO audit_log (principal_id, action, metadata)
       VALUES ($1, 'write', $2::jsonb)`,
      [actor.id, JSON.stringify({
        operation: 'entra_membership_sync_rejected', reason: 'SNAPSHOT_TOO_LARGE',
        groups_deactivated: groups.rowCount ?? 0,
        memberships_deactivated: memberships.rowCount ?? 0,
      })],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function syncEntraMemberships(
  pool: pg.Pool,
  actor: Principal,
  snapshots: readonly EntraGroupSnapshot[],
  options: MembershipSyncOptions = {},
): Promise<MembershipSyncResult> {
  if (snapshots.length > MAX_SYNC_GROUPS) {
    await quarantineOversizedSnapshot(pool, actor);
    throw new ServiceError('PAYLOAD_TOO_LARGE', 'too many Entra group results');
  }
  const maxPercent = options.maxDeactivationPercent ?? DEFAULT_MAX_DEACTIVATION_PERCENT;
  if (!Number.isFinite(maxPercent) || maxPercent < 0 || maxPercent > 100) {
    throw new ServiceError('INVALID_INPUT', 'mass-deactivation threshold is invalid');
  }
  const client = await pool.connect();
  const result: MembershipSyncResult = {
    groupsSeen: 0, groupsSkipped: 0, membershipsActive: 0,
    membershipsDeactivated: 0, groupsDeactivated: 0, groupsReactivated: 0, skipCodes: {},
  };
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [SYNC_LOCK_ID]);
    await requireOrgAdmin(client, actor.id);
    const bindings = await client.query(
      `SELECT external_id, scope_id, role, active, approval_revoked_at FROM entra_groups
        WHERE approved_by IS NOT NULL ORDER BY external_id FOR UPDATE`,
    );
    const activeMembershipsBefore = await client.query(
      `SELECT count(*)::int AS count FROM scope_memberships
        WHERE source_kind = 'entra' AND active`,
    );
    const byId = new Map(bindings.rows.map((row) => [row.external_id as string, row]));
    const received = new Set<string>();
    let total = 0;
    let quarantinedMemberships = 0;
    const definitiveMissing: string[] = [];

    for (const snapshot of snapshots) {
      if (!UUID.test(snapshot.id)) {
        skip(result, 'INVALID_GROUP_ID');
        continue;
      }
      const binding = byId.get(snapshot.id);
      if (received.has(snapshot.id)) {
        skip(result, 'DUPLICATE_GROUP_ID');
        if (binding && !binding.approval_revoked_at) {
          quarantinedMemberships += await quarantineBinding(client, snapshot.id, result);
        }
        continue;
      }
      received.add(snapshot.id);
      if (!binding) { skip(result, 'UNBOUND_GROUP'); continue; }
      if (binding.approval_revoked_at) { skip(result, 'REVOKED_GROUP'); continue; }
      if (snapshot.status === 'invalid') {
        skip(result, snapshot.errorCode ?? 'INVALID_GROUP');
        quarantinedMemberships += await quarantineBinding(client, snapshot.id, result);
        continue;
      }
      if (snapshot.status === 'missing') { definitiveMissing.push(snapshot.id); continue; }
      if (typeof snapshot.displayName !== 'string' || snapshot.displayName.length > 256
        || !Array.isArray(snapshot.memberObjectIds)) {
        skip(result, 'MALFORMED_GROUP');
        quarantinedMemberships += await quarantineBinding(client, snapshot.id, result);
        continue;
      }
      if (snapshot.memberObjectIds.length > MAX_GROUP_MEMBERS) {
        skip(result, 'GROUP_TOO_LARGE');
        quarantinedMemberships += await quarantineBinding(client, snapshot.id, result);
        continue;
      }
      const unique = new Set<string>();
      let malformed = false;
      for (const memberId of snapshot.memberObjectIds) {
        if (!UUID.test(memberId) || unique.has(memberId)) { malformed = true; break; }
        unique.add(memberId);
      }
      if (malformed || total + unique.size > MAX_SYNC_MEMBERSHIPS) {
        skip(result, malformed ? 'MALFORMED_MEMBERS' : 'SNAPSHOT_TOO_LARGE');
        quarantinedMemberships += await quarantineBinding(client, snapshot.id, result);
        continue;
      }
      total += unique.size;
      const reactivated = await client.query(
        `UPDATE entra_groups SET display_name = $2, last_seen_at = now(), active = TRUE,
                                 deactivated_at = NULL
          WHERE external_id = $1`,
        [snapshot.id, snapshot.displayName],
      );
      if (!binding.active && reactivated.rowCount) result.groupsReactivated += 1;
      result.groupsSeen += 1;
      const externalIds = [...unique];
      const principals = externalIds.length === 0 ? [] : (await client.query(
        `SELECT id FROM principals WHERE kind = 'user' AND external_id = ANY($1::text[])`,
        [externalIds],
      )).rows;
      const principalIds = principals.map((row) => row.id as string);
      if (principalIds.length > 0) {
        const activated = await client.query(
          `INSERT INTO scope_memberships
             (principal_id, scope_id, role, source_kind, source_id, active, synced_at)
           SELECT member_id, $2, $3, 'entra', $4, TRUE, now()
             FROM unnest($1::uuid[]) member_id
           ON CONFLICT (principal_id, scope_id, source_kind, source_id)
           DO UPDATE SET role = EXCLUDED.role, active = TRUE,
                         deactivated_at = NULL, synced_at = now()
           RETURNING 1`,
          [principalIds, binding.scope_id, binding.role, snapshot.id],
        );
        result.membershipsActive += activated.rowCount ?? 0;
      }
      const deactivated = await client.query(
        `UPDATE scope_memberships SET active = FALSE, deactivated_at = now(), synced_at = now()
          WHERE source_kind = 'entra' AND source_id = $1 AND active
            AND NOT (principal_id = ANY($2::uuid[])) RETURNING principal_id`,
        [snapshot.id, principalIds],
      );
      result.membershipsDeactivated += deactivated.rowCount ?? 0;
    }

    const activeCount = bindings.rows.filter((row) => row.active && !row.approval_revoked_at).length;
    const missingActive = definitiveMissing.filter((id) => byId.get(id)?.active);
    const deactivationPercent = activeCount === 0 ? 0 : (missingActive.length * 100) / activeCount;
    if (missingActive.length > 0 && deactivationPercent > maxPercent
      && !options.allowMassDeactivation) {
      throw new ServiceError('CONFLICT', 'suspicious Entra group deactivation threshold exceeded');
    }
    if (activeCount > 0 && snapshots.length === 0) {
      throw new ServiceError('CONFLICT', 'empty Entra snapshot cannot deactivate bound groups');
    }
    if (missingActive.length > 0) {
      const disappeared = await client.query(
        `UPDATE entra_groups SET active = FALSE, deactivated_at = now()
          WHERE active AND external_id = ANY($1::text[]) RETURNING external_id`,
        [missingActive],
      );
      result.groupsDeactivated = disappeared.rowCount ?? 0;
      const memberships = await client.query(
        `UPDATE scope_memberships SET active = FALSE, deactivated_at = now(), synced_at = now()
          WHERE source_kind = 'entra' AND source_id = ANY($1::text[]) AND active`,
        [missingActive],
      );
      result.membershipsDeactivated += memberships.rowCount ?? 0;
    }

    const priorMembershipCount = activeMembershipsBefore.rows[0]?.count ?? 0;
    const authoritativeDeactivations = result.membershipsDeactivated - quarantinedMemberships;
    const membershipDeactivationPercent = priorMembershipCount === 0 ? 0
      : (authoritativeDeactivations * 100) / priorMembershipCount;
    if (authoritativeDeactivations >= DEFAULT_MASS_MEMBERSHIP_DEACTIVATION_COUNT
      && membershipDeactivationPercent > maxPercent && !options.allowMassDeactivation) {
      throw new ServiceError('CONFLICT', 'suspicious Entra membership deactivation threshold exceeded');
    }

    // The synchronizing administrator and the organization must retain authority.
    await requireOrgAdmin(client, actor.id);
    const admins = await client.query(
      `SELECT count(DISTINCT m.principal_id)::int AS count
         FROM scope_memberships m JOIN scopes s ON s.id = m.scope_id
        WHERE s.kind = 'org' AND s.name = '' AND m.active AND m.role = 'admin'`,
    );
    if ((admins.rows[0]?.count ?? 0) < 1) {
      throw new ServiceError('CONFLICT', 'membership sync cannot remove the last org administrator');
    }
    await client.query(
      `INSERT INTO audit_log (principal_id, action, metadata)
       VALUES ($1, 'write', $2::jsonb)`,
      [actor.id, JSON.stringify({ operation: 'entra_membership_sync', ...result })],
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
