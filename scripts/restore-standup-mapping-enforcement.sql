\set ON_ERROR_STOP on
-- Restore the exact metadata captured by run-standup-mapping-enforcement.sql.
-- Drain writers and review the backup before running this rollback.
BEGIN;
SET LOCAL continuum.maintenance_restore = 'on';
UPDATE memories memory
   SET metadata = (
         memory.metadata
           - '_continuum_activity_provenance'
           - '_continuum_activity_epoch_ms'
           - '_continuum_actor_mapping_id'
           - '_continuum_actor_mapping_authority'
       ) || jsonb_strip_nulls(jsonb_build_object(
         '_continuum_activity_provenance',
           backup.metadata->'_continuum_activity_provenance',
         '_continuum_activity_epoch_ms',
           backup.metadata->'_continuum_activity_epoch_ms',
         '_continuum_actor_mapping_id',
           backup.metadata->'_continuum_actor_mapping_id',
         '_continuum_actor_mapping_authority',
           backup.metadata->'_continuum_actor_mapping_authority'
       )),
       updated_at = statement_timestamp()
  FROM standup_metadata_cleanup_backup backup
 WHERE memory.id = backup.memory_id;
COMMIT;
