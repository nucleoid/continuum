-- Bind privileged operator and sync actions to database-verifiable roles.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS continuum_trusted_database_identities (
  database_role NAME PRIMARY KEY,
  principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  can_approve BOOLEAN NOT NULL DEFAULT FALSE,
  can_sync BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (can_approve OR can_sync)
);
REVOKE ALL ON TABLE continuum_trusted_database_identities FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_invoking_database_role()
RETURNS NAME LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT CASE
    WHEN current_setting('role', TRUE) IS NULL
      OR current_setting('role', TRUE) IN ('', 'none')
      THEN session_user::name
    ELSE current_setting('role', TRUE)::name
  END
$$;
REVOKE ALL ON FUNCTION continuum_invoking_database_role() FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_register_trusted_database_identity(
  target_database_role NAME,
  target_principal_id UUID,
  approve_capability BOOLEAN,
  sync_capability BOOLEAN
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT (approve_capability OR sync_capability) THEN
    RAISE EXCEPTION 'at least one trusted database capability is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_database_role) THEN
    RAISE EXCEPTION 'trusted database role does not exist';
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
REVOKE ALL ON FUNCTION continuum_register_trusted_database_identity(
  NAME, UUID, BOOLEAN, BOOLEAN
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_require_trusted_database_identity(
  claimed_principal_id UUID,
  required_capability TEXT
) RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  invoking_role NAME := continuum_invoking_database_role();
  owner_role NAME;
BEGIN
  SELECT pg_get_userbyid(relowner)::name INTO owner_role
    FROM pg_class WHERE oid = 'principals'::regclass;
  IF invoking_role = owner_role THEN RETURN; END IF;
  IF required_capability NOT IN ('approve', 'sync') OR NOT EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
     WHERE identity.database_role = invoking_role
       AND identity.principal_id = claimed_principal_id
       AND CASE required_capability
             WHEN 'approve' THEN identity.can_approve
             WHEN 'sync' THEN identity.can_sync
             ELSE FALSE
           END
  ) THEN
    RAISE EXCEPTION 'operation requires a DB-bound trusted % identity', required_capability;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_require_trusted_database_identity(UUID, TEXT) FROM PUBLIC;

-- Audit insertion takes key-share locks while checking offboarded principals.
-- Run that existing guard as its hardened owner instead of granting the sync
-- role unrelated UPDATE authority on principal rows.
ALTER FUNCTION continuum_reject_offboarded_principal_audit() SECURITY DEFINER;
ALTER FUNCTION continuum_require_open_entra_binding_scope() SECURITY DEFINER;

CREATE OR REPLACE FUNCTION continuum_create_user_scope_approval(
  authorization_principal_id UUID,
  target_principal_id UUID,
  target_scope_id UUID,
  acknowledged_ids UUID[],
  evidence_hash TEXT
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE approval_id BIGINT;
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  IF NOT EXISTS (
    SELECT 1 FROM principals p
    JOIN scope_memberships m ON m.principal_id = p.id
    JOIN scopes s ON s.id = m.scope_id
    WHERE p.id = authorization_principal_id AND p.disabled_at IS NULL
      AND s.kind = 'org' AND s.name = '' AND m.active AND m.role = 'admin'
      AND m.source_kind = 'manual'
  ) THEN RAISE EXCEPTION 'approval requires an effective manual org administrator'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM principal_user_scopes mapping
     WHERE mapping.principal_id = target_principal_id
       AND mapping.scope_id = target_scope_id
       AND mapping.acknowledged_principal_ids = acknowledged_ids
       AND mapping.acknowledged_evidence_hash = evidence_hash
  ) THEN RAISE EXCEPTION 'approval evidence must match the locked owner mapping'; END IF;
  INSERT INTO principal_user_scope_approvals
    (principal_id, scope_id, approved_by, acknowledged_principal_ids,
     acknowledged_evidence_hash)
  VALUES (target_principal_id, target_scope_id, authorization_principal_id,
          acknowledged_ids, evidence_hash)
  RETURNING id INTO approval_id;
  RETURN approval_id;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_upsert_entra_group_binding(
  authorization_principal_id UUID, group_external_id TEXT, group_display_name TEXT,
  target_scope_id UUID, target_role TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE existed BOOLEAN;
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  IF NOT EXISTS (
    SELECT 1 FROM principals p
    JOIN scope_memberships m ON m.principal_id = p.id
    JOIN scopes s ON s.id = m.scope_id
    WHERE p.id = authorization_principal_id AND p.disabled_at IS NULL
      AND s.kind = 'org' AND s.name = '' AND m.active AND m.role = 'admin'
      AND m.source_kind = 'manual'
  ) THEN RAISE EXCEPTION 'binding approval requires a manual org administrator'; END IF;
  SELECT EXISTS(SELECT 1 FROM entra_groups WHERE external_id = group_external_id)
    INTO existed;
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
  RETURN existed;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_activate_entra_memberships(
  authorization_principal_id UUID, group_external_id TEXT, member_ids UUID[]
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE changed INTEGER;
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'sync');
  IF NOT EXISTS (
    SELECT 1 FROM principals p
    JOIN scope_memberships m ON m.principal_id = p.id
    JOIN scopes s ON s.id = m.scope_id
    WHERE p.id = authorization_principal_id AND p.disabled_at IS NULL
      AND s.kind = 'org' AND s.name = '' AND m.active AND m.role = 'admin'
      AND m.source_kind = 'manual'
  ) THEN RAISE EXCEPTION 'membership sync requires a manual org administrator'; END IF;
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
  DO UPDATE SET role = EXCLUDED.role, active = TRUE,
                deactivated_at = NULL, synced_at = now();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_guard_entra_admin_sources()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE table_owner OID; invoking_role NAME := continuum_invoking_database_role();
  trusted_sync BOOLEAN := FALSE;
BEGIN
  SELECT relowner INTO table_owner FROM pg_class WHERE oid = TG_RELID;
  IF invoking_role::regrole = table_owner THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_TABLE_NAME = 'entra_groups' THEN
    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.approved_by IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM continuum_trusted_database_identities identity
         WHERE identity.database_role = invoking_role AND identity.can_sync
      ) INTO trusted_sync;
      IF TG_OP = 'INSERT'
         OR OLD.approved_by IS DISTINCT FROM NEW.approved_by
         OR OLD.approved_at IS DISTINCT FROM NEW.approved_at
         OR OLD.scope_id IS DISTINCT FROM NEW.scope_id
         OR OLD.role IS DISTINCT FROM NEW.role THEN
        RAISE EXCEPTION 'Entra binding approvals require the guarded database function';
      END IF;
      IF NOT OLD.active AND NEW.active
         AND (NOT trusted_sync OR NEW.approval_revoked_at IS NOT NULL
              OR NEW.quarantined_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Entra binding reactivation requires trusted sync';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'scope_memberships' THEN
    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.source_kind = 'entra' AND NEW.active
       AND (TG_OP = 'INSERT' OR NOT OLD.active OR OLD.role IS DISTINCT FROM NEW.role
            OR OLD.scope_id IS DISTINCT FROM NEW.scope_id) THEN
      SELECT EXISTS (
        SELECT 1 FROM continuum_trusted_database_identities identity
         WHERE identity.database_role = invoking_role AND identity.can_sync
      ) INTO trusted_sync;
      IF NOT trusted_sync THEN
        RAISE EXCEPTION 'Entra membership activation requires trusted sync';
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_guard_manual_org_admin_membership()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE table_owner OID; touches_admin BOOLEAN := FALSE;
BEGIN
  SELECT relowner INTO table_owner FROM pg_class WHERE oid = 'scope_memberships'::regclass;
  IF current_user::regrole = table_owner THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    touches_admin := OLD.source_kind = 'manual' AND OLD.role = 'admin' AND EXISTS (
      SELECT 1 FROM scopes s WHERE s.id = OLD.scope_id AND s.kind = 'org' AND s.name = ''
    );
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    touches_admin := touches_admin OR (
      NEW.source_kind = 'manual' AND NEW.role = 'admin' AND NEW.active AND EXISTS (
        SELECT 1 FROM scopes s WHERE s.id = NEW.scope_id AND s.kind = 'org' AND s.name = ''
      )
    );
  END IF;
  IF touches_admin THEN
    RAISE EXCEPTION 'manual organization administrator changes require the guarded operator path';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_change_manual_org_admin(
  authorization_principal_id UUID, target_principal_id UUID,
  target_role TEXT, target_active BOOLEAN
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE org_scope_id UUID;
BEGIN
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
REVOKE ALL ON FUNCTION continuum_change_manual_org_admin(UUID, UUID, TEXT, BOOLEAN) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_takeover_manual_org_admin(
  authorization_principal_id UUID, from_principal_id UUID, to_principal_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE org_scope_id UUID;
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  IF from_principal_id = to_principal_id THEN RAISE EXCEPTION 'admin takeover requires two principals'; END IF;
  SELECT s.id INTO STRICT org_scope_id FROM scopes s WHERE s.kind = 'org' AND s.name = '';
  IF NOT EXISTS (
    SELECT 1 FROM scope_memberships m JOIN principals p ON p.id = m.principal_id
     WHERE m.principal_id = authorization_principal_id AND m.scope_id = org_scope_id
       AND m.source_kind = 'manual' AND m.source_id = 'manual'
       AND m.role = 'admin' AND m.active AND p.disabled_at IS NULL
  ) THEN RAISE EXCEPTION 'admin takeover requires an effective manual org administrator'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM scope_memberships m WHERE m.principal_id = from_principal_id
      AND m.scope_id = org_scope_id AND m.source_kind = 'manual'
      AND m.source_id = 'manual' AND m.role = 'admin' AND m.active
  ) THEN RAISE EXCEPTION 'takeover source administrator not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM principals p WHERE p.id = to_principal_id AND p.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'takeover target principal is not active';
  END IF;
  PERFORM pg_advisory_xact_lock(834641726154302120::bigint);
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
REVOKE ALL ON FUNCTION continuum_takeover_manual_org_admin(UUID, UUID, UUID) FROM PUBLIC;

-- Legacy request mappings are no longer authority or erasure selectors. They
-- are retained for the bounded, operator-controlled cleanup added by 0047 so
-- this catalog migration does not perform an unbounded data rewrite.
REVOKE ALL ON TABLE principal_offboarding_audit_requests FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_redact_offboarding_audit(
  target_principal_id UUID, authorization_principal_id UUID, target_ids BIGINT[]
) RETURNS TABLE(redacted_rows INTEGER, redacted_queries INTEGER)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE target_run principal_offboarding_runs%ROWTYPE; query_count INTEGER; changed_count INTEGER;
BEGIN
  IF COALESCE(cardinality(target_ids), 0) = 0 THEN RETURN QUERY SELECT 0, 0; RETURN; END IF;
  IF cardinality(target_ids) > 5000
     OR (SELECT count(*) FROM unnest(target_ids) value)
        <> (SELECT count(DISTINCT value) FROM unnest(target_ids) value) THEN
    RAISE EXCEPTION 'invalid offboarding audit redaction batch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM principals p JOIN scope_memberships m ON m.principal_id = p.id
    JOIN scopes s ON s.id = m.scope_id
    WHERE p.id = authorization_principal_id AND p.disabled_at IS NULL
      AND s.kind = 'org' AND s.name = '' AND m.active AND m.role = 'admin'
      AND continuum_membership_is_effective(m.active, m.source_kind)
  ) THEN RAISE EXCEPTION 'offboarding audit redaction requires an effective org administrator'; END IF;
  SELECT run.* INTO target_run FROM principal_offboarding_runs run
   WHERE run.principal_id = target_principal_id AND run.completed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR target_run.audit_fence_id IS NULL THEN RAISE EXCEPTION 'active fenced offboarding run not found'; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(target_ids) requested(id)
    LEFT JOIN audit_log audit ON audit.id = requested.id
     WHERE audit.id IS NULL OR audit.id > target_run.audit_fence_id
        OR COALESCE(audit.metadata->>'operation', '') = ANY(ARRAY[
          'principal_user_scope_mapped', 'principal_user_scope_acknowledgement_replaced',
          'principal_memory_erased', 'principal_offboarded', 'principal_offboarding_repaired'
        ]::text[])
        OR NOT (
          COALESCE(audit.principal_id = target_run.principal_id, FALSE)
          OR COALESCE(audit.scope_id = target_run.scope_id, FALSE)
          OR EXISTS (SELECT 1 FROM audit_log_offboarding_scopes selector
            WHERE selector.audit_id = audit.id AND selector.scope_id = target_run.scope_id)
        )
  ) THEN RAISE EXCEPTION 'audit row is outside the active offboarding run'; END IF;
  SELECT count(*)::integer INTO query_count FROM audit_log
   WHERE id = ANY(target_ids) AND query IS NOT NULL;
  UPDATE audit_log audit SET query = NULL,
         metadata = continuum_offboarding_expected_audit_metadata(audit.metadata)
   WHERE audit.id = ANY(target_ids);
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN QUERY SELECT changed_count, query_count;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_protect_offboarded_audit_tombstone()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE linked_to_offboarded BOOLEAN := FALSE;
BEGIN
  IF NEW.principal_id IS NOT DISTINCT FROM OLD.principal_id
     AND NEW.scope_id IS NOT DISTINCT FROM OLD.scope_id
     AND NEW.memory_id IS NOT DISTINCT FROM OLD.memory_id
     AND COALESCE(OLD.metadata->>'operation', '') <> ALL(ARRAY[
       'principal_user_scope_mapped', 'principal_user_scope_acknowledgement_replaced',
       'principal_memory_erased', 'principal_offboarded', 'principal_offboarding_repaired'
     ]::text[])
     AND NEW.query IS NULL AND NEW.metadata IS NOT DISTINCT FROM
       continuum_offboarding_expected_audit_metadata(OLD.metadata) THEN RETURN NEW; END IF;
  SELECT TRUE INTO linked_to_offboarded FROM principals p
   WHERE p.id IN (OLD.principal_id, NEW.principal_id) AND p.offboarded_at IS NOT NULL
   FOR KEY SHARE OF p NOWAIT;
  IF NOT FOUND THEN
    SELECT TRUE INTO linked_to_offboarded FROM principal_user_scopes mapping
    JOIN principals p ON p.id = mapping.principal_id
     WHERE p.offboarded_at IS NOT NULL AND (
       mapping.scope_id = OLD.scope_id OR mapping.scope_id = NEW.scope_id
       OR EXISTS (SELECT 1 FROM memories memory
         WHERE memory.id IN (OLD.memory_id, NEW.memory_id) AND memory.scope_id = mapping.scope_id)
       OR EXISTS (SELECT 1 FROM audit_log_offboarding_scopes selector
         WHERE selector.audit_id = NEW.id AND selector.scope_id = mapping.scope_id)
     ) FOR KEY SHARE OF p NOWAIT;
  END IF;
  IF FOUND OR linked_to_offboarded THEN
    IF NEW.principal_id IS DISTINCT FROM OLD.principal_id
       OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
       OR NEW.memory_id IS DISTINCT FROM OLD.memory_id THEN
      RAISE EXCEPTION 'offboarded audit linkage is immutable';
    END IF;
    IF COALESCE(OLD.metadata->>'operation', '') = ANY(ARRAY[
      'principal_user_scope_mapped', 'principal_user_scope_acknowledgement_replaced',
      'principal_memory_erased', 'principal_offboarded', 'principal_offboarding_repaired'
    ]::text[]) THEN
      IF NEW.query IS DISTINCT FROM OLD.query OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN
        RAISE EXCEPTION 'preserved offboarding audit evidence is immutable';
      END IF;
    ELSIF NEW.query IS NOT NULL OR NEW.metadata IS DISTINCT FROM
          continuum_offboarding_expected_audit_metadata(OLD.metadata) THEN
      RAISE EXCEPTION 'offboarded audit tombstone is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_apply_audit_retention(
  authorization_principal_id UUID, caller_cutoff TIMESTAMPTZ, retention_days INTEGER,
  retention_run_id UUID, batch_number INTEGER, expected_rows JSONB,
  export_mode TEXT, export_sha256 TEXT
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE minimum_days INTEGER; enforced_cutoff TIMESTAMPTZ;
BEGIN
  SELECT minimum_retention_days INTO STRICT minimum_days
    FROM continuum_audit_retention_policy WHERE singleton FOR SHARE;
  IF retention_days < minimum_days THEN RAISE EXCEPTION 'audit retention is below the owner-controlled minimum policy'; END IF;
  enforced_cutoff := transaction_timestamp() - (retention_days * interval '24 hours');
  IF caller_cutoff > enforced_cutoff THEN RAISE EXCEPTION 'audit retention cutoff exceeds the database-enforced cutoff'; END IF;
  RETURN continuum_apply_audit_retention_internal_v44(
    authorization_principal_id, LEAST(caller_cutoff, enforced_cutoff), retention_days,
    retention_run_id, batch_number, expected_rows, export_mode, export_sha256
  );
END;
$$;

CREATE OR REPLACE FUNCTION continuum_audit_retention_minimum_days()
RETURNS INTEGER LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT minimum_retention_days FROM continuum_audit_retention_policy WHERE singleton
$$;
REVOKE ALL ON FUNCTION continuum_audit_retention_minimum_days() FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_resume_offboarding_run(
  target_run_id UUID, authorization_principal_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE target_run principal_offboarding_runs%ROWTYPE; prior_actor UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM principals p JOIN scope_memberships m ON m.principal_id = p.id
    JOIN scopes s ON s.id = m.scope_id
    WHERE p.id = authorization_principal_id AND p.disabled_at IS NULL
      AND s.kind = 'org' AND s.name = '' AND m.active AND m.role = 'admin'
      AND continuum_membership_is_effective(m.active, m.source_kind)
  ) THEN RAISE EXCEPTION 'offboarding resume requires an effective org administrator'; END IF;
  SELECT * INTO target_run FROM principal_offboarding_runs
   WHERE run_id = target_run_id AND completed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'incomplete offboarding run not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM principal_offboarding_run_events e
    WHERE e.run_id = target_run_id AND e.phase = 'started') THEN
    RAISE EXCEPTION 'offboarding resume requires immutable start evidence';
  END IF;
  SELECT COALESCE((SELECT takeover.to_actor FROM principal_offboarding_takeover_events takeover
      WHERE takeover.run_id = target_run_id ORDER BY takeover.id DESC LIMIT 1),
    target_run.initiated_by) INTO prior_actor;
  IF prior_actor IS NULL THEN RAISE EXCEPTION 'offboarding resume requires immutable start evidence'; END IF;
  IF prior_actor <> authorization_principal_id THEN
    INSERT INTO principal_offboarding_takeover_events
      (run_id, principal_id, scope_id, from_actor, to_actor, evidence)
    VALUES (target_run.run_id, target_run.principal_id, target_run.scope_id,
      prior_actor, authorization_principal_id,
      jsonb_build_object('authorization_basis', 'current_effective_org_admin'));
    INSERT INTO principal_offboarding_run_events
      (run_id, principal_id, scope_id, phase, initiated_by, finalized_by,
       approval_id, approval_evidence_hash, evidence)
    VALUES (target_run.run_id, target_run.principal_id, target_run.scope_id, 'resumed',
      target_run.initiated_by, authorization_principal_id, target_run.approval_id,
      target_run.approval_evidence_hash,
      jsonb_build_object('resumed_by', authorization_principal_id,
        'takeover_from', prior_actor, 'authorization_basis', 'current_effective_org_admin'))
    ON CONFLICT (run_id, phase) DO NOTHING;
  END IF;
  RETURN TRUE;
END;
$$;

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments
      FROM pg_proc p WHERE p.pronamespace = current_schema()::regnamespace
       AND p.proname = ANY(ARRAY[
        'continuum_invoking_database_role', 'continuum_register_trusted_database_identity',
        'continuum_require_trusted_database_identity', 'continuum_create_user_scope_approval',
        'continuum_upsert_entra_group_binding', 'continuum_activate_entra_memberships',
        'continuum_guard_entra_admin_sources', 'continuum_guard_manual_org_admin_membership',
        'continuum_change_manual_org_admin', 'continuum_takeover_manual_org_admin',
        'continuum_redact_offboarding_audit', 'continuum_protect_offboarded_audit_tombstone',
        'continuum_apply_audit_retention', 'continuum_audit_retention_minimum_days',
        'continuum_resume_offboarding_run', 'continuum_reject_offboarded_principal_audit',
        'continuum_require_open_entra_binding_scope'
       ])
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, %I, pg_temp',
      schema_name, function_record.proname, function_record.arguments, schema_name);
  END LOOP;
END;
$harden$;
