import type pg from 'pg';
import type { Principal } from '../types.js';
import { requireOrgAdmin } from './access.js';
import { ServiceError } from './errors.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SYNC_LOCK_ID = '834641726154302119';
export const MAX_OFFBOARD_MEMORIES = 10_000;
export const MAX_OFFBOARD_EVIDENCE_IDS = 100;

export interface OffboardingEvidence {
  memberPrincipalIds: string[];
  authorPrincipalIds: string[];
  memberPrincipalIdsTruncated: boolean;
  authorPrincipalIdsTruncated: boolean;
}

export interface OriginalOffboardingEvidence {
  evidenceId: string;
  at: Date;
  memories: number;
  embeddings: number;
  memberships: number;
  auditQueries: number;
}

export interface OffboardingResult {
  principalId: string; scopeId: string; memories: number; embeddings: number;
  memberships: number; liveMemories: number; auditQueries: number;
  auditRows: number; dirtyAuditRows: number; dirtyMemories: number;
  dryRun: boolean; alreadyOffboarded: boolean; pseudonym: string; scopePseudonym: string;
  evidence: OffboardingEvidence;
  originalOffboarding: OriginalOffboardingEvidence | null;
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

async function ownershipEvidence(
  client: pg.PoolClient,
  principalId: string,
  scopeId: string,
): Promise<OffboardingEvidence> {
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

export async function mapOwnedUserScope(
  pool: pg.Pool, actor: Principal, principalId: string, scopeId: string,
  allowOtherActiveMembers = false,
): Promise<{
  principalId: string; scopeId: string; created: boolean; allowOtherActiveMembers: boolean;
}> {
  principalId = id(principalId, 'principal id');
  scopeId = id(scopeId, 'scope id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
    const evidence = await ownershipEvidence(client, principalId, scopeId);
    if ((evidence.memberPrincipalIds.length || evidence.authorPrincipalIds.length)
      && !allowOtherActiveMembers) {
      throw new ServiceError(
        'CONFLICT',
        'user scope has other active members or other principal history or authorship; explicit allowOtherActiveMembers override is required',
      );
    }
    const existing = await client.query(
      `SELECT principal_id, scope_id, allow_other_active_members FROM principal_user_scopes
        WHERE principal_id = $1 OR scope_id = $2 FOR UPDATE`, [principalId, scopeId],
    );
    if (existing.rows.some(
      (row) => row.principal_id !== principalId || row.scope_id !== scopeId,
    )) {
      throw new ServiceError('CONFLICT', 'principal or user scope already has a different owner mapping');
    }
    const created = !existing.rows[0];
    if (created) {
      await client.query(
        `INSERT INTO principal_user_scopes
           (principal_id, scope_id, mapped_by, allow_other_active_members)
         VALUES ($1, $2, $3, $4)`, [principalId, scopeId, actor.id, allowOtherActiveMembers],
      );
      await client.query(
        `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
         VALUES ($1, 'write', $2, $3::jsonb)`,
        [actor.id, scopeId, JSON.stringify({
          operation: 'principal_user_scope_mapped', principal_id: principalId,
          allow_other_active_members: allowOtherActiveMembers,
          other_member_principal_ids: evidence.memberPrincipalIds,
          other_author_principal_ids: evidence.authorPrincipalIds,
          other_member_principal_ids_truncated: evidence.memberPrincipalIdsTruncated,
          other_author_principal_ids_truncated: evidence.authorPrincipalIdsTruncated,
        })],
      );
    } else if (allowOtherActiveMembers && !existing.rows[0].allow_other_active_members) {
      await client.query(
        `UPDATE principal_user_scopes SET allow_other_active_members = TRUE, mapped_by = $2,
                mapped_at = now() WHERE principal_id = $1`, [principalId, actor.id],
      );
      await client.query(
        `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
         VALUES ($1, 'write', $2, $3::jsonb)`,
        [actor.id, scopeId, JSON.stringify({
          operation: 'principal_user_scope_override_enabled', principal_id: principalId,
          allow_other_active_members: true,
          other_member_principal_ids: evidence.memberPrincipalIds,
          other_author_principal_ids: evidence.authorPrincipalIds,
          other_member_principal_ids_truncated: evidence.memberPrincipalIdsTruncated,
          other_author_principal_ids_truncated: evidence.authorPrincipalIdsTruncated,
        })],
      );
    }
    await client.query('COMMIT');
    return {
      principalId, scopeId, created,
      allowOtherActiveMembers: allowOtherActiveMembers || Boolean(existing.rows[0]?.allow_other_active_members),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function offboardPrincipal(
  pool: pg.Pool, actor: Principal, principalId: string, dryRun = false,
): Promise<OffboardingResult> {
  principalId = id(principalId, 'principal id');
  const client = await pool.connect();
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [SYNC_LOCK_ID]);
    await requireOrgAdmin(client, actor.id);
    const target = await client.query(
      `SELECT id, display_name, disabled_at, offboarded_at, reactivated_at
         FROM principals WHERE id = $1 AND kind = 'user' FOR UPDATE`,
      [principalId],
    );
    if (!target.rowCount) throw new ServiceError('INVALID_INPUT', 'user principal not found');
    const mapping = await client.query(
      `SELECT pus.scope_id, pus.allow_other_active_members FROM principal_user_scopes pus
        JOIN scopes s ON s.id = pus.scope_id AND s.kind = 'user'
       WHERE pus.principal_id = $1 FOR UPDATE OF pus, s`, [principalId],
    );
    if (!mapping.rowCount) {
      throw new ServiceError('CONFLICT', 'principal has no explicit owned user scope mapping');
    }
    const scopeId = mapping.rows[0].scope_id as string;
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
    if ((ownership.memberPrincipalIds.length || ownership.authorPrincipalIds.length)
      && !mapping.rows[0].allow_other_active_members) {
      throw new ServiceError(
        'CONFLICT',
        'owned user scope has other principal history or authorship without an explicit safe operator override',
      );
    }
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
         (SELECT count(*)::int FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id WHERE m.scope_id = $1) AS embeddings,
         (SELECT count(*)::int FROM scope_memberships WHERE scope_id = $1 AND active) AS memberships,
         (SELECT count(*)::int FROM audit_log WHERE principal_id = $2 AND query IS NOT NULL) AS audit_queries,
         (SELECT count(*)::int FROM audit_log a
           WHERE a.principal_id = $2 OR a.scope_id = $1
              OR EXISTS (SELECT 1 FROM memories m WHERE m.scope_id = $1 AND m.id = a.memory_id)
              OR (a.metadata IS NOT NULL
                  AND a.metadata::text LIKE '%' || to_jsonb($3::text)::text || '%')) AS audit_rows,
         (SELECT count(*)::int FROM audit_log a
           WHERE (a.principal_id = $2 OR a.scope_id = $1
              OR EXISTS (SELECT 1 FROM memories m WHERE m.scope_id = $1 AND m.id = a.memory_id)
              OR (a.metadata IS NOT NULL
                  AND a.metadata::text LIKE '%' || to_jsonb($3::text)::text || '%'))
             AND (a.query IS NOT NULL OR a.metadata IS DISTINCT FROM '{"redacted":"principal_offboarding"}'::jsonb)
             AND COALESCE(a.metadata->>'operation', '') NOT IN
                 ('principal_memory_erased', 'principal_offboarded', 'principal_offboarding_repaired')) AS dirty_audit_rows`,
      [scopeId, principalId, scopeName],
    );
    const memories = Number(counts.rows[0].memories);
    const liveMemories = Number(counts.rows[0].live_memories);
    const embeddings = Number(counts.rows[0].embeddings);
    const memberships = Number(counts.rows[0].memberships);
    const auditQueries = Number(counts.rows[0].audit_queries);
    const auditRows = Number(counts.rows[0].audit_rows);
    const dirtyAuditRows = Number(counts.rows[0].dirty_audit_rows);
    const dirtyMemories = Number(counts.rows[0].dirty_memories);
    const original = await client.query(
      `SELECT id::text AS id, at, memories, embeddings, memberships, audit_rows
         FROM principal_offboarding_events
        WHERE principal_id = $1 AND NOT repair ORDER BY id ASC LIMIT 1`, [principalId],
    );
    const originalOffboarding: OriginalOffboardingEvidence | null = original.rows[0] ? {
      evidenceId: original.rows[0].id as string,
      at: original.rows[0].at as Date,
      memories: Number(original.rows[0].memories),
      embeddings: Number(original.rows[0].embeddings),
      memberships: Number(original.rows[0].memberships),
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
    const evidence: OffboardingEvidence = {
      memberPrincipalIds: members.rows.slice(0, MAX_OFFBOARD_EVIDENCE_IDS).map((row) => row.id as string),
      authorPrincipalIds: authors.rows.slice(0, MAX_OFFBOARD_EVIDENCE_IDS).map((row) => row.id as string),
      memberPrincipalIdsTruncated: members.rows.length > MAX_OFFBOARD_EVIDENCE_IDS,
      authorPrincipalIdsTruncated: authors.rows.length > MAX_OFFBOARD_EVIDENCE_IDS,
    };
    const wasOffboarded = target.rows[0].offboarded_at !== null;
    const pseudonym = erasedPrincipalPseudonym(principalId);
    const scopePseudonym = erasedScopePseudonym(scopeId);
    const alreadyOffboarded = wasOffboarded
      && target.rows[0].disabled_at !== null
      && target.rows[0].reactivated_at === null
      && target.rows[0].display_name === pseudonym
      && scopeName === scopePseudonym
      && dirtyMemories === 0 && embeddings === 0 && memberships === 0
      && auditQueries === 0 && dirtyAuditRows === 0;
    if (!alreadyOffboarded && memories > MAX_OFFBOARD_MEMORIES) {
      throw new ServiceError('CONFLICT', `owned user scope exceeds the atomic limit of ${MAX_OFFBOARD_MEMORIES} memories`);
    }
    const result: OffboardingResult = {
      principalId, scopeId, memories, liveMemories, embeddings, memberships, auditQueries,
      auditRows, dirtyAuditRows, dirtyMemories,
      dryRun, alreadyOffboarded, pseudonym, scopePseudonym, evidence, originalOffboarding,
    };
    if (dryRun) { await client.query('ROLLBACK'); return result; }
    if (result.alreadyOffboarded) { await client.query('COMMIT'); return result; }
    await client.query(
      `UPDATE memories SET type = 'context', title = '[erased]', body = '[erased]',
              metadata = '{}'::jsonb,
              tags = '{}'::text[], source = 'erased', source_ref = NULL,
              state = 'archived', supersedes_id = NULL, promoted_to_id = NULL,
              expires_at = NULL, last_verified = NULL, updated_at = now()
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
      `UPDATE audit_log a
          SET query = NULL, metadata = '{"redacted":"principal_offboarding"}'::jsonb
        WHERE a.principal_id = $2 OR a.scope_id = $1
           OR EXISTS (SELECT 1 FROM memories m WHERE m.scope_id = $1 AND m.id = a.memory_id)
           OR (a.metadata IS NOT NULL
               AND a.metadata::text LIKE '%' || to_jsonb($3::text)::text || '%')`,
      [scopeId, principalId, scopeName],
    );
    await client.query(
      `UPDATE scopes SET name = $2 WHERE id = $1`, [scopeId, scopePseudonym],
    );
    await client.query(
      `INSERT INTO principal_offboarding_events
         (principal_id, scope_id, actor_principal_id, repair, memories, embeddings,
          memberships, audit_rows, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [principalId, scopeId, actor.id, wasOffboarded, memories, embeddings,
        memberships, auditRows, JSON.stringify(evidence)],
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
        scope_pseudonym: scopePseudonym, embeddings, memberships,
        audit_queries: auditQueries, audit_rows: auditRows, dirty_audit_rows: dirtyAuditRows,
        dirty_memories: dirtyMemories,
        member_principal_ids: evidence.memberPrincipalIds,
        author_principal_ids: evidence.authorPrincipalIds,
        member_principal_ids_truncated: evidence.memberPrincipalIdsTruncated,
        author_principal_ids_truncated: evidence.authorPrincipalIdsTruncated,
        ...(wasOffboarded && originalOffboarding
          ? { repair_of_evidence_id: originalOffboarding.evidenceId } : {}),
      })],
    );
    // Keep the lifecycle transition last so a target who is also one of
    // several org admins can write this transaction's mandatory audit rows.
    // The target row has been locked FOR UPDATE since the start, so external
    // audit inserts still serialize behind the transition and fail afterward.
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
