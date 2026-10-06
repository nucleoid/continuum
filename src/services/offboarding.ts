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

const AUDIT_DIRTY = `(a.query IS NOT NULL
  OR a.metadata IS DISTINCT FROM '{"redacted":"principal_offboarding"}'::jsonb)`;
const AUDIT_NOT_PRESERVED = `COALESCE(a.metadata->>'operation', '')
  <> ALL($3::text[])`;

async function auditSelectionCounts(
  client: pg.PoolClient,
  scopeId: string,
  principalId: string,
): Promise<{ selection: AuditSelectionCounts; queries: number }> {
  const selected = await client.query(
    `WITH direct_candidates AS (
       SELECT a.id, a.query, a.metadata->>'request_id' AS request_id,
              'principal'::text AS reason, 1 AS priority
         FROM audit_log a
        WHERE a.principal_id = $2 AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED}
       UNION ALL
       SELECT a.id, a.query, a.metadata->>'request_id', 'scope', 2
         FROM audit_log a
        WHERE a.scope_id = $1 AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED}
       UNION ALL
       SELECT a.id, a.query, a.metadata->>'request_id', 'memory', 3
         FROM memories m JOIN audit_log a ON a.memory_id = m.id
        WHERE m.scope_id = $1 AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED}
       UNION ALL
       SELECT a.id, a.query, a.metadata->>'request_id', 'scope_ids', 4
         FROM audit_log a
        WHERE a.metadata ? 'scope_ids'
          AND a.metadata->'scope_ids' @> jsonb_build_array($1::text)
          AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED}
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
     ), targets AS (
       SELECT id, query, reason FROM direct
       UNION ALL
       SELECT id, query, reason FROM linked
     )
     SELECT count(*) FILTER (WHERE reason = 'principal')::int AS principal,
            count(*) FILTER (WHERE reason = 'scope')::int AS scope,
            count(*) FILTER (WHERE reason = 'memory')::int AS memory,
            count(*) FILTER (WHERE reason = 'scope_ids')::int AS scope_ids,
            count(*) FILTER (WHERE reason = 'linked_request')::int AS linked_request,
            count(*)::int AS total,
            count(*) FILTER (WHERE query IS NOT NULL)::int AS queries
       FROM targets`,
    [scopeId, principalId, [...PRESERVED_AUDIT_OPERATIONS]],
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

export async function offboardPrincipal(
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
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [SYNC_LOCK_ID]);
    await requireOrgAdmin(client, actor.id);
    const target = await client.query(
      `SELECT id, display_name, disabled_at, offboarded_at, reactivated_at
         FROM principals WHERE id = $1 AND kind = 'user' FOR UPDATE`, [principalId],
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
        WHERE pus.principal_id = $1 FOR UPDATE OF pus, s`, [principalId],
    );
    if (!mapping.rowCount) {
      throw new ServiceError('CONFLICT', 'principal has no explicit owned user scope mapping');
    }
    const scopeId = mapping.rows[0].scope_id as string;
    const approvalId = mapping.rows[0].approval_id as string;
    if (!dryRun && confirmationScopeId !== undefined && confirmationScopeId !== scopeId) {
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
    const members = await client.query(
      `SELECT DISTINCT principal_id::text AS id FROM scope_memberships
        WHERE scope_id = $1 ORDER BY id LIMIT $2`,
      [scopeId, MAX_OFFBOARD_EVIDENCE_IDS + 1],
    );
    const authors = await client.query(
      `SELECT DISTINCT author_id::text AS id FROM memories
        WHERE scope_id = $1 ORDER BY id LIMIT $2`,
      [scopeId, MAX_OFFBOARD_EVIDENCE_IDS + 1],
    );
    evidence.memberPrincipalIds = members.rows.slice(0, MAX_OFFBOARD_EVIDENCE_IDS)
      .map((member) => member.id as string);
    evidence.authorPrincipalIds = authors.rows.slice(0, MAX_OFFBOARD_EVIDENCE_IDS)
      .map((author) => author.id as string);
    evidence.memberPrincipalIdsTruncated = members.rows.length > MAX_OFFBOARD_EVIDENCE_IDS;
    evidence.authorPrincipalIdsTruncated = authors.rows.length > MAX_OFFBOARD_EVIDENCE_IDS;
    requireCompleteEvidence(evidence);
    const state = await client.query(
      `SELECT
         (SELECT count(*)::int FROM memories WHERE scope_id = $1) AS memories,
         (SELECT count(*)::int FROM memories WHERE scope_id = $1 AND state = 'live') AS live_memories,
         (SELECT count(*)::int FROM memories WHERE scope_id = $1 AND (
           type <> 'context' OR title <> '[erased]' OR body <> '[erased]'
           OR metadata <> '{}'::jsonb OR tags <> '{}'::text[] OR source <> 'erased'
           OR source_ref IS NOT NULL OR state <> 'archived' OR supersedes_id IS NOT NULL
           OR promoted_to_id IS NOT NULL OR expires_at IS NOT NULL OR last_verified IS NOT NULL
         )) AS dirty_memories,
         (SELECT count(*)::int FROM memory_embeddings e
           JOIN memories m ON m.id = e.memory_id WHERE m.scope_id = $1) AS embeddings,
         (SELECT count(*)::int FROM scope_memberships WHERE scope_id = $1 AND active) AS memberships,
         (SELECT count(*)::int FROM principal_aliases WHERE principal_id = $2) AS aliases,
         (SELECT count(*)::int FROM entra_groups WHERE scope_id = $1
           AND (active OR approval_revoked_at IS NULL)) AS entra_bindings`,
      [scopeId, principalId],
    );
    const audit = await auditSelectionCounts(client, scopeId, principalId);
    const row = state.rows[0];
    const memories = Number(row.memories);
    const liveMemories = Number(row.live_memories);
    const dirtyMemories = Number(row.dirty_memories);
    const embeddings = Number(row.embeddings);
    const memberships = Number(row.memberships);
    const aliases = Number(row.aliases);
    const entraBindings = Number(row.entra_bindings);
    const auditRows = audit.selection.total;
    const auditQueries = audit.queries;
    const dirtyAuditRows = auditRows;
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
    const clean = dirtyMemories === 0 && embeddings === 0 && memberships === 0
      && aliases === 0 && entraBindings === 0 && auditRows === 0;
    const wasOffboarded = target.rows[0].offboarded_at !== null;
    const alreadyOffboarded = wasOffboarded
      && target.rows[0].disabled_at !== null
      && target.rows[0].reactivated_at === null
      && target.rows[0].display_name === pseudonym
      && scopeName === scopePseudonym && clean;
    const previewProgress: OffboardingProgress = {
      batch: 0, batchSize, memoriesProcessed: 0, auditRowsProcessed: 0,
      memoriesRemaining: dirtyMemories, auditRowsRemaining: auditRows,
    };
    const baseResult = {
      principalId, scopeId, memories, liveMemories, embeddings, memberships, aliases,
      entraBindings, affectedRows, auditQueries, auditRows, dirtyAuditRows, dirtyMemories,
      dryRun, alreadyOffboarded, complete: alreadyOffboarded, pseudonym, scopePseudonym,
      evidence, auditSelection: audit.selection, progress: previewProgress, originalOffboarding,
    } satisfies OffboardingResult;
    if (dryRun) { await client.query('ROLLBACK'); return baseResult; }
    if (alreadyOffboarded) { await client.query('COMMIT'); return baseResult; }

    if (target.rows[0].reactivated_at !== null) {
      await client.query(
        'DELETE FROM principal_offboarding_audit_requests WHERE principal_id = $1', [principalId],
      );
      await client.query('DELETE FROM principal_offboarding_runs WHERE principal_id = $1', [principalId]);
    }
    let run = await client.query(
      'SELECT * FROM principal_offboarding_runs WHERE principal_id = $1 FOR UPDATE', [principalId],
    );
    if (run.rows[0]?.completed_at !== null && run.rows[0]?.completed_at !== undefined) {
      await client.query(
        `UPDATE principal_offboarding_runs
            SET initiated_by = $2, approval_id = $3, started_at = now(),
                initial_memories = $4, initial_embeddings = $5, initial_memberships = $6,
                initial_aliases = $7, initial_entra_bindings = $8,
                initial_audit_rows = $9, initial_audit_queries = $10,
                memories_processed = 0, audit_rows_processed = 0, batches = 0,
                completed_at = NULL
          WHERE principal_id = $1`,
        [principalId, actor.id, approvalId, memories, embeddings, memberships, aliases,
          entraBindings, auditRows, auditQueries],
      );
      run = await client.query(
        'SELECT * FROM principal_offboarding_runs WHERE principal_id = $1 FOR UPDATE', [principalId],
      );
    } else if (!run.rowCount) {
      run = await client.query(
        `INSERT INTO principal_offboarding_runs
           (principal_id, scope_id, initiated_by, approval_id, initial_memories,
            initial_embeddings, initial_memberships, initial_aliases,
            initial_entra_bindings, initial_audit_rows, initial_audit_queries)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [principalId, scopeId, actor.id, approvalId, memories, embeddings, memberships,
          aliases, entraBindings, auditRows, auditQueries],
      );
    }

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
      `CREATE TEMP TABLE offboarding_memory_targets ON COMMIT DROP AS
       SELECT id FROM memories WHERE scope_id = $1 AND (
         type <> 'context' OR title <> '[erased]' OR body <> '[erased]'
         OR metadata <> '{}'::jsonb OR tags <> '{}'::text[] OR source <> 'erased'
         OR source_ref IS NOT NULL OR state <> 'archived' OR supersedes_id IS NOT NULL
         OR promoted_to_id IS NOT NULL OR expires_at IS NOT NULL OR last_verified IS NOT NULL
       ) ORDER BY id FOR UPDATE LIMIT $2`,
      [scopeId, batchSize],
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
      `CREATE TEMP TABLE offboarding_audit_targets ON COMMIT DROP AS
       WITH candidates AS (
         SELECT a.id, a.metadata->>'request_id' AS request_id, 'principal'::text AS reason, 1 AS priority
           FROM audit_log a WHERE a.principal_id = $2 AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED}
         UNION ALL
         SELECT a.id, a.metadata->>'request_id', 'scope', 2
           FROM audit_log a WHERE a.scope_id = $1 AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED}
         UNION ALL
         SELECT a.id, a.metadata->>'request_id', 'memory', 3
           FROM memories m JOIN audit_log a ON a.memory_id = m.id
          WHERE m.scope_id = $1 AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED}
         UNION ALL
         SELECT a.id, a.metadata->>'request_id', 'scope_ids', 4
           FROM audit_log a
          WHERE a.metadata ? 'scope_ids'
            AND a.metadata->'scope_ids' @> jsonb_build_array($1::text)
            AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED}
       )
       SELECT DISTINCT ON (id) id, request_id, reason FROM candidates
        ORDER BY id, priority LIMIT $4`,
      [scopeId, principalId, [...PRESERVED_AUDIT_OPERATIONS], batchSize],
    );
    await client.query('ALTER TABLE offboarding_audit_targets ADD PRIMARY KEY (id)');
    await client.query(
      `INSERT INTO principal_offboarding_audit_requests (principal_id, request_id)
       SELECT $1, request_id FROM offboarding_audit_targets WHERE request_id IS NOT NULL
       ON CONFLICT DO NOTHING`, [principalId],
    );
    const directBatch = Number((await client.query(
      'SELECT count(*)::int AS count FROM offboarding_audit_targets',
    )).rows[0].count);
    await client.query(
      `INSERT INTO offboarding_audit_targets (id, request_id, reason)
       SELECT a.id, a.metadata->>'request_id', 'linked_request'
         FROM principal_offboarding_audit_requests r
         JOIN audit_log a ON a.metadata ? 'request_id'
          AND a.metadata->>'request_id' = r.request_id
        WHERE r.principal_id = $2 AND $1::uuid IS NOT NULL
          AND ${AUDIT_DIRTY} AND ${AUDIT_NOT_PRESERVED}
       ORDER BY a.id
       LIMIT $4
       ON CONFLICT (id) DO NOTHING`,
      [scopeId, principalId, [...PRESERVED_AUDIT_OPERATIONS],
        Math.max(0, batchSize - directBatch)],
    );
    const auditBatch = Number((await client.query(
      'SELECT count(*)::int AS count FROM offboarding_audit_targets',
    )).rows[0].count);
    await client.query(
      `UPDATE audit_log a SET query = NULL,
              metadata = '{"redacted":"principal_offboarding"}'::jsonb
         FROM offboarding_audit_targets t WHERE t.id = a.id`,
    );

    const remainingState = await client.query(
      `SELECT
         (SELECT count(*)::int FROM memories WHERE scope_id = $1 AND (
           type <> 'context' OR title <> '[erased]' OR body <> '[erased]'
           OR metadata <> '{}'::jsonb OR tags <> '{}'::text[] OR source <> 'erased'
           OR source_ref IS NOT NULL OR state <> 'archived' OR supersedes_id IS NOT NULL
           OR promoted_to_id IS NOT NULL OR expires_at IS NOT NULL OR last_verified IS NOT NULL
         )) AS memories,
         (SELECT count(*)::int FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
           WHERE m.scope_id = $1) AS embeddings,
         (SELECT count(*)::int FROM scope_memberships WHERE scope_id = $1 AND active) AS memberships,
         (SELECT count(*)::int FROM principal_aliases WHERE principal_id = $2) AS aliases,
         (SELECT count(*)::int FROM entra_groups WHERE scope_id = $1
           AND (active OR approval_revoked_at IS NULL)) AS entra_bindings`,
      [scopeId, principalId],
    );
    const remainingAudit = await auditSelectionCounts(client, scopeId, principalId);
    const remaining = remainingState.rows[0];
    const complete = Number(remaining.memories) === 0 && Number(remaining.embeddings) === 0
      && Number(remaining.memberships) === 0 && Number(remaining.aliases) === 0
      && Number(remaining.entra_bindings) === 0 && remainingAudit.selection.total === 0;
    const progressUpdate = await client.query(
      `UPDATE principal_offboarding_runs
          SET memories_processed = memories_processed + $2,
              audit_rows_processed = audit_rows_processed + $3,
              batches = batches + 1,
              completed_at = CASE WHEN $4 THEN now() ELSE NULL END
        WHERE principal_id = $1 RETURNING *`,
      [principalId, memoryBatch, auditBatch, complete],
    );
    const progressRow = progressUpdate.rows[0];
    if (complete) {
      await client.query(
        'DELETE FROM principal_offboarding_audit_requests WHERE principal_id = $1', [principalId],
      );
      const repair = wasOffboarded || originalOffboarding !== null;
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
      memoriesRemaining: Number(remaining.memories),
      auditRowsRemaining: remainingAudit.selection.total,
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
      dryRun: false, alreadyOffboarded: false, complete, progress,
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
