-- Close the final shared-role authority and Entra source-integrity gaps.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE continuum_entra_reapproval_requests (
  external_id TEXT PRIMARY KEY,
  backend_pid INTEGER NOT NULL,
  transaction_id BIGINT NOT NULL
);
REVOKE ALL ON TABLE continuum_entra_reapproval_requests FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_require_trusted_database_identity(
  claimed_principal_id UUID,
  required_capability TEXT
) RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  invoking_role NAME := continuum_invoking_database_role();
  owner_role NAME;
  bound_principal UUID;
BEGIN
  SELECT pg_get_userbyid(relowner)::name INTO owner_role
    FROM pg_class WHERE oid = 'principals'::regclass;
  IF invoking_role = owner_role THEN RETURN; END IF;
  SELECT identity.principal_id INTO bound_principal
    FROM continuum_trusted_database_identities identity
    JOIN principals p ON p.id = identity.principal_id
   WHERE identity.database_role = invoking_role
     AND identity.principal_id = claimed_principal_id
     AND p.disabled_at IS NULL
     AND CASE required_capability
           WHEN 'approve' THEN identity.can_approve AND p.kind = 'user'
             AND EXISTS (
               SELECT 1 FROM scope_memberships membership
               JOIN scopes scope ON scope.id = membership.scope_id
                WHERE membership.principal_id = p.id
                  AND scope.kind = 'org' AND scope.name = ''
                  AND membership.source_kind = 'manual'
                  AND membership.source_id = 'manual'
                  AND membership.role = 'admin' AND membership.active
             )
           WHEN 'sync' THEN identity.can_sync AND p.kind = 'service'
           ELSE FALSE
         END;
  IF bound_principal IS NULL THEN
    RAISE EXCEPTION 'operation requires a DB-bound trusted % identity', required_capability;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_require_trusted_database_identity(UUID, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_register_trusted_database_identity(
  target_database_role NAME,
  target_principal_id UUID,
  approve_capability BOOLEAN,
  sync_capability BOOLEAN
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT (approve_capability OR sync_capability) OR (approve_capability AND sync_capability) THEN
    RAISE EXCEPTION 'exactly one trusted database capability is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_database_role) THEN
    RAISE EXCEPTION 'trusted database role does not exist';
  END IF;
  IF sync_capability AND NOT EXISTS (
    SELECT 1 FROM principals p
     WHERE p.id = target_principal_id AND p.kind = 'service' AND p.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'sync identity must be an enabled service principal';
  END IF;
  IF approve_capability AND NOT EXISTS (
    SELECT 1 FROM principals p
    JOIN scope_memberships m ON m.principal_id = p.id
    JOIN scopes s ON s.id = m.scope_id
     WHERE p.id = target_principal_id AND p.kind = 'user' AND p.disabled_at IS NULL
       AND s.kind = 'org' AND s.name = '' AND m.source_kind = 'manual'
       AND m.source_id = 'manual' AND m.role = 'admin' AND m.active
  ) THEN
    RAISE EXCEPTION 'operator identity must be an effective manual org administrator';
  END IF;
  INSERT INTO continuum_trusted_database_identities
    (database_role, principal_id, can_approve, can_sync)
  VALUES (target_database_role, target_principal_id, approve_capability, sync_capability)
  ON CONFLICT (database_role) DO UPDATE SET
    principal_id = EXCLUDED.principal_id,
    can_approve = EXCLUDED.can_approve,
    can_sync = EXCLUDED.can_sync;
END;
$$;
REVOKE ALL ON FUNCTION continuum_register_trusted_database_identity(NAME, UUID, BOOLEAN, BOOLEAN)
FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_require_sync_session(claimed_principal_id UUID)
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE owner_role NAME;
BEGIN
  SELECT pg_get_userbyid(relowner)::name INTO owner_role
    FROM pg_class WHERE oid = 'principals'::regclass;
  IF continuum_invoking_database_role() = owner_role THEN
    IF NOT EXISTS (
      SELECT 1 FROM principals p
      LEFT JOIN scope_memberships m ON m.principal_id = p.id
      LEFT JOIN scopes s ON s.id = m.scope_id
       WHERE p.id = claimed_principal_id AND p.disabled_at IS NULL
         AND (p.kind = 'service' OR (
           s.kind = 'org' AND s.name = '' AND m.source_kind = 'manual'
           AND m.role = 'admin' AND m.active
         ))
    ) THEN RAISE EXCEPTION 'membership sync identity is not eligible'; END IF;
    RETURN;
  END IF;
  PERFORM continuum_require_trusted_database_identity(claimed_principal_id, 'sync');
END;
$$;
REVOKE ALL ON FUNCTION continuum_require_sync_session(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_rotate_sync_database_identity(
  authorization_principal_id UUID,
  target_database_role NAME,
  target_service_principal_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(834641726154302120::bigint);
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_database_role) THEN
    RAISE EXCEPTION 'trusted database role does not exist';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM principals p WHERE p.id = target_service_principal_id
      AND p.kind = 'service' AND p.disabled_at IS NULL
  ) THEN RAISE EXCEPTION 'sync identity must be an enabled service principal'; END IF;
  INSERT INTO continuum_trusted_database_identities
    (database_role, principal_id, can_approve, can_sync)
  VALUES (target_database_role, target_service_principal_id, FALSE, TRUE)
  ON CONFLICT (database_role) DO UPDATE SET
    principal_id = EXCLUDED.principal_id, can_approve = FALSE, can_sync = TRUE;
  INSERT INTO audit_log (principal_id, action, metadata)
  VALUES (authorization_principal_id, 'write', jsonb_build_object(
    'operation', 'entra_sync_identity_rotated',
    'database_role', target_database_role::text,
    'service_principal_id', target_service_principal_id));
END;
$$;
REVOKE ALL ON FUNCTION continuum_rotate_sync_database_identity(UUID, NAME, UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_upsert_entra_group_binding(
  authorization_principal_id UUID, group_external_id TEXT, group_display_name TEXT,
  target_scope_id UUID, target_role TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE existed BOOLEAN;
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  SELECT EXISTS(SELECT 1 FROM entra_groups WHERE external_id = group_external_id) INTO existed;
  INSERT INTO continuum_entra_reapproval_requests (external_id, backend_pid, transaction_id)
  VALUES (group_external_id, pg_backend_pid(), txid_current())
  ON CONFLICT (external_id) DO UPDATE SET
    backend_pid = EXCLUDED.backend_pid, transaction_id = EXCLUDED.transaction_id;
  INSERT INTO entra_groups
    (external_id, display_name, scope_id, role, active, approved_by, approved_at,
     deactivated_at, last_seen_at)
  VALUES (group_external_id, group_display_name, target_scope_id, target_role, TRUE,
          authorization_principal_id, now(), NULL, NULL)
  ON CONFLICT (external_id) DO UPDATE SET
    display_name = EXCLUDED.display_name, scope_id = EXCLUDED.scope_id,
    role = EXCLUDED.role, active = TRUE, approved_by = EXCLUDED.approved_by,
    approved_at = now(), approval_revoked_by = NULL, approval_revoked_at = NULL,
    deactivated_at = NULL, quarantined_at = NULL, quarantine_reason = NULL;
  DELETE FROM continuum_entra_reapproval_requests WHERE external_id = group_external_id;
  RETURN existed;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_guard_entra_admin_sources()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  table_owner OID;
  invoking_role NAME := continuum_invoking_database_role();
  trusted_sync BOOLEAN := FALSE;
  has_reapproval BOOLEAN := FALSE;
BEGIN
  SELECT relowner INTO table_owner FROM pg_class WHERE oid = TG_RELID;
  IF invoking_role::regrole = table_owner THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
    JOIN principals p ON p.id = identity.principal_id
     WHERE identity.database_role = invoking_role AND identity.can_sync
       AND p.kind = 'service' AND p.disabled_at IS NULL
  ) INTO trusted_sync;
  IF TG_TABLE_NAME = 'entra_groups' THEN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      SELECT EXISTS (
        SELECT 1 FROM continuum_entra_reapproval_requests request
         WHERE request.external_id = NEW.external_id
           AND request.backend_pid = pg_backend_pid()
           AND request.transaction_id = txid_current()
      ) INTO has_reapproval;
      IF NEW.approved_by IS NOT NULL AND (
           TG_OP = 'INSERT'
           OR OLD.approved_by IS DISTINCT FROM NEW.approved_by
           OR OLD.approved_at IS DISTINCT FROM NEW.approved_at
           OR OLD.scope_id IS DISTINCT FROM NEW.scope_id
           OR OLD.role IS DISTINCT FROM NEW.role
         ) AND NOT has_reapproval THEN
        RAISE EXCEPTION 'Entra binding approvals require the guarded database function';
      END IF;
      IF TG_OP = 'UPDATE' AND (
           (OLD.approval_revoked_at IS NOT NULL AND NEW.approval_revoked_at IS NULL)
           OR (OLD.approval_revoked_by IS NOT NULL AND NEW.approval_revoked_by IS NULL)
           OR (OLD.quarantined_at IS NOT NULL AND NEW.quarantined_at IS NULL)
           OR (OLD.quarantine_reason IS NOT NULL AND NEW.quarantine_reason IS NULL)
         ) AND NOT has_reapproval THEN
        RAISE EXCEPTION 'Entra binding revocation and quarantine clearing requires guarded reapproval';
      END IF;
      IF TG_OP = 'UPDATE' AND NOT OLD.active AND NEW.active
         AND (NOT trusted_sync OR NEW.approval_revoked_at IS NOT NULL
              OR NEW.quarantined_at IS NOT NULL) AND NOT has_reapproval THEN
        RAISE EXCEPTION 'Entra binding reactivation requires trusted sync or guarded reapproval';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'scope_memberships' THEN
    IF TG_OP = 'UPDATE' AND (OLD.source_kind = 'entra' OR NEW.source_kind = 'entra')
       AND (OLD.principal_id IS DISTINCT FROM NEW.principal_id
            OR OLD.source_kind IS DISTINCT FROM NEW.source_kind
            OR OLD.source_id IS DISTINCT FROM NEW.source_id) THEN
      RAISE EXCEPTION 'Entra membership principal and source identity are immutable';
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.source_kind = 'entra' AND NEW.active
       AND (TG_OP = 'INSERT' OR NOT OLD.active OR OLD.role IS DISTINCT FROM NEW.role
            OR OLD.scope_id IS DISTINCT FROM NEW.scope_id) AND NOT trusted_sync THEN
      RAISE EXCEPTION 'Entra membership activation requires trusted sync';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_activate_entra_memberships(
  authorization_principal_id UUID, group_external_id TEXT, member_ids UUID[]
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE changed INTEGER;
BEGIN
  PERFORM continuum_require_sync_session(authorization_principal_id);
  IF EXISTS (
    SELECT 1 FROM unnest(member_ids) member_id
    LEFT JOIN principals p ON p.id = member_id
     WHERE p.id IS NULL OR p.disabled_at IS NOT NULL OR p.kind <> 'user'
  ) THEN RAISE EXCEPTION 'membership sync contains an ineligible principal'; END IF;
  INSERT INTO scope_memberships
    (principal_id, scope_id, role, source_kind, source_id, active, synced_at)
  SELECT member_id, binding.scope_id, binding.role, 'entra', binding.external_id, TRUE, now()
    FROM entra_groups binding CROSS JOIN unnest(member_ids) member_id
   WHERE binding.external_id = group_external_id AND binding.active
     AND binding.approved_by IS NOT NULL AND binding.approval_revoked_at IS NULL
     AND binding.quarantined_at IS NULL
  ON CONFLICT (principal_id, scope_id, source_kind, source_id)
  DO UPDATE SET role = EXCLUDED.role, active = TRUE, deactivated_at = NULL, synced_at = now();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_record_entra_sync_success(
  authorization_principal_id UUID, max_staleness_hours INTEGER
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_sync_session(authorization_principal_id);
  IF max_staleness_hours < 1 OR max_staleness_hours > 168 THEN
    RAISE EXCEPTION 'Entra sync staleness bound is invalid';
  END IF;
  UPDATE entra_sync_state SET last_success_at = now(), last_attempt_at = now(),
    last_failure_at = NULL, last_failure_code = NULL,
    max_staleness = make_interval(hours => max_staleness_hours)
   WHERE singleton;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entra sync freshness state is missing'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_record_entra_sync_success(UUID, INTEGER) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_record_entra_sync_failure(
  authorization_principal_id UUID, failure_code TEXT, max_staleness_hours INTEGER
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_sync_session(authorization_principal_id);
  IF max_staleness_hours < 1 OR max_staleness_hours > 168
     OR failure_code IS NULL OR length(failure_code) > 128 THEN
    RAISE EXCEPTION 'invalid Entra sync failure state';
  END IF;
  UPDATE entra_sync_state SET last_attempt_at = now(), last_failure_at = now(),
    last_failure_code = failure_code,
    max_staleness = make_interval(hours => max_staleness_hours)
   WHERE singleton;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entra sync freshness state is missing'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_record_entra_sync_failure(UUID, TEXT, INTEGER) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_change_manual_org_admin(
  authorization_principal_id UUID, target_principal_id UUID,
  target_role TEXT, target_active BOOLEAN
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE org_scope_id UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(834641726154302120::bigint);
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  IF target_role NOT IN ('reader', 'writer') THEN
    RAISE EXCEPTION 'guarded admin change supports disable or demotion only';
  END IF;
  SELECT s.id INTO STRICT org_scope_id FROM scopes s WHERE s.kind = 'org' AND s.name = '';
  UPDATE scope_memberships SET role = target_role, active = target_active,
         deactivated_at = CASE WHEN target_active THEN NULL ELSE now() END
   WHERE principal_id = target_principal_id AND scope_id = org_scope_id
     AND source_kind = 'manual' AND source_id = 'manual' AND role = 'admin';
  IF NOT FOUND THEN RAISE EXCEPTION 'manual organization administrator not found'; END IF;
  INSERT INTO audit_log (principal_id, action, scope_id, metadata)
  VALUES (authorization_principal_id, 'write', org_scope_id, jsonb_build_object(
    'operation', 'manual_org_admin_changed', 'target_principal_id', target_principal_id,
    'target_role', target_role, 'target_active', target_active));
END;
$$;

CREATE OR REPLACE FUNCTION continuum_takeover_manual_org_admin(
  authorization_principal_id UUID, from_principal_id UUID, to_principal_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE org_scope_id UUID;
BEGIN
  IF from_principal_id = to_principal_id THEN
    RAISE EXCEPTION 'admin takeover requires two principals';
  END IF;
  PERFORM pg_advisory_xact_lock(834641726154302120::bigint);
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  SELECT s.id INTO STRICT org_scope_id FROM scopes s WHERE s.kind = 'org' AND s.name = '';
  IF NOT EXISTS (
    SELECT 1 FROM scope_memberships m WHERE m.principal_id = from_principal_id
      AND m.scope_id = org_scope_id AND m.source_kind = 'manual'
      AND m.source_id = 'manual' AND m.role = 'admin' AND m.active
  ) THEN RAISE EXCEPTION 'takeover source administrator not found'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM principals p WHERE p.id = to_principal_id AND p.disabled_at IS NULL
  ) THEN RAISE EXCEPTION 'takeover target principal is not active'; END IF;
  INSERT INTO scope_memberships
    (principal_id, scope_id, role, source_kind, source_id, active, deactivated_at)
  VALUES (to_principal_id, org_scope_id, 'admin', 'manual', 'manual', TRUE, NULL)
  ON CONFLICT (principal_id, scope_id, source_kind, source_id)
  DO UPDATE SET role = 'admin', active = TRUE, deactivated_at = NULL;
  UPDATE scope_memberships SET role = 'writer', active = TRUE, deactivated_at = NULL
   WHERE principal_id = from_principal_id AND scope_id = org_scope_id
     AND source_kind = 'manual' AND source_id = 'manual';
  INSERT INTO audit_log (principal_id, action, scope_id, metadata)
  VALUES (authorization_principal_id, 'write', org_scope_id, jsonb_build_object(
    'operation', 'manual_org_admin_takeover',
    'from_principal_id', from_principal_id, 'to_principal_id', to_principal_id));
END;
$$;

CREATE FUNCTION continuum_operator_write_offboarding_run(
  target_principal_id UUID, authorization_principal_id UUID,
  command TEXT, details JSONB DEFAULT '{}'::jsonb
) RETURNS SETOF principal_offboarding_runs LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  RETURN QUERY SELECT * FROM continuum_write_offboarding_run(
    target_principal_id, authorization_principal_id, command, details);
END;
$$;

CREATE FUNCTION continuum_operator_start_offboarding_run(
  target_run_id UUID, authorization_principal_id UUID, start_evidence JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  RETURN continuum_start_offboarding_run(target_run_id, authorization_principal_id, start_evidence);
END;
$$;

CREATE FUNCTION continuum_operator_complete_offboarding_run(
  target_run_id UUID, authorization_principal_id UUID, completion_evidence JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  RETURN continuum_complete_offboarding_run(
    target_run_id, authorization_principal_id, completion_evidence);
END;
$$;

CREATE FUNCTION continuum_operator_resume_offboarding_run(
  target_run_id UUID, authorization_principal_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  RETURN continuum_resume_offboarding_run(target_run_id, authorization_principal_id);
END;
$$;

CREATE FUNCTION continuum_operator_restart_offboarding_run(
  target_principal_id UUID, authorization_principal_id UUID, details JSONB
) RETURNS SETOF principal_offboarding_runs LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  RETURN QUERY SELECT * FROM continuum_restart_offboarding_run(
    target_principal_id, authorization_principal_id, details);
END;
$$;

CREATE FUNCTION continuum_operator_redact_offboarding_audit(
  target_principal_id UUID, authorization_principal_id UUID, target_ids BIGINT[]
) RETURNS TABLE(redacted_rows INTEGER, redacted_queries INTEGER)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  RETURN QUERY SELECT * FROM continuum_redact_offboarding_audit(
    target_principal_id, authorization_principal_id, target_ids);
END;
$$;

CREATE FUNCTION continuum_operator_apply_audit_retention(
  authorization_principal_id UUID, caller_cutoff TIMESTAMPTZ, retention_days INTEGER,
  retention_run_id UUID, batch_number INTEGER, expected_rows JSONB,
  export_mode TEXT, export_sha256 TEXT
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  RETURN continuum_apply_audit_retention(
    authorization_principal_id, caller_cutoff, retention_days, retention_run_id,
    batch_number, expected_rows, export_mode, export_sha256);
END;
$$;

CREATE FUNCTION continuum_operator_reactivate_principal(
  target_principal_id UUID, authorization_principal_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  RETURN continuum_reactivate_principal(target_principal_id, authorization_principal_id);
END;
$$;

CREATE FUNCTION continuum_operator_record_offboarding_event(target_run_id UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE authorization_principal_id UUID;
BEGIN
  SELECT event.finalized_by INTO authorization_principal_id
    FROM principal_offboarding_run_events event
   WHERE event.run_id = target_run_id AND event.phase = 'completed';
  IF authorization_principal_id IS NULL THEN
    RAISE EXCEPTION 'completed offboarding evidence is required';
  END IF;
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  RETURN continuum_record_offboarding_event(target_run_id);
END;
$$;

REVOKE ALL ON FUNCTION continuum_operator_write_offboarding_run(UUID, UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION continuum_operator_start_offboarding_run(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION continuum_operator_complete_offboarding_run(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION continuum_operator_resume_offboarding_run(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION continuum_operator_restart_offboarding_run(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION continuum_operator_redact_offboarding_audit(UUID, UUID, BIGINT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION continuum_operator_apply_audit_retention(UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION continuum_operator_reactivate_principal(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION continuum_operator_record_offboarding_event(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_cleanup_legacy_offboarding_audit_requests(batch_size INTEGER)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE changed INTEGER;
BEGIN
  IF batch_size < 1 OR batch_size > 5000 THEN
    RAISE EXCEPTION 'legacy cleanup batch size must be between 1 and 5000';
  END IF;
  WITH targets AS (
    SELECT principal_id, request_id FROM principal_offboarding_audit_requests
     ORDER BY principal_id, request_id LIMIT batch_size FOR UPDATE SKIP LOCKED
  )
  DELETE FROM principal_offboarding_audit_requests legacy USING targets
   WHERE legacy.principal_id = targets.principal_id AND legacy.request_id = targets.request_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$;
REVOKE ALL ON FUNCTION continuum_cleanup_legacy_offboarding_audit_requests(INTEGER) FROM PUBLIC;

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments
      FROM pg_proc p WHERE p.pronamespace = quote_ident(current_schema())::regnamespace
       AND p.proname = ANY(ARRAY[
        'continuum_require_trusted_database_identity',
        'continuum_register_trusted_database_identity',
        'continuum_require_sync_session', 'continuum_rotate_sync_database_identity',
        'continuum_upsert_entra_group_binding', 'continuum_guard_entra_admin_sources',
        'continuum_activate_entra_memberships', 'continuum_record_entra_sync_success',
        'continuum_record_entra_sync_failure', 'continuum_change_manual_org_admin',
        'continuum_takeover_manual_org_admin',
        'continuum_operator_write_offboarding_run',
        'continuum_operator_start_offboarding_run',
        'continuum_operator_complete_offboarding_run',
        'continuum_operator_resume_offboarding_run',
        'continuum_operator_restart_offboarding_run',
        'continuum_operator_redact_offboarding_audit',
        'continuum_operator_apply_audit_retention',
        'continuum_operator_reactivate_principal',
        'continuum_operator_record_offboarding_event',
        'continuum_cleanup_legacy_offboarding_audit_requests'
       ])
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, %I, pg_temp',
      schema_name, function_record.proname, function_record.arguments, schema_name);
  END LOOP;
END;
$harden$;
