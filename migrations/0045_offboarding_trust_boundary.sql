-- Close the remaining exact-head trust boundaries without rewriting public ancestry.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE continuum_audit_retention_policy (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  minimum_retention_days INTEGER NOT NULL CHECK (minimum_retention_days >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO continuum_audit_retention_policy (singleton, minimum_retention_days)
VALUES (TRUE, 30);
REVOKE ALL ON TABLE continuum_audit_retention_policy FROM PUBLIC;

DO $rename$
BEGIN
  IF to_regprocedure(
    'continuum_apply_audit_retention(uuid,timestamptz,integer,uuid,integer,jsonb,text,text)'
  ) IS NOT NULL THEN
    ALTER FUNCTION continuum_apply_audit_retention(
      UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT
    ) RENAME TO continuum_apply_audit_retention_internal_v44;
  ELSIF to_regprocedure(
    'continuum_apply_audit_retention_internal_v44(uuid,timestamptz,integer,uuid,integer,jsonb,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'audit retention implementation is missing';
  END IF;
END;
$rename$;

DO $revoke$
DECLARE grant_record RECORD;
BEGIN
  FOR grant_record IN
    SELECT DISTINCT grantee
      FROM information_schema.routine_privileges
     WHERE specific_schema = current_schema()
       AND routine_name = 'continuum_apply_audit_retention_internal_v44'
       AND privilege_type = 'EXECUTE'
       AND grantee <> current_user
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %I.%I(UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT) FROM %I',
      current_schema(), 'continuum_apply_audit_retention_internal_v44', grant_record.grantee
    );
  END LOOP;
  FOR grant_record IN
    SELECT DISTINCT grantee
      FROM information_schema.routine_privileges
     WHERE specific_schema = current_schema()
       AND routine_name = 'continuum_write_offboarding_run_internal'
       AND privilege_type = 'EXECUTE'
       AND grantee <> current_user
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %I.continuum_write_offboarding_run_internal(UUID, UUID, TEXT, JSONB) FROM %I',
      current_schema(), grant_record.grantee
    );
  END LOOP;
END;
$revoke$;
REVOKE ALL ON FUNCTION continuum_apply_audit_retention_internal_v44(
  UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION continuum_write_offboarding_run_internal(UUID, UUID, TEXT, JSONB)
  FROM PUBLIC;

CREATE FUNCTION continuum_apply_audit_retention(
  authorization_principal_id UUID,
  caller_cutoff TIMESTAMPTZ,
  retention_days INTEGER,
  retention_run_id UUID,
  batch_number INTEGER,
  expected_rows JSONB,
  export_mode TEXT,
  export_sha256 TEXT
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  minimum_days INTEGER;
  enforced_cutoff TIMESTAMPTZ;
BEGIN
  SELECT minimum_retention_days INTO STRICT minimum_days
    FROM continuum_audit_retention_policy WHERE singleton FOR SHARE;
  IF retention_days < minimum_days THEN
    RAISE EXCEPTION 'audit retention is below the owner-controlled minimum policy';
  END IF;
  enforced_cutoff := transaction_timestamp() - (retention_days * interval '24 hours');
  IF caller_cutoff > enforced_cutoff THEN
    RAISE EXCEPTION 'audit retention cutoff exceeds the database-enforced cutoff';
  END IF;
  RETURN continuum_apply_audit_retention_internal_v44(
    authorization_principal_id, enforced_cutoff, retention_days, retention_run_id,
    batch_number, expected_rows, export_mode, export_sha256
  );
END;
$$;
REVOKE ALL ON FUNCTION continuum_apply_audit_retention(
  UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT
) FROM PUBLIC;

CREATE FUNCTION continuum_create_user_scope_approval(
  authorization_principal_id UUID,
  target_principal_id UUID,
  target_scope_id UUID,
  acknowledged_ids UUID[],
  evidence_hash TEXT
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE approval_id BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM principals p
    JOIN scope_memberships m ON m.principal_id = p.id
    JOIN scopes s ON s.id = m.scope_id
    WHERE p.id = authorization_principal_id AND p.disabled_at IS NULL
      AND s.kind = 'org' AND s.name = '' AND m.active AND m.role = 'admin'
      AND continuum_membership_is_effective(m.active, m.source_kind)
  ) THEN RAISE EXCEPTION 'approval requires an effective org administrator'; END IF;
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
REVOKE ALL ON FUNCTION continuum_create_user_scope_approval(
  UUID, UUID, UUID, UUID[], TEXT
) FROM PUBLIC;

CREATE FUNCTION continuum_upsert_entra_group_binding(
  authorization_principal_id UUID, group_external_id TEXT, group_display_name TEXT,
  target_scope_id UUID, target_role TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE existed BOOLEAN;
BEGIN
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
REVOKE ALL ON FUNCTION continuum_upsert_entra_group_binding(UUID, TEXT, TEXT, UUID, TEXT)
  FROM PUBLIC;

CREATE FUNCTION continuum_activate_entra_memberships(
  authorization_principal_id UUID, group_external_id TEXT, member_ids UUID[]
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE changed INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM principals p
    JOIN scope_memberships m ON m.principal_id = p.id
    JOIN scopes s ON s.id = m.scope_id
    WHERE p.id = authorization_principal_id AND p.disabled_at IS NULL
      AND s.kind = 'org' AND s.name = '' AND m.active AND m.role = 'admin'
      AND m.source_kind = 'manual'
  ) THEN RAISE EXCEPTION 'membership sync requires a manual org administrator'; END IF;
  INSERT INTO scope_memberships
    (principal_id, scope_id, role, source_kind, source_id, active, synced_at)
  SELECT member_id, binding.scope_id, binding.role, 'entra', binding.external_id, TRUE, now()
    FROM entra_groups binding CROSS JOIN unnest(member_ids) member_id
   WHERE binding.external_id = group_external_id AND binding.active
     AND binding.approved_by IS NOT NULL AND binding.approval_revoked_at IS NULL
  ON CONFLICT (principal_id, scope_id, source_kind, source_id)
  DO UPDATE SET role = EXCLUDED.role, active = TRUE,
                deactivated_at = NULL, synced_at = now();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$;
REVOKE ALL ON FUNCTION continuum_activate_entra_memberships(UUID, TEXT, UUID[]) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_guard_manual_org_admin_membership()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE table_owner OID;
BEGIN
  SELECT relowner INTO table_owner FROM pg_class WHERE oid = 'scope_memberships'::regclass;
  IF current_user::regrole = table_owner THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.source_kind = 'manual'
     AND NEW.role = 'admin' AND NEW.active
     AND (TG_OP = 'INSERT' OR OLD.role <> 'admin' OR NOT OLD.active)
     AND EXISTS (SELECT 1 FROM scopes s WHERE s.id = NEW.scope_id
                  AND s.kind = 'org' AND s.name = '') THEN
    RAISE EXCEPTION 'manual organization administrator changes require the guarded operator path';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE FUNCTION continuum_guard_entra_admin_sources()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE table_owner OID;
BEGIN
  SELECT relowner INTO table_owner FROM pg_class WHERE oid = TG_RELID;
  IF current_user::regrole = table_owner THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_TABLE_NAME = 'entra_groups' AND TG_OP IN ('INSERT', 'UPDATE')
     AND to_jsonb(NEW)->>'approved_by' IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR to_jsonb(OLD)->>'approved_by' IS DISTINCT FROM to_jsonb(NEW)->>'approved_by'
          OR to_jsonb(OLD)->>'approved_at' IS DISTINCT FROM to_jsonb(NEW)->>'approved_at'
          OR to_jsonb(OLD)->>'scope_id' IS DISTINCT FROM to_jsonb(NEW)->>'scope_id'
          OR to_jsonb(OLD)->>'role' IS DISTINCT FROM to_jsonb(NEW)->>'role'
          OR ((to_jsonb(OLD)->>'active')::boolean = FALSE
              AND (to_jsonb(NEW)->>'active')::boolean = TRUE)) THEN
    RAISE EXCEPTION 'Entra binding approvals require the guarded database function';
  END IF;
  IF TG_TABLE_NAME = 'scope_memberships' AND TG_OP IN ('INSERT', 'UPDATE')
     AND to_jsonb(NEW)->>'source_kind' = 'entra'
     AND to_jsonb(NEW)->>'role' = 'admin'
     AND (to_jsonb(NEW)->>'active')::boolean
     AND EXISTS (SELECT 1 FROM scopes s WHERE s.id = (to_jsonb(NEW)->>'scope_id')::uuid
                  AND s.kind = 'org' AND s.name = '')
     AND (TG_OP = 'INSERT' OR to_jsonb(OLD)->>'role' <> 'admin'
          OR NOT (to_jsonb(OLD)->>'active')::boolean) THEN
    RAISE EXCEPTION 'Entra organization administrator activation requires trusted sync';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION continuum_guard_entra_admin_sources() FROM PUBLIC;
CREATE TRIGGER guard_entra_binding_approvals
BEFORE INSERT OR UPDATE ON entra_groups FOR EACH ROW
EXECUTE FUNCTION continuum_guard_entra_admin_sources();
CREATE TRIGGER guard_entra_org_admin_memberships
BEFORE INSERT OR UPDATE ON scope_memberships FOR EACH ROW
EXECUTE FUNCTION continuum_guard_entra_admin_sources();

CREATE OR REPLACE FUNCTION continuum_offboarding_actual_state_is_erased(target_run_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH target_run AS NOT MATERIALIZED (
    SELECT run.* FROM principal_offboarding_runs run WHERE run.run_id = target_run_id
  ), target_audit AS (
    SELECT audit.id FROM target_run run CROSS JOIN LATERAL (
      SELECT candidate.id FROM audit_log candidate
       WHERE candidate.principal_id = run.principal_id
         AND candidate.id <= run.audit_fence_id
       ORDER BY candidate.principal_id, candidate.id OFFSET 0
    ) audit
    UNION
    SELECT audit.id FROM target_run run CROSS JOIN LATERAL (
      SELECT candidate.id FROM audit_log candidate
       WHERE candidate.scope_id = run.scope_id AND candidate.id <= run.audit_fence_id
       ORDER BY candidate.scope_id, candidate.id OFFSET 0
    ) audit
    UNION
    SELECT audit.id FROM target_run run CROSS JOIN LATERAL (
      SELECT candidate.id FROM audit_log_offboarding_scopes selector
      JOIN audit_log candidate ON candidate.id = selector.audit_id
                              AND candidate.id <= run.audit_fence_id
       WHERE selector.scope_id = run.scope_id AND selector.selector_kind = 'memory'
       ORDER BY selector.audit_id OFFSET 0
    ) audit
    UNION
    SELECT audit.id FROM target_run run CROSS JOIN LATERAL (
      SELECT candidate.id FROM audit_log_offboarding_scopes selector
      JOIN audit_log candidate ON candidate.id = selector.audit_id
                              AND candidate.id <= run.audit_fence_id
       WHERE selector.scope_id = run.scope_id AND selector.selector_kind = 'scope_ids'
       ORDER BY selector.audit_id OFFSET 0
    ) audit
  )
  SELECT COALESCE((SELECT NOT (
    NOT EXISTS (SELECT 1 FROM principals p WHERE p.id = run.principal_id
      AND p.disabled_at IS NOT NULL AND p.offboarded_at IS NOT NULL
      AND p.reactivated_at IS NULL
      AND p.display_name = 'erased-' || left(replace(run.principal_id::text, '-', ''), 12))
    OR NOT EXISTS (SELECT 1 FROM scopes s WHERE s.id = run.scope_id
      AND s.kind = 'user' AND s.name = 'erased-user-' || run.scope_id::text)
    OR NOT EXISTS (SELECT 1 FROM principal_user_scopes mapping
      WHERE mapping.principal_id = run.principal_id AND mapping.scope_id = run.scope_id)
    OR NOT EXISTS (SELECT 1 FROM principal_user_scope_approvals approval
      WHERE approval.id = run.approval_id AND approval.principal_id = run.principal_id
        AND approval.scope_id = run.scope_id
        AND approval.acknowledged_evidence_hash = run.approval_evidence_hash)
    OR EXISTS (SELECT 1 FROM memories m WHERE m.scope_id = run.scope_id AND (
      m.type IS DISTINCT FROM 'context' OR m.title IS DISTINCT FROM '[erased]'
      OR m.body IS DISTINCT FROM '[erased]' OR m.metadata IS DISTINCT FROM '{}'::jsonb
      OR m.tags IS DISTINCT FROM '{}'::text[] OR m.source IS DISTINCT FROM 'erased'
      OR m.source_ref IS NOT NULL OR m.state IS DISTINCT FROM 'archived'
      OR m.supersedes_id IS NOT NULL OR m.promoted_to_id IS NOT NULL
      OR m.expires_at IS NOT NULL OR m.last_verified IS NOT NULL))
    OR EXISTS (SELECT 1 FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
      WHERE m.scope_id = run.scope_id)
    OR EXISTS (SELECT 1 FROM scope_memberships m WHERE m.scope_id = run.scope_id AND m.active)
    OR EXISTS (SELECT 1 FROM principal_aliases a WHERE a.principal_id = run.principal_id)
    OR EXISTS (SELECT 1 FROM entra_groups g WHERE g.scope_id = run.scope_id
      AND (g.active OR g.approval_revoked_at IS NULL))
    OR EXISTS (SELECT 1 FROM target_audit target JOIN audit_log audit ON audit.id = target.id
      WHERE audit.query IS NOT NULL OR audit.metadata IS DISTINCT FROM
        continuum_offboarding_expected_audit_metadata(audit.metadata))
  ) FROM target_run run), FALSE)
$$;
REVOKE ALL ON FUNCTION continuum_offboarding_actual_state_is_erased(UUID) FROM PUBLIC;

CREATE TABLE principal_offboarding_takeover_events (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL,
  principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  scope_id UUID NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,
  from_actor UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  to_actor UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  evidence JSONB NOT NULL,
  CHECK (from_actor <> to_actor)
);
CREATE INDEX principal_offboarding_takeover_events_run_idx
  ON principal_offboarding_takeover_events (run_id, id);
CREATE TRIGGER preserve_offboarding_takeover_event
BEFORE UPDATE OR DELETE ON principal_offboarding_takeover_events
FOR EACH ROW EXECUTE FUNCTION continuum_preserve_offboarding_run_event();

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
  SELECT COALESCE(
    (SELECT takeover.to_actor FROM principal_offboarding_takeover_events takeover
      WHERE takeover.run_id = target_run_id ORDER BY takeover.id DESC LIMIT 1),
    target_run.initiated_by
  ) INTO prior_actor;
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
        'takeover_from', prior_actor,
        'authorization_basis', 'current_effective_org_admin'))
    ON CONFLICT (run_id, phase) DO NOTHING;
  END IF;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION continuum_resume_offboarding_run(UUID, UUID) FROM PUBLIC;

CREATE TABLE continuum_offboarding_restart_requests (
  run_id UUID PRIMARY KEY,
  backend_pid INTEGER NOT NULL,
  transaction_id BIGINT NOT NULL
);
REVOKE ALL ON TABLE continuum_offboarding_restart_requests FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_guard_completed_offboarding_run()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF OLD.completed_at IS NULL THEN RETURN NEW; END IF;
  IF NEW.run_id IS DISTINCT FROM OLD.run_id AND NEW.completed_at IS NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM continuum_offboarding_restart_requests request
       WHERE request.run_id = OLD.run_id AND request.backend_pid = pg_backend_pid()
         AND request.transaction_id = txid_current()
    ) THEN RAISE EXCEPTION 'completed offboarding restart requires verified capability'; END IF;
    RETURN NEW;
  END IF;
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'completed offboarding run is immutable'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_guard_completed_offboarding_run() FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_restart_offboarding_run(
  target_principal_id UUID, authorization_principal_id UUID, details JSONB
) RETURNS SETOF principal_offboarding_runs LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE current_run principal_offboarding_runs%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM principals p JOIN scope_memberships m ON m.principal_id = p.id
    JOIN scopes s ON s.id = m.scope_id
    WHERE p.id = authorization_principal_id AND p.disabled_at IS NULL
      AND s.kind = 'org' AND s.name = '' AND m.active AND m.role = 'admin'
      AND continuum_membership_is_effective(m.active, m.source_kind)
  ) THEN RAISE EXCEPTION 'fresh offboarding requires an effective org administrator'; END IF;
  SELECT run.* INTO current_run FROM principal_offboarding_runs run
  JOIN principals p ON p.id = run.principal_id
   WHERE run.principal_id = target_principal_id AND run.completed_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM principal_offboarding_run_events e
                  WHERE e.run_id = run.run_id AND e.phase = 'completed')
     AND ((p.offboarded_at IS NULL AND p.disabled_at IS NULL AND p.reactivated_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM principal_offboarding_run_events e
                        WHERE e.run_id = run.run_id AND e.phase = 'reactivated'))
       OR (p.offboarded_at IS NOT NULL AND p.disabled_at IS NOT NULL
           AND p.reactivated_at IS NULL
           AND NOT continuum_offboarding_actual_state_is_erased(run.run_id)))
   FOR UPDATE OF run, p;
  IF NOT FOUND THEN RAISE EXCEPTION 'fresh offboarding restart requires guarded reactivation or dirty repair state'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM principal_user_scope_approvals a
     WHERE a.id = (details->>'approval_id')::bigint
       AND a.principal_id = current_run.principal_id AND a.scope_id = current_run.scope_id
       AND a.acknowledged_evidence_hash = details->>'approval_evidence_hash'
  ) THEN RAISE EXCEPTION 'fresh offboarding restart requires current approval evidence'; END IF;
  INSERT INTO continuum_offboarding_restart_requests (run_id, backend_pid, transaction_id)
  VALUES (current_run.run_id, pg_backend_pid(), txid_current());
  RETURN QUERY SELECT * FROM continuum_write_offboarding_run_internal(
    target_principal_id, authorization_principal_id, 'restart', details
  );
  DELETE FROM continuum_offboarding_restart_requests WHERE run_id = current_run.run_id;
