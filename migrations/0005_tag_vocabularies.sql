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

-- Normalize historical input before strict capture validation is enabled.
UPDATE memories AS memory
   SET tags = (
    SELECT COALESCE(array_agg(item.tag ORDER BY item.first_position), '{}') AS tags
      FROM (
        SELECT lower(btrim(value)) AS tag, min(position) AS first_position
          FROM unnest(memory.tags) WITH ORDINALITY AS existing(value, position)
         WHERE btrim(value) <> ''
         GROUP BY lower(btrim(value))
      ) AS item
  );

-- Dynamic plugin dimensions already live in metadata and are not taxonomy.
UPDATE memories AS memory
   SET tags = (
     SELECT COALESCE(array_agg(value ORDER BY position), '{}') AS tags
       FROM unnest(memory.tags) WITH ORDINALITY AS existing(value, position)
      WHERE EXISTS (
        SELECT 1
          FROM tag_vocabularies AS vocabulary
          JOIN scopes AS scope ON scope.id = memory.scope_id
         WHERE vocabulary.scope_kind = scope.kind
           AND vocabulary.tag = existing.value
      )
   )
 WHERE memory.source IN ('ado-workitem', 'deploy-event');

-- Preserve conforming historical taxonomy by adopting it for the scope kind.
-- There is no trustworthy actor to attribute these pre-vocabulary rows to, so
-- imported entries are system-owned rather than fabricating a principal.
INSERT INTO tag_vocabularies (scope_kind, tag, description, is_system)
SELECT DISTINCT scope.kind, existing.tag, 'Imported historical tag', true
  FROM memories AS memory
  JOIN scopes AS scope ON scope.id = memory.scope_id
 CROSS JOIN LATERAL unnest(memory.tags) AS existing(tag)
 WHERE length(existing.tag) BETWEEN 1 AND 64
   AND existing.tag ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
ON CONFLICT (scope_kind, tag) DO NOTHING;

-- Nonconforming historical values cannot become new controlled tags. Retain
-- them as explicit legacy metadata before removing them from active taxonomy,
-- allowing deployment to proceed without either silent loss or policy bypass.
WITH classified AS (
  SELECT memory.id,
         array_agg(value ORDER BY position)
           FILTER (WHERE length(value) BETWEEN 1 AND 64
                     AND value ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$') AS valid_tags,
         array_agg(value ORDER BY position)
           FILTER (WHERE length(value) NOT BETWEEN 1 AND 64
                      OR value !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$') AS invalid_tags
    FROM memories AS memory
   CROSS JOIN LATERAL unnest(memory.tags) WITH ORDINALITY AS existing(value, position)
   GROUP BY memory.id
)
UPDATE memories AS memory
   SET metadata = jsonb_set(
         memory.metadata,
         '{continuum_legacy_tags}',
         CASE
           WHEN jsonb_typeof(memory.metadata->'continuum_legacy_tags') = 'array'
             THEN memory.metadata->'continuum_legacy_tags'
           WHEN memory.metadata ? 'continuum_legacy_tags'
             THEN jsonb_build_array(memory.metadata->'continuum_legacy_tags')
           ELSE '[]'::jsonb
         END || to_jsonb(classified.invalid_tags),
         true
       ),
       tags = COALESCE(classified.valid_tags, '{}')
  FROM classified
 WHERE classified.id = memory.id
   AND classified.invalid_tags IS NOT NULL;
