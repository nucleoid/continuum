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
   'pr', 'merged', 'branch', 'github', 'ado', 'deploy', 'session', 'terminal', 'decision'
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

DO $$
DECLARE
  unknown_report TEXT;
BEGIN
  SELECT string_agg(item.scope_kind || ':' || item.tag, ', ' ORDER BY item.scope_kind, item.tag)
    INTO unknown_report
    FROM (
      SELECT DISTINCT scope.kind AS scope_kind, existing.tag
        FROM memories AS memory
        JOIN scopes AS scope ON scope.id = memory.scope_id
       CROSS JOIN LATERAL unnest(memory.tags) AS existing(tag)
       WHERE NOT EXISTS (
         SELECT 1
           FROM tag_vocabularies AS vocabulary
          WHERE vocabulary.scope_kind = scope.kind
            AND vocabulary.tag = existing.tag
       )
       ORDER BY scope.kind, existing.tag
       LIMIT 20
    ) AS item;

  IF unknown_report IS NOT NULL THEN
    RAISE EXCEPTION 'unknown historical tags remain: %', unknown_report;
  END IF;
END
$$;
