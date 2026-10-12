/** Activity authority lives in checked relations, never caller metadata. */
export const TRUSTED_ACTIVITY_METADATA_KEYS = [
  'actor', 'actor_principal_id', 'thread_owner_principal_id', 'thread_key', 'closes_thread_keys',
  '_continuum_activity_provenance', '_continuum_activity_epoch_ms',
  '_continuum_actor_mapping_id', '_continuum_actor_mapping_authority',
] as const;

export function stripTrustedActivityMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const result = { ...metadata };
  for (const key of TRUSTED_ACTIVITY_METADATA_KEYS) delete result[key];
  return result;
}
