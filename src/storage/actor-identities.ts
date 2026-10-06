import type pg from 'pg';
import type { ExternalActorIdentity } from '../capture/plugin.js';
import type { Queryable } from './queryable.js';

export interface ActorIdentityMappingInput {
  authority: string;
  externalActorId: string;
  principalId: string;
  mappedByPrincipalId: string;
}

export interface ActorIdentityReplacementInput extends ActorIdentityMappingInput {
  reason: string;
}

export interface ActorIdentityRevocationInput {
  authority: string;
  externalActorId: string;
  revokedByPrincipalId: string;
  reason: string;
}

export interface ResolvedActorIdentityMapping {
  mappingId: string;
  authority: string;
  principalId: string;
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
    `WITH active_mapping AS MATERIALIZED (
       SELECT mapping_id
         FROM actor_principal_mappings
        WHERE authority = $1 AND external_actor_id = $2 AND revoked_at IS NULL
        FOR UPDATE
     )
     UPDATE actor_principal_mappings mapping
        SET revoked_by_principal_id = $3, revocation_reason = $4
       FROM active_mapping
      WHERE mapping.mapping_id = active_mapping.mapping_id`,
    [input.authority, input.externalActorId, input.revokedByPrincipalId, input.reason],
  );
  return result.rowCount === 1;
}

export async function replaceActorIdentity(
  pool: pg.Pool,
  input: ActorIdentityReplacementInput,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const revoked = await revokeActorIdentity(client, {
      authority: input.authority,
      externalActorId: input.externalActorId,
      revokedByPrincipalId: input.mappedByPrincipalId,
      reason: input.reason,
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
  return (await resolveActorIdentityMapping(db, identity, options))?.principalId ?? null;
}

export async function resolveActorIdentityMapping(
  db: pg.Pool | Queryable,
  identity: ExternalActorIdentity,
  options: { lock?: boolean } = {},
): Promise<ResolvedActorIdentityMapping | null> {
  const { rows } = await db.query(
    `SELECT mapping.mapping_id, mapping.authority, mapping.principal_id
       FROM actor_principal_mappings mapping
       JOIN principals principal ON principal.id = mapping.principal_id
      WHERE mapping.authority = $1
        AND mapping.external_actor_id = $2
        AND mapping.revoked_at IS NULL
        AND principal.kind = 'user'
      ${options.lock ? 'FOR SHARE OF mapping FOR KEY SHARE OF principal' : ''}`,
    [identity.authority, identity.externalId],
  );
  const row = rows[0] as {
    mapping_id: string;
    authority: string;
    principal_id: string;
  } | undefined;
  return row ? {
    mappingId: row.mapping_id,
    authority: row.authority,
    principalId: row.principal_id,
  } : null;
}
