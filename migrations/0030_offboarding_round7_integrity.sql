-- Round-seven integrity: immutable lifecycle evidence and bounded selector cursors.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE principal_offboarding_runs
  ADD COLUMN audit_memory_key_cursor UUID,
  ADD COLUMN audit_memory_item_cursor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN audit_memory_complete BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN audit_linked_request_cursor TEXT,
  ADD COLUMN audit_linked_request_item_cursor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN audit_linked_request_exhausted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN audit_linked_complete BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE principal_offboarding_runs run
   SET audit_memory_complete = TRUE,
       audit_linked_complete = TRUE
 WHERE EXISTS (
   SELECT 1 FROM principal_offboarding_run_events event
    WHERE event.run_id = run.run_id AND event.phase = 'completed'
 );

ALTER TABLE principal_offboarding_run_events
  DROP CONSTRAINT principal_offboarding_run_events_phase_check,
  DROP CONSTRAINT principal_offboarding_run_events_check,
  ADD CONSTRAINT principal_offboarding_run_events_phase_check
    CHECK (phase IN ('started', 'completed', 'reactivated')),
  ADD CONSTRAINT principal_offboarding_run_events_actor_check
    CHECK ((phase = 'started' AND finalized_by IS NULL)
        OR (phase IN ('completed', 'reactivated') AND finalized_by IS NOT NULL));

CREATE FUNCTION continuum_guard_offboarding_run_progress() RETURNS trigger AS $$
DECLARE
  old_completed_evidence BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'principal offboarding runs cannot be deleted; incomplete offboarding run evidence is protected';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM principal_offboarding_run_events event
     WHERE event.run_id = OLD.run_id AND event.phase = 'completed'
  ) INTO old_completed_evidence;

  IF NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.scope_id IS DISTINCT FROM OLD.scope_id THEN
    RAISE EXCEPTION 'offboarding run identity is immutable';
  END IF;

  IF NEW.run_id IS DISTINCT FROM OLD.run_id THEN
    IF NOT old_completed_evidence OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'offboarding run identity can rotate only after immutable completion evidence';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM principal_offboarding_run_events event
        WHERE event.run_id = NEW.run_id AND event.phase = 'completed'
     ) THEN
    RAISE EXCEPTION 'offboarding completion requires append-only completion evidence';
  END IF;
  IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'completed offboarding run cannot be reopened without a new run identity';
  END IF;
  IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    RAISE EXCEPTION 'offboarding completion timestamp is immutable';
  END IF;

  IF NEW.initiated_by IS DISTINCT FROM OLD.initiated_by
     OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
     OR NEW.approval_evidence_hash IS DISTINCT FROM OLD.approval_evidence_hash
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.initial_memories IS DISTINCT FROM OLD.initial_memories
     OR NEW.initial_embeddings IS DISTINCT FROM OLD.initial_embeddings
     OR NEW.initial_memberships IS DISTINCT FROM OLD.initial_memberships
     OR NEW.initial_aliases IS DISTINCT FROM OLD.initial_aliases
     OR NEW.initial_entra_bindings IS DISTINCT FROM OLD.initial_entra_bindings
     OR NEW.initial_audit_rows IS DISTINCT FROM OLD.initial_audit_rows
     OR NEW.initial_audit_queries IS DISTINCT FROM OLD.initial_audit_queries
     OR NEW.initial_audit_selection IS DISTINCT FROM OLD.initial_audit_selection
     OR NEW.initial_count_truncated IS DISTINCT FROM OLD.initial_count_truncated THEN
    RAISE EXCEPTION 'offboarding run authorization and initial evidence are immutable';
  END IF;

  IF (NEW.memory_cursor IS NOT NULL AND OLD.memory_cursor IS NOT NULL
      AND NEW.memory_cursor < OLD.memory_cursor)
     OR (NEW.audit_fence_id IS NOT NULL AND OLD.audit_fence_id IS NOT NULL
         AND NEW.audit_fence_id < OLD.audit_fence_id)
     OR NEW.audit_principal_cursor < OLD.audit_principal_cursor
     OR NEW.audit_scope_cursor < OLD.audit_scope_cursor
     OR NEW.audit_memory_cursor < OLD.audit_memory_cursor
     OR NEW.audit_scope_ids_cursor < OLD.audit_scope_ids_cursor
     OR NEW.audit_linked_cursor < OLD.audit_linked_cursor
     OR NEW.memories_processed < OLD.memories_processed
     OR NEW.embeddings_processed < OLD.embeddings_processed
     OR NEW.memberships_processed < OLD.memberships_processed
     OR NEW.aliases_processed < OLD.aliases_processed
     OR NEW.entra_bindings_processed < OLD.entra_bindings_processed
     OR NEW.audit_rows_processed < OLD.audit_rows_processed
     OR NEW.audit_queries_processed < OLD.audit_queries_processed
     OR NEW.batches < OLD.batches
     OR (NEW.audit_memory_key_cursor IS NOT NULL AND OLD.audit_memory_key_cursor IS NOT NULL
         AND NEW.audit_memory_key_cursor < OLD.audit_memory_key_cursor)
     OR (NEW.audit_memory_key_cursor IS NOT DISTINCT FROM OLD.audit_memory_key_cursor
         AND NEW.audit_memory_item_cursor < OLD.audit_memory_item_cursor)
     OR (OLD.audit_memory_complete AND NOT NEW.audit_memory_complete)
     OR (NEW.audit_linked_request_cursor IS NOT NULL
         AND OLD.audit_linked_request_cursor IS NOT NULL
         AND NEW.audit_linked_request_cursor < OLD.audit_linked_request_cursor)
     OR (NEW.audit_linked_request_cursor IS NOT DISTINCT FROM OLD.audit_linked_request_cursor
         AND NEW.audit_linked_request_item_cursor < OLD.audit_linked_request_item_cursor)
     OR (OLD.audit_linked_complete AND NOT NEW.audit_linked_complete) THEN
    RAISE EXCEPTION 'offboarding fences and cursors cannot regress';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER guard_offboarding_run_progress
