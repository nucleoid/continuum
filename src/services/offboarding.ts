import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Principal } from '../types.js';
import { requireOrgAdmin } from './access.js';
import { ServiceError } from './errors.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SYNC_LOCK_ID = '834641726154302119';
export const MAX_OFFBOARD_EVIDENCE_IDS = 100;
export const DEFAULT_OFFBOARD_BATCH_SIZE = 1_000;
export const MAX_OFFBOARD_BATCH_SIZE = 5_000;
// Retained as a wire-compatibility constant for older operators. It is no
// longer a whole-operation rejection threshold; execution is resumable.
export const MAX_OFFBOARD_AFFECTED_ROWS = 50_000;
export const MAX_OFFBOARD_MEMORIES = 10_000;

export interface OffboardingEvidence {
  memberPrincipalIds: string[];
  authorPrincipalIds: string[];
  memberPrincipalIdsTruncated: boolean;
  authorPrincipalIdsTruncated: boolean;
  acknowledgedPrincipalIds: string[];
  acknowledgedEvidenceHash: string;
}

export interface OriginalOffboardingEvidence {
  evidenceId: string;
  at: Date;
  memories: number;
  embeddings: number;
  memberships: number;
  aliases: number;
  entraBindings: number;
  auditQueries: number;
}

export interface AuditSelectionCounts {
  principal: number;
  scope: number;
  memory: number;
  scopeIds: number;
  linkedRequest: number;
  scopeName: number;
  total: number;
}

export interface OffboardingProgress {
  batch: number;
  batchSize: number;
  memoriesProcessed: number;
  auditRowsProcessed: number;
  memoriesRemaining: number;
  auditRowsRemaining: number;
}

export interface OffboardingResult {
  principalId: string; scopeId: string; memories: number; embeddings: number;
  memberships: number; aliases: number; entraBindings: number; affectedRows: number;
  liveMemories: number; auditQueries: number; auditRows: number;
  dirtyAuditRows: number; dirtyMemories: number;
  dryRun: boolean; alreadyOffboarded: boolean; pseudonym: string; scopePseudonym: string;
  complete: boolean; auditSelection: AuditSelectionCounts; progress: OffboardingProgress;
  evidence: OffboardingEvidence;
  originalOffboarding: OriginalOffboardingEvidence | null;
}

export interface OffboardingOptions {
  dryRun?: boolean;
  confirmationScopeId?: string;
  batchSize?: number;
}

export interface IncompleteOffboardingRun {
  principalId: string;
  scopeId: string;
  startedAt: Date;
  batches: number;
  memoriesProcessed: number;
  auditRowsProcessed: number;
}

