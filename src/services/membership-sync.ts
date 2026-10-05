import type pg from 'pg';
import type { MembershipRole, Principal, ScopeKind } from '../types.js';
import { requireOrgAdmin } from './access.js';
import { ServiceError } from './errors.js';

export const MAX_SYNC_GROUPS = 500;
export const MAX_GROUP_MEMBERS = 10_000;
export const MAX_SYNC_MEMBERSHIPS = 50_000;
const SYNC_LOCK_ID = '834641726154302119';

export interface EntraGroupSnapshot {
  id: string;
  displayName: string;
  memberObjectIds: string[];
}

export interface MembershipSyncResult {
  groupsSeen: number;
  membershipsActive: number;
  membershipsDeactivated: number;
  groupsDeactivated: number;
}

function assertUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ServiceError('INVALID_INPUT', `${field} must be a UUID`);
  }
}

export function parseMembershipGroupName(displayName: string): {
  kind: ScopeKind; name: string; role: MembershipRole;
} | null {
  if (displayName.length > 256) throw new ServiceError('INVALID_INPUT', 'group display name is too long');
  const match = /^continuum-(org|team|project|role)-(.*)-(reader|writer|admin)$/.exec(displayName);
  if (!match) return null;
  const kind = match[1] as ScopeKind;
  const name = match[2];
  if ((kind === 'org' && name !== '') || (kind !== 'org' && (name.length === 0 || name.length > 128))) {
    return null;
  }
  return { kind, name, role: match[3] as MembershipRole };
}

function validateSnapshot(groups: readonly EntraGroupSnapshot[]): void {
  if (groups.length > MAX_SYNC_GROUPS) throw new ServiceError('PAYLOAD_TOO_LARGE', 'too many Entra groups');
  const ids = new Set<string>();
  let total = 0;
  for (const group of groups) {
    assertUuid(group.id, 'group id');
    if (ids.has(group.id)) throw new ServiceError('INVALID_INPUT', 'duplicate Entra group id');
    ids.add(group.id);
    if (group.memberObjectIds.length > MAX_GROUP_MEMBERS) {
      throw new ServiceError('PAYLOAD_TOO_LARGE', 'too many members in Entra group');
    }
    total += group.memberObjectIds.length;
    if (total > MAX_SYNC_MEMBERSHIPS) throw new ServiceError('PAYLOAD_TOO_LARGE', 'too many memberships');
    const members = new Set<string>();
    for (const id of group.memberObjectIds) {
      assertUuid(id, 'member object id');
      if (members.has(id)) throw new ServiceError('INVALID_INPUT', 'duplicate member object id');
      members.add(id);
    }
  }
}

export async function syncEntraMemberships(
  pool: pg.Pool,
  actor: Principal,
  groups: readonly EntraGroupSnapshot[],
): Promise<MembershipSyncResult> {
  validateSnapshot(groups);
  const client = await pool.connect();
  const result: MembershipSyncResult = {
    groupsSeen: 0, membershipsActive: 0, membershipsDeactivated: 0, groupsDeactivated: 0,
  };
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [SYNC_LOCK_ID]);
    await requireOrgAdmin(client, actor.id);
    const seen: string[] = [];
    for (const snapshot of groups) {
      const existing = await client.query(
        `SELECT external_id, scope_id, role, active FROM entra_groups
          WHERE external_id = $1 FOR UPDATE`,
        [snapshot.id],
      );
      let binding = existing.rows[0] as { scope_id: string; role: MembershipRole; active: boolean } | undefined;
      if (!binding) {
        const parsed = parseMembershipGroupName(snapshot.displayName);
        if (!parsed) continue;
        const scope = await client.query(
          `SELECT id FROM scopes WHERE kind = $1 AND name = $2`,
          [parsed.kind, parsed.name],
        );
        if (!scope.rows[0]) throw new ServiceError('INVALID_INPUT', 'Entra group targets an unknown scope');
        await client.query(
          `INSERT INTO entra_groups (external_id, display_name, scope_id, role)
           VALUES ($1, $2, $3, $4)`,
          [snapshot.id, snapshot.displayName, scope.rows[0].id, parsed.role],
        );
        binding = { scope_id: scope.rows[0].id, role: parsed.role, active: true };
      } else {
        await client.query(
          `UPDATE entra_groups SET display_name = $2, last_seen_at = now()
            WHERE external_id = $1`,
          [snapshot.id, snapshot.displayName],
        );
      }
      seen.push(snapshot.id);
      result.groupsSeen += 1;
      if (!binding.active) continue;
      const externalIds = snapshot.memberObjectIds;
      const principals = externalIds.length === 0 ? [] : (await client.query(
        `SELECT id, external_id FROM principals
          WHERE external_id = ANY($1::text[]) AND external_id IS NOT NULL`,
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
            AND NOT (principal_id = ANY($2::uuid[]))`,
        [snapshot.id, principalIds],
      );
      result.membershipsDeactivated += deactivated.rowCount ?? 0;
    }
    const disappeared = await client.query(
      `UPDATE entra_groups SET active = FALSE, deactivated_at = now()
        WHERE active AND NOT (external_id = ANY($1::text[]))
       RETURNING external_id`,
      [seen],
    );
    result.groupsDeactivated = disappeared.rowCount ?? 0;
    const disappearedIds = disappeared.rows.map((row) => row.external_id as string);
    if (disappearedIds.length > 0) {
      const memberships = await client.query(
        `UPDATE scope_memberships SET active = FALSE, deactivated_at = now(), synced_at = now()
          WHERE source_kind = 'entra' AND source_id = ANY($1::text[]) AND active`,
        [disappearedIds],
      );
      result.membershipsDeactivated += memberships.rowCount ?? 0;
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
