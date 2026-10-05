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
 WHERE memory.id = classified.id;
