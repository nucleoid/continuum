import type pg from 'pg';
import type { Principal } from '../types.js';
import { requireOrgAdmin } from './access.js';
import { ServiceError } from './errors.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SYNC_LOCK_ID = '834641726154302119';
export const MAX_OFFBOARD_MEMORIES = 10_000;

export interface OffboardingResult {
  principalId: string; scopeId: string; memories: number; embeddings: number;
  memberships: number; dryRun: boolean; alreadyOffboarded: boolean; pseudonym: string;
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
): Promise<{ principalId: string; scopeId: string; created: boolean }> {
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
    const existing = await client.query(
      `SELECT principal_id, scope_id FROM principal_user_scopes
        WHERE principal_id = $1 OR scope_id = $2 FOR UPDATE`, [principalId, scopeId],
    );
    if (existing.rows[0]
      && (existing.rows[0].principal_id !== principalId || existing.rows[0].scope_id !== scopeId)) {
      throw new ServiceError('CONFLICT', 'principal or user scope already has a different owner mapping');
    }
    const created = !existing.rows[0];
    if (created) {
      await client.query(
        `INSERT INTO principal_user_scopes (principal_id, scope_id, mapped_by)
         VALUES ($1, $2, $3)`, [principalId, scopeId, actor.id],
      );
      await client.query(
        `INSERT INTO audit_log (principal_id, action, scope_id, metadata)
         VALUES ($1, 'write', $2, $3::jsonb)`,
        [actor.id, scopeId, JSON.stringify({ operation: 'principal_user_scope_mapped', principal_id: principalId })],
      );
    }
    await client.query('COMMIT');
    return { principalId, scopeId, created };
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
      `SELECT id, offboarded_at FROM principals WHERE id = $1 AND kind = 'user' FOR UPDATE`,
      [principalId],
    );
    if (!target.rowCount) throw new ServiceError('INVALID_INPUT', 'user principal not found');
    const mapping = await client.query(
      `SELECT pus.scope_id FROM principal_user_scopes pus
        JOIN scopes s ON s.id = pus.scope_id AND s.kind = 'user'
       WHERE pus.principal_id = $1 FOR UPDATE OF pus, s`, [principalId],
    );
    if (!mapping.rowCount) {
      throw new ServiceError('CONFLICT', 'principal has no explicit owned user scope mapping');
    }
    const scopeId = mapping.rows[0].scope_id as string;
    const counts = await client.query(
      `SELECT
         (SELECT count(*)::int FROM memories WHERE scope_id = $1) AS memories,
         (SELECT count(*)::int FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id WHERE m.scope_id = $1) AS embeddings,
         (SELECT count(*)::int FROM scope_memberships WHERE principal_id = $2 AND active) AS memberships`,
      [scopeId, principalId],
    );
    const memories = Number(counts.rows[0].memories);
    const embeddings = Number(counts.rows[0].embeddings);
    const memberships = Number(counts.rows[0].memberships);
    const alreadyOffboarded = target.rows[0].offboarded_at !== null;
    if (!alreadyOffboarded && memories > MAX_OFFBOARD_MEMORIES) {
      throw new ServiceError('CONFLICT', `owned user scope exceeds the atomic limit of ${MAX_OFFBOARD_MEMORIES} memories`);
    }
    const pseudonym = erasedPrincipalPseudonym(principalId);
    const result: OffboardingResult = {
      principalId, scopeId, memories, embeddings, memberships, dryRun,
      alreadyOffboarded, pseudonym,
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
        operation: 'principal_offboarded', principal_id: principalId,
        pseudonym, memories, embeddings, memberships,
      })],
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { destroyClient = true; }
    throw error;
  } finally { client.release(destroyClient); }
}
