-- Run this procedure only after webhook intake is paused and in-flight
-- deliveries are drained, immediately before rolling the application back to
-- a version whose ADO/deploy plugins still emit dynamic tags. It preserves
-- those values privately while every other writer remains fail-closed.
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
  unknown_count INTEGER;
BEGIN
  IF cardinality(NEW.tags) = 0 THEN
    RETURN NEW;
  END IF;

  SELECT kind INTO STRICT memory_scope_kind
    FROM scopes
   WHERE id = NEW.scope_id;

  PERFORM 1
    FROM tag_vocabularies
   WHERE scope_kind = memory_scope_kind
     AND tag = ANY(NEW.tags)
   FOR KEY SHARE;

  IF NEW.source IN ('ado-workitem', 'deploy-event') THEN
    WITH classified AS (
      SELECT requested.tag,
             requested.position,
             EXISTS (
               SELECT 1
                 FROM tag_vocabularies AS vocabulary
                WHERE vocabulary.scope_kind = memory_scope_kind
                  AND vocabulary.tag = requested.tag
             ) AS allowed,
             row_number() OVER (
               PARTITION BY requested.tag ORDER BY requested.position
             ) AS occurrence
        FROM unnest(NEW.tags) WITH ORDINALITY AS requested(tag, position)
    )
    SELECT COALESCE(
             array_agg(tag ORDER BY position)
               FILTER (WHERE allowed AND occurrence = 1),
             '{}'::text[]
           ),
           jsonb_agg(tag ORDER BY position)
             FILTER (WHERE NOT allowed OR occurrence > 1)
      INTO active_tags, legacy_tags
      FROM classified;

    NEW.tags := active_tags;
    IF legacy_tags IS NOT NULL THEN
      NEW.metadata := jsonb_set(
        CASE
          WHEN jsonb_typeof(NEW.metadata) = 'object' THEN NEW.metadata
          ELSE jsonb_build_object('continuum_legacy_metadata', NEW.metadata)
        END,
        '{continuum_legacy_tags}',
        CASE
          WHEN jsonb_typeof(NEW.metadata) = 'object'
            AND jsonb_typeof(NEW.metadata->'continuum_legacy_tags') = 'array'
            THEN NEW.metadata->'continuum_legacy_tags'
          WHEN jsonb_typeof(NEW.metadata) = 'object'
            AND NEW.metadata ? 'continuum_legacy_tags'
            AND jsonb_typeof(NEW.metadata->'continuum_legacy_tags') <> 'null'
            THEN jsonb_build_array(NEW.metadata->'continuum_legacy_tags')
          ELSE '[]'::jsonb
        END || legacy_tags,
        true
      );
    END IF;
    RETURN NEW;
  END IF;

  SELECT count(*)::integer INTO unknown_count
    FROM unnest(NEW.tags) AS requested(tag)
   WHERE requested.tag IS NULL
      OR NOT EXISTS (
        SELECT 1
          FROM tag_vocabularies AS vocabulary
         WHERE vocabulary.scope_kind = memory_scope_kind
           AND vocabulary.tag = requested.tag
      );

  IF unknown_count > 0
     OR cardinality(NEW.tags) <> (
       SELECT count(DISTINCT requested.tag)
         FROM unnest(NEW.tags) AS requested(tag)
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'memory tags violate the controlled vocabulary',
      CONSTRAINT = 'memories_tags_controlled_vocabulary';
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
