import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Principal } from '../types.js';
import { requireOrgAdmin } from './access.js';
import { ServiceError } from './errors.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SYNC_LOCK_ID = '834641726154302119';
export const MAX_OFFBOARD_MEMORIES = 10_000;
export const MAX_OFFBOARD_EVIDENCE_IDS = 100;
export const MAX_OFFBOARD_AFFECTED_ROWS = 50_000;

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

export interface OffboardingResult {
  principalId: string; scopeId: string; memories: number; embeddings: number;
  memberships: number; aliases: number; entraBindings: number; affectedRows: number;
  liveMemories: number; auditQueries: number; auditRows: number;
  dirtyAuditRows: number; dirtyMemories: number;
  dryRun: boolean; alreadyOffboarded: boolean; pseudonym: string; scopePseudonym: string;
  evidence: OffboardingEvidence;
  originalOffboarding: OriginalOffboardingEvidence | null;
}

export interface OffboardingOptions {
  dryRun?: boolean;
  confirmationScopeId?: string;
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
  acknowledgedPrincipalIds: string[]; acknowledgedEvidenceHash: string;
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
          other_member_principal_ids: current.memberPrincipalIds,
          other_author_principal_ids: current.authorPrincipalIds,
          other_member_principal_ids_truncated: current.memberPrincipalIdsTruncated,
          other_author_principal_ids_truncated: current.authorPrincipalIdsTruncated,
        })],
      );
    }
    await client.query('COMMIT');
    return {
      principalId, scopeId, created,
      allowOtherActiveMembers: acknowledgedPrincipalIds.length > 0,
      acknowledgedPrincipalIds, acknowledgedEvidenceHash,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function offboardPrincipal(
  pool: pg.Pool, actor: Principal, principalId: string,
  dryRunOrOptions: boolean | OffboardingOptions = false,
): Promise<OffboardingResult> {
  principalId = id(principalId, 'principal id');
  const options = typeof dryRunOrOptions === 'boolean'
    ? { dryRun: dryRunOrOptions } : dryRunOrOptions;
  const dryRun = options.dryRun ?? false;
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
         FROM principals WHERE id = $1 AND kind = 'user' FOR UPDATE`,
      [principalId],
    );
    if (!target.rowCount) throw new ServiceError('INVALID_INPUT', 'user principal not found');
    const mapping = await client.query(
      `SELECT pus.scope_id, pus.acknowledged_principal_ids,
              pus.acknowledged_evidence_hash
         FROM principal_user_scopes pus
         JOIN scopes s ON s.id = pus.scope_id AND s.kind = 'user'
        WHERE pus.principal_id = $1 FOR UPDATE OF pus, s`, [principalId],
    );
    if (!mapping.rowCount) {
      throw new ServiceError('CONFLICT', 'principal has no explicit owned user scope mapping');
    }
    const scopeId = mapping.rows[0].scope_id as string;
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

    await client.query(
      `CREATE TEMP TABLE offboarding_audit_targets ON COMMIT DROP AS
       WITH direct AS MATERIALIZED (
         SELECT a.id, a.metadata->>'request_id' AS request_id
           FROM audit_log a
          WHERE a.principal_id = $2 OR a.scope_id = $1
             OR EXISTS (SELECT 1 FROM memories m WHERE m.scope_id = $1 AND m.id = a.memory_id)
             OR (jsonb_typeof(a.metadata->'scope_ids') = 'array'
                 AND a.metadata->'scope_ids' @> jsonb_build_array($1::text))
             OR (a.metadata IS NOT NULL AND jsonb_path_exists(
                   a.metadata, '$.** ? (@ == $scope_name)',
                   jsonb_build_object('scope_name', $3::text)))
       ), linked_requests AS MATERIALIZED (
         SELECT DISTINCT request_id FROM direct WHERE request_id IS NOT NULL
       )
       SELECT id FROM (
         SELECT id FROM direct
         UNION
         SELECT a.id FROM audit_log a
          JOIN linked_requests linked
            ON linked.request_id = a.metadata->>'request_id'
       ) targets
       LIMIT $4`,
      [scopeId, principalId, scopeName, MAX_OFFBOARD_AFFECTED_ROWS + 1],
    );
    await client.query(
      'ALTER TABLE offboarding_audit_targets ADD PRIMARY KEY (id)',
    );
    const counts = await client.query(
      `SELECT
         (SELECT count(*)::int FROM memories WHERE scope_id = $1) AS memories,
         (SELECT count(*)::int FROM memories WHERE scope_id = $1 AND state = 'live') AS live_memories,
         (SELECT count(*)::int FROM memories
           WHERE scope_id = $1 AND (
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
           AND (active OR approval_revoked_at IS NULL)) AS entra_bindings,
         (SELECT count(*)::int FROM offboarding_audit_targets) AS audit_rows,
         (SELECT count(*)::int FROM audit_log a JOIN offboarding_audit_targets t ON t.id = a.id
           WHERE a.query IS NOT NULL) AS audit_queries,
         (SELECT count(*)::int FROM audit_log a JOIN offboarding_audit_targets t ON t.id = a.id
           WHERE (a.query IS NOT NULL
                  OR a.metadata IS DISTINCT FROM '{"redacted":"principal_offboarding"}'::jsonb)
             AND COALESCE(a.metadata->>'operation', '') NOT IN
                 ('principal_memory_erased', 'principal_offboarded', 'principal_offboarding_repaired'))
           AS dirty_audit_rows`,
      [scopeId, principalId],
    );
    const row = counts.rows[0];
    const memories = Number(row.memories);
    const liveMemories = Number(row.live_memories);
    const dirtyMemories = Number(row.dirty_memories);
    const embeddings = Number(row.embeddings);
    const memberships = Number(row.memberships);
    const aliases = Number(row.aliases);
    const entraBindings = Number(row.entra_bindings);
    const auditRows = Number(row.audit_rows);
    const auditQueries = Number(row.audit_queries);
    const dirtyAuditRows = Number(row.dirty_audit_rows);
    // Two rows per memory are changed (tombstone + receipt), plus four fixed
    // rows: scope, durable event, summary audit, and principal lifecycle.
    const affectedRows = (memories * 2) + embeddings + memberships + aliases
      + entraBindings + auditRows + 4;
    if (auditRows > MAX_OFFBOARD_AFFECTED_ROWS || affectedRows > MAX_OFFBOARD_AFFECTED_ROWS) {
      throw new ServiceError(
        'CONFLICT', `offboarding exceeds the atomic affected-row limit of ${MAX_OFFBOARD_AFFECTED_ROWS}`,
      );
    }
    const original = await client.query(
      `SELECT id::text AS id, at, memories, embeddings, memberships, aliases,
              entra_bindings, audit_rows
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
      auditQueries: Number(original.rows[0].audit_rows),
    } : null;
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

    const wasOffboarded = target.rows[0].offboarded_at !== null;
    const pseudonym = erasedPrincipalPseudonym(principalId);
    const scopePseudonym = erasedScopePseudonym(scopeId);
    const alreadyOffboarded = wasOffboarded
      && target.rows[0].disabled_at !== null
      && target.rows[0].reactivated_at === null
      && target.rows[0].display_name === pseudonym
      && scopeName === scopePseudonym
      && dirtyMemories === 0 && embeddings === 0 && memberships === 0
      && aliases === 0 && entraBindings === 0
      && auditQueries === 0 && dirtyAuditRows === 0;
    if (!alreadyOffboarded && memories > MAX_OFFBOARD_MEMORIES) {
      throw new ServiceError(
        'CONFLICT', `owned user scope exceeds the atomic limit of ${MAX_OFFBOARD_MEMORIES} memories`,
      );
    }
    const result: OffboardingResult = {
      principalId, scopeId, memories, liveMemories, embeddings, memberships, aliases,
      entraBindings, affectedRows, auditQueries, auditRows, dirtyAuditRows, dirtyMemories,
      dryRun, alreadyOffboarded, pseudonym, scopePseudonym, evidence, originalOffboarding,
    };
    if (dryRun) { await client.query('ROLLBACK'); return result; }
    if (result.alreadyOffboarded) { await client.query('COMMIT'); return result; }
    // A repair must write its mandatory per-memory receipt while the database
    // fence is already closed. The target row lock prevents another writer
    // from observing this transaction-local reopening; the final update below
    // restores offboarded_at before commit, and rollback restores it on error.
    if (wasOffboarded) {
      await client.query('UPDATE principals SET offboarded_at = NULL WHERE id = $1', [principalId]);
    }
    await client.query(
      `UPDATE memories SET type = 'context', title = '[erased]', body = '[erased]',
              metadata = '{}'::jsonb, tags = '{}'::text[], source = 'erased',
              source_ref = NULL, state = 'archived', supersedes_id = NULL,
              promoted_to_id = NULL, expires_at = NULL, last_verified = NULL,
              updated_at = now()
        WHERE scope_id = $1`, [scopeId],
    );
    await client.query(
      `DELETE FROM memory_embeddings e USING memories m
        WHERE e.memory_id = m.id AND m.scope_id = $1`, [scopeId],
    );
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
        WHERE scope_id = $1 AND (active OR approval_revoked_at IS NULL)`,
      [scopeId, actor.id],
    );
    await client.query('DELETE FROM principal_aliases WHERE principal_id = $1', [principalId]);
    await client.query(
      `UPDATE audit_log a
          SET query = NULL, metadata = '{"redacted":"principal_offboarding"}'::jsonb
         FROM offboarding_audit_targets t WHERE t.id = a.id`,
    );
    await client.query('UPDATE scopes SET name = $2 WHERE id = $1', [scopeId, scopePseudonym]);
    await client.query(
      `INSERT INTO principal_offboarding_events
         (principal_id, scope_id, actor_principal_id, repair, memories, embeddings,
          memberships, aliases, entra_bindings, audit_rows, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [principalId, scopeId, actor.id, wasOffboarded, memories, embeddings,
        memberships, aliases, entraBindings, auditRows, JSON.stringify(evidence)],
    );
    await client.query(
      `INSERT INTO audit_log (principal_id, action, memory_id, scope_id, metadata)
       SELECT $1, 'archive', m.id, m.scope_id, $3::jsonb
         FROM memories m WHERE m.scope_id = $2`,
      [actor.id, scopeId, JSON.stringify({
        operation: 'principal_memory_erased', principal_id: principalId,
      })],
    );
    await client.query(
      `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
       VALUES ($1, 'archive', $2, $3::jsonb)`,
      [actor.id, scopeId, JSON.stringify({
        operation: wasOffboarded ? 'principal_offboarding_repaired' : 'principal_offboarded',
        principal_id: principalId, pseudonym, memories, live_memories: liveMemories,
        scope_pseudonym: scopePseudonym, embeddings, memberships, aliases,
        entra_bindings: entraBindings, affected_rows: affectedRows,
        audit_queries: auditQueries, audit_rows: auditRows, dirty_audit_rows: dirtyAuditRows,
        dirty_memories: dirtyMemories,
        member_principal_ids: evidence.memberPrincipalIds,
        author_principal_ids: evidence.authorPrincipalIds,
        member_principal_ids_truncated: evidence.memberPrincipalIdsTruncated,
        author_principal_ids_truncated: evidence.authorPrincipalIdsTruncated,
        acknowledged_principal_ids: acknowledgedPrincipalIds,
        acknowledged_evidence_hash: acknowledgedEvidenceHash,
        ...(wasOffboarded && originalOffboarding
          ? { repair_of_evidence_id: originalOffboarding.evidenceId } : {}),
      })],
    );
    // Keep the lifecycle transition last so mandatory audit writes remain valid.
    await client.query(
      `UPDATE principals SET display_name = $2, disabled_at = COALESCE(disabled_at, now()),
              offboarded_at = now(), reactivated_at = NULL WHERE id = $1`,
      [principalId, pseudonym],
    );
    await client.query('COMMIT');
    return result;
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
