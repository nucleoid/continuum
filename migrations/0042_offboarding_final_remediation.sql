-- Final least-privilege boundary for resumable offboarding and audit retention.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE principal_offboarding_run_events
  DROP CONSTRAINT principal_offboarding_run_events_phase_check,
  DROP CONSTRAINT principal_offboarding_run_events_actor_check,
  ADD CONSTRAINT principal_offboarding_run_events_phase_check
    CHECK (phase IN ('started', 'resumed', 'completed', 'reactivated')),
  ADD CONSTRAINT principal_offboarding_run_events_actor_check
    CHECK ((phase = 'started' AND finalized_by IS NULL)
        OR (phase IN ('resumed', 'completed', 'reactivated') AND finalized_by IS NOT NULL));

-- Keep the former command implementation owner-only. The public command name
-- below deliberately excludes restart; a fresh run has a stronger contract.
DO $rename$
BEGIN
  IF to_regprocedure('continuum_write_offboarding_run(uuid,uuid,text,jsonb)') IS NOT NULL THEN
    ALTER FUNCTION continuum_write_offboarding_run(UUID, UUID, TEXT, JSONB)
      RENAME TO continuum_write_offboarding_run_internal;
  ELSIF to_regprocedure(
    'continuum_write_offboarding_run_internal(uuid,uuid,text,jsonb)'
  ) IS NULL THEN
    RAISE EXCEPTION 'offboarding progress function is missing';
  END IF;
END;
$rename$;
REVOKE ALL ON FUNCTION continuum_write_offboarding_run_internal(UUID, UUID, TEXT, JSONB)
  FROM PUBLIC;

CREATE FUNCTION continuum_write_offboarding_run(
  target_principal_id UUID,
  authorization_principal_id UUID,
  command TEXT,
  details JSONB DEFAULT '{}'::jsonb
) RETURNS SETOF principal_offboarding_runs
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF command = 'restart' THEN
    RAISE EXCEPTION 'fresh offboarding restart requires the guarded restart function';
  END IF;
  RETURN QUERY SELECT * FROM continuum_write_offboarding_run_internal(
    target_principal_id, authorization_principal_id, command, details
  );
END;
$$;
REVOKE ALL ON FUNCTION continuum_write_offboarding_run(UUID, UUID, TEXT, JSONB) FROM PUBLIC;

CREATE FUNCTION continuum_restart_offboarding_run(
  target_principal_id UUID,
  authorization_principal_id UUID,
  details JSONB
) RETURNS SETOF principal_offboarding_runs
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  current_run principal_offboarding_runs%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM principals principal
    JOIN scope_memberships membership ON membership.principal_id = principal.id
    JOIN scopes scope ON scope.id = membership.scope_id
    WHERE principal.id = authorization_principal_id
      AND principal.disabled_at IS NULL
      AND scope.kind = 'org' AND scope.name = ''
      AND membership.active AND membership.role = 'admin'
      AND continuum_membership_is_effective(membership.active, membership.source_kind)
  ) THEN
    RAISE EXCEPTION 'fresh offboarding requires an effective org administrator';
  END IF;

  SELECT run.* INTO current_run
    FROM principal_offboarding_runs run
    JOIN principals principal ON principal.id = run.principal_id
   WHERE run.principal_id = target_principal_id
     AND run.completed_at IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM principal_offboarding_run_events event
        WHERE event.run_id = run.run_id AND event.phase = 'completed'
     )
     AND (
       (principal.offboarded_at IS NULL AND principal.disabled_at IS NULL
        AND principal.reactivated_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM principal_offboarding_run_events event
           WHERE event.run_id = run.run_id AND event.phase = 'reactivated'
        ))
       OR
       (principal.offboarded_at IS NOT NULL AND principal.disabled_at IS NOT NULL
        AND principal.reactivated_at IS NULL
        AND NOT continuum_offboarding_actual_state_is_erased(run.run_id))
     )
   FOR UPDATE OF run, principal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fresh offboarding restart requires guarded reactivation or dirty repair state';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM principal_user_scope_approvals approval
     WHERE approval.id = (details->>'approval_id')::bigint
       AND approval.principal_id = current_run.principal_id
       AND approval.scope_id = current_run.scope_id
       AND approval.acknowledged_evidence_hash = details->>'approval_evidence_hash'
  ) THEN
    RAISE EXCEPTION 'fresh offboarding restart requires current approval evidence';
  END IF;

  RETURN QUERY SELECT * FROM continuum_write_offboarding_run_internal(
    target_principal_id, authorization_principal_id, 'restart', details
  );
