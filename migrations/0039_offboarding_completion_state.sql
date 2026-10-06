-- Close direct application-role writes to the offboarding progress ledger.
-- The workflow functions below are deliberately command-scoped. They keep the
-- owner-only tables behind a SECURITY DEFINER boundary while completion still
-- derives its decision from the actual indexed application data.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION continuum_write_offboarding_run(
  target_principal_id UUID,
  authorization_principal_id UUID,
  command TEXT,
  details JSONB DEFAULT '{}'::jsonb
) RETURNS SETOF principal_offboarding_runs
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  cursor_column TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM principals authorization_principal
    JOIN scope_memberships membership
      ON membership.principal_id = authorization_principal.id
    JOIN scopes scope ON scope.id = membership.scope_id
    WHERE authorization_principal.id = authorization_principal_id
      AND authorization_principal.disabled_at IS NULL
      AND scope.kind = 'org' AND scope.name = ''
      AND membership.active AND membership.role = 'admin'
      AND continuum_membership_is_effective(membership.active, membership.source_kind)
  ) THEN
    RAISE EXCEPTION 'offboarding progress requires an effective org administrator';
  END IF;

  IF command = 'create' THEN
    RETURN QUERY INSERT INTO principal_offboarding_runs
      (principal_id, scope_id, initiated_by, approval_id, initial_memories,
       initial_embeddings, initial_memberships, initial_aliases,
       initial_entra_bindings, initial_audit_rows, initial_audit_queries,
       initial_audit_selection, approval_evidence_hash, initial_count_truncated)
    VALUES (target_principal_id, (details->>'scope_id')::uuid,
      authorization_principal_id, (details->>'approval_id')::bigint,
      (details->>'initial_memories')::integer,
      (details->>'initial_embeddings')::integer,
      (details->>'initial_memberships')::integer,
      (details->>'initial_aliases')::integer,
      (details->>'initial_entra_bindings')::integer,
      (details->>'initial_audit_rows')::integer,
      (details->>'initial_audit_queries')::integer,
      details->'initial_audit_selection', details->>'approval_evidence_hash',
      ARRAY(SELECT jsonb_array_elements_text(details->'initial_count_truncated')))
    RETURNING *;
  ELSIF command = 'restart' THEN
    RETURN QUERY UPDATE principal_offboarding_runs run SET
      run_id = gen_random_uuid(), initiated_by = authorization_principal_id,
      approval_id = (details->>'approval_id')::bigint,
      approval_evidence_hash = details->>'approval_evidence_hash', started_at = now(),
      initial_memories = (details->>'initial_memories')::integer,
      initial_embeddings = (details->>'initial_embeddings')::integer,
      initial_memberships = (details->>'initial_memberships')::integer,
      initial_aliases = (details->>'initial_aliases')::integer,
      initial_entra_bindings = (details->>'initial_entra_bindings')::integer,
      initial_audit_rows = (details->>'initial_audit_rows')::integer,
      initial_audit_queries = (details->>'initial_audit_queries')::integer,
      initial_audit_selection = details->'initial_audit_selection',
      initial_count_truncated = ARRAY(
        SELECT jsonb_array_elements_text(details->'initial_count_truncated')),
      memories_processed = 0, embeddings_processed = 0, memberships_processed = 0,
      aliases_processed = 0, entra_bindings_processed = 0,
      audit_rows_processed = 0, audit_queries_processed = 0, batches = 0,
      memory_cursor = NULL, audit_principal_cursor = 0, audit_scope_cursor = 0,
      audit_memory_cursor = 0, audit_scope_ids_cursor = 0, audit_linked_cursor = 0,
      audit_memory_key_cursor = NULL, audit_memory_item_cursor = 0,
      audit_memory_complete = FALSE, audit_linked_request_cursor = NULL,
      audit_linked_request_item_cursor = 0, audit_linked_request_exhausted = FALSE,
      audit_linked_complete = FALSE, memory_complete = FALSE,
      scope_cleanup_complete = FALSE, audit_fence_id = NULL, completed_at = NULL
    WHERE run.principal_id = target_principal_id RETURNING run.*;
  ELSIF command = 'scope_complete' THEN
    RETURN QUERY UPDATE principal_offboarding_runs run
      SET scope_cleanup_complete = TRUE
      WHERE run.principal_id = target_principal_id RETURNING run.*;
  ELSIF command = 'set_fence' THEN
    RETURN QUERY UPDATE principal_offboarding_runs run
      SET audit_fence_id = (SELECT COALESCE(max(id), 0) FROM audit_log)
      WHERE run.principal_id = target_principal_id AND audit_fence_id IS NULL
      RETURNING run.*;
  ELSIF command = 'memory_cursor' THEN
    RETURN QUERY UPDATE principal_offboarding_runs run
      SET memory_cursor = (details->>'cursor')::uuid
      WHERE run.principal_id = target_principal_id RETURNING run.*;
  ELSIF command = 'memory_complete' THEN
    RETURN QUERY UPDATE principal_offboarding_runs run SET memory_complete = TRUE
      WHERE run.principal_id = target_principal_id RETURNING run.*;
  ELSIF command = 'audit_cursor' THEN
    cursor_column := details->>'column';
    IF cursor_column NOT IN ('audit_principal_cursor', 'audit_scope_cursor',
                             'audit_scope_ids_cursor') THEN
      RAISE EXCEPTION 'invalid offboarding audit cursor';
    END IF;
    RETURN QUERY EXECUTE format(
      'UPDATE principal_offboarding_runs SET %I = $2 WHERE principal_id = $1 RETURNING *',
      cursor_column)
      USING target_principal_id, (details->>'cursor')::bigint;
  ELSIF command = 'audit_memory_complete' THEN
    RETURN QUERY UPDATE principal_offboarding_runs run
      SET audit_memory_complete = TRUE, audit_memory_cursor = audit_fence_id
      WHERE run.principal_id = target_principal_id RETURNING run.*;
  ELSIF command = 'audit_memory_cursor' THEN
    RETURN QUERY UPDATE principal_offboarding_runs run
      SET audit_memory_item_cursor = (details->>'cursor')::bigint
      WHERE run.principal_id = target_principal_id RETURNING run.*;
  ELSIF command = 'linked_complete' THEN
    RETURN QUERY UPDATE principal_offboarding_runs run SET
      audit_linked_request_cursor = COALESCE(details->>'request_cursor',
                                             audit_linked_request_cursor),
      audit_linked_request_item_cursor = COALESCE(
        (details->>'item_cursor')::bigint, audit_linked_request_item_cursor),
      audit_linked_request_exhausted = TRUE, audit_linked_complete = TRUE,
      audit_linked_cursor = audit_fence_id
      WHERE run.principal_id = target_principal_id RETURNING run.*;
  ELSIF command = 'linked_cursor' THEN
    RETURN QUERY UPDATE principal_offboarding_runs run SET
      audit_linked_request_cursor = details->>'request_cursor',
      audit_linked_request_item_cursor = (details->>'item_cursor')::bigint,
      audit_linked_request_exhausted = FALSE
      WHERE run.principal_id = target_principal_id RETURNING run.*;
  ELSIF command = 'add_progress' THEN
    RETURN QUERY UPDATE principal_offboarding_runs run SET
      memories_processed = memories_processed + (details->>'memories')::integer,
      audit_rows_processed = audit_rows_processed + (details->>'audit_rows')::integer,
      embeddings_processed = embeddings_processed + (details->>'embeddings')::integer,
      memberships_processed = memberships_processed + (details->>'memberships')::integer,
      aliases_processed = aliases_processed + (details->>'aliases')::integer,
      entra_bindings_processed = entra_bindings_processed + (details->>'entra_bindings')::integer,
      audit_queries_processed = audit_queries_processed + (details->>'audit_queries')::integer,
      batches = batches + 1
      WHERE run.principal_id = target_principal_id RETURNING run.*;
  ELSE
    RAISE EXCEPTION 'unsupported offboarding progress command';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_write_offboarding_run(UUID, UUID, TEXT, JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_get_offboarding_run(
  target_principal_id UUID,
  authorization_principal_id UUID
) RETURNS SETOF principal_offboarding_runs
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM principals p JOIN scope_memberships m ON m.principal_id = p.id
    JOIN scopes s ON s.id = m.scope_id
    WHERE p.id = authorization_principal_id AND p.disabled_at IS NULL
      AND s.kind = 'org' AND s.name = '' AND m.active AND m.role = 'admin'
      AND continuum_membership_is_effective(m.active, m.source_kind)
  ) THEN
    RAISE EXCEPTION 'offboarding run lock requires an effective org administrator';
  END IF;
  RETURN QUERY SELECT run.* FROM principal_offboarding_runs run
    WHERE run.principal_id = target_principal_id FOR UPDATE;
