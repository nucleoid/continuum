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
SET LOCAL lock_timeout = '5s';
LOCK TABLE memories IN EXCLUSIVE MODE;

-- A vocabulary is shared by every scope of a kind. Historical private values
-- must therefore never be adopted into it. Keep only shipped vocabulary tags
-- active and retain every unknown original value on its memory, including
-- plugin dimensions and malformed values, without exposing them through the
-- shared scope-kind vocabulary.
WITH expanded AS (
  SELECT memory.id,
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
   CROSS JOIN LATERAL unnest(memory.tags) WITH ORDINALITY AS existing(value, position)
), shipped AS (
  SELECT id, normalized AS tag, min(position) AS first_position
    FROM expanded
   WHERE is_shipped
   GROUP BY id, normalized
), classified AS (
  SELECT memory.id,
         (
           SELECT array_agg(shipped.tag ORDER BY shipped.first_position)
             FROM shipped
            WHERE shipped.id = memory.id
         ) AS active_tags,
         (
           SELECT array_agg(expanded.value ORDER BY expanded.position)
             FROM expanded
            WHERE expanded.id = memory.id
              AND NOT expanded.is_shipped
         ) AS legacy_tags
    FROM memories AS memory
   WHERE cardinality(memory.tags) > 0
)
UPDATE memories AS memory
   SET metadata = jsonb_set(
         CASE
           WHEN jsonb_typeof(memory.metadata) = 'object' THEN memory.metadata
           ELSE jsonb_build_object('continuum_legacy_metadata', memory.metadata)
         END,
         '{continuum_legacy_tags}',
         CASE
           WHEN jsonb_typeof(memory.metadata) = 'object'
             AND jsonb_typeof(memory.metadata->'continuum_legacy_tags') = 'array'
             THEN memory.metadata->'continuum_legacy_tags'
           WHEN jsonb_typeof(memory.metadata) = 'object'
             AND memory.metadata ? 'continuum_legacy_tags'
             AND jsonb_typeof(memory.metadata->'continuum_legacy_tags') <> 'null'
             THEN jsonb_build_array(memory.metadata->'continuum_legacy_tags')
           ELSE '[]'::jsonb
         END || to_jsonb(classified.legacy_tags),
         true
       ),
       tags = COALESCE(classified.active_tags, '{}')
  FROM classified
 WHERE classified.id = memory.id
   AND classified.legacy_tags IS NOT NULL;

-- Memories containing only shipped tags still need normalization and
-- de-duplication but do not need a legacy metadata field.
WITH shipped AS (
  SELECT memory.id,
         lower(btrim(existing.value)) AS tag,
         min(existing.position) AS first_position
    FROM memories AS memory
    JOIN scopes AS scope ON scope.id = memory.scope_id
   CROSS JOIN LATERAL unnest(memory.tags) WITH ORDINALITY AS existing(value, position)
   WHERE EXISTS (
     SELECT 1
       FROM tag_vocabularies AS vocabulary
      WHERE vocabulary.scope_kind = scope.kind
        AND vocabulary.tag = lower(btrim(existing.value))
   )
   GROUP BY memory.id, lower(btrim(existing.value))
)
UPDATE memories AS memory
   SET tags = classified.tags
  FROM (
    SELECT id, array_agg(tag ORDER BY first_position) AS tags
      FROM shipped
     GROUP BY id
  ) AS classified
 WHERE memory.id = classified.id
   AND memory.tags IS DISTINCT FROM classified.tags;

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