BEFORE UPDATE OR DELETE ON principal_offboarding_runs
FOR EACH ROW EXECUTE FUNCTION continuum_guard_offboarding_run_progress();

CREATE TRIGGER guard_offboarding_run_truncate
BEFORE TRUNCATE ON principal_offboarding_runs
FOR EACH STATEMENT EXECUTE FUNCTION continuum_preserve_offboarding_run_event();

CREATE OR REPLACE FUNCTION continuum_guard_principal_reactivation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  has_capability BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM continuum_principal_reactivation_requests request
     WHERE request.principal_id = OLD.id
       AND request.backend_pid = pg_backend_pid()
       AND request.transaction_id = txid_current()
  ) INTO has_capability;

  IF (OLD.offboarded_at IS NOT NULL AND NEW.offboarded_at IS NULL)
     OR (OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS NULL) THEN
    IF NOT has_capability OR NEW.offboarded_at IS NOT NULL
       OR NEW.disabled_at IS NOT NULL OR NEW.reactivated_at IS NULL THEN
      RAISE EXCEPTION 'offboarded principal reactivation requires the guarded database function';
    END IF;
    IF EXISTS (
      SELECT 1 FROM principal_offboarding_runs run
       WHERE run.principal_id = OLD.id
         AND NOT EXISTS (
           SELECT 1 FROM principal_offboarding_run_events event
            WHERE event.run_id = run.run_id AND event.phase = 'completed'
         )
    ) THEN
      RAISE EXCEPTION 'principal offboarding is incomplete';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_reactivate_principal(
  target_principal_id UUID,
  authorization_principal_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  was_offboarded BOOLEAN;
  completed_run principal_offboarding_runs%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM principals authorization_principal
      JOIN scope_memberships membership
        ON membership.principal_id = authorization_principal.id
      JOIN scopes scope ON scope.id = membership.scope_id
     WHERE authorization_principal.id = authorization_principal_id
       AND authorization_principal.disabled_at IS NULL
       AND scope.kind = 'org' AND scope.name = ''
       AND membership.active AND membership.role = 'admin'
       AND continuum_membership_is_effective(membership.active, membership.source_kind)
  ) THEN
    RAISE EXCEPTION 'principal reactivation requires an effective org administrator';
  END IF;

  SELECT offboarded_at IS NOT NULL INTO was_offboarded
    FROM principals
   WHERE id = target_principal_id AND disabled_at IS NOT NULL
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF was_offboarded THEN
    SELECT run.* INTO completed_run
      FROM principal_offboarding_runs run
     WHERE run.principal_id = target_principal_id
       AND EXISTS (
         SELECT 1 FROM principal_offboarding_run_events event
          WHERE event.run_id = run.run_id AND event.phase = 'completed'
       )
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'principal offboarding is incomplete or lacks immutable completion evidence';
    END IF;
  END IF;

  INSERT INTO continuum_principal_reactivation_requests
    (principal_id, backend_pid, transaction_id)
  VALUES (target_principal_id, pg_backend_pid(), txid_current());
  UPDATE principals
     SET disabled_at = NULL, offboarded_at = NULL, reactivated_at = now()
   WHERE id = target_principal_id;
  DELETE FROM continuum_principal_reactivation_requests
   WHERE principal_id = target_principal_id;

  IF was_offboarded THEN
    INSERT INTO principal_offboarding_run_events
      (run_id, principal_id, scope_id, phase, initiated_by, finalized_by,
       approval_id, approval_evidence_hash, evidence)
    VALUES (
      completed_run.run_id, completed_run.principal_id, completed_run.scope_id,
      'reactivated', completed_run.initiated_by, authorization_principal_id,
      completed_run.approval_id, completed_run.approval_evidence_hash,
      jsonb_build_object(
        'authorization_principal_id', authorization_principal_id,
        'previously_offboarded', TRUE
      )
    );
  END IF;

  INSERT INTO audit_log (principal_id, action, metadata)
  VALUES (
    '00000000-0000-4000-8000-000000000011',
    'write',
    jsonb_build_object(
      'operation', 'principal_reactivation_guarded',
      'principal_id', target_principal_id,
      'authorization_principal_id', authorization_principal_id,
      'previously_offboarded', was_offboarded
    )
  );
  RETURN was_offboarded;