END;
$$;
REVOKE ALL ON FUNCTION continuum_restart_offboarding_run(UUID, UUID, JSONB) FROM PUBLIC;

-- Request IDs are server-generated request identity for correlation only.
-- Inbound client IDs are non-linking metadata and never establish erasure targets.
DO $harden$
DECLARE schema_name TEXT := current_schema(); function_name TEXT;
BEGIN
  FOREACH function_name IN ARRAY ARRAY[
    'continuum_apply_audit_retention', 'continuum_create_user_scope_approval',
    'continuum_upsert_entra_group_binding', 'continuum_activate_entra_memberships',
    'continuum_guard_manual_org_admin_membership',
    'continuum_guard_entra_admin_sources', 'continuum_resume_offboarding_run',
    'continuum_guard_completed_offboarding_run', 'continuum_restart_offboarding_run',
    'continuum_offboarding_actual_state_is_erased'
  ] LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, %I, pg_temp',
      schema_name, function_name,
      CASE function_name
        WHEN 'continuum_apply_audit_retention' THEN 'UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT'
        WHEN 'continuum_create_user_scope_approval' THEN 'UUID, UUID, UUID, UUID[], TEXT'
        WHEN 'continuum_upsert_entra_group_binding' THEN 'UUID, TEXT, TEXT, UUID, TEXT'
        WHEN 'continuum_activate_entra_memberships' THEN 'UUID, TEXT, UUID[]'
        WHEN 'continuum_guard_manual_org_admin_membership' THEN ''
        WHEN 'continuum_guard_entra_admin_sources' THEN ''
        WHEN 'continuum_resume_offboarding_run' THEN 'UUID, UUID'
        WHEN 'continuum_guard_completed_offboarding_run' THEN ''
        WHEN 'continuum_offboarding_actual_state_is_erased' THEN 'UUID'
        ELSE 'UUID, UUID, JSONB'
      END,
      schema_name
    );
  END LOOP;
END;
$harden$;