END;
$$;
REVOKE ALL ON FUNCTION continuum_restart_offboarding_run(UUID, UUID, JSONB) FROM PUBLIC;

CREATE FUNCTION continuum_resume_offboarding_run(
  target_run_id UUID,
  authorization_principal_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  target_run principal_offboarding_runs%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM principals principal
    JOIN scope_memberships membership ON membership.principal_id = principal.id
    JOIN scopes scope ON scope.id = membership.scope_id
    WHERE principal.id = authorization_principal_id
      AND principal.disabled_at IS NULL
      AND scope.kind = 'org' AND scope.name = ''
      AND membership.active AND membership.role = 'admin'
      AND continuum_membership_is_effective(membership.active, membership.source_kind)
  ) THEN
    RAISE EXCEPTION 'offboarding resume requires an effective org administrator';
  END IF;
  SELECT run.* INTO target_run FROM principal_offboarding_runs run
   WHERE run.run_id = target_run_id AND run.completed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'incomplete offboarding run not found'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM principal_offboarding_run_events event
     WHERE event.run_id = target_run_id AND event.phase = 'started'
  ) THEN
    RAISE EXCEPTION 'offboarding resume requires immutable start evidence';
  END IF;
  IF target_run.initiated_by <> authorization_principal_id THEN
    INSERT INTO principal_offboarding_run_events
      (run_id, principal_id, scope_id, phase, initiated_by, finalized_by,
       approval_id, approval_evidence_hash, evidence)
    VALUES (
      target_run.run_id, target_run.principal_id, target_run.scope_id, 'resumed',
      target_run.initiated_by, authorization_principal_id, target_run.approval_id,
      target_run.approval_evidence_hash,
      jsonb_build_object(
        'resumed_by', authorization_principal_id,
        'takeover_from', target_run.initiated_by,
        'authorization_basis', 'current_effective_org_admin'
      )
    ) ON CONFLICT (run_id, phase) DO NOTHING;
  END IF;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION continuum_resume_offboarding_run(UUID, UUID) FROM PUBLIC;

