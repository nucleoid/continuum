-- Upgrade-safe correction: completed runs may restart either after guarded
-- reactivation or to repair state that became dirty after completion.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION continuum_restart_offboarding_run(
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

-- Counters are database-stored but application-driven telemetry. Preserve the
-- honest trust label while the completion basis remains database-verified.
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

DO $migration$
DECLARE
  schema_name TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_restart_offboarding_run(UUID, UUID, JSONB) SET search_path = pg_catalog, %I, pg_temp',
    schema_name, schema_name
  );
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_complete_offboarding_run(UUID, UUID, JSONB) SET search_path = pg_catalog, %I, pg_temp',
    schema_name, schema_name
  );
END;
$migration$;
