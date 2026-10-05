\set ON_ERROR_STOP on
-- Restore the exact metadata captured by run-standup-mapping-enforcement.sql.
-- Drain writers and review the backup before running this rollback.
BEGIN;
SET LOCAL continuum.maintenance_restore = 'on';
UPDATE memories memory
   SET metadata = backup.metadata,
       updated_at = statement_timestamp()
  FROM standup_metadata_cleanup_backup backup
 WHERE memory.id = backup.memory_id;
COMMIT;