export async function listIncompleteOffboardingRuns(
  pool: pg.Pool, actor: Principal,
): Promise<IncompleteOffboardingRun[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireOrgAdmin(client, actor.id);
    const result = await client.query(
      `SELECT principal_id::text, scope_id::text, started_at, batches,
              memories_processed, audit_rows_processed
         FROM principal_offboarding_runs
        WHERE completed_at IS NULL ORDER BY started_at, principal_id`,
    );
    await client.query('COMMIT');
    return result.rows.map((row) => ({
      principalId: row.principal_id as string,
      scopeId: row.scope_id as string,
      startedAt: row.started_at as Date,
      batches: Number(row.batches),
      memoriesProcessed: Number(row.memories_processed),
      auditRowsProcessed: Number(row.audit_rows_processed),
    }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function id(value: string, field: string): string {
  if (!UUID.test(value)) throw new ServiceError('INVALID_INPUT', `${field} must be a UUID`);
  return value.toLowerCase();
}

export function erasedPrincipalPseudonym(principalId: string): string {
  return `erased-${principalId.replaceAll('-', '').slice(0, 12).toLowerCase()}`;
}

export function erasedScopePseudonym(scopeId: string): string {
  return `erased-user-${scopeId.toLowerCase()}`;
}

function evidencePrincipalIds(evidence: Pick<
  OffboardingEvidence, 'memberPrincipalIds' | 'authorPrincipalIds'
>): string[] {
  return [...new Set([...evidence.memberPrincipalIds, ...evidence.authorPrincipalIds])].sort();
}

function evidenceHash(principalId: string, scopeId: string, principalIds: string[]): string {
  return createHash('sha256')
    .update([principalId, scopeId, ...principalIds].join('\n'), 'utf8')
    .digest('hex');
}

async function ownershipEvidence(
  client: pg.PoolClient,
  principalId: string,
  scopeId: string,
): Promise<Omit<OffboardingEvidence, 'acknowledgedPrincipalIds' | 'acknowledgedEvidenceHash'>> {
  const members = await client.query(
    `SELECT DISTINCT principal_id::text AS id FROM scope_memberships
      WHERE scope_id = $1 AND principal_id <> $2 ORDER BY id LIMIT $3`,
    [scopeId, principalId, MAX_OFFBOARD_EVIDENCE_IDS + 1],
  );
  const authors = await client.query(
    `SELECT DISTINCT author_id::text AS id FROM memories
      WHERE scope_id = $1 AND author_id <> $2 ORDER BY id LIMIT $3`,
    [scopeId, principalId, MAX_OFFBOARD_EVIDENCE_IDS + 1],
  );
  return {
    memberPrincipalIds: members.rows.slice(0, MAX_OFFBOARD_EVIDENCE_IDS)
      .map((row) => row.id as string),
    authorPrincipalIds: authors.rows.slice(0, MAX_OFFBOARD_EVIDENCE_IDS)
      .map((row) => row.id as string),
    memberPrincipalIdsTruncated: members.rows.length > MAX_OFFBOARD_EVIDENCE_IDS,
    authorPrincipalIdsTruncated: authors.rows.length > MAX_OFFBOARD_EVIDENCE_IDS,
  };
}

function requireCompleteEvidence(evidence: Pick<
  OffboardingEvidence, 'memberPrincipalIdsTruncated' | 'authorPrincipalIdsTruncated'
>): void {
  if (evidence.memberPrincipalIdsTruncated || evidence.authorPrincipalIdsTruncated) {
    throw new ServiceError(
      'CONFLICT',
      `owned-scope evidence exceeds the bounded limit of ${MAX_OFFBOARD_EVIDENCE_IDS} principal IDs`,
    );
  }
}

export async function mapOwnedUserScope(
  pool: pg.Pool, actor: Principal, principalId: string, scopeId: string,
  allowOtherActiveMembers = false,
): Promise<{
  principalId: string; scopeId: string; created: boolean; allowOtherActiveMembers: boolean;
  acknowledgedPrincipalIds: string[]; acknowledgedEvidenceHash: string; approvalId: string;
}> {
  principalId = id(principalId, 'principal id');
  scopeId = id(scopeId, 'scope id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await requireOrgAdmin(client, actor.id);
    const principal = await client.query(
      `SELECT id FROM principals WHERE id = $1 AND kind = 'user'
        AND offboarded_at IS NULL FOR UPDATE`, [principalId],
    );
    if (!principal.rowCount) throw new ServiceError('INVALID_INPUT', 'active user principal not found');
    const scope = await client.query(
      `SELECT id FROM scopes WHERE id = $1 AND kind = 'user' FOR UPDATE`, [scopeId],
    );
    if (!scope.rowCount) throw new ServiceError('INVALID_SCOPE', 'user scope not found');
    const history = await client.query(
      `SELECT 1 FROM scope_memberships
        WHERE principal_id = $1 AND scope_id = $2 AND role IN ('writer', 'admin') LIMIT 1`,
      [principalId, scopeId],
    );
    if (!history.rowCount) {
      throw new ServiceError(
        'CONFLICT', 'principal has no writer or admin membership history on the user scope',
      );
    }
    const current = await ownershipEvidence(client, principalId, scopeId);
    requireCompleteEvidence(current);
    const currentIds = evidencePrincipalIds(current);
    const existing = await client.query(
      `SELECT principal_id, scope_id, acknowledged_principal_ids,
              acknowledged_evidence_hash
         FROM principal_user_scopes
        WHERE principal_id = $1 OR scope_id = $2 FOR UPDATE`, [principalId, scopeId],
    );
    if (existing.rows.some(
      (row) => row.principal_id !== principalId || row.scope_id !== scopeId,
    )) {
      throw new ServiceError('CONFLICT', 'principal or user scope already has a different owner mapping');
    }
    const priorIds = (existing.rows[0]?.acknowledged_principal_ids as string[] | undefined) ?? [];
    const unacknowledged = currentIds.filter((principal) => !priorIds.includes(principal));
    if (unacknowledged.length && !allowOtherActiveMembers) {
      throw new ServiceError(
        'CONFLICT',
        'user scope has other active members or other principal history or authorship; explicit allowOtherActiveMembers override is required',
      );
    }
    const created = !existing.rows[0];
    const acknowledgedPrincipalIds = allowOtherActiveMembers ? currentIds : priorIds;
    const acknowledgedEvidenceHash = evidenceHash(
      principalId, scopeId, acknowledgedPrincipalIds,
    );
    const acknowledgementChanged = created
      || acknowledgedEvidenceHash !== existing.rows[0]?.acknowledged_evidence_hash;
    if (created) {
      await client.query(
        `INSERT INTO principal_user_scopes
           (principal_id, scope_id, mapped_by, acknowledged_principal_ids,
            acknowledged_evidence_hash)
         VALUES ($1, $2, $3, $4::uuid[], $5)`,
        [principalId, scopeId, actor.id, acknowledgedPrincipalIds, acknowledgedEvidenceHash],
      );
    } else if (acknowledgementChanged) {
      await client.query(
        `UPDATE principal_user_scopes
            SET acknowledged_principal_ids = $2::uuid[], acknowledged_evidence_hash = $3,
                mapped_by = $4, mapped_at = now()
          WHERE principal_id = $1`,
        [principalId, acknowledgedPrincipalIds, acknowledgedEvidenceHash, actor.id],
      );
    }
    if (acknowledgementChanged) {
      const approval = await client.query(
        `INSERT INTO principal_user_scope_approvals
           (principal_id, scope_id, approved_by, acknowledged_principal_ids,
            acknowledged_evidence_hash)
         VALUES ($1, $2, $3, $4::uuid[], $5) RETURNING id::text AS id`,
        [principalId, scopeId, actor.id, acknowledgedPrincipalIds, acknowledgedEvidenceHash],
      );
      await client.query(
        `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
         VALUES ($1, 'write', $2, $3::jsonb)`,
        [actor.id, scopeId, JSON.stringify({
          operation: created ? 'principal_user_scope_mapped'
            : 'principal_user_scope_acknowledgement_replaced',
          principal_id: principalId,
          shared_scope_acknowledged: acknowledgedPrincipalIds.length > 0,
          acknowledged_principal_ids: acknowledgedPrincipalIds,
          acknowledged_evidence_hash: acknowledgedEvidenceHash,
          approval_id: approval.rows[0].id,
          other_member_principal_ids: current.memberPrincipalIds,
          other_author_principal_ids: current.authorPrincipalIds,
          other_member_principal_ids_truncated: current.memberPrincipalIdsTruncated,
          other_author_principal_ids_truncated: current.authorPrincipalIdsTruncated,
        })],
      );
    }
    const approval = await client.query(
      `SELECT id::text AS id FROM principal_user_scope_approvals
        WHERE principal_id = $1 AND scope_id = $2 ORDER BY id DESC LIMIT 1`,
      [principalId, scopeId],
    );
    await client.query('COMMIT');
    return {
      principalId, scopeId, created,
      allowOtherActiveMembers: acknowledgedPrincipalIds.length > 0,
      acknowledgedPrincipalIds, acknowledgedEvidenceHash, approvalId: approval.rows[0].id,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

const PRESERVED_AUDIT_OPERATIONS = [
  'principal_user_scope_mapped',
  'principal_user_scope_acknowledgement_replaced',
  'principal_memory_erased',
  'principal_offboarded',
  'principal_offboarding_repaired',
] as const;

// Every producer is classified explicitly. A UUID-looking string or number is
// not safe merely because of its JSON shape: only named fields for the exact
// operation/source survive erasure.
const AUDIT_OPERATION_POLICIES = [
  { operation: 'api_key_issued', safeFields: ['key_id', 'service_principal_id'] },
  { operation: 'api_key_revoked', safeFields: ['key_id', 'service_principal_id', 'key_revoked_at'] },
  { operation: 'api_key_rotated', safeFields: ['key_id', 'service_principal_id', 'key_rotated_at'] },
  { operation: 'create_scope', safeFields: ['created', 'kind'] },
  { operation: 'entra_group_binding_provisioned', safeFields: ['group_id', 'scope_id', 'role', 'previous_scope_id', 'previous_role'] },
  { operation: 'entra_group_binding_reactivated', safeFields: ['group_id', 'scope_id', 'role', 'previous_scope_id', 'previous_role'] },
  { operation: 'entra_group_binding_updated', safeFields: ['group_id', 'scope_id', 'role', 'previous_scope_id', 'previous_role'] },
  { operation: 'entra_group_binding_revoked', safeFields: ['group_id', 'role', 'memberships_deactivated'] },
  { operation: 'entra_membership_sync', safeFields: ['groups_seen', 'groups_reactivated', 'groups_deactivated', 'memberships_active', 'memberships_deactivated', 'groups_skipped'] },
  { operation: 'entra_membership_sync_rejected', safeFields: ['reason', 'last_success_at', 'max_staleness_hours', 'stale', 'stale_memberships_deactivated', 'groups_deactivated', 'memberships_deactivated'] },
  { operation: 'entra_membership_sync_screened', safeFields: ['groups_seen', 'groups_reactivated', 'groups_deactivated', 'memberships_active', 'memberships_deactivated', 'groups_skipped'] },
  { operation: 'get_memory', safeFields: ['request_id', 'record_kind'] },
  { operation: 'list_memories', safeFields: ['request_id', 'record_kind', 'state', 'scope_filtered', 'type_filter', 'limit', 'offset', 'count'] },
  { operation: 'principal_disabled', safeFields: ['principal_id'] },
  { operation: 'principal_memory_erased', safeFields: ['principal_id'] },
  { operation: 'principal_reactivated', safeFields: ['principal_id', 'previously_offboarded'] },
  { operation: 'service_principal_provisioned', safeFields: ['service_principal_id', 'external_id'] },
] as const;

const AUDIT_SOURCE_POLICIES = [
  { source: 'ado-workitem', safeFields: [] },
  { source: 'audit-retention', safeFields: ['cutoff', 'retention_days', 'first_id', 'last_id', 'first_at', 'last_at', 'deleted_count', 'export_mode', 'export_sha256', 'run_id', 'batch_number'] },
  { source: 'deploy-event', safeFields: [] },
  { source: 'github-branch', safeFields: [] },
  { source: 'github-pr', safeFields: [] },
  { source: 'lifecycle', safeFields: [] },
  { source: 'manual', safeFields: [] },
  { source: 'terminal-summary', safeFields: [] },
] as const;

function policyMetadataSql(discriminator: 'operation' | 'source', value: string,
  safeFields: readonly string[]): string {
  const fields = [discriminator, ...safeFields].map((field) => `'${field}'`).join(',');
  return `(SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
    FROM jsonb_each(a.metadata) entry WHERE entry.key = ANY(ARRAY[${fields}]::text[]))`;
}

const AUDIT_CLASSIFIED_METADATA = `(CASE
${AUDIT_OPERATION_POLICIES.map((policy) =>
    `WHEN a.metadata->>'operation' = '${policy.operation}' THEN ${policyMetadataSql('operation', policy.operation, policy.safeFields)}`)
    .join('\n')}
${AUDIT_SOURCE_POLICIES.map((policy) =>
    `WHEN a.metadata->>'source' = '${policy.source}' THEN ${policyMetadataSql('source', policy.source, policy.safeFields)}`)
    .join('\n')}
ELSE NULL END)`;
const AUDIT_REDACTED_METADATA = `'${JSON.stringify({ redacted: 'principal_offboarding' })}'::jsonb`;
const AUDIT_EXPECTED_METADATA = `(CASE
  WHEN ${AUDIT_CLASSIFIED_METADATA} IS NOT NULL THEN ${AUDIT_CLASSIFIED_METADATA}
  ELSE ${AUDIT_REDACTED_METADATA} END)`;

const AUDIT_DIRTY = `(a.query IS NOT NULL
  OR a.metadata IS DISTINCT FROM ${AUDIT_EXPECTED_METADATA})`;
const AUDIT_NOT_PRESERVED = `COALESCE(a.metadata->>'operation', '')
  <> ALL($3::text[])`;

type AuditCursorColumn = 'audit_principal_cursor' | 'audit_scope_cursor'
  | 'audit_memory_cursor' | 'audit_scope_ids_cursor' | 'audit_linked_cursor';

async function selectAuditBranch(
  client: pg.PoolClient,
  args: {
    principalId: string; scopeId: string; cursor: string; cursorColumn: AuditCursorColumn;
    reason: 'principal' | 'scope' | 'memory' | 'scope_ids' | 'linked_request';
    from: string; where: string; remaining: number;
  },
): Promise<number> {
  if (args.remaining <= 0) return 0;
  const boundedScan = args.reason === 'scope_ids'
    ? `SELECT a.* FROM audit_log a
        WHERE a.id > $4 AND $1::uuid IS NOT NULL AND $2::uuid IS NOT NULL
        ORDER BY a.id LIMIT $5`
    : `SELECT a.* ${args.from}
        WHERE a.id > $4 AND $1::uuid IS NOT NULL AND $2::uuid IS NOT NULL AND ${args.where}
        ORDER BY a.id LIMIT $5`;
  const selected = await client.query(
    `WITH scan AS MATERIALIZED (${boundedScan}),
     candidates AS MATERIALIZED (
       SELECT a.* FROM scan a
        WHERE ${args.reason === 'scope_ids' ? args.where : 'TRUE'}
     ), selected AS (
       SELECT a.id, a.metadata->>'request_id' AS request_id
         FROM candidates a
        WHERE ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED}
     ), inserted AS (
       INSERT INTO offboarding_audit_targets (id, request_id, reason)
       SELECT id, request_id, $6 FROM selected
       ON CONFLICT (id) DO NOTHING RETURNING id
     )
     SELECT COALESCE((SELECT max(id) FROM scan), $4::bigint)::text AS cursor,
            (SELECT count(*)::int FROM inserted) AS inserted`,
    [args.scopeId, args.principalId, [...PRESERVED_AUDIT_OPERATIONS], args.cursor,
      args.remaining, args.reason],
  );
  const cursor = selected.rows[0].cursor as string;
  if (BigInt(cursor) > BigInt(args.cursor)) {
    await client.query(
      `UPDATE principal_offboarding_runs SET ${args.cursorColumn} = $2 WHERE principal_id = $1`,
      [args.principalId, cursor],
    );
  }
  return Number(selected.rows[0].inserted);
}

async function auditWorkRemains(
  client: pg.PoolClient, scopeId: string, principalId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM audit_log a
        WHERE a.principal_id = $2 AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED} LIMIT 1
     ) OR EXISTS (
       SELECT 1 FROM audit_log a
        WHERE a.scope_id = $1 AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED} LIMIT 1
     ) OR EXISTS (
       SELECT 1 FROM memories m JOIN audit_log a ON a.memory_id = m.id
        WHERE m.scope_id = $1 AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED} LIMIT 1
     ) OR EXISTS (
       SELECT 1 FROM audit_log a
        WHERE a.metadata ? 'scope_ids'
          AND a.metadata->'scope_ids' @> jsonb_build_array($1::text)
          AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED} LIMIT 1
     ) OR EXISTS (
       SELECT 1 FROM principal_offboarding_audit_requests r
       JOIN audit_log a ON a.metadata ? 'request_id'
        AND a.metadata->>'request_id' = r.request_id
        WHERE r.principal_id = $2 AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED} LIMIT 1
     ) AS remains`,
    [scopeId, principalId, [...PRESERVED_AUDIT_OPERATIONS]],
  );
  return result.rows[0].remains as boolean;
}

async function auditCursorWorkRemains(
  client: pg.PoolClient, scopeId: string, principalId: string,
  cursors: Record<AuditCursorColumn, string>,
): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM audit_log a WHERE a.principal_id = $2 AND a.id > $3 LIMIT 1
     ) OR EXISTS (
       SELECT 1 FROM audit_log a WHERE a.scope_id = $1 AND a.id > $4 LIMIT 1
     ) OR EXISTS (
       SELECT 1 FROM memories m JOIN audit_log a ON a.memory_id = m.id
        WHERE m.scope_id = $1 AND a.id > $5 LIMIT 1
     ) OR EXISTS (
       SELECT 1 FROM audit_log a
        WHERE a.metadata ? 'scope_ids'
          AND a.metadata->'scope_ids' @> jsonb_build_array($1::text)
          AND a.id > $6 LIMIT 1
     ) OR EXISTS (
       SELECT 1 FROM principal_offboarding_audit_requests r
       JOIN audit_log a ON a.metadata ? 'request_id'
        AND a.metadata->>'request_id' = r.request_id
        WHERE r.principal_id = $2 AND a.id > $7 LIMIT 1
     ) AS remains`,
    [scopeId, principalId, cursors.audit_principal_cursor,
      cursors.audit_scope_cursor, cursors.audit_memory_cursor,
      cursors.audit_scope_ids_cursor, cursors.audit_linked_cursor],
  );
  return result.rows[0].remains as boolean;
}

