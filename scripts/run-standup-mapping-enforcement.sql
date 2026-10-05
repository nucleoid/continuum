\set ON_ERROR_STOP on
-- MAINTENANCE ONLY. Drain old writers first. This removes only obsolete trust
-- markers; content, attribution labels, thread labels, and revoked history stay
-- intact. Every changed value is backed up for exact restoration.
SET lock_timeout = '5s';
SET statement_timeout = '30min';

CREATE TABLE IF NOT EXISTS standup_metadata_cleanup_backup (
  memory_id UUID PRIMARY KEY REFERENCES memories(id) ON DELETE RESTRICT,
  metadata JSONB NOT NULL,
  backed_up_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

INSERT INTO standup_metadata_cleanup_backup (memory_id, metadata)
SELECT memory.id, memory.metadata
  FROM memories memory
 WHERE memory.metadata ?| ARRAY[
   '_continuum_activity_provenance', '_continuum_activity_epoch_ms',
   '_continuum_actor_mapping_id', '_continuum_actor_mapping_authority'
 ]
ON CONFLICT (memory_id) DO NOTHING;

DO $$
DECLARE
  changed INTEGER;
BEGIN
  LOOP
    WITH candidates AS MATERIALIZED (
      SELECT memory.id
        FROM memories memory
       WHERE memory.metadata ?| ARRAY[
         '_continuum_activity_provenance', '_continuum_activity_epoch_ms',
         '_continuum_actor_mapping_id', '_continuum_actor_mapping_authority'
       ]
       ORDER BY memory.id
       LIMIT 10000
       FOR UPDATE SKIP LOCKED
    )
    UPDATE memories memory
       SET metadata = memory.metadata
           - '_continuum_activity_provenance'
           - '_continuum_activity_epoch_ms'
           - '_continuum_actor_mapping_id'
           - '_continuum_actor_mapping_authority',
           updated_at = statement_timestamp()
      FROM candidates
     WHERE memory.id = candidates.id;
    GET DIAGNOSTICS changed = ROW_COUNT;
    EXIT WHEN changed = 0;
    COMMIT;
  END LOOP;
END
$$;
