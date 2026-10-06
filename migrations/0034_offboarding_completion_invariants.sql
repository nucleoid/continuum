-- Ensure upgraded installations receive the exact completion/phase invariants
-- even when 0033 was applied by an earlier review build.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION continuum_complete_offboarding_run(
  target_run_id UUID,
  finalizer UUID,
  completion_evidence JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  inserted_run_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM principal_offboarding_runs run
     WHERE run.run_id = target_run_id
       AND run.completed_at IS NULL
       AND run.memory_complete AND run.scope_cleanup_complete
       AND run.audit_fence_id IS NOT NULL
       AND run.audit_principal_cursor >= run.audit_fence_id
       AND run.audit_scope_cursor >= run.audit_fence_id
       AND run.audit_scope_ids_cursor >= run.audit_fence_id
       AND run.audit_memory_complete AND run.audit_linked_complete
       AND completion_evidence->>'run_id' = run.run_id::text
       AND completion_evidence->>'initiated_by' = run.initiated_by::text
       AND completion_evidence->>'finalized_by' = finalizer::text
       AND completion_evidence->>'approval_id' = run.approval_id::text
       AND completion_evidence->>'approval_evidence_hash' = run.approval_evidence_hash
       AND (completion_evidence->>'counts_exact')::boolean
       AND (completion_evidence->>'memories_processed')::integer = run.memories_processed
       AND (completion_evidence->>'embeddings_processed')::integer = run.embeddings_processed
       AND (completion_evidence->>'memberships_processed')::integer = run.memberships_processed
       AND (completion_evidence->>'aliases_processed')::integer = run.aliases_processed
       AND (completion_evidence->>'entra_bindings_processed')::integer = run.entra_bindings_processed
       AND (completion_evidence->>'audit_rows_processed')::integer = run.audit_rows_processed
       AND (completion_evidence->>'audit_queries_processed')::integer = run.audit_queries_processed
       AND (completion_evidence->>'batches')::integer = run.batches
  ) THEN
    RAISE EXCEPTION 'offboarding completion requires exhausted phases and exact receipt evidence';
  END IF;

  INSERT INTO continuum_offboarding_completion_requests
    (run_id, backend_pid, transaction_id)
  VALUES (target_run_id, pg_backend_pid(), txid_current());
  INSERT INTO principal_offboarding_run_events
    (run_id, principal_id, scope_id, phase, initiated_by, finalized_by,
     approval_id, approval_evidence_hash, evidence)
  SELECT started.run_id, started.principal_id, started.scope_id, 'completed',
         started.initiated_by, finalizer, started.approval_id,
         started.approval_evidence_hash, completion_evidence
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

CREATE OR REPLACE FUNCTION continuum_guard_offboarding_phase_progress() RETURNS trigger AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id THEN RETURN NEW; END IF;
  IF (OLD.memory_complete AND NOT NEW.memory_complete)
     OR (OLD.scope_cleanup_complete AND NOT NEW.scope_cleanup_complete) THEN
    RAISE EXCEPTION 'offboarding durable phases cannot regress';
  END IF;
  IF (NEW.audit_linked_request_cursor IS DISTINCT FROM OLD.audit_linked_request_cursor
      OR NEW.audit_linked_request_item_cursor IS DISTINCT FROM OLD.audit_linked_request_item_cursor
      OR NEW.audit_linked_complete IS DISTINCT FROM OLD.audit_linked_complete)
     AND NOT (
       NEW.audit_fence_id IS NOT NULL
       AND NEW.audit_principal_cursor >= NEW.audit_fence_id
       AND NEW.audit_scope_cursor >= NEW.audit_fence_id
       AND NEW.audit_scope_ids_cursor >= NEW.audit_fence_id
       AND NEW.audit_memory_complete
     ) THEN
    RAISE EXCEPTION 'linked audit phase requires every direct selector to complete';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS guard_offboarding_phase_progress ON principal_offboarding_runs;
CREATE TRIGGER guard_offboarding_phase_progress
BEFORE UPDATE ON principal_offboarding_runs
FOR EACH ROW EXECUTE FUNCTION continuum_guard_offboarding_phase_progress();

DO $migration$
DECLARE schema_name TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_complete_offboarding_run(UUID, UUID, JSONB) SET search_path = pg_catalog, %I, pg_temp',
    schema_name, schema_name
  );
END;
$migration$;
