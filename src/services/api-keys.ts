import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Principal } from '../types.js';
import { requireOrgAdmin } from './access.js';
import { ServiceError } from './errors.js';

export interface IssuedApiKey {
  id: string;
  key: string;
  prefix: string;
  lastFour: string;
  allowedSource: string | null;
}

function validateSource(source?: string): string | null {
  if (source === undefined) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(source)) {
    throw new ServiceError('INVALID_INPUT', 'allowed source is invalid');
  }
  return source;
}

function material(): Omit<IssuedApiKey, 'id' | 'allowedSource'> & { hash: Buffer } {
  const key = `ctm_${randomBytes(32).toString('base64url')}`;
  return {
    key, prefix: key.slice(0, 12), lastFour: key.slice(-4),
    hash: createHash('sha256').update(key, 'utf8').digest(),
  };
}

export async function issueApiKey(
  pool: pg.Pool,
  actor: Principal,
  servicePrincipalId: string,
  allowedSource?: string,
): Promise<IssuedApiKey> {
  const source = validateSource(allowedSource);
  const generated = material();
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireOrgAdmin(client, actor.id);
    const principal = await client.query(
      `SELECT 1 FROM principals
        WHERE id = $1 AND kind = 'service' AND disabled_at IS NULL FOR UPDATE`,
      [servicePrincipalId],
    );
    if (!principal.rowCount) throw new ServiceError('INVALID_INPUT', 'service principal not found');
    await client.query(
      `INSERT INTO service_api_keys
         (id, principal_id, key_hash, prefix, last_four, allowed_source)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, servicePrincipalId, generated.hash, generated.prefix, generated.lastFour, source],
    );
    await client.query(
      `INSERT INTO audit_log (principal_id, action, metadata)
       VALUES ($1, 'write', $2::jsonb)`,
      [actor.id, JSON.stringify({ operation: 'api_key_issued', key_id: id, service_principal_id: servicePrincipalId })],
    );
    await client.query('COMMIT');
    return { id, key: generated.key, prefix: generated.prefix, lastFour: generated.lastFour, allowedSource: source };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function rotateApiKey(
  pool: pg.Pool,
  actor: Principal,
  keyId: string,
): Promise<IssuedApiKey> {
  const generated = material();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireOrgAdmin(client, actor.id);
    const { rows } = await client.query(
      `UPDATE service_api_keys k
          SET key_hash = $2, prefix = $3, last_four = $4, rotated_at = now()
         FROM principals p
        WHERE k.id = $1 AND k.revoked_at IS NULL
          AND p.id = k.principal_id AND p.disabled_at IS NULL
      RETURNING k.allowed_source, k.principal_id, k.rotated_at`,
      [keyId, generated.hash, generated.prefix, generated.lastFour],
    );
    if (!rows[0]) throw new ServiceError('INVALID_INPUT', 'API key not found');
    await client.query(
      `INSERT INTO audit_log (principal_id, action, metadata)
       VALUES ($1, 'write', $2::jsonb)`,
      [actor.id, JSON.stringify({ operation: 'api_key_rotated', key_id: keyId,
        service_principal_id: rows[0].principal_id, key_rotated_at: rows[0].rotated_at })],
    );
    await client.query('COMMIT');
    return { id: keyId, key: generated.key, prefix: generated.prefix,
      lastFour: generated.lastFour, allowedSource: rows[0].allowed_source };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function revokeApiKey(
  pool: pg.Pool,
  actor: Principal,
  keyId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireOrgAdmin(client, actor.id);
    const { rows } = await client.query(
      `UPDATE service_api_keys SET revoked_at = now()
        WHERE id = $1 AND revoked_at IS NULL
      RETURNING principal_id, revoked_at`,
      [keyId],
    );
    if (!rows[0]) throw new ServiceError('INVALID_INPUT', 'API key not found');
    await client.query(
      `INSERT INTO audit_log (principal_id, action, metadata)
       VALUES ($1, 'write', $2::jsonb)`,
      [actor.id, JSON.stringify({ operation: 'api_key_revoked', key_id: keyId,
        service_principal_id: rows[0].principal_id, key_revoked_at: rows[0].revoked_at })],
    );
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
