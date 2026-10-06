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
  auditId: string;
  at: Date;
  memories: number;
  embeddings: number;
  memberships: number;
  auditQueries: number;
}

export interface OffboardingResult {
  principalId: string; scopeId: string; memories: number; embeddings: number;
  memberships: number; liveMemories: number; auditQueries: number;
  dryRun: boolean; alreadyOffboarded: boolean; pseudonym: string;
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
        WHERE principal_id = $1 AND scope_id = $2 LIMIT 1`, [principalId, scopeId],
    );
    if (!history.rowCount) {
      throw new ServiceError('CONFLICT', 'principal has no membership history on the user scope');
    }
    const otherActiveMembers = await client.query(
      `SELECT DISTINCT m.principal_id
         FROM scope_memberships m
         JOIN principals p ON p.id = m.principal_id AND p.disabled_at IS NULL
        WHERE m.scope_id = $1 AND m.principal_id <> $2 AND m.active
          AND continuum_membership_is_effective(m.active, m.source_kind)
        LIMIT 1`, [scopeId, principalId],
    );
    if (otherActiveMembers.rowCount && !allowOtherActiveMembers) {
      throw new ServiceError(
        'CONFLICT',
        'user scope has other active members; explicit allowOtherActiveMembers override is required',
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
      `SELECT id, disabled_at, offboarded_at, reactivated_at
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
    const history = await client.query(
      `SELECT 1 FROM scope_memberships
        WHERE principal_id = $1 AND scope_id = $2 LIMIT 1`, [principalId, scopeId],
    );
    if (!history.rowCount) {
      throw new ServiceError('CONFLICT', 'principal has no membership history on the owned user scope');
    }
    const otherActiveMembers = await client.query(
      `SELECT DISTINCT m.principal_id
         FROM scope_memberships m
         JOIN principals p ON p.id = m.principal_id AND p.disabled_at IS NULL
        WHERE m.scope_id = $1 AND m.principal_id <> $2 AND m.active
          AND continuum_membership_is_effective(m.active, m.source_kind)
        LIMIT 1`, [scopeId, principalId],
    );
    if (otherActiveMembers.rowCount && !mapping.rows[0].allow_other_active_members) {
      throw new ServiceError(
        'CONFLICT',
        'owned user scope has other active members without an explicit safe operator override',
      );
    }
    const counts = await client.query(
      `SELECT
         (SELECT count(*)::int FROM memories WHERE scope_id = $1) AS memories,
         (SELECT count(*)::int FROM memories WHERE scope_id = $1 AND state = 'live') AS live_memories,
         (SELECT count(*)::int FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id WHERE m.scope_id = $1) AS embeddings,
         (SELECT count(*)::int FROM scope_memberships WHERE scope_id = $1 AND active) AS memberships,
         (SELECT count(*)::int FROM audit_log WHERE principal_id = $2 AND query IS NOT NULL) AS audit_queries`,
      [scopeId, principalId],
    );
    const memories = Number(counts.rows[0].memories);
    const liveMemories = Number(counts.rows[0].live_memories);
    const embeddings = Number(counts.rows[0].embeddings);
    const memberships = Number(counts.rows[0].memberships);
    const auditQueries = Number(counts.rows[0].audit_queries);
    const original = await client.query(
      `SELECT id::text AS id, at, metadata
         FROM audit_log
        WHERE metadata->>'operation' = 'principal_offboarded'
          AND metadata->>'principal_id' = $1
        ORDER BY id ASC LIMIT 1`, [principalId],
    );
    const originalMetadata = original.rows[0]?.metadata as Record<string, unknown> | undefined;
    const originalOffboarding: OriginalOffboardingEvidence | null = original.rows[0] ? {
      auditId: original.rows[0].id as string,
      at: original.rows[0].at as Date,
      memories: Number(originalMetadata?.memories ?? 0),
      embeddings: Number(originalMetadata?.embeddings ?? 0),
      memberships: Number(originalMetadata?.memberships ?? 0),
      auditQueries: Number(originalMetadata?.audit_queries ?? 0),
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
    const alreadyOffboarded = wasOffboarded
      && target.rows[0].disabled_at !== null
      && target.rows[0].reactivated_at === null
      && liveMemories === 0 && embeddings === 0 && memberships === 0 && auditQueries === 0;
    if (!alreadyOffboarded && memories > MAX_OFFBOARD_MEMORIES) {
      throw new ServiceError('CONFLICT', `owned user scope exceeds the atomic limit of ${MAX_OFFBOARD_MEMORIES} memories`);
    }
    const pseudonym = erasedPrincipalPseudonym(principalId);
    const result: OffboardingResult = {
      principalId, scopeId, memories, liveMemories, embeddings, memberships, auditQueries,
      dryRun, alreadyOffboarded, pseudonym, evidence, originalOffboarding,
    };
    if (dryRun) { await client.query('ROLLBACK'); return result; }
    if (result.alreadyOffboarded) { await client.query('COMMIT'); return result; }
    await client.query(
      `UPDATE memories SET title = '[erased]', body = '[erased]', metadata = '{}'::jsonb,
              tags = '{}'::text[], source = 'erased', source_ref = NULL,
              state = 'archived', expires_at = NULL, last_verified = NULL, updated_at = now()
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
      `UPDATE audit_log SET query = NULL
        WHERE principal_id = $1 AND query IS NOT NULL`, [principalId],
    );
    await client.query(
      `UPDATE principals SET display_name = $2, disabled_at = COALESCE(disabled_at, now()),
              offboarded_at = now(), reactivated_at = NULL WHERE id = $1`,
      [principalId, pseudonym],
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
        embeddings, memberships, audit_queries: auditQueries,
        ...(wasOffboarded && originalOffboarding
          ? { repair_of_audit_id: originalOffboarding.auditId } : {}),
      })],
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
