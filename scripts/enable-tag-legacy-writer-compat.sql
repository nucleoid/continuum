-- Run this procedure only after webhook intake is paused and in-flight
-- deliveries are drained, immediately before rolling the application back to
-- any pre-vocabulary application version. It normalizes every legacy writer
-- at the database boundary so rollback cannot silently lose tagged writes.
BEGIN;

SET LOCAL lock_timeout = '5s';
LOCK TABLE memories IN EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION enforce_memory_tag_vocabulary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  memory_scope_kind TEXT;
  active_tags TEXT[];
  legacy_tags JSONB;
  original_tags TEXT[] := NEW.tags;
  original_metadata JSONB := NEW.metadata;
BEGIN
  SELECT kind INTO STRICT memory_scope_kind
    FROM scopes
   WHERE id = NEW.scope_id;

  PERFORM 1
    FROM tag_vocabularies
   WHERE scope_kind = memory_scope_kind
     AND tag = ANY(
       SELECT lower(btrim(requested.tag))
         FROM unnest(NEW.tags) AS requested(tag)
     )
   FOR KEY SHARE;

  WITH expanded AS (
    SELECT requested.tag,
           requested.position,
           lower(btrim(requested.tag)) AS normalized
      FROM unnest(NEW.tags) WITH ORDINALITY AS requested(tag, position)
  ), classified AS (
    SELECT expanded.*,
           EXISTS (
             SELECT 1
               FROM tag_vocabularies AS vocabulary
              WHERE vocabulary.scope_kind = memory_scope_kind
                AND vocabulary.tag = expanded.normalized
           ) AS allowed,
           row_number() OVER (
             PARTITION BY normalized ORDER BY position
           ) AS occurrence
      FROM expanded
  )
  SELECT COALESCE(
           array_agg(normalized ORDER BY position)
             FILTER (WHERE allowed AND occurrence = 1),
           '{}'::text[]
         ),
         jsonb_agg(tag ORDER BY position)
           FILTER (WHERE NOT allowed OR occurrence > 1)
    INTO active_tags, legacy_tags
    FROM classified;

  NEW.tags := active_tags;
  NEW.metadata :=
    CASE
      WHEN jsonb_typeof(original_metadata) = 'object' THEN
        original_metadata
          - 'continuum_legacy_tags'
          - 'continuum_legacy_metadata'
          - 'continuum_tag_migration'
          - 'continuum_migration_conflicts'
      ELSE '{}'::jsonb
    END
    || CASE WHEN jsonb_typeof(original_metadata) <> 'object'
      THEN jsonb_build_object('continuum_legacy_metadata', original_metadata)
      ELSE '{}'::jsonb END
    || CASE WHEN legacy_tags IS NOT NULL
      THEN jsonb_build_object('continuum_legacy_tags', legacy_tags)
      ELSE '{}'::jsonb END
    || jsonb_build_object(
      'continuum_tag_migration',
      jsonb_build_object('version', 1, 'original_tags', to_jsonb(original_tags))
    )
    || CASE WHEN jsonb_typeof(original_metadata) = 'object' AND (
         original_metadata ? 'continuum_legacy_tags'
      OR original_metadata ? 'continuum_legacy_metadata'
      OR original_metadata ? 'continuum_tag_migration'
      OR original_metadata ? 'continuum_migration_conflicts'
    ) THEN jsonb_build_object(
      'continuum_migration_conflicts',
        CASE WHEN original_metadata ? 'continuum_legacy_tags'
          THEN jsonb_build_array(jsonb_build_object(
            'key', 'continuum_legacy_tags', 'value', original_metadata->'continuum_legacy_tags'))
          ELSE '[]'::jsonb END
        || CASE WHEN original_metadata ? 'continuum_legacy_metadata'
          THEN jsonb_build_array(jsonb_build_object(
            'key', 'continuum_legacy_metadata', 'value', original_metadata->'continuum_legacy_metadata'))
          ELSE '[]'::jsonb END
        || CASE WHEN original_metadata ? 'continuum_tag_migration'
          THEN jsonb_build_array(jsonb_build_object(
            'key', 'continuum_tag_migration', 'value', original_metadata->'continuum_tag_migration'))
          ELSE '[]'::jsonb END
        || CASE WHEN original_metadata ? 'continuum_migration_conflicts'
          THEN jsonb_build_array(jsonb_build_object(
            'key', 'continuum_migration_conflicts', 'value', original_metadata->'continuum_migration_conflicts'))
          ELSE '[]'::jsonb END
    ) ELSE '{}'::jsonb END;

  RETURN NEW;
END;
$$;

COMMIT;