async function stateWorkRemains(
  client: pg.PoolClient, scopeId: string, principalId: string, memoryCursor?: string | null,
): Promise<{ memories: boolean; embeddings: boolean; memberships: boolean;
  aliases: boolean; entraBindings: boolean }> {
  const result = await client.query(
    `SELECT
       EXISTS (SELECT 1 FROM memories WHERE scope_id = $1 AND (
         ($3::uuid IS NOT NULL AND id > $3)
         OR ($3::uuid IS NULL AND (
           type <> 'context' OR title <> '[erased]' OR body <> '[erased]'
           OR metadata <> '{}'::jsonb OR tags <> '{}'::text[] OR source <> 'erased'
           OR source_ref IS NOT NULL OR state <> 'archived' OR supersedes_id IS NOT NULL
           OR promoted_to_id IS NOT NULL OR expires_at IS NOT NULL OR last_verified IS NOT NULL
         ))
       ) LIMIT 1) AS memories,
       EXISTS (SELECT 1 FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
         WHERE m.scope_id = $1 LIMIT 1) AS embeddings,
       EXISTS (SELECT 1 FROM scope_memberships WHERE scope_id = $1 AND active LIMIT 1) AS memberships,
       EXISTS (SELECT 1 FROM principal_aliases WHERE principal_id = $2 LIMIT 1) AS aliases,
       EXISTS (SELECT 1 FROM entra_groups WHERE scope_id = $1
         AND (active OR approval_revoked_at IS NULL) LIMIT 1) AS entra_bindings`,
    [scopeId, principalId, memoryCursor ?? null],
  );
  return result.rows[0] as {
    memories: boolean; embeddings: boolean; memberships: boolean;
    aliases: boolean; entraBindings: boolean;
  };
}

