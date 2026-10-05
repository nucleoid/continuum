-- This must be the first migration statement: principal creation and other
-- pre-lock DDL can otherwise wait indefinitely on principals/memories FKs.
SET LOCAL lock_timeout = '5s';

CREATE TABLE tag_vocabularies (
  scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('org', 'team', 'project', 'user', 'role')),
  tag         TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 64),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  created_by  UUID REFERENCES principals(id) ON DELETE RESTRICT,
  is_system   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_kind, tag),
  CHECK (tag = lower(tag)),
  CHECK (tag ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CHECK ((is_system AND created_by IS NULL) OR (NOT is_system AND created_by IS NOT NULL))
);

INSERT INTO tag_vocabularies (scope_kind, tag, description, is_system)
SELECT scope_kind, tag, 'Built-in Continuum tag', true
  FROM unnest(ARRAY['org', 'team', 'project', 'user', 'role']) AS scope_kind
 CROSS JOIN unnest(ARRAY[
   'pr', 'merged', 'branch', 'github', 'ado', 'deploy', 'session', 'terminal', 'decision',
   'knowledge-gap'
 ]) AS tag;

-- Drain writers that started before this migration, then keep later writers
-- paused until the historical rewrite and enforcement trigger commit together.
-- EXCLUSIVE conflicts with the ROW SHARE lock taken by SELECT ... FOR UPDATE,
-- so promote/verify writers drain before the migration can block their later
-- write-lock upgrade. ACCESS SHARE remains compatible, so reads continue.
-- Fail instead of waiting forever when an operator has not drained writers.
LOCK TABLE memories IN EXCLUSIVE MODE;

-- A vocabulary is shared by every scope of a kind. Historical private values
-- must therefore never be adopted into it. Keep only shipped vocabulary tags
-- active and retain every unknown original value on its memory, including
-- plugin dimensions and malformed values, without exposing them through the
-- shared scope-kind vocabulary.
WITH expanded AS MATERIALIZED (
  SELECT memory.id,
         memory.tags AS original_tags,
         memory.metadata AS original_metadata,
         existing.value,
         existing.position,
         lower(btrim(existing.value)) AS normalized,
         EXISTS (
           SELECT 1
             FROM tag_vocabularies AS vocabulary
            WHERE vocabulary.scope_kind = scope.kind
              AND vocabulary.tag = lower(btrim(existing.value))
         ) AS is_shipped
    FROM memories AS memory
    JOIN scopes AS scope ON scope.id = memory.scope_id
    LEFT JOIN LATERAL unnest(memory.tags) WITH ORDINALITY AS existing(value, position)
      ON true
), ranked AS MATERIALIZED (
  SELECT expanded.*,
         row_number() OVER (
           PARTITION BY id, normalized ORDER BY position
         ) AS normalized_occurrence
    FROM expanded
), grouped AS MATERIALIZED (
  SELECT id,
         original_tags,
         original_metadata,
         COALESCE(
           array_agg(normalized ORDER BY position)
             FILTER (WHERE position IS NOT NULL AND is_shipped AND normalized_occurrence = 1),
           '{}'::text[]
         ) AS active_tags,
         jsonb_agg(value ORDER BY position)
           FILTER (WHERE position IS NOT NULL AND NOT is_shipped) AS legacy_tags
    FROM ranked
   GROUP BY id, original_tags, original_metadata
), rewritten AS MATERIALIZED (
  SELECT id,
         active_tags,
         (
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
           ) ELSE '{}'::jsonb END
         ) AS metadata
    FROM grouped
   WHERE original_tags IS DISTINCT FROM active_tags
      OR jsonb_typeof(original_metadata) <> 'object'
      OR original_metadata ?| ARRAY[
        'continuum_legacy_tags', 'continuum_legacy_metadata',
        'continuum_tag_migration', 'continuum_migration_conflicts'
      ]
)
UPDATE memories AS memory
   SET tags = rewritten.active_tags,
       metadata = rewritten.metadata
  FROM rewritten
 WHERE rewritten.id = memory.id;

-- Install the database boundary in the same transaction as the rewrite. This
-- makes a migration-first rolling deploy fail closed for old writers: values
-- outside the vocabulary are rejected even before every application process
-- runs vocabulary-aware code. Lock matching rows so deletion still serializes
-- with those old writers as well as with current capture and promotion paths.
CREATE FUNCTION enforce_memory_tag_vocabulary()
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

CREATE TRIGGER memories_tags_controlled_vocabulary
BEFORE INSERT OR UPDATE OF scope_id, tags ON memories
FOR EACH ROW
EXECUTE FUNCTION enforce_memory_tag_vocabulary();
