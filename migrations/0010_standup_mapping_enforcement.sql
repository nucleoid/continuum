-- Remove active standup semantics from legacy or forged rows that are not
-- backed by the exact current actor mapping. This is deliberately destructive
-- only to reserved derived metadata; memory content and ordinary metadata are
-- retained. Deploy this migration before application instances that require
-- mapping-bound standup reads (see docs/standup-digest.md).
UPDATE memories memory
   SET metadata = memory.metadata
       - 'actor'
       - 'actor_principal_id'
       - 'thread_owner_principal_id'
       - 'thread_key'
       - 'closes_thread_keys'
       - '_continuum_activity_provenance'
       - '_continuum_activity_epoch_ms'
       - '_continuum_actor_mapping_id'
       - '_continuum_actor_mapping_authority',
       updated_at = statement_timestamp()
 WHERE memory.metadata ?| ARRAY[
         'actor_principal_id', 'thread_owner_principal_id', 'thread_key',
         'closes_thread_keys', '_continuum_activity_provenance',
         '_continuum_activity_epoch_ms', '_continuum_actor_mapping_id',
         '_continuum_actor_mapping_authority'
       ]
   AND NOT EXISTS (
         SELECT 1
           FROM actor_principal_mappings mapping
          WHERE mapping.mapping_id = CASE
                  WHEN memory.metadata->>'_continuum_actor_mapping_id'
                         ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
                  THEN (memory.metadata->>'_continuum_actor_mapping_id')::uuid
                  ELSE NULL
                END
            AND mapping.authority = memory.metadata->>'_continuum_actor_mapping_authority'
            AND mapping.principal_id::text = memory.metadata->>'actor_principal_id'
            AND mapping.revoked_at IS NULL
       );

DROP INDEX memories_standup_closures_gin;
CREATE INDEX memories_standup_closures_gin
  ON memories USING gin ((metadata->'closes_thread_keys') jsonb_path_ops)
  WHERE metadata->>'_continuum_activity_provenance' = 'capture-v1'
    AND metadata ? 'closes_thread_keys';
