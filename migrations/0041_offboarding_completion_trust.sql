-- Preserve completed erasure receipts and distinguish database-verified state
-- from application-reported operational telemetry.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION continuum_guard_completed_offboarding_run()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF OLD.completed_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.run_id IS DISTINCT FROM OLD.run_id AND NEW.completed_at IS NULL THEN
    IF continuum_offboarding_actual_state_is_erased(OLD.run_id) THEN
      RAISE EXCEPTION 'completed erased offboarding run cannot be restarted';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'completed offboarding run is immutable';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_guard_completed_offboarding_run() FROM PUBLIC;

DROP TRIGGER IF EXISTS guard_completed_offboarding_run ON principal_offboarding_runs;
CREATE TRIGGER guard_completed_offboarding_run
BEFORE UPDATE ON principal_offboarding_runs
FOR EACH ROW EXECUTE FUNCTION continuum_guard_completed_offboarding_run();

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
     AND run.initiated_by = finalizer
     AND run.memory_complete AND run.scope_cleanup_complete
     AND run.audit_fence_id IS NOT NULL
     AND run.audit_principal_cursor >= run.audit_fence_id
     AND run.audit_scope_cursor >= run.audit_fence_id
     AND run.audit_scope_ids_cursor >= run.audit_fence_id
     AND run.audit_memory_complete AND run.audit_linked_complete
     AND continuum_offboarding_actual_state_is_erased(run.run_id)
     AND EXISTS (
       SELECT 1 FROM principals principal
       JOIN scope_memberships membership ON membership.principal_id = principal.id
       JOIN scopes scope ON scope.id = membership.scope_id
        WHERE principal.id = finalizer AND principal.disabled_at IS NULL
          AND scope.kind = 'org' AND scope.name = ''
          AND membership.active AND membership.role = 'admin'
          AND continuum_membership_is_effective(
            membership.active, membership.source_kind)
     )
     AND EXISTS (
       SELECT 1 FROM audit_log_offboarding_backfill_state backfill
        WHERE backfill.singleton = TRUE AND backfill.completed
     );
  IF verified_evidence IS NULL THEN
    RAISE EXCEPTION 'offboarding completion requires verified erasure and the initiating effective org administrator';
  END IF;

  INSERT INTO continuum_offboarding_completion_requests
    (run_id, backend_pid, transaction_id)
  VALUES (target_run_id, pg_backend_pid(), txid_current());
  INSERT INTO principal_offboarding_run_events
    (run_id, principal_id, scope_id, phase, initiated_by, finalized_by,
     approval_id, approval_evidence_hash, evidence)
  SELECT started.run_id, started.principal_id, started.scope_id, 'completed',
         started.initiated_by, started.initiated_by, started.approval_id,
         started.approval_evidence_hash, verified_evidence
    FROM principal_offboarding_run_events started
   WHERE started.run_id = target_run_id AND started.phase = 'started'
     AND started.initiated_by = finalizer
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
       AND (procedure.proname LIKE 'continuum\_%' ESCAPE '\'
            OR procedure.proname = 'reject_lifecycle_principal_membership')
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
  IF EXISTS (
    SELECT 1 FROM pg_proc procedure
     WHERE procedure.pronamespace = current_schema()::regnamespace
       AND (procedure.proname LIKE 'continuum\_%' ESCAPE '\'
            OR procedure.proname = 'reject_lifecycle_principal_membership')
       AND procedure.proowner = current_user::regrole
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend dependency
          WHERE dependency.classid = 'pg_proc'::regclass
            AND dependency.objid = procedure.oid
            AND dependency.deptype = 'e'
       )
       AND NOT COALESCE(procedure.proconfig @> ARRAY[
         format('search_path=pg_catalog, %I, pg_temp', schema_name)
       ], FALSE)
  ) THEN
    RAISE EXCEPTION 'Continuum function search_path hardening is incomplete';
  END IF;
END;
$migration$;
