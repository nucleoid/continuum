-- Close independent exact-head findings without rewriting application data.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION continuum_guard_entra_admin_sources()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  table_owner OID;
  invoking_role NAME := continuum_invoking_database_role();
  trusted_sync BOOLEAN := FALSE;
  has_reapproval BOOLEAN := FALSE;
BEGIN
  -- A binding's immutable provider identity is never rewritten. Guarded
  -- reapproval updates the approved target and metadata, not external_id.
  IF TG_TABLE_NAME = 'entra_groups' THEN
    IF TG_OP = 'UPDATE' AND OLD.external_id IS DISTINCT FROM NEW.external_id THEN
      RAISE EXCEPTION 'Entra group external_id is immutable';
    END IF;
  END IF;
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

CREATE FUNCTION continuum_sync_observe_entra_group(
  authorization_principal_id UUID, group_external_id TEXT, group_display_name TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE changed_count INTEGER;
BEGIN
  PERFORM continuum_require_sync_session(authorization_principal_id);
  IF group_display_name IS NULL OR length(group_display_name) > 256 THEN
    RAISE EXCEPTION 'invalid Entra group display name';
  END IF;
  UPDATE entra_groups SET display_name = group_display_name, last_seen_at = now(),
         active = TRUE, deactivated_at = NULL
   WHERE external_id = group_external_id AND approval_revoked_at IS NULL
     AND quarantined_at IS NULL;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count > 0;
END;
$$;
REVOKE ALL ON FUNCTION continuum_sync_observe_entra_group(UUID, TEXT, TEXT) FROM PUBLIC;

CREATE FUNCTION continuum_sync_deactivate_entra_memberships(
  authorization_principal_id UUID, group_external_ids TEXT[], retained_principal_ids UUID[]
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE changed INTEGER;
BEGIN
  PERFORM continuum_require_sync_session(authorization_principal_id);
  IF COALESCE(cardinality(group_external_ids), 0) > 500
     OR COALESCE(cardinality(retained_principal_ids), 0) > 10000 THEN
    RAISE EXCEPTION 'Entra membership deactivation selector is too large';
  END IF;
  UPDATE scope_memberships SET active = FALSE,
         deactivated_at = COALESCE(deactivated_at, now()), synced_at = now()
   WHERE source_kind = 'entra' AND active
     AND (group_external_ids IS NULL OR source_id = ANY(group_external_ids))
     AND (retained_principal_ids IS NULL
          OR NOT (principal_id = ANY(retained_principal_ids)));
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$;
REVOKE ALL ON FUNCTION continuum_sync_deactivate_entra_memberships(UUID, TEXT[], UUID[])
FROM PUBLIC;

CREATE FUNCTION continuum_sync_deactivate_entra_groups(
  authorization_principal_id UUID, group_external_ids TEXT[]
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE changed INTEGER;
BEGIN
  PERFORM continuum_require_sync_session(authorization_principal_id);
  IF group_external_ids IS NULL OR cardinality(group_external_ids) > 500 THEN
    RAISE EXCEPTION 'invalid Entra group deactivation selector';
  END IF;
  UPDATE entra_groups SET active = FALSE,
         deactivated_at = COALESCE(deactivated_at, now())
   WHERE active AND external_id = ANY(group_external_ids);
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$;
REVOKE ALL ON FUNCTION continuum_sync_deactivate_entra_groups(UUID, TEXT[]) FROM PUBLIC;

CREATE FUNCTION continuum_sync_quarantine_entra_group(
  authorization_principal_id UUID, group_external_id TEXT, quarantine_code TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE changed_count INTEGER; was_active BOOLEAN;
BEGIN
  PERFORM continuum_require_sync_session(authorization_principal_id);
  IF quarantine_code IS NULL OR length(quarantine_code) > 128 THEN
    RAISE EXCEPTION 'invalid Entra quarantine code';
  END IF;
  SELECT active INTO was_active FROM entra_groups
   WHERE external_id = group_external_id AND approval_revoked_at IS NULL;
  UPDATE entra_groups SET active = FALSE,
         deactivated_at = COALESCE(deactivated_at, now()),
         quarantined_at = COALESCE(quarantined_at, now()),
         quarantine_reason = quarantine_code
   WHERE external_id = group_external_id AND approval_revoked_at IS NULL;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count > 0 AND COALESCE(was_active, FALSE);
END;
$$;
REVOKE ALL ON FUNCTION continuum_sync_quarantine_entra_group(UUID, TEXT, TEXT) FROM PUBLIC;

-- The raw caller-UUID lock API is retired. Only a DB-bound operator wrapper
-- may lock mutable run state; shared application sessions retain dry-run reads.
CREATE FUNCTION continuum_operator_get_offboarding_run(
  target_principal_id UUID, authorization_principal_id UUID
) RETURNS SETOF principal_offboarding_runs LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  RETURN QUERY SELECT run.* FROM principal_offboarding_runs run
    WHERE run.principal_id = target_principal_id FOR UPDATE;
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_get_offboarding_run(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION continuum_get_offboarding_run(UUID, UUID) FROM PUBLIC;

CREATE FUNCTION continuum_operator_authorize_audit_retention(
  authorization_principal_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_authorize_audit_retention(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_rotate_sync_database_identity(
  authorization_principal_id UUID,
  target_database_role NAME,
  target_service_principal_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  schema_name TEXT;
  owner_role NAME;
  target_oid OID;
  target_superuser BOOLEAN;
  old_identity RECORD;
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  -- Match sync/offboarding lock order before the admin/operator safety lock.
  PERFORM pg_advisory_xact_lock(834641726154302119::bigint);
  PERFORM pg_advisory_xact_lock(834641726154302120::bigint);
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');

  SELECT oid, rolsuper INTO target_oid, target_superuser FROM pg_roles
   WHERE rolname = target_database_role;
  IF target_oid IS NULL THEN
    RAISE EXCEPTION 'sync database role must be an existing role';
  END IF;
  SELECT namespace.nspname, pg_get_userbyid(relation.relowner)::name
    INTO schema_name, owner_role
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = 'principals'::regclass;
  IF target_superuser OR target_database_role = owner_role
     OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = quote_ident(schema_name)::regnamespace
                 AND relowner = target_oid)
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = quote_ident(schema_name)::regnamespace
                 AND proowner = target_oid) THEN
    RAISE EXCEPTION 'sync database role cannot be an owner role';
  END IF;
  IF EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
     WHERE identity.database_role = target_database_role AND identity.can_approve
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members membership
    JOIN continuum_trusted_database_identities identity
      ON identity.can_approve AND (identity.database_role::regrole::oid = membership.roleid
        OR identity.database_role::regrole::oid = membership.member)
     WHERE target_oid IN (membership.roleid, membership.member)
  ) THEN
    RAISE EXCEPTION 'sync database role cannot be approve-related or operator-related';
  END IF;
  IF has_table_privilege(target_database_role,
       format('%I.scope_memberships', schema_name), 'INSERT,DELETE')
     OR has_table_privilege(target_database_role,
       format('%I.memories', schema_name), 'INSERT,UPDATE,DELETE')
     OR has_table_privilege(target_database_role,
       format('%I.scopes', schema_name), 'INSERT,UPDATE,DELETE')
     OR has_function_privilege(target_database_role,
       format('%I.continuum_operator_reactivate_principal(uuid,uuid)', schema_name), 'EXECUTE') THEN
    RAISE EXCEPTION 'sync database role must not carry application or operator privileges';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM principals p WHERE p.id = target_service_principal_id
      AND p.kind = 'service' AND p.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'sync identity must be an enabled service principal';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
    JOIN principals p ON p.id = identity.principal_id
    JOIN scope_memberships membership ON membership.principal_id = p.id
    JOIN scopes scope ON scope.id = membership.scope_id
     WHERE identity.can_approve AND p.disabled_at IS NULL AND p.kind = 'user'
       AND membership.source_kind = 'manual' AND membership.source_id = 'manual'
       AND membership.role = 'admin' AND membership.active
       AND scope.kind = 'org' AND scope.name = ''
  ) THEN
    RAISE EXCEPTION 'sync rotation requires at least one effective DB-bound operator';
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, target_database_role);
  EXECUTE format('GRANT SELECT ON TABLE %I.scopes, %I.principals, %I.entra_groups, '
    || '%I.scope_memberships, %I.entra_sync_state, %I.principal_user_scopes, '
    || '%I.memories, %I.audit_log_offboarding_scopes TO %I',
    schema_name, schema_name, schema_name, schema_name, schema_name, schema_name,
    schema_name, schema_name, target_database_role);
  EXECUTE format('GRANT INSERT ON TABLE %I.principals, %I.audit_log TO %I',
    schema_name, schema_name, target_database_role);
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I.audit_log_id_seq TO %I',
    schema_name, target_database_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION '
    || '%I.continuum_activate_entra_memberships(UUID, TEXT, UUID[]), '
    || '%I.continuum_require_sync_session(UUID), '
    || '%I.continuum_record_entra_sync_success(UUID, INTEGER), '
    || '%I.continuum_record_entra_sync_failure(UUID, TEXT, INTEGER), '
    || '%I.continuum_sync_observe_entra_group(UUID, TEXT, TEXT), '
    || '%I.continuum_sync_deactivate_entra_memberships(UUID, TEXT[], UUID[]), '
    || '%I.continuum_sync_deactivate_entra_groups(UUID, TEXT[]), '
    || '%I.continuum_sync_quarantine_entra_group(UUID, TEXT, TEXT) TO %I',
    schema_name, schema_name, schema_name, schema_name, schema_name, schema_name,
    schema_name, schema_name, target_database_role);
  EXECUTE format('REVOKE UPDATE ON TABLE %I.scope_memberships, %I.entra_groups FROM %I',
    schema_name, schema_name, target_database_role);

  FOR old_identity IN
    SELECT database_role FROM continuum_trusted_database_identities
     WHERE can_sync AND database_role <> target_database_role FOR UPDATE
  LOOP
    DELETE FROM continuum_trusted_database_identities
     WHERE database_role = old_identity.database_role AND can_sync;
    EXECUTE format('REVOKE ALL ON FUNCTION '
      || '%I.continuum_activate_entra_memberships(UUID, TEXT, UUID[]), '
      || '%I.continuum_require_sync_session(UUID), '
      || '%I.continuum_record_entra_sync_success(UUID, INTEGER), '
      || '%I.continuum_record_entra_sync_failure(UUID, TEXT, INTEGER), '
      || '%I.continuum_sync_observe_entra_group(UUID, TEXT, TEXT), '
      || '%I.continuum_sync_deactivate_entra_memberships(UUID, TEXT[], UUID[]), '
      || '%I.continuum_sync_deactivate_entra_groups(UUID, TEXT[]), '
      || '%I.continuum_sync_quarantine_entra_group(UUID, TEXT, TEXT) FROM %I',
      schema_name, schema_name, schema_name, schema_name, schema_name, schema_name,
      schema_name, schema_name, old_identity.database_role);
    EXECUTE format('REVOKE INSERT ON TABLE %I.principals, %I.audit_log FROM %I',
      schema_name, schema_name, old_identity.database_role);
    EXECUTE format('REVOKE UPDATE ON TABLE %I.scope_memberships, %I.entra_groups FROM %I',
      schema_name, schema_name, old_identity.database_role);
  END LOOP;

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

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments
      FROM pg_proc p WHERE p.pronamespace = quote_ident(current_schema())::regnamespace
       AND p.proname = ANY(ARRAY[
        'continuum_guard_entra_admin_sources',
        'continuum_sync_observe_entra_group',
        'continuum_sync_deactivate_entra_memberships',
        'continuum_sync_deactivate_entra_groups',
        'continuum_sync_quarantine_entra_group',
        'continuum_operator_get_offboarding_run',
        'continuum_operator_authorize_audit_retention',
        'continuum_rotate_sync_database_identity'
       ])
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, %I, pg_temp',
      schema_name, function_record.proname, function_record.arguments, schema_name);
  END LOOP;
END;
$harden$;
