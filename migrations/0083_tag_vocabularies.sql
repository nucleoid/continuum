-- This must be the first migration statement: principal creation and other
-- pre-lock DDL can otherwise wait indefinitely on principals/memories FKs.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

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
REVOKE ALL ON tag_vocabularies FROM PUBLIC;

-- Capture exact live identities before extending their expected permission set.
CREATE TEMP TABLE continuum_tag_upgrade_roles(role_oid OID PRIMARY KEY, role_name NAME, operator BOOLEAN) ON COMMIT DROP;
DO $profiles$
DECLARE candidate RECORD;
BEGIN
  FOR candidate IN SELECT profile.database_role_oid,role.rolname,profile.profile_kind
    FROM continuum_pgvector_role_profiles profile JOIN pg_catalog.pg_roles role ON role.oid=profile.database_role_oid
    WHERE profile.profile_kind IN ('application','operator') LOOP
    BEGIN
      PERFORM continuum_assert_application_role_allowlist(candidate.rolname,candidate.profile_kind='operator');
      INSERT INTO continuum_tag_upgrade_roles VALUES(candidate.database_role_oid,candidate.rolname,candidate.profile_kind='operator');
    EXCEPTION WHEN OTHERS THEN CONTINUE;
    END;
  END LOOP;
END;
$profiles$;

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
                 - 'continuum_tag_rollback_compat'
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
             OR original_metadata ? 'continuum_tag_rollback_compat'
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
               || CASE WHEN original_metadata ? 'continuum_tag_rollback_compat'
                 THEN jsonb_build_array(jsonb_build_object(
                   'key', 'continuum_tag_rollback_compat', 'value', original_metadata->'continuum_tag_rollback_compat'))
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
        'continuum_tag_migration', 'continuum_tag_rollback_compat',
        'continuum_migration_conflicts'
      ]
)
UPDATE memories AS memory
   SET tags = rewritten.active_tags,
       metadata = rewritten.metadata
  FROM rewritten
 WHERE rewritten.id = memory.id;

CREATE TABLE continuum_tag_write_policy(singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), legacy_compat BOOLEAN NOT NULL DEFAULT FALSE);
INSERT INTO continuum_tag_write_policy VALUES(TRUE,FALSE);
REVOKE ALL ON continuum_tag_write_policy FROM PUBLIC;

CREATE FUNCTION continuum_tag_metadata_subset(value JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_object_agg(entry.key,entry.value),'{}'::jsonb)
  FROM jsonb_each(CASE WHEN jsonb_typeof(value)='object' THEN value ELSE '{}'::jsonb END) entry
  WHERE entry.key=ANY(ARRAY['continuum_legacy_tags','continuum_legacy_metadata','continuum_tag_migration',
    'continuum_tag_rollback_compat','continuum_migration_conflicts']::text[])
$$;

CREATE FUNCTION continuum_check_tag_provenance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE owned_role OID; invoking_role OID; old_subset JSONB; new_subset JSONB; source_row memories%ROWTYPE;
BEGIN
  SELECT relowner INTO owned_role FROM pg_catalog.pg_class WHERE oid='memories'::regclass;
  SELECT oid INTO invoking_role FROM pg_catalog.pg_roles WHERE rolname=continuum_invoking_database_role();
  IF invoking_role=owned_role THEN RETURN NEW; END IF;
  old_subset:=CASE WHEN TG_OP='UPDATE' THEN continuum_tag_metadata_subset(OLD.metadata) ELSE '{}'::jsonb END;
  new_subset:=continuum_tag_metadata_subset(NEW.metadata);
  IF TG_OP='UPDATE' AND old_subset<>'{}'::jsonb AND new_subset=old_subset
    AND NEW.metadata->'promoted_from' IS DISTINCT FROM OLD.metadata->'promoted_from' THEN
    RAISE check_violation USING MESSAGE='memory tag provenance is protected',CONSTRAINT='memories_tag_provenance';
  END IF;
  IF new_subset=old_subset THEN RETURN NEW; END IF;
  -- The existing approved offboarding path clears metadata to its canonical tombstone.
  IF new_subset='{}'::jsonb AND NEW.metadata='{}'::jsonb AND NEW.tags='{}'::text[]
    AND NEW.type='context' AND NEW.title='[erased]' AND NEW.body='[erased]' AND NEW.state='archived'
    AND EXISTS(SELECT 1 FROM continuum_pgvector_role_profiles WHERE database_role_oid=invoking_role AND profile_kind='operator')
    AND EXISTS(SELECT 1 FROM principal_offboarding_runs run JOIN principals target ON target.id=run.principal_id
      JOIN principal_user_scopes mapping ON mapping.principal_id=run.principal_id AND mapping.scope_id=run.scope_id
      WHERE run.scope_id=OLD.scope_id AND run.completed_at IS NULL AND target.disabled_at IS NOT NULL) THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' AND jsonb_typeof(NEW.metadata->'promoted_from')='string' THEN
    BEGIN
      SELECT * INTO source_row FROM memories WHERE id=(NEW.metadata->>'promoted_from')::uuid FOR UPDATE;
    EXCEPTION WHEN invalid_text_representation THEN source_row.id:=NULL;
    END;
    IF source_row.id IS NOT NULL AND source_row.state='live' AND source_row.promoted_to_id IS NULL
      AND source_row.scope_id<>NEW.scope_id AND NEW.source='promote:'||source_row.source
      AND continuum_tag_metadata_subset(source_row.metadata)=new_subset THEN RETURN NEW; END IF;
  END IF;
  RAISE check_violation USING MESSAGE='memory tag provenance is protected',CONSTRAINT='memories_tag_provenance';
