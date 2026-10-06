import type { Queryable } from './queryable.js';

export interface ActivityAttributionInput {
  memoryId: string;
  actorPrincipalId: string;
  mappingId: string;
  mappingAuthority: string;
  actorLabel: string;
  threadKey: string;
  closesThreadKeys: string[];
  activityAt: Date;
  trustExpiresAt?: Date | null;
}

export interface StoredActivityAttribution {
  actorPrincipalId: string;
  mappingId: string;
  mappingAuthority: string;
  actorLabel: string;
  threadKey: string;
  activityAt: Date;
  trustExpiresAt: Date | null;
}

export async function createActivityAttribution(
  db: Queryable,
  input: ActivityAttributionInput,
): Promise<void> {
  const attribution = await db.query<{ activity_at: Date }>(
    `INSERT INTO memory_activity_attributions
       (memory_id, actor_principal_id, thread_owner_principal_id, mapping_id,
        mapping_authority, actor_label, thread_key, activity_at, trust_expires_at)
     VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8)
     RETURNING activity_at`,
    [
      input.memoryId,
      input.actorPrincipalId,
      input.mappingId,
      input.mappingAuthority,
      input.actorLabel,
      input.threadKey,
      input.activityAt,
      input.trustExpiresAt ?? null,
    ],
  );
  if (input.closesThreadKeys.length > 0) {
    await db.query(
      `INSERT INTO standup_thread_closures
         (source_memory_id, actor_principal_id, mapping_id, thread_key, closed_at)
       SELECT $1, $2, $3, key, $5
         FROM unnest($4::text[]) AS key`,
      [
        input.memoryId,
        input.actorPrincipalId,
        input.mappingId,
        input.closesThreadKeys,
        attribution.rows[0]!.activity_at,
      ],
    );
  }
}

export async function getActivityAttributionForUpdate(
  db: Queryable,
  memoryId: string,
): Promise<StoredActivityAttribution | null> {
  const { rows } = await db.query(
    `SELECT attribution.actor_principal_id, attribution.mapping_id,
            attribution.mapping_authority, attribution.actor_label,
            attribution.thread_key, attribution.activity_at,
            attribution.trust_expires_at
       FROM memory_activity_attributions attribution
       JOIN actor_principal_mappings mapping
         ON mapping.mapping_id = attribution.mapping_id
        AND mapping.authority = attribution.mapping_authority
        AND mapping.principal_id = attribution.actor_principal_id
        AND (mapping.revoked_at IS NULL
             OR mapping.revoked_at >= attribution.received_at)
      WHERE attribution.memory_id = $1
      FOR SHARE OF attribution, mapping`,
    [memoryId],
  );
  const row = rows[0];
  return row ? {
    actorPrincipalId: row.actor_principal_id,
    mappingId: row.mapping_id,
    mappingAuthority: row.mapping_authority,
    actorLabel: row.actor_label,
    threadKey: row.thread_key,
    activityAt: row.activity_at,
    trustExpiresAt: row.trust_expires_at,
  } : null;
}