END;
$$;
REVOKE ALL ON FUNCTION continuum_get_offboarding_run(UUID, UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_start_offboarding_run(
  target_run_id UUID,
  authorization_principal_id UUID,
  start_evidence JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM principals p JOIN scope_memberships m ON m.principal_id = p.id
    JOIN scopes s ON s.id = m.scope_id
    WHERE p.id = authorization_principal_id AND p.disabled_at IS NULL
      AND s.kind = 'org' AND s.name = '' AND m.active AND m.role = 'admin'
      AND continuum_membership_is_effective(m.active, m.source_kind)
  ) THEN
    RAISE EXCEPTION 'offboarding start requires an effective org administrator';
  END IF;
  INSERT INTO principal_offboarding_run_events
    (run_id, principal_id, scope_id, phase, initiated_by, finalized_by,
     approval_id, approval_evidence_hash, evidence)
  SELECT run_id, principal_id, scope_id, 'started', initiated_by, NULL,
         approval_id, approval_evidence_hash, start_evidence
    FROM principal_offboarding_runs
   WHERE run_id = target_run_id AND initiated_by = authorization_principal_id
  ON CONFLICT (run_id, phase) DO NOTHING;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION continuum_start_offboarding_run(UUID, UUID, JSONB) FROM PUBLIC;

-- Completion treats counters and cursors as telemetry, never authorization.
CREATE OR REPLACE FUNCTION continuum_offboarding_expected_audit_metadata(
  audit_metadata JSONB
) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN audit_metadata->>'operation' = 'api_key_issued' THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry
        WHERE entry.key = ANY(ARRAY['operation','key_id','service_principal_id']::text[]))
    WHEN audit_metadata->>'operation' = 'api_key_revoked' THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry
        WHERE entry.key = ANY(ARRAY['operation','key_id','service_principal_id','key_revoked_at']::text[]))
    WHEN audit_metadata->>'operation' = 'api_key_rotated' THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry
        WHERE entry.key = ANY(ARRAY['operation','key_id','service_principal_id','key_rotated_at']::text[]))
    WHEN audit_metadata->>'operation' = 'create_scope' THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry
        WHERE entry.key = ANY(ARRAY['operation','created','kind']::text[]))
    WHEN audit_metadata->>'operation' IN (
      'entra_group_binding_provisioned', 'entra_group_binding_reactivated',
      'entra_group_binding_updated'
    ) THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry
        WHERE entry.key = ANY(ARRAY[
          'operation','group_id','scope_id','role','previous_scope_id','previous_role'
        ]::text[]))
    WHEN audit_metadata->>'operation' = 'entra_group_binding_revoked' THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry
        WHERE entry.key = ANY(ARRAY[
          'operation','group_id','role','memberships_deactivated'
        ]::text[]))
    WHEN audit_metadata->>'operation' IN (
      'entra_membership_sync', 'entra_membership_sync_screened'
    ) THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry
        WHERE entry.key = ANY(ARRAY[
          'operation','groups_seen','groups_reactivated','groups_deactivated',
          'memberships_active','memberships_deactivated','groups_skipped'
        ]::text[]))
    WHEN audit_metadata->>'operation' = 'entra_membership_sync_rejected' THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry
        WHERE entry.key = ANY(ARRAY[
          'operation','reason','last_success_at','max_staleness_hours','stale',
          'stale_memberships_deactivated','groups_deactivated','memberships_deactivated'
        ]::text[]))
    WHEN audit_metadata->>'operation' = 'get_memory' THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry
        WHERE entry.key = ANY(ARRAY['operation','request_id','record_kind']::text[]))
    WHEN audit_metadata->>'operation' = 'list_memories' THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry
        WHERE entry.key = ANY(ARRAY[
          'operation','request_id','record_kind','state','scope_filtered','type_filter',
          'limit','offset','count'
        ]::text[]))
    WHEN audit_metadata->>'operation' IN (
      'principal_disabled', 'principal_memory_erased'
    ) THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry
        WHERE entry.key = ANY(ARRAY['operation','principal_id']::text[]))
    WHEN audit_metadata->>'operation' IN (
      'principal_offboarded', 'principal_offboarding_repaired'
    ) THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry
        WHERE entry.key = ANY(ARRAY[
          'operation','principal_id','approval_id','acknowledged_evidence_hash',
          'memories','audit_rows','batches'
        ]::text[]))
    WHEN audit_metadata->>'operation' = 'principal_reactivation_guarded' THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry
        WHERE entry.key = ANY(ARRAY[
          'operation','principal_id','authorization_principal_id','previously_offboarded'
        ]::text[]))
    WHEN audit_metadata->>'operation' = 'principal_reactivated' THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry
        WHERE entry.key = ANY(ARRAY[
          'operation','principal_id','previously_offboarded'
        ]::text[]))
    WHEN audit_metadata->>'operation' IN (
      'principal_user_scope_mapped',
      'principal_user_scope_acknowledgement_replaced'
    ) THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry
        WHERE entry.key = ANY(ARRAY[
          'operation','principal_id','shared_scope_acknowledged',
          'acknowledged_principal_ids','acknowledged_evidence_hash','approval_id',
          'other_member_principal_ids','other_author_principal_ids',
          'other_member_principal_ids_truncated','other_author_principal_ids_truncated'
        ]::text[]))
    WHEN audit_metadata->>'operation' = 'service_principal_provisioned' THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry
        WHERE entry.key = ANY(ARRAY[
          'operation','service_principal_id','external_id'
        ]::text[]))
    WHEN audit_metadata->>'source' = 'audit-retention' THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry
        WHERE entry.key = ANY(ARRAY[
          'source','cutoff','retention_days','first_id','last_id','first_at','last_at',
          'deleted_count','export_mode','export_sha256','run_id','batch_number'
        ]::text[]))
    WHEN audit_metadata->>'source' IN (
      'ado-workitem', 'deploy-event', 'github-branch', 'github-pr', 'lifecycle',
      'manual', 'terminal-summary'
    ) THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(audit_metadata) entry WHERE entry.key = 'source')
    ELSE '{"redacted":"principal_offboarding"}'::jsonb
  END
