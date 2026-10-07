import type pg from 'pg';
import type { MembershipRole, Principal } from '../types.js';
import { requireOrgAdmin } from './access.js';
import { ServiceError } from './errors.js';

export const MAX_SYNC_GROUPS = 500;
export const MAX_GROUP_MEMBERS = 10_000;
export const MAX_SYNC_MEMBERSHIPS = 50_000;
export const DEFAULT_MAX_DEACTIVATION_PERCENT = 25;
export const DEFAULT_MASS_MEMBERSHIP_DEACTIVATION_COUNT = 100;
export const DEFAULT_MAX_STALENESS_HOURS = 48;
export const MAX_STALENESS_HOURS = 168;
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
  maxStalenessHours?: number;
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

function canonicalUuid(value: string, field: string): string {
  uuid(value, field);
  return value.toLowerCase();
}

function role(value: string): asserts value is MembershipRole {
  if (!['reader', 'writer', 'admin'].includes(value)) {
    throw new ServiceError('INVALID_INPUT', 'role is invalid');
  }
}

async function requireManualSyncActor(
  client: pg.PoolClient | pg.Pool,
  actorId: string,
): Promise<void> {
  try {
    await client.query('SELECT continuum_require_sync_session($1)', [actorId]);
  } catch (error) {
    throw new ServiceError(
      'FORBIDDEN',
      'membership sync requires the DB-bound sync service identity',
      { cause: error },
    );
  }
}

/** Performs the cheap local authorization gate required before Graph I/O. */
export async function validateMembershipSyncActor(
  pool: pg.Pool,
  actor: Principal,
): Promise<void> {
  await requireManualSyncActor(pool, actor.id);
}