async function boundedAuditPreview(
  client: pg.PoolClient,
  scopeId: string,
  principalId: string,
  limit: number,
): Promise<{ selection: AuditSelectionCounts; queries: number }> {
  const selected = await client.query(
    `WITH direct_candidates AS (
       (SELECT a.id, a.query, a.metadata->>'request_id' AS request_id,
              'principal'::text AS reason, 1 AS priority
         FROM audit_log a
        WHERE a.principal_id = $2 AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED}
        ORDER BY a.id LIMIT $4)
       UNION ALL
       (SELECT a.id, a.query, a.metadata->>'request_id', 'scope', 2
         FROM audit_log a
        WHERE a.scope_id = $1 AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED}
        ORDER BY a.id LIMIT $4)
       UNION ALL
       (SELECT a.id, a.query, a.metadata->>'request_id', 'memory', 3
         FROM memories m JOIN audit_log a ON a.memory_id = m.id
        WHERE m.scope_id = $1 AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED}
        ORDER BY a.id LIMIT $4)
       UNION ALL
       (SELECT a.id, a.query, a.metadata->>'request_id', 'scope_ids', 4
         FROM audit_log a
        WHERE a.metadata ? 'scope_ids'
          AND a.metadata->'scope_ids' @> jsonb_build_array($1::text)
          AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED}
        ORDER BY a.id LIMIT $4)
     ), direct AS (
       SELECT DISTINCT ON (id) id, query, request_id, reason
         FROM direct_candidates ORDER BY id, priority
     ), request_ids AS (
       SELECT DISTINCT request_id FROM direct WHERE request_id IS NOT NULL
       UNION
       SELECT request_id FROM principal_offboarding_audit_requests
        WHERE principal_id = $2
     ), linked AS (
       SELECT a.id, a.query, 'linked_request'::text AS reason
         FROM request_ids r JOIN audit_log a
           ON a.metadata ? 'request_id' AND a.metadata->>'request_id' = r.request_id
        WHERE ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED}
          AND NOT EXISTS (SELECT 1 FROM direct d WHERE d.id = a.id)
        ORDER BY a.id LIMIT $4
     ), targets AS (
       SELECT id, query, reason FROM direct
       UNION ALL
       SELECT id, query, reason FROM linked
     ), bounded_targets AS (
       SELECT * FROM targets ORDER BY id LIMIT $4
     )
     SELECT count(*) FILTER (WHERE reason = 'principal')::int AS principal,
            count(*) FILTER (WHERE reason = 'scope')::int AS scope,
            count(*) FILTER (WHERE reason = 'memory')::int AS memory,
            count(*) FILTER (WHERE reason = 'scope_ids')::int AS scope_ids,
            count(*) FILTER (WHERE reason = 'linked_request')::int AS linked_request,
            count(*)::int AS total,
            count(*) FILTER (WHERE query IS NOT NULL)::int AS queries
       FROM bounded_targets`,
    [scopeId, principalId, [...PRESERVED_AUDIT_OPERATIONS], limit],
  );
  const row = selected.rows[0];
  return {
    selection: {
      principal: Number(row.principal), scope: Number(row.scope), memory: Number(row.memory),
      scopeIds: Number(row.scope_ids), linkedRequest: Number(row.linked_request),
      scopeName: 0, total: Number(row.total),
    },
    queries: Number(row.queries),
  };
}