END;
$$;

REVOKE ALL ON FUNCTION continuum_reactivate_principal(UUID, UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_reject_offboarded_principal_audit() RETURNS trigger AS $$
DECLARE
  principal_offboarded_at TIMESTAMPTZ;
  owner_principal_id UUID;
  effective_scope_id UUID;
BEGIN
  SELECT p.offboarded_at INTO principal_offboarded_at
    FROM principals p WHERE p.id = NEW.principal_id FOR KEY SHARE;
  IF principal_offboarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'audit insert forbidden for offboarded principal';
  END IF;

  effective_scope_id := NEW.scope_id;
  IF effective_scope_id IS NULL AND NEW.memory_id IS NOT NULL THEN
    SELECT memory.scope_id INTO effective_scope_id
      FROM memories memory WHERE memory.id = NEW.memory_id;
  END IF;
  SELECT p.id, p.offboarded_at INTO owner_principal_id, principal_offboarded_at
    FROM principal_user_scopes pus
    JOIN principals p ON p.id = pus.principal_id
   WHERE pus.scope_id = effective_scope_id
   FOR KEY SHARE OF p;
  IF FOUND AND principal_offboarded_at IS NOT NULL THEN
    IF NOT (NEW.action = 'archive' AND NEW.query IS NULL
      AND NEW.metadata->>'principal_id' = owner_principal_id::text
      AND (
        (NEW.memory_id IS NOT NULL AND NEW.metadata = jsonb_build_object(
          'operation', 'principal_memory_erased', 'principal_id', owner_principal_id::text
        ))
        OR (NEW.memory_id IS NULL AND NEW.metadata->>'operation' IN
          ('principal_offboarded', 'principal_offboarding_repaired')
          AND NEW.metadata - ARRAY[
            'operation', 'principal_id', 'approval_id', 'acknowledged_evidence_hash',
            'memories', 'audit_rows', 'batches'
          ]::text[] = '{}'::jsonb)
      )) THEN
      RAISE EXCEPTION 'audit insert forbidden for an offboarded owned scope';
    END IF;
  END IF;

  FOR principal_offboarded_at IN
    SELECT p.offboarded_at
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(NEW.metadata->'scope_ids') = 'array'
             THEN NEW.metadata->'scope_ids' ELSE '[]'::jsonb END
      ) AS carried(value)
      JOIN principal_user_scopes pus
        ON pus.scope_id = CASE
          WHEN carried.value ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
          THEN carried.value::uuid ELSE NULL END
      JOIN principals p ON p.id = pus.principal_id
     FOR KEY SHARE OF p
  LOOP
    IF principal_offboarded_at IS NOT NULL THEN
      RAISE EXCEPTION 'audit insert forbidden for an offboarded owned scope';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