/** Explicitly creates, updates, or reactivates an immutable group-ID binding. */
export async function provisionEntraGroupBinding(
  pool: pg.Pool,
  actor: Principal,
  input: EntraGroupBindingInput,
): Promise<{ created: boolean; reactivated: boolean }> {
  const externalId = canonicalUuid(input.externalId, 'group id');
  const scopeId = canonicalUuid(input.scopeId, 'scope id');
  role(input.role);
  const displayName = input.displayName?.trim().slice(0, 256) || externalId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [SYNC_LOCK_ID]);
    await requireOrgAdmin(client, actor.id);
    const scope = await client.query('SELECT id FROM scopes WHERE id = $1 FOR SHARE', [scopeId]);
    if (!scope.rowCount) throw new ServiceError('INVALID_INPUT', 'scope not found');
    const prior = await client.query(
      `SELECT scope_id, role, active FROM entra_groups WHERE external_id = $1 FOR UPDATE`,
      [externalId],
    );
    const alreadyApproved = await client.query(
      `SELECT 1 FROM entra_groups
        WHERE external_id = $1 AND approved_by IS NOT NULL AND approval_revoked_at IS NULL`,
      [externalId],
    );
    if (!alreadyApproved.rowCount) {
      const approved = await client.query(
        `SELECT count(*)::int AS count FROM entra_groups
          WHERE approved_by IS NOT NULL AND approval_revoked_at IS NULL`,
      );
      if ((approved.rows[0]?.count ?? 0) >= MAX_SYNC_GROUPS) {
        throw new ServiceError(
          'CONFLICT', `cannot approve more than ${MAX_SYNC_GROUPS} Entra group bindings`,
        );
      }
    }
    const created = !prior.rows[0];
    const reactivated = prior.rows[0]?.active === false;
    const changedTarget = prior.rows[0]
      && (prior.rows[0].scope_id !== scopeId || prior.rows[0].role !== input.role);
    if (changedTarget) {
      await client.query(
        `UPDATE scope_memberships
            SET active = FALSE, deactivated_at = now(), synced_at = now()
          WHERE source_kind = 'entra' AND source_id = $1 AND active`,
        [externalId],
      );
      await requireOrgAdmin(client, actor.id);
      const admins = await client.query(
        `SELECT count(DISTINCT m.principal_id)::int AS count
           FROM scope_memberships m JOIN scopes s ON s.id = m.scope_id
          WHERE s.kind = 'org' AND s.name = '' AND m.active AND m.role = 'admin'`,
      );
      if ((admins.rows[0]?.count ?? 0) < 1) {
        throw new ServiceError('CONFLICT', 'binding update cannot remove the last org administrator');
      }
    }
    await client.query(
      `SELECT continuum_upsert_entra_group_binding($1, $2, $3, $4, $5)`,
      [actor.id, externalId, displayName, scopeId, input.role],
    );
    await client.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
       VALUES ($1, 'write', $2, $3::jsonb)`,
      [actor.id, scopeId, JSON.stringify({
        operation: created ? 'entra_group_binding_provisioned'
          : reactivated ? 'entra_group_binding_reactivated' : 'entra_group_binding_updated',
        group_id: externalId,
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
  externalId = canonicalUuid(externalId, 'group id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [SYNC_LOCK_ID]);
    await requireOrgAdmin(client, actor.id);
    const binding = await client.query(
      `SELECT scope_id, role FROM entra_groups
        WHERE external_id = $1 AND approved_by IS NOT NULL
          AND approval_revoked_at IS NULL
        FOR UPDATE`,
      [externalId],
    );
    if (!binding.rowCount) {
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
      `UPDATE entra_groups
          SET active = FALSE, deactivated_at = COALESCE(deactivated_at, now()),
              approval_revoked_by = $2, approval_revoked_at = now()
        WHERE external_id = $1`,
      [externalId, actor.id],
    );
    await client.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
       VALUES ($1, 'write', $2, $3::jsonb)`,
      [actor.id, binding.rows[0].scope_id, JSON.stringify({
        operation: 'entra_group_binding_revoked', group_id: externalId,
        role: binding.rows[0].role, memberships_deactivated: memberships.rowCount ?? 0,
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
  return rows.map((row) => (row.external_id as string).toLowerCase());
}

function skip(result: MembershipSyncResult, code: string): void {
  result.groupsSkipped += 1;
  result.skipCodes[code] = (result.skipCodes[code] ?? 0) + 1;
}

async function quarantineBinding(
  client: pg.PoolClient,
  actorId: string,
  externalId: string,
  result: MembershipSyncResult,
  reason: string,
): Promise<number> {
  const memberships = await client.query<{ count: number }>(
    `SELECT continuum_sync_deactivate_entra_memberships(
       $1, ARRAY[$2]::text[], NULL::uuid[])::int AS count`,
    [actorId, externalId],
  );
  const count = Number(memberships.rows[0]?.count ?? 0);
  result.membershipsDeactivated += count;
  const group = await client.query<{ changed: boolean }>(
    `SELECT continuum_sync_quarantine_entra_group($1, $2, $3) AS changed`,
    [actorId, externalId, reason],
  );
  result.groupsDeactivated += group.rows[0]?.changed ? 1 : 0;
  return count;
}

async function rejectOversizedSnapshot(
  client: pg.PoolClient,
  actor: Principal,
  maxStalenessHours: number,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await recordRejectedAttempt(
      client,
      actor,
      new ServiceError('PAYLOAD_TOO_LARGE', 'Entra snapshot exceeds the whole-run limit'),
      maxStalenessHours,
      { groupsDeactivated: 0, membershipsDeactivated: 0, skipCodes: {} },
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

interface BindingRow {
  external_id: string;
  scope_id: string;
  role: MembershipRole;
  active: boolean;
  approval_revoked_at: Date | null;
  quarantined_at: Date | null;
}

interface PreparedSnapshot {
  snapshot: EntraGroupSnapshot & { displayName: string; memberObjectIds: string[] };
  binding: BindingRow;
}

function rejectionReason(error: unknown): string {
  if (!(error instanceof ServiceError)) return 'SYNC_FAILED';
  if (error.code === 'PAYLOAD_TOO_LARGE') return 'SNAPSHOT_TOO_LARGE';
  if (error.message.includes('empty Entra snapshot')) return 'EMPTY_SNAPSHOT';
  if (error.message.includes('group deactivation threshold')) return 'GROUP_DEACTIVATION_THRESHOLD';
  if (error.message.includes('membership deactivation threshold')) return 'MEMBERSHIP_DEACTIVATION_THRESHOLD';
  if (error.message.includes('last org administrator')) return 'LAST_ORG_ADMIN';
  if (error.code === 'FORBIDDEN') return 'SYNCHRONIZER_AUTHORITY_REMOVED';
  return error.code;
}

async function recordRejectedAttempt(
  client: pg.PoolClient,
  actor: Principal,
  error: unknown,
  maxStalenessHours: number,
  quarantine: Pick<MembershipSyncResult, 'groupsDeactivated' | 'membershipsDeactivated' | 'skipCodes'>,
): Promise<void> {
  await requireManualSyncActor(client, actor.id);
  await client.query('SELECT continuum_record_entra_sync_failure($1, $2, $3)', [
    actor.id, rejectionReason(error), maxStalenessHours,
  ]);
  const state = await client.query<{ last_success_at: Date; stale: boolean }>(
    `SELECT last_success_at, now() >= last_success_at + max_staleness AS stale
       FROM entra_sync_state WHERE singleton`,
  );
  if (!state.rows[0]) throw new Error('Entra sync freshness state is missing');
  const staleDeactivated = state.rows[0].stale ? Number((await client.query<{ count: number }>(
    `SELECT continuum_sync_deactivate_entra_memberships(
       $1, NULL::text[], NULL::uuid[])::int AS count`, [actor.id],
  )).rows[0]?.count ?? 0) : 0;
  await client.query(
    `INSERT INTO audit_log (principal_id, action, metadata)
     VALUES ($1, 'write', $2::jsonb)`,
    [actor.id, JSON.stringify({
      operation: 'entra_membership_sync_rejected',
      reason: rejectionReason(error),
      last_success_at: state.rows[0].last_success_at,
      max_staleness_hours: maxStalenessHours,
      stale: state.rows[0].stale,
      stale_memberships_deactivated: staleDeactivated,
      groups_deactivated: quarantine.groupsDeactivated,
      memberships_deactivated: quarantine.membershipsDeactivated,
      quarantine: {
        groups_deactivated: quarantine.groupsDeactivated,
        memberships_deactivated: quarantine.membershipsDeactivated,
        skip_codes: quarantine.skipCodes,
      },
    })],
  );
}

export async function rejectEntraMembershipSync(
  pool: pg.Pool,
  actor: Principal,
  error: unknown,
  options: Pick<MembershipSyncOptions, 'maxStalenessHours'> = {},
): Promise<void> {
  const maxStalenessHours = options.maxStalenessHours ?? DEFAULT_MAX_STALENESS_HOURS;
  if (!Number.isSafeInteger(maxStalenessHours)
    || maxStalenessHours < 1 || maxStalenessHours > MAX_STALENESS_HOURS) {
    throw new ServiceError('INVALID_INPUT', 'Entra membership staleness bound is invalid');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [SYNC_LOCK_ID]);
    await recordRejectedAttempt(
      client, actor, error, maxStalenessHours,
      { groupsDeactivated: 0, membershipsDeactivated: 0, skipCodes: {} },
    );
    await client.query('COMMIT');
  } catch (recordError) {
    await client.query('ROLLBACK');
    throw recordError;
  } finally {
    client.release();
  }
}

async function auditRejectedSync(
  client: pg.PoolClient,
  actor: Principal,
  error: unknown,
  result: MembershipSyncResult,
  maxStalenessHours: number,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await recordRejectedAttempt(client, actor, error, maxStalenessHours, result);
    await client.query('COMMIT');
  } catch (auditError) {
    await client.query('ROLLBACK');
    throw new AggregateError(
      [error, auditError],
      'membership sync failed and rejection audit could not be recorded',
    );
  }
}

export async function syncEntraMemberships(
  pool: pg.Pool,
  actor: Principal,
  snapshots: readonly EntraGroupSnapshot[],
  options: MembershipSyncOptions = {},
): Promise<MembershipSyncResult> {
  const maxPercent = options.maxDeactivationPercent ?? DEFAULT_MAX_DEACTIVATION_PERCENT;
  if (!Number.isFinite(maxPercent) || maxPercent < 0 || maxPercent > 100) {
    throw new ServiceError('INVALID_INPUT', 'mass-deactivation threshold is invalid');
  }
  const maxStalenessHours = options.maxStalenessHours ?? DEFAULT_MAX_STALENESS_HOURS;
  if (!Number.isSafeInteger(maxStalenessHours)
    || maxStalenessHours < 1 || maxStalenessHours > MAX_STALENESS_HOURS) {
    throw new ServiceError('INVALID_INPUT', 'Entra membership staleness bound is invalid');
  }
  const normalizedSnapshots = snapshots.map((snapshot) => ({
    ...snapshot,
    id: UUID.test(snapshot.id) ? snapshot.id.toLowerCase() : snapshot.id,
    memberObjectIds: snapshot.memberObjectIds?.map((id) => UUID.test(id) ? id.toLowerCase() : id),
  }));
  const client = await pool.connect();
  const result: MembershipSyncResult = {
    groupsSeen: 0, groupsSkipped: 0, membershipsActive: 0,
    membershipsDeactivated: 0, groupsDeactivated: 0, groupsReactivated: 0, skipCodes: {},
  };
  let transactionOpen = false;
  let authoritativePhase = false;
  let durableQuarantine = result;
  let lockAcquired = false;
  let primaryError: unknown;
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [SYNC_LOCK_ID]);
    lockAcquired = true;
    let membershipResults = 0;
    const exceedsMembershipLimit = normalizedSnapshots.some((snapshot) => {
      membershipResults += Array.isArray(snapshot.memberObjectIds) ? snapshot.memberObjectIds.length : 0;
      return membershipResults > MAX_SYNC_MEMBERSHIPS;
    });
    if (normalizedSnapshots.length > MAX_SYNC_GROUPS || exceedsMembershipLimit) {
      await rejectOversizedSnapshot(client, actor, maxStalenessHours);
      throw new ServiceError('PAYLOAD_TOO_LARGE', 'Entra snapshot exceeds the whole-run limit');
    }

    // Commit input-driven quarantines before applying authoritative changes.
    // Later threshold/admin rejection must never restore stale invalid access.
    await client.query('BEGIN');
    transactionOpen = true;
    await requireManualSyncActor(client, actor.id);
    const bindings = await client.query<BindingRow>(
      `SELECT external_id, scope_id, role, active, approval_revoked_at, quarantined_at FROM entra_groups
        WHERE approved_by IS NOT NULL ORDER BY external_id`,
    );
    const byId = new Map(bindings.rows.map((row) => [row.external_id, row]));
    const idCounts = new Map<string, number>();
    for (const snapshot of normalizedSnapshots) {
      if (UUID.test(snapshot.id)) idCounts.set(snapshot.id, (idCounts.get(snapshot.id) ?? 0) + 1);
    }
    const quarantined = new Set<string>();
    const prepared: PreparedSnapshot[] = [];
    const definitiveMissing: string[] = [];

    for (const snapshot of normalizedSnapshots) {
      if (!UUID.test(snapshot.id)) {
        skip(result, 'INVALID_GROUP_ID');
        continue;
      }
      const binding = byId.get(snapshot.id);
      if ((idCounts.get(snapshot.id) ?? 0) > 1) {
        skip(result, 'DUPLICATE_GROUP_ID');
        if (binding && !binding.approval_revoked_at && !quarantined.has(snapshot.id)) {
          await quarantineBinding(client, actor.id, snapshot.id, result, 'DUPLICATE_GROUP_ID');
          quarantined.add(snapshot.id);
        }
        continue;
      }
      if (!binding) { skip(result, 'UNBOUND_GROUP'); continue; }
      if (binding.approval_revoked_at) { skip(result, 'REVOKED_GROUP'); continue; }
      if (binding.quarantined_at) { skip(result, 'QUARANTINED_GROUP'); continue; }
      if (snapshot.status === 'invalid') {
        const code = snapshot.errorCode ?? 'INVALID_GROUP';
        skip(result, code);
        await quarantineBinding(client, actor.id, snapshot.id, result, code);
        continue;
      }
      if (snapshot.status === 'missing') { definitiveMissing.push(snapshot.id); continue; }
      if (typeof snapshot.displayName !== 'string' || snapshot.displayName.length > 256
        || !Array.isArray(snapshot.memberObjectIds)) {
        skip(result, 'MALFORMED_GROUP');
        await quarantineBinding(client, actor.id, snapshot.id, result, 'MALFORMED_GROUP');
        continue;
      }
      if (snapshot.memberObjectIds.length > MAX_GROUP_MEMBERS) {
        skip(result, 'GROUP_TOO_LARGE');
        await quarantineBinding(client, actor.id, snapshot.id, result, 'GROUP_TOO_LARGE');
        continue;
      }
      const unique = new Set<string>();
      let malformed = false;
      for (const memberId of snapshot.memberObjectIds) {
        if (!UUID.test(memberId) || unique.has(memberId)) { malformed = true; break; }
        unique.add(memberId);
      }
      if (malformed) {
        skip(result, 'MALFORMED_MEMBERS');
        await quarantineBinding(client, actor.id, snapshot.id, result, 'MALFORMED_MEMBERS');
        continue;
      }
      prepared.push({
        snapshot: { ...snapshot, displayName: snapshot.displayName, memberObjectIds: [...unique] },
        binding,
      });
    }

    await client.query(
      `INSERT INTO audit_log (principal_id, action, metadata)
       VALUES ($1, 'write', $2::jsonb)`,
      [actor.id, JSON.stringify({ operation: 'entra_membership_sync_screened', ...result })],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    durableQuarantine = { ...result, skipCodes: { ...result.skipCodes } };
    authoritativePhase = true;

    // Valid snapshots are authoritative, but this phase rolls back atomically
    // when a global removal threshold or administrator guard rejects the run.
    await client.query('BEGIN');
    transactionOpen = true;
    await requireManualSyncActor(client, actor.id);
    const currentBindings = await client.query<BindingRow>(
      `SELECT external_id, scope_id, role, active, approval_revoked_at, quarantined_at FROM entra_groups
        WHERE approved_by IS NOT NULL ORDER BY external_id`,
    );
    const currentById = new Map(currentBindings.rows.map((row) => [row.external_id, row]));
    const activeMembershipsBefore = await client.query(
      `SELECT count(*)::int AS count FROM scope_memberships
        WHERE source_kind = 'entra' AND active`,
    );
    let authoritativeDeactivations = 0;

    for (const candidate of prepared) {
      const { snapshot } = candidate;
      const binding = currentById.get(snapshot.id);
      if (!binding || binding.approval_revoked_at || binding.quarantined_at
        || quarantined.has(snapshot.id)) continue;
      const reactivated = await client.query<{ changed: boolean }>(
        `SELECT continuum_sync_observe_entra_group($1, $2, $3) AS changed`,
        [actor.id, snapshot.id, snapshot.displayName],
      );
      if (!candidate.binding.active && reactivated.rows[0]?.changed) result.groupsReactivated += 1;
      result.groupsSeen += 1;
      const externalIds = snapshot.memberObjectIds;
      if (externalIds.length > 0) {
        await client.query(
          `INSERT INTO principals (id, external_id, kind, display_name)
           SELECT gen_random_uuid(), external_id, 'user', external_id
             FROM unnest($1::text[]) external_id
           ON CONFLICT (external_id) DO NOTHING`,
          [externalIds],
        );
      }
      const principals = externalIds.length === 0 ? [] : (await client.query(
        `SELECT id, external_id, kind, disabled_at FROM principals
          WHERE external_id = ANY($1::text[])`,
        [externalIds],
      )).rows;
      if (principals.length !== externalIds.length
        || principals.some((principal) => principal.kind !== 'user')) {
        throw new ServiceError('CONFLICT', 'Entra member identity conflicts with an existing principal');
      }
      const disabledCount = principals.filter((row) => row.disabled_at !== null).length;
      if (disabledCount > 0) {
        result.skipCodes.DISABLED_PRINCIPAL =
          (result.skipCodes.DISABLED_PRINCIPAL ?? 0) + disabledCount;
      }
      const principalIds = principals
        .filter((row) => row.disabled_at === null)
        .map((row) => row.id as string);
      if (principalIds.length > 0) {
        const activated = await client.query<{ count: number }>(
          `SELECT continuum_activate_entra_memberships($1, $2, $3::uuid[])::int AS count`,
          [actor.id, snapshot.id, principalIds],
        );
        result.membershipsActive += Number(activated.rows[0]?.count ?? 0);
      }
      const deactivated = await client.query<{ count: number }>(
        `SELECT continuum_sync_deactivate_entra_memberships(
           $1, ARRAY[$2]::text[], $3::uuid[])::int AS count`,
        [actor.id, snapshot.id, principalIds],
      );
      const removed = Number(deactivated.rows[0]?.count ?? 0);
      result.membershipsDeactivated += removed;
      authoritativeDeactivations += removed;
    }

    const activeCount = currentBindings.rows.filter((row) => row.active
      && !row.approval_revoked_at && !row.quarantined_at).length;
    const missingActive = definitiveMissing.filter((id) => currentById.get(id)?.active);
    const deactivationPercent = activeCount === 0 ? 0 : (missingActive.length * 100) / activeCount;
    if (missingActive.length > 0 && deactivationPercent > maxPercent
      && !options.allowMassDeactivation) {
      throw new ServiceError('CONFLICT', 'suspicious Entra group deactivation threshold exceeded');
    }
    if (activeCount > 0 && normalizedSnapshots.length === 0) {
      throw new ServiceError('CONFLICT', 'empty Entra snapshot cannot deactivate bound groups');
    }
    if (missingActive.length > 0) {
      const memberships = await client.query<{ count: number }>(
        `SELECT continuum_sync_deactivate_entra_memberships(
           $1, $2::text[], NULL::uuid[])::int AS count`,
        [actor.id, missingActive],
      );
      const removed = Number(memberships.rows[0]?.count ?? 0);
      result.membershipsDeactivated += removed;
      authoritativeDeactivations += removed;
      const disappeared = await client.query<{ count: number }>(
        `SELECT continuum_sync_deactivate_entra_groups($1, $2::text[])::int AS count`,
        [actor.id, missingActive],
      );
      result.groupsDeactivated += Number(disappeared.rows[0]?.count ?? 0);
    }

    const priorMembershipCount = activeMembershipsBefore.rows[0]?.count ?? 0;
    const membershipDeactivationPercent = priorMembershipCount === 0 ? 0
      : (authoritativeDeactivations * 100) / priorMembershipCount;
    if (authoritativeDeactivations >= DEFAULT_MASS_MEMBERSHIP_DEACTIVATION_COUNT
      && membershipDeactivationPercent > maxPercent && !options.allowMassDeactivation) {
      throw new ServiceError('CONFLICT', 'suspicious Entra membership deactivation threshold exceeded');
    }

    // The synchronizing administrator and the organization must retain authority.
    await requireManualSyncActor(client, actor.id);
    const admins = await client.query(
      `SELECT count(DISTINCT m.principal_id)::int AS count
         FROM scope_memberships m
         JOIN scopes s ON s.id = m.scope_id
         JOIN principals p ON p.id = m.principal_id AND p.disabled_at IS NULL
        WHERE s.kind = 'org' AND s.name = '' AND m.active AND m.role = 'admin'`,
    );
    if ((admins.rows[0]?.count ?? 0) < 1) {
      throw new ServiceError('CONFLICT', 'membership sync cannot remove the last org administrator');
    }
    await client.query('SELECT continuum_record_entra_sync_success($1, $2)', [
      actor.id, maxStalenessHours,
    ]);
    await client.query(
      `INSERT INTO audit_log (principal_id, action, metadata)
       VALUES ($1, 'write', $2::jsonb)`,
      [actor.id, JSON.stringify({ operation: 'entra_membership_sync', ...result })],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    try {
      if (transactionOpen) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        if (authoritativePhase) {
          await auditRejectedSync(client, actor, error, durableQuarantine, maxStalenessHours);
        }
      }
      primaryError = error;
      throw error;
    } catch (handledError) {
      primaryError = handledError;
      throw handledError;
    }
  } finally {
    let cleanupError: unknown;
    if (lockAcquired) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock($1::bigint) AS unlocked', [SYNC_LOCK_ID],
        );
        if (unlocked.rows[0]?.unlocked !== true) {
          throw new Error('Entra membership sync advisory lock was not held');
        }
      } catch (error) { cleanupError = error; }
    }
    const unsafe = cleanupError ?? (!lockAcquired ? primaryError : undefined);
    client.release(unsafe instanceof Error ? unsafe
      : unsafe === undefined ? undefined : new Error('Membership sync connection is unsafe', { cause: unsafe }));
    if (cleanupError !== undefined) {
      if (primaryError !== undefined) {
        throw new AggregateError([primaryError, cleanupError], 'Membership sync failed and lock cleanup failed');
      }
      throw cleanupError;
    }
  }
}
