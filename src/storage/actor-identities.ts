import type pg from 'pg';
import type { ExternalActorIdentity } from '../capture/plugin.js';
import type { Queryable } from './queryable.js';

export interface ActorIdentityMappingInput {
  authority: string;
  externalActorId: string;
  principalId: string;
  mappedByPrincipalId: string;
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

export async function resolveActorPrincipalId(
  db: pg.Pool | Queryable,
  identity: ExternalActorIdentity,
): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT mapping.principal_id
       FROM actor_principal_mappings mapping
       JOIN principals principal ON principal.id = mapping.principal_id
      WHERE mapping.authority = $1
        AND mapping.external_actor_id = $2
        AND principal.kind = 'user'`,
    [identity.authority, identity.externalId],
  );
  return (rows[0]?.principal_id as string | undefined) ?? null;
}