$$;
REVOKE ALL ON FUNCTION continuum_offboarding_expected_audit_metadata(JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_offboarding_actual_state_is_erased(target_run_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH target_run AS (
    SELECT run.* FROM principal_offboarding_runs run
     WHERE run.run_id = target_run_id
  ), direct_audit AS (
    SELECT DISTINCT audit.id, audit.metadata->>'request_id' AS request_id
      FROM target_run run
      JOIN audit_log audit ON audit.id <= run.audit_fence_id
     WHERE audit.principal_id = run.principal_id
        OR audit.scope_id = run.scope_id
        OR EXISTS (
          SELECT 1 FROM memories memory
           WHERE memory.id = audit.memory_id AND memory.scope_id = run.scope_id)
        OR EXISTS (
          SELECT 1 FROM audit_log_offboarding_scopes selector
           WHERE selector.audit_id = audit.id AND selector.scope_id = run.scope_id)
        OR EXISTS (
          SELECT 1
            FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(audit.metadata->'scope_ids') = 'array'
                   THEN audit.metadata->'scope_ids' ELSE '[]'::jsonb END
            ) carried(value)
           WHERE carried.value = run.scope_id::text)
  ), linked_request AS (
    SELECT request.request_id FROM target_run run
      JOIN principal_offboarding_audit_requests request
        ON request.principal_id = run.principal_id
    UNION
    SELECT request_id FROM direct_audit WHERE request_id IS NOT NULL
  ), target_audit AS (
    SELECT id FROM direct_audit
    UNION
    SELECT audit.id FROM target_run run
      JOIN audit_log audit ON audit.id <= run.audit_fence_id
     WHERE audit.metadata->>'request_id' IN (SELECT request_id FROM linked_request)
  )
  SELECT COALESCE((
    SELECT NOT (
      NOT EXISTS (SELECT 1 FROM principals p WHERE p.id = run.principal_id
                   AND p.disabled_at IS NOT NULL AND p.offboarded_at IS NOT NULL
                   AND p.reactivated_at IS NULL
                   AND p.display_name = 'erased-' ||
                     left(replace(run.principal_id::text, '-', ''), 12))
      OR NOT EXISTS (SELECT 1 FROM scopes s WHERE s.id = run.scope_id
                      AND s.kind = 'user'
                      AND s.name = 'erased-user-' || run.scope_id::text)
      OR NOT EXISTS (SELECT 1 FROM principal_user_scopes mapping
                      WHERE mapping.principal_id = run.principal_id
                        AND mapping.scope_id = run.scope_id)
      OR NOT EXISTS (SELECT 1 FROM principal_user_scope_approvals approval
                      WHERE approval.id = run.approval_id
                        AND approval.principal_id = run.principal_id
                        AND approval.scope_id = run.scope_id
                        AND approval.acknowledged_evidence_hash =
                          run.approval_evidence_hash)
      OR EXISTS (SELECT 1 FROM memories m WHERE m.scope_id = run.scope_id AND (
        m.type IS DISTINCT FROM 'context' OR m.title IS DISTINCT FROM '[erased]'
        OR m.body IS DISTINCT FROM '[erased]'
        OR m.metadata IS DISTINCT FROM '{}'::jsonb
        OR m.tags IS DISTINCT FROM '{}'::text[]
        OR m.source IS DISTINCT FROM 'erased'
        OR m.source_ref IS NOT NULL OR m.state IS DISTINCT FROM 'archived'
        OR m.supersedes_id IS NOT NULL OR m.promoted_to_id IS NOT NULL
        OR m.expires_at IS NOT NULL OR m.last_verified IS NOT NULL))
      OR EXISTS (SELECT 1 FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
                  WHERE m.scope_id = run.scope_id)
      OR EXISTS (SELECT 1 FROM scope_memberships m
                  WHERE m.scope_id = run.scope_id AND m.active)
      OR EXISTS (SELECT 1 FROM principal_aliases a WHERE a.principal_id = run.principal_id)
      OR EXISTS (SELECT 1 FROM entra_groups g WHERE g.scope_id = run.scope_id
                  AND (g.active OR g.approval_revoked_at IS NULL))
      OR EXISTS (
        SELECT 1 FROM target_audit target JOIN audit_log audit ON audit.id = target.id
         WHERE audit.query IS NOT NULL OR audit.metadata IS DISTINCT FROM
             continuum_offboarding_expected_audit_metadata(audit.metadata))
    ) FROM target_run run
  ), FALSE)
$$;
REVOKE ALL ON FUNCTION continuum_offboarding_actual_state_is_erased(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_require_actual_offboarding_erasure()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.phase = 'completed'
     AND NOT continuum_offboarding_actual_state_is_erased(NEW.run_id) THEN
    RAISE EXCEPTION 'actual indexed erasure state is incomplete';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_require_actual_offboarding_erasure() FROM PUBLIC;

DROP TRIGGER IF EXISTS require_actual_offboarding_erasure
  ON principal_offboarding_run_events;
CREATE TRIGGER require_actual_offboarding_erasure
BEFORE INSERT ON principal_offboarding_run_events
FOR EACH ROW EXECUTE FUNCTION continuum_require_actual_offboarding_erasure();

-- Keep the state proved by the completion trigger true after the immutable
-- receipt is appended. Row locks serialize these checks with offboarding and
-- reactivation, closing completion-versus-dirty-update races.
CREATE OR REPLACE FUNCTION continuum_protect_offboarded_principal_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF OLD.offboarded_at IS NOT NULL AND NEW.offboarded_at IS NOT NULL
     AND (NEW.display_name IS DISTINCT FROM
            'erased-' || left(replace(NEW.id::text, '-', ''), 12)
          OR NEW.disabled_at IS NULL OR NEW.reactivated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'offboarded principal identity is immutable until guarded reactivation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_protect_offboarded_principal_identity() FROM PUBLIC;

DROP TRIGGER IF EXISTS protect_offboarded_principal_identity ON principals;
CREATE TRIGGER protect_offboarded_principal_identity
BEFORE UPDATE OF display_name, disabled_at, offboarded_at, reactivated_at ON principals
FOR EACH ROW EXECUTE FUNCTION continuum_protect_offboarded_principal_identity();

CREATE OR REPLACE FUNCTION continuum_protect_offboarded_scope_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  owner_offboarded BOOLEAN;
BEGIN
  SELECT TRUE INTO owner_offboarded
    FROM principal_user_scopes mapping
    JOIN principals principal ON principal.id = mapping.principal_id
   WHERE mapping.scope_id = OLD.id AND principal.offboarded_at IS NOT NULL
   FOR KEY SHARE OF principal;
  IF FOUND AND (NEW.kind IS DISTINCT FROM 'user'
                OR NEW.name IS DISTINCT FROM 'erased-user-' || NEW.id::text) THEN
    RAISE EXCEPTION 'offboarded owned-scope identity is immutable until guarded reactivation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_protect_offboarded_scope_identity() FROM PUBLIC;

DROP TRIGGER IF EXISTS protect_offboarded_scope_identity ON scopes;
CREATE TRIGGER protect_offboarded_scope_identity
BEFORE UPDATE OF kind, name ON scopes
FOR EACH ROW EXECUTE FUNCTION continuum_protect_offboarded_scope_identity();

CREATE OR REPLACE FUNCTION continuum_protect_offboarded_audit_tombstone()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  linked_to_offboarded BOOLEAN := FALSE;
BEGIN
  -- The normal bounded scrub writes only the canonical state. Keep that
  -- production-shaped batch O(rows), without per-row linkage lookups/locks.
  IF NEW.principal_id IS NOT DISTINCT FROM OLD.principal_id
     AND NEW.scope_id IS NOT DISTINCT FROM OLD.scope_id
     AND NEW.memory_id IS NOT DISTINCT FROM OLD.memory_id
     AND NEW.query IS NULL AND NEW.metadata IS NOT DISTINCT FROM
       continuum_offboarding_expected_audit_metadata(NEW.metadata) THEN
    RETURN NEW;
  END IF;

  SELECT TRUE INTO linked_to_offboarded FROM principals principal
   WHERE principal.id IN (OLD.principal_id, NEW.principal_id)
     AND principal.offboarded_at IS NOT NULL
   FOR KEY SHARE OF principal;
  IF NOT FOUND THEN
    SELECT TRUE INTO linked_to_offboarded
      FROM principal_user_scopes mapping
      JOIN principals principal ON principal.id = mapping.principal_id
     WHERE principal.offboarded_at IS NOT NULL AND (
       mapping.scope_id = OLD.scope_id OR mapping.scope_id = NEW.scope_id
       OR EXISTS (SELECT 1 FROM memories memory
                   WHERE memory.id IN (OLD.memory_id, NEW.memory_id)
                     AND memory.scope_id = mapping.scope_id)
       OR EXISTS (SELECT 1 FROM audit_log_offboarding_scopes selector
                   WHERE selector.audit_id = NEW.id
                     AND selector.scope_id = mapping.scope_id)
       OR EXISTS (SELECT 1 FROM principal_offboarding_audit_requests request
                   WHERE request.principal_id = mapping.principal_id
                     AND request.request_id = COALESCE(
                       NEW.metadata->>'request_id', OLD.metadata->>'request_id'))
     )
     FOR KEY SHARE OF principal;
  END IF;
  IF FOUND OR linked_to_offboarded THEN
    IF NEW.principal_id IS DISTINCT FROM OLD.principal_id
       OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
       OR NEW.memory_id IS DISTINCT FROM OLD.memory_id THEN
      RAISE EXCEPTION 'offboarded audit linkage is immutable';
    END IF;
    IF COALESCE(OLD.metadata->>'operation', '') = ANY(ARRAY[
         'principal_user_scope_mapped',
         'principal_user_scope_acknowledgement_replaced',
         'principal_memory_erased',
         'principal_offboarded',
         'principal_offboarding_repaired'
       ]::text[]) THEN
      IF NEW.query IS DISTINCT FROM OLD.query OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN
        RAISE EXCEPTION 'preserved offboarding audit evidence is immutable';
      END IF;
    ELSIF NEW.query IS NOT NULL OR NEW.metadata IS DISTINCT FROM
          continuum_offboarding_expected_audit_metadata(NEW.metadata) THEN
      RAISE EXCEPTION 'offboarded audit tombstone is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_protect_offboarded_audit_tombstone() FROM PUBLIC;

DROP TRIGGER IF EXISTS protect_offboarded_audit_tombstone ON audit_log;
CREATE TRIGGER protect_offboarded_audit_tombstone
BEFORE UPDATE OF principal_id, scope_id, memory_id, query, metadata ON audit_log
FOR EACH ROW EXECUTE FUNCTION continuum_protect_offboarded_audit_tombstone();

DO $migration$
DECLARE
  schema_name TEXT := current_schema();
  function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT procedure.proname,
           pg_get_function_identity_arguments(procedure.oid) AS arguments
      FROM pg_proc procedure
     WHERE procedure.pronamespace = current_schema()::regnamespace
       AND procedure.proname LIKE 'continuum\_%' ESCAPE '\'
       AND procedure.proowner = current_user::regrole
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend dependency
          WHERE dependency.classid = 'pg_proc'::regclass
            AND dependency.objid = procedure.oid
            AND dependency.deptype = 'e'
       )
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, %I, pg_temp',
      schema_name, function_record.proname, function_record.arguments, schema_name
    );
  END LOOP;
END;
$migration$;
