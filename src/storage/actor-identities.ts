import type pg from 'pg';
import type { ExternalActorIdentity } from '../capture/plugin.js';
import type { Queryable } from './queryable.js';

export interface ActorIdentityMappingInput {
  authority: string;
  externalActorId: string;
  principalId: string;
  mappedByPrincipalId: string;
}

export interface ActorIdentityRevocationInput {
  authority: string;
  externalActorId: string;
  revokedByPrincipalId: string;
}

export async function mapActorIdentity(
  db: Queryable,
  input: ActorIdentityMappingInput,
): Promise<void> {
  await db.query(
    `INSERT INTO actor_principal_mappings
       (authority, external_actor_id, principal_id, mapped_by_principal_id)
     VALUES ($1, $2, $3, $4)`,
    [input.authority, input.externalActorId, input.principalId, input.mappedByPrincipalId],
  );
}

export async function revokeActorIdentity(
  db: Queryable,
  input: ActorIdentityRevocationInput,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE actor_principal_mappings
        SET revoked_by_principal_id = $3
      WHERE authority = $1 AND external_actor_id = $2 AND revoked_at IS NULL`,
    [input.authority, input.externalActorId, input.revokedByPrincipalId],
  );
  return result.rowCount === 1;
}

export async function replaceActorIdentity(
  pool: pg.Pool,
  input: ActorIdentityMappingInput,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const revoked = await revokeActorIdentity(client, {
      authority: input.authority,
      externalActorId: input.externalActorId,
      revokedByPrincipalId: input.mappedByPrincipalId,
    });
    if (!revoked) throw new Error('active actor identity mapping not found');
    await mapActorIdentity(client, input);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveActorPrincipalId(
  db: pg.Pool | Queryable,
  identity: ExternalActorIdentity,
  options: { lock?: boolean } = {},
): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT mapping.principal_id
       FROM actor_principal_mappings mapping
       JOIN principals principal ON principal.id = mapping.principal_id
      WHERE mapping.authority = $1
        AND mapping.external_actor_id = $2
        AND mapping.revoked_at IS NULL
        AND principal.kind = 'user'
      ${options.lock ? 'FOR KEY SHARE OF mapping, principal' : ''}`,
    [identity.authority, identity.externalId],
  );
  return (rows[0]?.principal_id as string | undefined) ?? null;
}
