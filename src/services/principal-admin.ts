import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Principal } from '../types.js';
import { LIFECYCLE_PRINCIPAL_ID } from '../lifecycle/principal.js';
import { canonicalPrincipalExternalId } from '../storage/principals.js';
import { requireOrgAdmin } from './access.js';
import { ServiceError } from './errors.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function provisionServicePrincipal(
  pool: pg.Pool,
  actor: Principal,
  externalId: string,
  displayName: string,
): Promise<Principal> {
  const canonicalId = canonicalPrincipalExternalId(externalId);
  const name = displayName.trim().slice(0, 256);
  if (!UUID.test(canonicalId) || !name) {
    throw new ServiceError('INVALID_INPUT', 'service principal ID and display name are required');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireOrgAdmin(client, actor.id);
    const existing = await client.query(
      'SELECT id FROM principals WHERE external_id = $1 FOR UPDATE', [canonicalId],
    );
    if (existing.rowCount) {
      throw new ServiceError('CONFLICT', 'service principal already exists');
    }
    const id = randomUUID();
    const { rows } = await client.query(
      `INSERT INTO principals (id, external_id, kind, display_name)
       VALUES ($1, $2, 'service', $3)
       RETURNING id, external_id, kind, display_name, created_at`,
      [id, canonicalId, name],
    );
    await client.query(
      `INSERT INTO audit_log (principal_id, action, metadata)
       VALUES ($1, 'write', $2::jsonb)`,
      [actor.id, JSON.stringify({
        operation: 'service_principal_provisioned', service_principal_id: id,
        external_id: canonicalId,
      })],
    );
    await client.query('COMMIT');
    return {
      id: rows[0].id, externalId: rows[0].external_id, kind: rows[0].kind,
      displayName: rows[0].display_name, createdAt: rows[0].created_at,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function disablePrincipal(
  pool: pg.Pool,
  actor: Principal,
  principalId: string,
): Promise<void> {
  if (principalId === LIFECYCLE_PRINCIPAL_ID) {
    throw new ServiceError('INVALID_INPUT', 'system lifecycle principal cannot be disabled');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireOrgAdmin(client, actor.id);
    const disabled = await client.query<{ disabled: boolean }>(
      `SELECT continuum_disable_principal($1::uuid, $2::uuid) AS disabled`,
      [actor.id, principalId],
    );
    if (disabled.rows[0]?.disabled !== true) {
      throw new ServiceError('INVALID_INPUT', 'active principal not found');
    }
    await client.query(
      `INSERT INTO audit_log (principal_id, action, metadata)
       VALUES ($1, 'write', $2::jsonb)`,
      [actor.id, JSON.stringify({ operation: 'principal_disabled', principal_id: principalId })],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    const databaseError = error as { code?: string; message?: string };
    if (databaseError.code === '42501'
      || /(?:DB|role-name\/OID)-bound trusted approve identity|guarded approve path/i
        .test(databaseError.message ?? '')) {
      throw new ServiceError(
        'FORBIDDEN', 'protected principal disable requires a DB-bound operator session',
        { cause: error },
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function reactivatePrincipal(
  pool: pg.Pool,
  actor: Principal,
  principalId: string,
): Promise<void> {
  if (principalId === LIFECYCLE_PRINCIPAL_ID) {
    throw new ServiceError('INVALID_INPUT', 'system lifecycle principal cannot be reactivated');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireOrgAdmin(client, actor.id);
    const reactivated = await client.query(
      `SELECT continuum_operator_reactivate_principal($1::uuid, $2::uuid) AS previously_offboarded`,
      [principalId, actor.id],
    );
    if (reactivated.rows[0]?.previously_offboarded === null) {
      throw new ServiceError('INVALID_INPUT', 'disabled principal not found');
    }
    await client.query(
      `INSERT INTO audit_log (principal_id, action, metadata)
       VALUES ($1, 'write', $2::jsonb)`,
      [actor.id, JSON.stringify({
        operation: 'principal_reactivated',
        principal_id: principalId,
        previously_offboarded: reactivated.rows[0].previously_offboarded,
      })],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    const databaseError = error as { code?: string; message?: string };
    if (databaseError.code === '42501'
      || /(?:DB|role-name\/OID)-bound trusted approve identity|operator session/i
        .test(databaseError.message ?? '')) {
      throw new ServiceError(
        'FORBIDDEN', 'principal reactivation requires a DB-bound operator session',
        { cause: error },
      );
    }
    throw error;
  } finally {
    client.release();
  }
}