END;
$$;
CREATE TRIGGER memories_tag_provenance BEFORE INSERT OR UPDATE OF metadata ON memories
  FOR EACH ROW EXECUTE FUNCTION continuum_check_tag_provenance();

CREATE FUNCTION continuum_finish_tag_promotion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE owned_role OID; invoking_role OID; source_row memories%ROWTYPE; subset JSONB;
BEGIN
  SELECT relowner INTO owned_role FROM pg_catalog.pg_class WHERE oid='memories'::regclass;
  SELECT oid INTO invoking_role FROM pg_catalog.pg_roles WHERE rolname=continuum_invoking_database_role();
  IF invoking_role=owned_role THEN RETURN NEW; END IF;
  subset:=continuum_tag_metadata_subset(NEW.metadata);
  IF subset='{}'::jsonb THEN RETURN NEW; END IF;
  -- Original input was admitted by memories_tag_provenance before the
  -- normalizer generated this receipt. Caller-supplied receipts never reach
  -- this branch. A protected promotion always retains its reciprocal check.
  IF jsonb_typeof(NEW.metadata->'promoted_from') IS DISTINCT FROM 'string'
    AND NEW.metadata ? 'continuum_tag_rollback_compat'
    AND (SELECT legacy_compat FROM continuum_tag_write_policy WHERE singleton) THEN RETURN NEW; END IF;
  BEGIN
    SELECT * INTO source_row FROM memories WHERE id=(NEW.metadata->>'promoted_from')::uuid FOR UPDATE;
  EXCEPTION WHEN invalid_text_representation THEN source_row.id:=NULL;
  END;
  IF source_row.id IS NULL OR source_row.promoted_to_id IS DISTINCT FROM NEW.id OR source_row.state<>'promoted'
    OR continuum_tag_metadata_subset(source_row.metadata) IS DISTINCT FROM subset THEN
    RAISE check_violation USING MESSAGE='memory promotion provenance is incomplete',CONSTRAINT='memories_tag_provenance';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER memories_tag_promotion AFTER INSERT ON memories
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION continuum_finish_tag_promotion();

CREATE FUNCTION enforce_memory_tag_vocabulary() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE scope_kind_value TEXT; unknown_count INTEGER;
  active_tags TEXT[]; legacy_tags JSONB; original_tags TEXT[]:=NEW.tags; original_metadata JSONB:=NEW.metadata;