-- Completion prerequisites are checked here. The completion-event trigger
-- performs the exact indexed state proof once, while this function holds its
-- backend-local capability and the transaction's lifecycle locks.
CREATE OR REPLACE FUNCTION continuum_complete_offboarding_run(
  target_run_id UUID,
  finalizer UUID,
  completion_evidence JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  inserted_run_id UUID;
  verified_evidence JSONB;
BEGIN
  SELECT jsonb_build_object(
           'run_id', run.run_id,
           'initiated_by', run.initiated_by,
           'finalized_by', finalizer,
           'completion_basis', 'database_verified_erasure',
           'attribution_basis', 'application_supplied_effective_org_admin',
           'telemetry', jsonb_build_object(
             'trust', 'application_reported',
             'memories_processed', run.memories_processed,
             'embeddings_processed', run.embeddings_processed,
             'memberships_processed', run.memberships_processed,
             'aliases_processed', run.aliases_processed,
             'entra_bindings_processed', run.entra_bindings_processed,
             'audit_rows_processed', run.audit_rows_processed,
             'audit_queries_processed', run.audit_queries_processed,
             'batches', run.batches
           )
         )
    INTO verified_evidence
    FROM principal_offboarding_runs run
   WHERE run.run_id = target_run_id
     AND run.completed_at IS NULL
     AND run.memory_complete AND run.scope_cleanup_complete
     AND run.audit_fence_id IS NOT NULL
     AND run.audit_principal_cursor >= run.audit_fence_id
     AND run.audit_scope_cursor >= run.audit_fence_id
     AND run.audit_scope_ids_cursor >= run.audit_fence_id
     AND run.audit_memory_complete AND run.audit_linked_complete
     AND EXISTS (
       SELECT 1 FROM principals principal
       JOIN scope_memberships membership ON membership.principal_id = principal.id
       JOIN scopes scope ON scope.id = membership.scope_id
        WHERE principal.id = finalizer AND principal.disabled_at IS NULL
          AND scope.kind = 'org' AND scope.name = ''
          AND membership.active AND membership.role = 'admin'
          AND continuum_membership_is_effective(membership.active, membership.source_kind)
     )
     AND EXISTS (
       SELECT 1 FROM audit_log_offboarding_backfill_state backfill
        WHERE backfill.singleton = TRUE AND backfill.completed
     );
  IF verified_evidence IS NULL THEN
    RAISE EXCEPTION 'offboarding completion requires ready state and a current effective org administrator';
  END IF;

  INSERT INTO continuum_offboarding_completion_requests
    (run_id, backend_pid, transaction_id)
  VALUES (target_run_id, pg_backend_pid(), txid_current());
  INSERT INTO principal_offboarding_run_events
    (run_id, principal_id, scope_id, phase, initiated_by, finalized_by,
     approval_id, approval_evidence_hash, evidence)
  SELECT started.run_id, started.principal_id, started.scope_id, 'completed',
         started.initiated_by, finalizer, started.approval_id,
         started.approval_evidence_hash, verified_evidence
    FROM principal_offboarding_run_events started
   WHERE started.run_id = target_run_id AND started.phase = 'started'
  ON CONFLICT (run_id, phase) DO NOTHING
  RETURNING run_id INTO inserted_run_id;
  IF inserted_run_id IS NULL THEN
    RAISE EXCEPTION 'offboarding completion evidence could not be appended';
  END IF;
  UPDATE principal_offboarding_runs SET completed_at = now()
   WHERE run_id = target_run_id AND completed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'offboarding run could not be finalized'; END IF;
  DELETE FROM continuum_offboarding_completion_requests WHERE run_id = target_run_id;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION continuum_complete_offboarding_run(UUID, UUID, JSONB) FROM PUBLIC;

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

-- The app role may request only canonical redaction of rows independently
-- proved to belong to the active run and immutable audit fence.
CREATE FUNCTION continuum_redact_offboarding_audit(
  target_principal_id UUID,
  authorization_principal_id UUID,
  target_ids BIGINT[]
) RETURNS TABLE(redacted_rows INTEGER, redacted_queries INTEGER)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  target_run principal_offboarding_runs%ROWTYPE;
  query_count INTEGER;
  changed_count INTEGER;
BEGIN
  IF COALESCE(cardinality(target_ids), 0) = 0 THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;
  IF cardinality(target_ids) > 5000
     OR (SELECT count(*) FROM unnest(target_ids) value)
        <> (SELECT count(DISTINCT value) FROM unnest(target_ids) value) THEN
    RAISE EXCEPTION 'invalid offboarding audit redaction batch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM principals principal
    JOIN scope_memberships membership ON membership.principal_id = principal.id
    JOIN scopes scope ON scope.id = membership.scope_id
    WHERE principal.id = authorization_principal_id
      AND principal.disabled_at IS NULL
      AND scope.kind = 'org' AND scope.name = ''
      AND membership.active AND membership.role = 'admin'
      AND continuum_membership_is_effective(membership.active, membership.source_kind)
  ) THEN
    RAISE EXCEPTION 'offboarding audit redaction requires an effective org administrator';
  END IF;
  SELECT run.* INTO target_run FROM principal_offboarding_runs run
   WHERE run.principal_id = target_principal_id AND run.completed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR target_run.audit_fence_id IS NULL THEN
    RAISE EXCEPTION 'active fenced offboarding run not found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(target_ids) requested(id)
    LEFT JOIN audit_log audit ON audit.id = requested.id
     WHERE audit.id IS NULL OR audit.id > target_run.audit_fence_id
        OR COALESCE(audit.metadata->>'operation', '') = ANY(ARRAY[
          'principal_user_scope_mapped', 'principal_user_scope_acknowledgement_replaced',
          'principal_memory_erased', 'principal_offboarded', 'principal_offboarding_repaired'
        ]::text[])
        OR NOT (
          audit.principal_id = target_run.principal_id
          OR audit.scope_id = target_run.scope_id
          OR EXISTS (
            SELECT 1 FROM audit_log_offboarding_scopes selector
             WHERE selector.audit_id = audit.id AND selector.scope_id = target_run.scope_id
          )
          OR EXISTS (
            SELECT 1 FROM principal_offboarding_audit_requests request
             WHERE request.principal_id = target_run.principal_id
               AND request.request_id = audit.metadata->>'request_id'
          )
        )
  ) THEN
    RAISE EXCEPTION 'audit row is outside the active offboarding run';
  END IF;
  SELECT count(*)::integer INTO query_count FROM audit_log
   WHERE id = ANY(target_ids) AND query IS NOT NULL;
  UPDATE audit_log audit SET query = NULL,
         metadata = continuum_offboarding_expected_audit_metadata(audit.metadata)
   WHERE audit.id = ANY(target_ids);
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN QUERY SELECT changed_count, query_count;
END;
$$;
REVOKE ALL ON FUNCTION continuum_redact_offboarding_audit(UUID, UUID, BIGINT[]) FROM PUBLIC;

