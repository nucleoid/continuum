-- MAINTENANCE-ONLY DATA CLEANUP. This file is intentionally outside migrations/
-- and is never run by ordinary application startup. Drain old writers and run
-- the documented preflight before executing it with psql in a maintenance window.
-- Remove active standup semantics from legacy or forged rows that are not
-- backed by the exact current actor mapping. This is deliberately destructive
-- only to reserved derived metadata; memory content and ordinary metadata are
-- retained. Strict readers already fail closed without this cleanup.
SET lock_timeout = '5s';
SET statement_timeout = '5min';

WITH candidates AS MATERIALIZED (
  SELECT memory.id
    FROM memories memory
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
         )
   ORDER BY memory.id
   LIMIT 10000
   FOR UPDATE SKIP LOCKED
)
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
  FROM candidates
 WHERE memory.id = candidates.id;

-- Thread ownership is part of actor attribution, not a delegation mechanism.
-- Retire historical rows that omit it or assign the thread to another actor.
WITH candidates AS MATERIALIZED (
  SELECT memory.id
    FROM memories memory
   WHERE memory.metadata ? 'actor_principal_id'
     AND memory.metadata->>'thread_owner_principal_id'
           IS DISTINCT FROM memory.metadata->>'actor_principal_id'
   ORDER BY memory.id
   LIMIT 10000
   FOR UPDATE SKIP LOCKED
)
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
  FROM candidates
 WHERE memory.id = candidates.id;