BEGIN
  SELECT kind INTO STRICT scope_kind_value FROM scopes WHERE id=NEW.scope_id;
  IF cardinality(NEW.tags)>32 THEN
    RAISE check_violation USING MESSAGE='memory tags violate the controlled vocabulary',CONSTRAINT='memories_tags_controlled_vocabulary';
  END IF;
  IF (SELECT legacy_compat FROM continuum_tag_write_policy WHERE singleton) THEN
  PERFORM 1
    FROM tag_vocabularies
   WHERE scope_kind = scope_kind_value
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
              WHERE vocabulary.scope_kind = scope_kind_value
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

  -- Current writers and promotion already provide canonical, unique tags.
  -- Leaving those rows byte-for-byte unchanged preserves trusted migration
  -- provenance and prevents this compatibility trigger from recursively
  -- treating its own metadata as a new conflict on unrelated updates.
  IF original_tags IS NOT DISTINCT FROM active_tags THEN
    RETURN NEW;
  END IF;

  NEW.tags := active_tags;
  NEW.metadata :=
    CASE
      WHEN jsonb_typeof(original_metadata) = 'object' THEN
        original_metadata
          - 'continuum_legacy_tags'
          - 'continuum_legacy_metadata'
          - 'continuum_tag_migration'
          - 'continuum_tag_rollback_compat'
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
      'continuum_tag_rollback_compat',
      jsonb_build_object('version', 1, 'original_tags', to_jsonb(original_tags))
    )
    || CASE WHEN jsonb_typeof(original_metadata) = 'object' AND (
         original_metadata ? 'continuum_legacy_tags'
      OR original_metadata ? 'continuum_legacy_metadata'
      OR original_metadata ? 'continuum_tag_migration'
      OR original_metadata ? 'continuum_tag_rollback_compat'
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
        || CASE WHEN original_metadata ? 'continuum_tag_rollback_compat'
          THEN jsonb_build_array(jsonb_build_object(
            'key', 'continuum_tag_rollback_compat', 'value', original_metadata->'continuum_tag_rollback_compat'))
          ELSE '[]'::jsonb END
        || CASE WHEN original_metadata ? 'continuum_migration_conflicts'
          THEN jsonb_build_array(jsonb_build_object(
            'key', 'continuum_migration_conflicts', 'value', original_metadata->'continuum_migration_conflicts'))
          ELSE '[]'::jsonb END
    ) ELSE '{}'::jsonb END;

  RETURN NEW;
  END IF;
  IF cardinality(NEW.tags)=0 THEN RETURN NEW; END IF;
  PERFORM 1 FROM tag_vocabularies WHERE scope_kind=scope_kind_value AND tag=ANY(NEW.tags) FOR KEY SHARE;
  SELECT count(*) INTO unknown_count FROM unnest(NEW.tags) requested(tag)
    WHERE requested.tag IS NULL OR requested.tag!~'^[a-z0-9]+(?:-[a-z0-9]+)*$' OR length(requested.tag)>64
      OR NOT EXISTS(SELECT 1 FROM tag_vocabularies WHERE scope_kind=scope_kind_value AND tag=requested.tag);
  IF unknown_count>0 OR cardinality(NEW.tags)<>(SELECT count(DISTINCT tag) FROM unnest(NEW.tags) requested(tag)) THEN
    RAISE check_violation USING MESSAGE='memory tags violate the controlled vocabulary',CONSTRAINT='memories_tags_controlled_vocabulary';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memories_tags_controlled_vocabulary BEFORE INSERT OR UPDATE OF scope_id,tags ON memories
  FOR EACH ROW EXECUTE FUNCTION enforce_memory_tag_vocabulary();

DO $harden$
DECLARE signature TEXT; schema_name TEXT:=current_schema();
BEGIN
  FOREACH signature IN ARRAY ARRAY['continuum_tag_metadata_subset(jsonb)','continuum_check_tag_provenance()',
    'continuum_finish_tag_promotion()','enforce_memory_tag_vocabulary()'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path=pg_catalog,%I,pg_temp',schema_name,signature,schema_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',schema_name,signature);
  END LOOP;
END;
$harden$;

DO $extend$
DECLARE definition TEXT; revised TEXT; candidate RECORD; schema_name TEXT:=current_schema();
BEGIN
  SELECT pg_get_functiondef('continuum_assert_application_role_allowlist(name,boolean)'::regprocedure) INTO definition;
  revised:=replace(definition,'(''principal_offboarding_takeover_events'',''SELECT'')',
    '(''principal_offboarding_takeover_events'',''SELECT''),(''tag_vocabularies'',''SELECT''),(''tag_vocabularies'',''INSERT''),(''tag_vocabularies'',''UPDATE''),(''tag_vocabularies'',''DELETE'')');
  IF revised=definition THEN RAISE EXCEPTION 'tag profile extension anchor is missing'; END IF;
  EXECUTE revised;
  FOR candidate IN SELECT * FROM continuum_tag_upgrade_roles LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=candidate.role_oid AND rolname=candidate.role_name) THEN CONTINUE; END IF;
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE %I.tag_vocabularies TO %I',schema_name,candidate.role_name);
    PERFORM continuum_assert_application_role_allowlist(candidate.role_name,candidate.operator);
  END LOOP;
END;
$extend$;