ALTER TABLE principal_offboarding_events ADD COLUMN run_id UUID;
CREATE UNIQUE INDEX principal_offboarding_events_run_id_idx
  ON principal_offboarding_events (run_id) WHERE run_id IS NOT NULL;

CREATE FUNCTION continuum_record_offboarding_event(target_run_id UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  inserted_id BIGINT;
BEGIN
  INSERT INTO principal_offboarding_events
    (run_id, principal_id, scope_id, actor_principal_id, repair, memories,
     embeddings, memberships, aliases, entra_bindings, audit_rows, audit_queries,
     approval_id, batches, evidence)
  SELECT run.run_id, run.principal_id, run.scope_id, completed.finalized_by,
         COALESCE((started.evidence->>'repair')::boolean, FALSE),
         run.memories_processed, run.embeddings_processed, run.memberships_processed,
         run.aliases_processed, run.entra_bindings_processed, run.audit_rows_processed,
         run.audit_queries_processed, run.approval_id, run.batches, started.evidence
    FROM principal_offboarding_runs run
    JOIN principal_offboarding_run_events started
      ON started.run_id = run.run_id AND started.phase = 'started'
    JOIN principal_offboarding_run_events completed
      ON completed.run_id = run.run_id AND completed.phase = 'completed'
   WHERE run.run_id = target_run_id AND run.completed_at IS NOT NULL
  ON CONFLICT (run_id) WHERE run_id IS NOT NULL DO NOTHING
  RETURNING id INTO inserted_id;
  IF inserted_id IS NULL THEN
    SELECT id INTO inserted_id FROM principal_offboarding_events WHERE run_id = target_run_id;
  END IF;
  IF inserted_id IS NULL THEN
    RAISE EXCEPTION 'completed offboarding run evidence not found';
  END IF;
  RETURN inserted_id;
END;
$$;
REVOKE ALL ON FUNCTION continuum_record_offboarding_event(UUID) FROM PUBLIC;

-- Shared application roles cannot mint or alter a manual organization admin.
-- Reviewed operator scripts run as the membership-table owner.
CREATE FUNCTION continuum_guard_manual_org_admin_membership()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  table_owner OID;
  touches_admin BOOLEAN := FALSE;
BEGIN
  SELECT relowner INTO table_owner FROM pg_class
   WHERE oid = 'scope_memberships'::regclass;
  IF current_user::regrole = table_owner THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    touches_admin := OLD.source_kind = 'manual' AND OLD.role = 'admin' AND EXISTS (
      SELECT 1 FROM scopes scope WHERE scope.id = OLD.scope_id
       AND scope.kind = 'org' AND scope.name = ''
    );
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    touches_admin := touches_admin OR (
      NEW.source_kind = 'manual' AND NEW.role = 'admin' AND NEW.active AND EXISTS (
        SELECT 1 FROM scopes scope WHERE scope.id = NEW.scope_id
         AND scope.kind = 'org' AND scope.name = ''
      )
    );
  END IF;
  IF touches_admin THEN
    RAISE EXCEPTION 'manual organization administrator changes require the guarded operator path';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION continuum_guard_manual_org_admin_membership() FROM PUBLIC;
CREATE TRIGGER guard_manual_org_admin_membership
BEFORE INSERT OR UPDATE OR DELETE ON scope_memberships
FOR EACH ROW EXECUTE FUNCTION continuum_guard_manual_org_admin_membership();

CREATE FUNCTION continuum_guard_retention_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.metadata->>'source' = 'audit-retention' THEN
    RAISE EXCEPTION 'audit retention evidence is immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION continuum_guard_retention_evidence() FROM PUBLIC;
CREATE TRIGGER guard_retention_evidence
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION continuum_guard_retention_evidence();

CREATE FUNCTION continuum_apply_audit_retention(
  authorization_principal_id UUID,
  cutoff TIMESTAMPTZ,
  retention_days INTEGER,
  retention_run_id UUID,
  batch_number INTEGER,
  expected_rows JSONB,
  export_mode TEXT,
  export_sha256 TEXT
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  actual_rows JSONB;
  expected_rows_by_id JSONB;
  deleted_count INTEGER;
  first_row JSONB;
  last_row JSONB;
BEGIN
  IF retention_days < 1 OR batch_number < 1
     OR jsonb_typeof(expected_rows) <> 'array'
     OR jsonb_array_length(expected_rows) NOT BETWEEN 1 AND 1000
     OR export_mode NOT IN ('none', 'jsonl')
     OR (export_mode = 'jsonl' AND export_sha256 !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'invalid audit retention batch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM principals principal
    JOIN scope_memberships membership ON membership.principal_id = principal.id
    JOIN scopes scope ON scope.id = membership.scope_id
    WHERE principal.id = authorization_principal_id
      AND principal.disabled_at IS NULL
      AND scope.kind = 'org' AND scope.name = ''
      AND membership.active AND membership.role = 'admin'
      AND continuum_membership_is_effective(membership.active, membership.source_kind)
  ) THEN
    RAISE EXCEPTION 'audit retention requires a current org admin';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(expected_rows)) <>
     (SELECT count(DISTINCT (row->>'id')::bigint) FROM jsonb_array_elements(expected_rows) row) THEN
    RAISE EXCEPTION 'audit retention batch contains duplicate IDs';
  END IF;
  SELECT jsonb_agg(row ORDER BY (row->>'id')::bigint)
    INTO expected_rows_by_id FROM jsonb_array_elements(expected_rows) row;

  SELECT jsonb_agg(jsonb_build_object(
           'id', audit.id::text,
           'at', CASE
             WHEN audit.at = '-infinity'::timestamptz THEN '-infinity'
             WHEN audit.at = 'infinity'::timestamptz THEN 'infinity'
             WHEN extract(year FROM audit.at AT TIME ZONE 'UTC') < 1
               THEN to_char(audit.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z" BC')
             ELSE to_char(audit.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
           END,
           'principal_id', audit.principal_id,
           'action', audit.action,
           'memory_id', audit.memory_id,
           'scope_id', audit.scope_id,
           'query', audit.query,
           'metadata_json', audit.metadata::text
         ) ORDER BY audit.id)
    INTO actual_rows
    FROM audit_log audit
   WHERE audit.id = ANY(ARRAY(
           SELECT (row->>'id')::bigint FROM jsonb_array_elements(expected_rows) row
         ))
     AND audit.at < cutoff
     AND COALESCE(audit.metadata->>'operation', '') <> ALL(ARRAY[
       'principal_user_scope_mapped', 'principal_user_scope_acknowledgement_replaced',
       'principal_memory_erased', 'principal_offboarded', 'principal_offboarding_repaired'
     ]::text[])
     AND COALESCE(audit.metadata->>'source', '') <> 'audit-retention';
  IF actual_rows IS DISTINCT FROM expected_rows_by_id THEN
    RAISE EXCEPTION 'audit retention row changed after export or is not deletable';
  END IF;

  first_row := expected_rows->0;
  last_row := expected_rows->(jsonb_array_length(expected_rows) - 1);
  DELETE FROM audit_log audit
   WHERE audit.id = ANY(ARRAY(
           SELECT (row->>'id')::bigint FROM jsonb_array_elements(expected_rows) row
         ))
     AND audit.at < cutoff
     AND COALESCE(audit.metadata->>'operation', '') <> ALL(ARRAY[
       'principal_user_scope_mapped', 'principal_user_scope_acknowledgement_replaced',
       'principal_memory_erased', 'principal_offboarded', 'principal_offboarding_repaired'
     ]::text[])
     AND COALESCE(audit.metadata->>'source', '') <> 'audit-retention';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  IF deleted_count <> jsonb_array_length(expected_rows) THEN
    RAISE EXCEPTION 'audit retention delete count did not match the selected batch';
  END IF;
  INSERT INTO audit_log (principal_id, action, metadata)
  VALUES (authorization_principal_id, 'archive', jsonb_build_object(
    'source', 'audit-retention',
    'cutoff', to_char(cutoff AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'retention_days', retention_days,
    'first_id', first_row->>'id',
    'last_id', last_row->>'id',
    'first_at', first_row->>'at',
    'last_at', last_row->>'at',
    'deleted_count', deleted_count,
    'export_mode', export_mode,
    'export_sha256', export_sha256,
    'run_id', retention_run_id,
    'batch_number', batch_number
  ));
  RETURN deleted_count;
END;
$$;
REVOKE ALL ON FUNCTION continuum_apply_audit_retention(
  UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT
) FROM PUBLIC;

-- Harden every Continuum-owned SECURITY DEFINER. A foreign owner is accepted
-- only when it already has the exact safe path; otherwise migration fails.
DO $migration$
DECLARE
  schema_name TEXT := current_schema();
  function_record RECORD;
  unsafe_record RECORD;
BEGIN
  FOR function_record IN
    SELECT procedure.proname,
           pg_get_function_identity_arguments(procedure.oid) AS arguments
      FROM pg_proc procedure
     WHERE procedure.pronamespace = current_schema()::regnamespace
       AND (procedure.proname LIKE 'continuum\_%' ESCAPE '\'
            OR procedure.proname = 'reject_lifecycle_principal_membership')
       AND procedure.proowner = current_user::regrole
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend dependency
          WHERE dependency.classid = 'pg_proc'::regclass
            AND dependency.objid = procedure.oid AND dependency.deptype = 'e'
       )
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, %I, pg_temp',
      schema_name, function_record.proname, function_record.arguments, schema_name
    );
  END LOOP;

  SELECT procedure.proname,
         pg_get_function_identity_arguments(procedure.oid) AS arguments,
         pg_get_userbyid(procedure.proowner) AS owner_name
    INTO unsafe_record
    FROM pg_proc procedure
   WHERE procedure.pronamespace = current_schema()::regnamespace
     AND procedure.prosecdef
     AND (procedure.proname LIKE 'continuum\_%' ESCAPE '\'
          OR procedure.proname = 'reject_lifecycle_principal_membership')
     AND NOT COALESCE(procedure.proconfig @> ARRAY[
       format('search_path=pg_catalog, %I, pg_temp', schema_name)
     ], FALSE)
   ORDER BY procedure.proname LIMIT 1;
  IF FOUND THEN
    IF unsafe_record.owner_name <> current_user THEN
      RAISE EXCEPTION 'foreign-owned Continuum SECURITY DEFINER function %.%(%) is unsafe',
        schema_name, unsafe_record.proname, unsafe_record.arguments;
    END IF;
    RAISE EXCEPTION 'Continuum SECURITY DEFINER function %.%(%) is unsafe',
      schema_name, unsafe_record.proname, unsafe_record.arguments;
  END IF;
END;
$migration$;