function requestedBatchSize(value: number | undefined): number {
  const batchSize = value ?? DEFAULT_OFFBOARD_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_OFFBOARD_BATCH_SIZE) {
    throw new ServiceError(
      'INVALID_INPUT', `batchSize must be an integer from 1 through ${MAX_OFFBOARD_BATCH_SIZE}`,
    );
  }
  return batchSize;
}

async function startOffboardingRunEvent(
  client: pg.PoolClient,
  run: Record<string, unknown>,
  initiatedBy: string,
  evidence: OffboardingEvidence,
): Promise<void> {
  // phase started: immutable authorization exists before the first fence/write.
  await client.query(
    `INSERT INTO principal_offboarding_run_events
       (run_id, principal_id, scope_id, phase, initiated_by, finalized_by,
        approval_id, approval_evidence_hash, evidence)
     VALUES ($1, $2, $3, 'started', $4, NULL, $5, $6, $7::jsonb)
     ON CONFLICT (run_id, phase) DO NOTHING`,
    [run.run_id, run.principal_id, run.scope_id, initiatedBy, run.approval_id,
      run.approval_evidence_hash, JSON.stringify(evidence)],
  );
}

async function finalizeOffboardingRun(
  client: pg.PoolClient,
  run: Record<string, unknown>,
  finalizedBy: string,
  completionEvidence: Record<string, unknown>,
): Promise<void> {
  // phase completed: preserve both the original initiator and finalizer.
  const inserted = await client.query(
    `INSERT INTO principal_offboarding_run_events
       (run_id, principal_id, scope_id, phase, initiated_by, finalized_by,
        approval_id, approval_evidence_hash, evidence)
     SELECT started.run_id, started.principal_id, started.scope_id, 'completed',
            started.initiated_by, $2, started.approval_id,
            started.approval_evidence_hash, $3::jsonb
       FROM principal_offboarding_run_events started
      WHERE started.run_id = $1 AND started.phase = 'started'
     ON CONFLICT (run_id, phase) DO NOTHING RETURNING run_id`,
    [run.run_id, finalizedBy, JSON.stringify(completionEvidence)],
  );
  if (!inserted.rowCount) {
    throw new Error('offboarding completion evidence could not be appended');
  }
  const completed = await client.query(
    `UPDATE principal_offboarding_runs SET completed_at = now()
      WHERE run_id = $1 AND completed_at IS NULL RETURNING run_id`, [run.run_id],
  );
  if (!completed.rowCount) throw new Error('offboarding run could not be finalized');
}

export async function offboardPrincipal(
  pool: pg.Pool, actor: Principal, principalId: string,
  dryRunOrOptions: boolean | OffboardingOptions = false,
): Promise<OffboardingResult> {
  const options = typeof dryRunOrOptions === 'boolean'
    ? { dryRun: dryRunOrOptions } : dryRunOrOptions;
  const dryRun = options.dryRun ?? false;
  if (dryRun) return previewOffboarding(pool, actor, principalId, options);
  return offboardPrincipalCore(pool, actor, principalId, options);
}

async function previewOffboarding(
  pool: pg.Pool, actor: Principal, principalId: string, options: OffboardingOptions,
): Promise<OffboardingResult> {
  return offboardPrincipalCore(pool, actor, principalId, { ...options, dryRun: true });
}

