-- Run after every application instance is vocabulary-aware and before writers
-- resume following a rollback. This replaces the compatibility function and
-- recreates the strict trigger as one bounded transaction.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE memories IN EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION enforce_memory_tag_vocabulary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  memory_scope_kind TEXT;
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

DROP TRIGGER IF EXISTS memories_tags_controlled_vocabulary ON memories;
CREATE TRIGGER memories_tags_controlled_vocabulary
BEFORE INSERT OR UPDATE OF scope_id, tags ON memories
FOR EACH ROW
EXECUTE FUNCTION enforce_memory_tag_vocabulary();

COMMIT;