async function offboardPrincipalCore(
  pool: pg.Pool, actor: Principal, principalId: string,
  dryRunOrOptions: boolean | OffboardingOptions = false,
): Promise<OffboardingResult> {
  principalId = id(principalId, 'principal id');
  const options = typeof dryRunOrOptions === 'boolean'
    ? { dryRun: dryRunOrOptions } : dryRunOrOptions;
  const dryRun = options.dryRun ?? false;
  const batchSize = requestedBatchSize(options.batchSize);
  const confirmationScopeId = options.confirmationScopeId === undefined
    ? undefined : id(options.confirmationScopeId, 'confirmation scope id');
  const client = await pool.connect();
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    if (!dryRun) {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [SYNC_LOCK_ID]);
    }
    await requireOrgAdmin(client, actor.id);
    const target = await client.query(
      `SELECT id, display_name, disabled_at, offboarded_at, reactivated_at
         FROM principals WHERE id = $1 AND kind = 'user'${dryRun ? '' : ' FOR UPDATE'}`, [principalId],
    );
    if (!target.rowCount) throw new ServiceError('INVALID_INPUT', 'user principal not found');
    const mapping = await client.query(
      `SELECT pus.scope_id, pus.acknowledged_principal_ids,
              pus.acknowledged_evidence_hash, approval.id::text AS approval_id
         FROM principal_user_scopes pus
         JOIN scopes s ON s.id = pus.scope_id AND s.kind = 'user'
         JOIN LATERAL (
           SELECT id FROM principal_user_scope_approvals
            WHERE principal_id = pus.principal_id AND scope_id = pus.scope_id
            ORDER BY id DESC LIMIT 1
         ) approval ON TRUE
        WHERE pus.principal_id = $1${dryRun ? '' : ' FOR UPDATE OF pus, s'}`, [principalId],
    );
    if (!mapping.rowCount) {
      throw new ServiceError('CONFLICT', 'principal has no explicit owned user scope mapping');
    }
    const scopeId = mapping.rows[0].scope_id as string;
    const approvalId = mapping.rows[0].approval_id as string;
    if (!dryRun && confirmationScopeId === undefined) {
      throw new ServiceError('INVALID_INPUT', 'confirmation scope id is required for erasure');
    }
    if (!dryRun && confirmationScopeId !== scopeId) {
      throw new ServiceError('CONFLICT', 'confirmation scope id does not match the owned user scope');
    }
    const scopeState = await client.query('SELECT name FROM scopes WHERE id = $1', [scopeId]);
    const scopeName = scopeState.rows[0].name as string;
    const history = await client.query(
      `SELECT 1 FROM scope_memberships
        WHERE principal_id = $1 AND scope_id = $2 AND role IN ('writer', 'admin') LIMIT 1`,
      [principalId, scopeId],
    );
    if (!history.rowCount) {
      throw new ServiceError(
        'CONFLICT', 'principal has no writer or admin membership history on the owned user scope',
      );
    }
    const ownership = await ownershipEvidence(client, principalId, scopeId);
    requireCompleteEvidence(ownership);
    const currentEvidenceIds = evidencePrincipalIds(ownership);
    const acknowledgedPrincipalIds = (
      mapping.rows[0].acknowledged_principal_ids as string[]
    ).map((value) => value.toLowerCase()).sort();
    const acknowledgedEvidenceHash = mapping.rows[0].acknowledged_evidence_hash as string;
    if (acknowledgedEvidenceHash !== evidenceHash(
      principalId, scopeId, acknowledgedPrincipalIds,
    )) {
      throw new ServiceError('CONFLICT', 'owned-scope acknowledgement evidence hash is invalid');
    }
    if (currentEvidenceIds.some((principal) => !acknowledgedPrincipalIds.includes(principal))) {
      throw new ServiceError(
        'CONFLICT',
        'owned user scope has unacknowledged principal evidence; review and replace the acknowledgement',
      );
    }
    const evidence: OffboardingEvidence = {
      ...ownership, acknowledgedPrincipalIds, acknowledgedEvidenceHash,
    };
    let run = await client.query(
      `SELECT * FROM principal_offboarding_runs WHERE principal_id = $1${dryRun ? '' : ' FOR UPDATE'}`,
      [principalId],
    );
    const resumedRun = run.rows[0]?.completed_at === null;
    const resumedState = resumedRun
      ? await stateWorkRemains(client, scopeId, principalId, run.rows[0].memory_cursor) : null;
    const resumedAuditRemains = resumedRun
      ? await auditCursorWorkRemains(
        client, scopeId, principalId, run.rows[0] as Record<AuditCursorColumn, string>,
      ) : false;
    const state = resumedRun ? null : await client.query(
      `SELECT
         (SELECT count(*)::int FROM (SELECT 1 FROM memories WHERE scope_id = $1 LIMIT $3) x) AS memories,
         (SELECT count(*)::int FROM (SELECT 1 FROM memories WHERE scope_id = $1 AND state = 'live' LIMIT $3) x) AS live_memories,
         (SELECT count(*)::int FROM (SELECT 1 FROM memories WHERE scope_id = $1 AND (
           type <> 'context' OR title <> '[erased]' OR body <> '[erased]'
           OR metadata <> '{}'::jsonb OR tags <> '{}'::text[] OR source <> 'erased'
           OR source_ref IS NOT NULL OR state <> 'archived' OR supersedes_id IS NOT NULL
           OR promoted_to_id IS NOT NULL OR expires_at IS NOT NULL OR last_verified IS NOT NULL
         ) LIMIT $3) x) AS dirty_memories,
         (SELECT count(*)::int FROM (SELECT 1 FROM memory_embeddings e
           JOIN memories m ON m.id = e.memory_id WHERE m.scope_id = $1 LIMIT $3) x) AS embeddings,
         (SELECT count(*)::int FROM (SELECT 1 FROM scope_memberships WHERE scope_id = $1 AND active LIMIT $3) x) AS memberships,
         (SELECT count(*)::int FROM (SELECT 1 FROM principal_aliases WHERE principal_id = $2 LIMIT $3) x) AS aliases,
         (SELECT count(*)::int FROM (SELECT 1 FROM entra_groups WHERE scope_id = $1
           AND (active OR approval_revoked_at IS NULL) LIMIT $3) x) AS entra_bindings`,
      [scopeId, principalId, batchSize + 1],
    );
    const audit = resumedRun ? {
      selection: run.rows[0].initial_audit_selection as AuditSelectionCounts,
      queries: Number(run.rows[0].initial_audit_queries),
    } : await boundedAuditPreview(client, scopeId, principalId, batchSize);
    const row = resumedRun ? {
      memories: run.rows[0].initial_memories,
      live_memories: run.rows[0].initial_memories,
      dirty_memories: resumedState!.memories ? 1 : 0,
      embeddings: run.rows[0].initial_embeddings,
      memberships: run.rows[0].initial_memberships,
      aliases: run.rows[0].initial_aliases,
      entra_bindings: run.rows[0].initial_entra_bindings,
    } : state!.rows[0];
    const memories = Number(row.memories);
    const liveMemories = Number(row.live_memories);
    const dirtyMemories = Number(row.dirty_memories);
    const embeddings = Number(row.embeddings);
    const memberships = Number(row.memberships);
    const aliases = Number(row.aliases);
    const entraBindings = Number(row.entra_bindings);
    const auditRows = audit.selection.total;
    const auditQueries = audit.queries;
    const dirtyAuditRows = resumedRun ? (resumedAuditRemains ? 1 : 0) : auditRows;
    const affectedRows = (dirtyMemories * 2) + embeddings + memberships + aliases
      + entraBindings + auditRows + 4;
    const original = await client.query(
      `SELECT id::text AS id, at, memories, embeddings, memberships, aliases,
              entra_bindings, audit_rows, audit_queries
         FROM principal_offboarding_events
        WHERE principal_id = $1 AND NOT repair ORDER BY id ASC LIMIT 1`, [principalId],
    );
    const originalOffboarding: OriginalOffboardingEvidence | null = original.rows[0] ? {
      evidenceId: original.rows[0].id as string,
      at: original.rows[0].at as Date,
      memories: Number(original.rows[0].memories),
      embeddings: Number(original.rows[0].embeddings),
      memberships: Number(original.rows[0].memberships),
      aliases: Number(original.rows[0].aliases),
      entraBindings: Number(original.rows[0].entra_bindings),
      auditQueries: Number(original.rows[0].audit_queries),
    } : null;
    const pseudonym = erasedPrincipalPseudonym(principalId);
    const scopePseudonym = erasedScopePseudonym(scopeId);
    const clean = resumedRun
      ? !resumedState!.memories && !resumedState!.embeddings && !resumedState!.memberships
        && !resumedState!.aliases && !resumedState!.entraBindings && !resumedAuditRemains
      : dirtyMemories === 0 && embeddings === 0 && memberships === 0
        && aliases === 0 && entraBindings === 0 && auditRows === 0;
    const wasOffboarded = target.rows[0].offboarded_at !== null;
    const alreadyOffboarded = !resumedRun && wasOffboarded
      && target.rows[0].disabled_at !== null
      && target.rows[0].reactivated_at === null
      && target.rows[0].display_name === pseudonym
      && scopeName === scopePseudonym && clean;
    const previewProgress: OffboardingProgress = {
      batch: 0, batchSize, memoriesProcessed: 0, auditRowsProcessed: 0,
      memoriesRemaining: dirtyMemories, auditRowsRemaining: dirtyAuditRows,
    };
    const baseResult = {
      principalId, scopeId, memories, liveMemories, embeddings, memberships, aliases,
      entraBindings, affectedRows, auditQueries, auditRows, dirtyAuditRows, dirtyMemories,
      dryRun, alreadyOffboarded, complete: alreadyOffboarded, pseudonym, scopePseudonym,
      evidence, auditSelection: audit.selection, progress: previewProgress, originalOffboarding,
    } satisfies OffboardingResult;
    if (dryRun) { await client.query('ROLLBACK'); return baseResult; }
    if (alreadyOffboarded) { await client.query('COMMIT'); return baseResult; }

    if (run.rows[0]?.completed_at !== null && run.rows[0]?.completed_at !== undefined) {
      await client.query(
        `UPDATE principal_offboarding_runs
            SET run_id = gen_random_uuid(), initiated_by = $2::uuid, approval_id = $3,
                approval_evidence_hash = $12, started_at = now(),
                initial_memories = $4, initial_embeddings = $5, initial_memberships = $6,
                initial_aliases = $7, initial_entra_bindings = $8,
                initial_audit_rows = $9, initial_audit_queries = $10,
                initial_audit_selection = $11::jsonb,
                memories_processed = 0, audit_rows_processed = 0, batches = 0,
                memory_cursor = NULL, audit_principal_cursor = 0, audit_scope_cursor = 0,
                audit_memory_cursor = 0, audit_scope_ids_cursor = 0, audit_linked_cursor = 0,
                completed_at = NULL
          WHERE principal_id = $1`,
        [principalId, actor.id, approvalId, memories, embeddings, memberships, aliases,
          entraBindings, auditRows, auditQueries, JSON.stringify(audit.selection),
          acknowledgedEvidenceHash],
      );
      run = await client.query(
        'SELECT * FROM principal_offboarding_runs WHERE principal_id = $1 FOR UPDATE', [principalId],
      );
    } else if (!run.rowCount) {
      run = await client.query(
        `INSERT INTO principal_offboarding_runs
           (principal_id, scope_id, initiated_by, approval_id, initial_memories,
            initial_embeddings, initial_memberships, initial_aliases,
            initial_entra_bindings, initial_audit_rows, initial_audit_queries,
            initial_audit_selection, approval_evidence_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
         RETURNING *`,
        [principalId, scopeId, actor.id, approvalId, memories, embeddings, memberships,
          aliases, entraBindings, auditRows, auditQueries, JSON.stringify(audit.selection),
          acknowledgedEvidenceHash],
      );
    }

    await startOffboardingRunEvent(
      client, run.rows[0], String(run.rows[0].initiated_by), evidence,
    );
    await client.query('UPDATE scopes SET name = $2 WHERE id = $1', [scopeId, scopePseudonym]);
    await client.query(
      `UPDATE scope_memberships
          SET active = FALSE, deactivated_at = COALESCE(deactivated_at, now())
        WHERE scope_id = $1 AND active`, [scopeId],
    );
    await client.query(
      `UPDATE entra_groups
          SET active = FALSE, deactivated_at = COALESCE(deactivated_at, now()),
              approval_revoked_by = COALESCE(approval_revoked_by, $2),
              approval_revoked_at = COALESCE(approval_revoked_at, now()),
              quarantined_at = COALESCE(quarantined_at, now()),
              quarantine_reason = 'OWNED_SCOPE_OFFBOARDED'
        WHERE scope_id = $1 AND (active OR approval_revoked_at IS NULL)`, [scopeId, actor.id],
    );
    await client.query('DELETE FROM principal_aliases WHERE principal_id = $1', [principalId]);
    await client.query(
      `UPDATE principals SET display_name = $2, disabled_at = COALESCE(disabled_at, now()),
              offboarded_at = COALESCE(offboarded_at, now()), reactivated_at = NULL
        WHERE id = $1`, [principalId, pseudonym],
    );

    await client.query(
      `CREATE TEMP TABLE offboarding_memory_candidates ON COMMIT DROP AS
       SELECT id FROM memories
        WHERE scope_id = $1 AND ($3::uuid IS NULL OR id > $3)
        ORDER BY id LIMIT $2`,
      [scopeId, batchSize, run.rows[0].memory_cursor],
    );
    const memoryCandidates = Number((await client.query(
      'SELECT count(*)::int AS count FROM offboarding_memory_candidates',
    )).rows[0].count);
    if (memoryCandidates > 0) {
      await client.query(
        `UPDATE principal_offboarding_runs
            SET memory_cursor = (
              SELECT id FROM offboarding_memory_candidates ORDER BY id DESC LIMIT 1
            )
          WHERE principal_id = $1`, [principalId],
      );
    }
    await client.query(
      `CREATE TEMP TABLE offboarding_memory_targets ON COMMIT DROP AS
       SELECT m.id FROM memories m
       JOIN offboarding_memory_candidates candidate ON candidate.id = m.id
       WHERE m.type <> 'context' OR m.title <> '[erased]' OR m.body <> '[erased]'
          OR m.metadata <> '{}'::jsonb OR m.tags <> '{}'::text[] OR m.source <> 'erased'
          OR m.source_ref IS NOT NULL OR m.state <> 'archived' OR m.supersedes_id IS NOT NULL
          OR m.promoted_to_id IS NOT NULL OR m.expires_at IS NOT NULL OR m.last_verified IS NOT NULL
       FOR UPDATE OF m`,
    );
    const memoryBatch = Number((await client.query(
      'SELECT count(*)::int AS count FROM offboarding_memory_targets',
    )).rows[0].count);
    await client.query(
      `DELETE FROM memory_embeddings e USING offboarding_memory_targets t
        WHERE e.memory_id = t.id`,
    );
    await client.query(
      `UPDATE memories m SET type = 'context', title = '[erased]', body = '[erased]',
              metadata = '{}'::jsonb, tags = '{}'::text[], source = 'erased',
              source_ref = NULL, state = 'archived', supersedes_id = NULL,
              promoted_to_id = NULL, expires_at = NULL, last_verified = NULL,
              updated_at = now()
         FROM offboarding_memory_targets t WHERE t.id = m.id`,
    );
    await client.query(
      `INSERT INTO audit_log (principal_id, action, memory_id, scope_id, metadata)
       SELECT $1, 'archive', m.id, m.scope_id, $2::jsonb
         FROM memories m JOIN offboarding_memory_targets t ON t.id = m.id`,
      [actor.id, JSON.stringify({
        operation: 'principal_memory_erased', principal_id: principalId,
      })],
    );
    await client.query(
      `DELETE FROM memory_embeddings e WHERE e.memory_id IN (
         SELECT e2.memory_id FROM memory_embeddings e2
          JOIN memories m ON m.id = e2.memory_id
         WHERE m.scope_id = $1 ORDER BY e2.memory_id LIMIT $2
       )`, [scopeId, batchSize],
    );

    await client.query(
      `CREATE TEMP TABLE offboarding_audit_targets (
         id BIGINT PRIMARY KEY, request_id TEXT, reason TEXT NOT NULL
       ) ON COMMIT DROP`,
    );
    let auditBatch = 0;
    const branch = async (
      cursorColumn: AuditCursorColumn, reason: Parameters<typeof selectAuditBranch>[1]['reason'],
      from: string, where: string,
    ) => {
      const inserted = await selectAuditBranch(client, {
        principalId, scopeId, cursorColumn, reason, from, where,
        cursor: String(run.rows[0][cursorColumn]), remaining: batchSize - auditBatch,
      });
      auditBatch += inserted;
    };
    await branch('audit_principal_cursor', 'principal', 'FROM audit_log a', 'a.principal_id = $2');
    await branch('audit_scope_cursor', 'scope', 'FROM audit_log a', 'a.scope_id = $1');
    await branch(
      'audit_memory_cursor', 'memory',
      'FROM memories m JOIN audit_log a ON a.memory_id = m.id', 'm.scope_id = $1',
    );
    await branch(
      'audit_scope_ids_cursor', 'scope_ids', 'FROM audit_log a',
      `a.metadata ? 'scope_ids' AND a.metadata->'scope_ids' @> jsonb_build_array($1::text)`,
    );
    const addedRequests = await client.query(
      `INSERT INTO principal_offboarding_audit_requests (principal_id, request_id)
       SELECT $1, request_id FROM offboarding_audit_targets WHERE request_id IS NOT NULL
       ON CONFLICT DO NOTHING RETURNING request_id`, [principalId],
    );
    if (addedRequests.rowCount) {
      run.rows[0].audit_linked_cursor = '0';
      await client.query(
        `UPDATE principal_offboarding_runs SET audit_linked_cursor = 0 WHERE principal_id = $1`,
        [principalId],
      );
    }
    await branch(
      'audit_linked_cursor', 'linked_request',
      `FROM principal_offboarding_audit_requests r
       JOIN audit_log a ON a.metadata ? 'request_id'
        AND a.metadata->>'request_id' = r.request_id`,
      'r.principal_id = $2',
    );
    const auditedRows = Number((await client.query(
      'SELECT count(*)::int AS count FROM offboarding_audit_targets',
    )).rows[0].count);
    await client.query(
      `UPDATE audit_log a SET query = NULL,
              metadata = ${AUDIT_EXPECTED_METADATA}
         FROM offboarding_audit_targets t WHERE t.id = a.id`,
    );

    const currentRun = await client.query(
      `SELECT memory_cursor, audit_principal_cursor, audit_scope_cursor,
              audit_memory_cursor, audit_scope_ids_cursor, audit_linked_cursor
         FROM principal_offboarding_runs WHERE principal_id = $1`, [principalId],
    );
    // Finalization re-probes all dirty state through indexed EXISTS checks. An
    // exhausted cursor alone is never evidence that an interrupted run is done.
    const remaining = await stateWorkRemains(client, scopeId, principalId, null);
    const remainingAudit = await auditWorkRemains(client, scopeId, principalId);
    const completionReady = !remaining.memories && !remaining.embeddings
      && !remaining.memberships && !remaining.aliases
      && !remaining.entraBindings && !remainingAudit;
    const progressUpdate = await client.query(
      `UPDATE principal_offboarding_runs
          SET memories_processed = memories_processed + $2,
              audit_rows_processed = audit_rows_processed + $3,
              batches = batches + 1
        WHERE principal_id = $1 RETURNING *`,
      [principalId, memoryBatch, auditedRows],
    );
    const progressRow = progressUpdate.rows[0];
    if (completionReady) {
      const repair = wasOffboarded || originalOffboarding !== null;
      await finalizeOffboardingRun(client, progressRow, actor.id, {
        run_id: progressRow.run_id,
        initiated_by: progressRow.initiated_by,
        finalized_by: actor.id,
        approval_id: progressRow.approval_id,
        approval_evidence_hash: progressRow.approval_evidence_hash,
        memories_processed: Number(progressRow.memories_processed),
        audit_rows_processed: Number(progressRow.audit_rows_processed),
        batches: Number(progressRow.batches),
      });
      await client.query(
        `INSERT INTO principal_offboarding_events
           (principal_id, scope_id, actor_principal_id, repair, memories, embeddings,
            memberships, aliases, entra_bindings, audit_rows, audit_queries,
            approval_id, batches, evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
        [principalId, scopeId, actor.id, repair, progressRow.initial_memories,
          progressRow.initial_embeddings, progressRow.initial_memberships,
          progressRow.initial_aliases, progressRow.initial_entra_bindings,
          progressRow.initial_audit_rows, progressRow.initial_audit_queries,
          approvalId, progressRow.batches, JSON.stringify(evidence)],
      );
      await client.query(
        `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
         VALUES ($1, 'archive', $2, $3::jsonb)`,
        [actor.id, scopeId, JSON.stringify({
          operation: repair ? 'principal_offboarding_repaired' : 'principal_offboarded',
          principal_id: principalId, approval_id: approvalId,
          acknowledged_evidence_hash: acknowledgedEvidenceHash,
          memories: Number(progressRow.initial_memories),
          audit_rows: Number(progressRow.initial_audit_rows),
          batches: Number(progressRow.batches),
        })],
      );
    }
    await client.query('COMMIT');
    const progress: OffboardingProgress = {
      batch: Number(progressRow.batches), batchSize,
      memoriesProcessed: Number(progressRow.memories_processed),
      auditRowsProcessed: Number(progressRow.audit_rows_processed),
      memoriesRemaining: remaining.memories ? 1 : 0,
      auditRowsRemaining: remainingAudit ? 1 : 0,
    };
    return {
      ...baseResult,
      memories: Number(progressRow.initial_memories),
      embeddings: Number(progressRow.initial_embeddings),
      memberships: Number(progressRow.initial_memberships),
      aliases: Number(progressRow.initial_aliases),
      entraBindings: Number(progressRow.initial_entra_bindings),
      auditRows: Number(progressRow.initial_audit_rows),
      auditQueries: Number(progressRow.initial_audit_queries),
      dryRun: false, alreadyOffboarded: false, complete: completionReady, progress,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { destroyClient = true; }
    if ((error as Error).message?.includes('last effective manual org administrator')) {
      throw new ServiceError(
        'CONFLICT', 'cannot remove the last effective manual org administrator', { cause: error },
      );
    }
    throw error;
  } finally { client.release(destroyClient); }
}
