-- Close post-0048 lifecycle, registration, retirement, and run-binding gaps.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM continuum_trusted_database_identities identity
      LEFT JOIN pg_roles role ON role.oid = identity.database_role_oid
     WHERE role.oid IS NULL OR role.rolname <> identity.database_role::text
  ) THEN
    RAISE EXCEPTION 'trusted database identity has stale role OID provenance; explicitly clean up and re-register it';
  END IF;
  IF (SELECT count(*) FROM continuum_trusted_database_identities WHERE can_sync) > 1 THEN
    RAISE EXCEPTION 'multiple active sync identities require explicit reviewed cleanup';
  END IF;
  IF EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities WHERE can_approve
  ) THEN
    RAISE EXCEPTION 'pre-0049 operator role provenance is not independently verifiable; remove it and explicitly re-register after migration';
  END IF;
END;
$preflight$;

CREATE UNIQUE INDEX continuum_trusted_database_identities_one_sync
  ON continuum_trusted_database_identities ((can_sync)) WHERE can_sync;

-- PostgreSQL grants schema USAGE to PUBLIC by default. Every supported
-- Continuum role is granted schema USAGE explicitly, so remove that ambient
-- path before credentials can be retired safely.
DO $public_schema$
BEGIN
  EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM PUBLIC', current_schema());
END;
$public_schema$;

CREATE OR REPLACE FUNCTION continuum_validate_trusted_database_role(
  target_database_role NAME,
  required_capability TEXT,
  allow_existing_sync BOOLEAN DEFAULT FALSE
) RETURNS OID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  schema_name TEXT;
  schema_oid OID;
  owner_oid OID;
  target_oid OID;
  target_superuser BOOLEAN;
  target_createdb BOOLEAN;
  target_createrole BOOLEAN;
  target_replication BOOLEAN;
  target_bypassrls BOOLEAN;
  existing_sync BOOLEAN;
BEGIN
  IF required_capability NOT IN ('approve', 'sync') THEN
    RAISE EXCEPTION 'invalid trusted database capability';
  END IF;
  SELECT oid, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    INTO target_oid, target_superuser, target_createdb, target_createrole,
         target_replication, target_bypassrls
    FROM pg_roles WHERE rolname = target_database_role;
  IF target_oid IS NULL THEN
    RAISE EXCEPTION 'trusted database role does not exist';
  END IF;
  SELECT namespace.nspname, namespace.oid, relation.relowner
    INTO schema_name, schema_oid, owner_oid
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = 'principals'::regclass;
  SELECT EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
     WHERE identity.database_role_oid = target_oid AND identity.can_sync
  ) INTO existing_sync;
  IF target_superuser OR target_createdb OR target_createrole OR target_replication
     OR target_bypassrls OR target_oid = owner_oid
     OR has_schema_privilege(target_database_role, schema_name, 'CREATE')
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE oid = schema_oid AND nspowner = target_oid)
     OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = schema_oid AND relowner = target_oid)
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = schema_oid AND proowner = target_oid) THEN
    RAISE EXCEPTION 'trusted database role must be isolated and cannot have privileged attributes, schema CREATE, or ownership';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_auth_members membership
     WHERE target_oid IN (membership.roleid, membership.member)
       AND NOT (
         membership.roleid = target_oid
         AND membership.member = owner_oid
       )
  ) THEN
    RAISE EXCEPTION 'trusted database role must be isolated from every membership and SET ROLE edge';
  END IF;
  IF required_capability = 'sync' THEN
    IF EXISTS (
      SELECT 1 FROM continuum_trusted_database_identities identity
       WHERE identity.database_role_oid = target_oid
         AND NOT (allow_existing_sync AND identity.can_sync AND NOT identity.can_approve)
    ) THEN
      RAISE EXCEPTION 'sync database role already has trusted approval authority';
    END IF;
    IF (NOT (allow_existing_sync AND existing_sync)) AND (
      EXISTS (
        SELECT 1 FROM pg_class relation
         WHERE relation.relnamespace = schema_oid
           AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND has_table_privilege(target_database_role, relation.oid,
                 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      ) OR has_table_privilege(target_database_role,
        format('%I.memories', schema_name), 'SELECT')
      OR has_function_privilege(target_database_role,
        format('%I.continuum_operator_reactivate_principal(uuid,uuid)', schema_name),
        'EXECUTE')
    ) THEN
      RAISE EXCEPTION 'sync database role has existing application, memory-read, or operator authority';
    END IF;
    IF has_table_privilege(target_database_role,
         format('%I.memories', schema_name), 'SELECT')
       OR has_function_privilege(target_database_role,
         format('%I.continuum_operator_reactivate_principal(uuid,uuid)', schema_name),
         'EXECUTE') THEN
      RAISE EXCEPTION 'sync database role has memory-read or operator authority';
    END IF;
  ELSE
    IF existing_sync OR has_schema_privilege(target_database_role, schema_name, 'CREATE')
       OR has_table_privilege(target_database_role,
         format('%I.entra_groups', schema_name), 'UPDATE')
       OR has_function_privilege(target_database_role,
         format('%I.continuum_activate_entra_memberships(uuid,text,uuid[])', schema_name),
         'EXECUTE') THEN
      RAISE EXCEPTION 'approval database role has unsafe sync, schema, or raw Entra authority';
    END IF;
  END IF;
  RETURN target_oid;
END;
$$;
REVOKE ALL ON FUNCTION continuum_validate_trusted_database_role(NAME, TEXT, BOOLEAN)
FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_retire_sync_database_identities(
  retained_role_oid OID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  schema_name TEXT;
  schema_oid OID;
  owner_oid OID;
  old_identity RECORD;
BEGIN
  SELECT namespace.nspname, namespace.oid, relation.relowner
    INTO schema_name, schema_oid, owner_oid
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = 'principals'::regclass;
  FOR old_identity IN
    SELECT identity.database_role_oid, role.rolname
      FROM continuum_trusted_database_identities identity
      LEFT JOIN pg_roles role ON role.oid = identity.database_role_oid
     WHERE identity.can_sync AND identity.database_role_oid <> retained_role_oid
     FOR UPDATE OF identity
  LOOP
    IF old_identity.rolname IS NULL THEN
      RAISE EXCEPTION 'retired sync database role no longer resolves by OID';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_auth_members membership
       WHERE old_identity.database_role_oid IN (membership.roleid, membership.member)
         AND NOT (
           membership.roleid = old_identity.database_role_oid
           AND membership.member = owner_oid
         )
    ) OR EXISTS (
      SELECT 1 FROM pg_namespace namespace
       WHERE namespace.oid = schema_oid AND namespace.nspowner = old_identity.database_role_oid
    ) OR EXISTS (
      SELECT 1 FROM pg_class relation
       WHERE relation.relnamespace = schema_oid AND relation.relowner = old_identity.database_role_oid
    ) OR EXISTS (
      SELECT 1 FROM pg_proc function
       WHERE function.pronamespace = schema_oid AND function.proowner = old_identity.database_role_oid
    ) THEN
      RAISE EXCEPTION 'retired sync database role has membership or owns application objects';
    END IF;
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I',
      schema_name, old_identity.rolname);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I',
      schema_name, old_identity.rolname);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM %I',
      schema_name, old_identity.rolname);
    EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I',
      schema_name, old_identity.rolname);
    EXECUTE format('ALTER ROLE %I NOLOGIN', old_identity.rolname);
    DELETE FROM continuum_trusted_database_identities
     WHERE database_role_oid = old_identity.database_role_oid
       AND can_sync AND NOT can_approve;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION continuum_retire_sync_database_identities(OID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_install_sync_database_identity(
  target_database_role NAME,
  target_service_principal_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  schema_name TEXT;
  target_oid OID;
  already_bound BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(834641726154302119::bigint);
  PERFORM pg_advisory_xact_lock(834641726154302120::bigint);
  IF NOT EXISTS (
    SELECT 1 FROM principals principal
     WHERE principal.id = target_service_principal_id
       AND principal.kind = 'service' AND principal.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'sync identity must be an enabled service principal';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
     WHERE identity.database_role = target_database_role
       AND identity.principal_id = target_service_principal_id
       AND identity.can_sync AND NOT identity.can_approve
  ) INTO already_bound;
  target_oid := continuum_validate_trusted_database_role(
    target_database_role, 'sync', already_bound
  );
  SELECT namespace.nspname INTO schema_name
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = 'principals'::regclass;

  PERFORM continuum_retire_sync_database_identities(target_oid);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I',
    schema_name, target_database_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I',
    schema_name, target_database_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM %I',
    schema_name, target_database_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I',
    schema_name, target_database_role);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, target_database_role);
  EXECUTE format('GRANT SELECT ON TABLE %I.scopes, %I.principals, %I.entra_groups, '
    || '%I.scope_memberships, %I.entra_sync_state TO %I',
    schema_name, schema_name, schema_name, schema_name, schema_name, target_database_role);
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

  INSERT INTO continuum_trusted_database_identities
    (database_role, database_role_oid, principal_id, can_approve, can_sync)
  VALUES (target_database_role, target_oid, target_service_principal_id, FALSE, TRUE)
  ON CONFLICT (database_role) DO UPDATE SET
    database_role_oid = EXCLUDED.database_role_oid,
    principal_id = EXCLUDED.principal_id,
    can_approve = FALSE,
    can_sync = TRUE;
END;
$$;
REVOKE ALL ON FUNCTION continuum_install_sync_database_identity(NAME, UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_register_trusted_database_identity(
  target_database_role NAME,
  target_principal_id UUID,
  approve_capability BOOLEAN,
  sync_capability BOOLEAN
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE target_role_oid OID;
BEGIN
  IF NOT (approve_capability OR sync_capability) OR (approve_capability AND sync_capability) THEN
    RAISE EXCEPTION 'exactly one trusted database capability is required';
  END IF;
  IF sync_capability THEN
    PERFORM continuum_install_sync_database_identity(
      target_database_role, target_principal_id
    );
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(834641726154302120::bigint);
  IF NOT EXISTS (
    SELECT 1 FROM principals principal
    JOIN scope_memberships membership ON membership.principal_id = principal.id
    JOIN scopes scope ON scope.id = membership.scope_id
     WHERE principal.id = target_principal_id
       AND principal.kind = 'user' AND principal.disabled_at IS NULL
       AND scope.kind = 'org' AND scope.name = ''
       AND membership.source_kind = 'manual' AND membership.source_id = 'manual'
       AND membership.role = 'admin' AND membership.active
  ) THEN
    RAISE EXCEPTION 'operator identity must be an effective manual org administrator';
  END IF;
  target_role_oid := continuum_validate_trusted_database_role(
    target_database_role, 'approve', FALSE
  );
  INSERT INTO continuum_trusted_database_identities
    (database_role, database_role_oid, principal_id, can_approve, can_sync)
  VALUES (target_database_role, target_role_oid, target_principal_id, TRUE, FALSE)
  ON CONFLICT (database_role) DO UPDATE SET
    database_role_oid = EXCLUDED.database_role_oid,
    principal_id = EXCLUDED.principal_id,
    can_approve = TRUE,
    can_sync = FALSE;
END;
$$;
REVOKE ALL ON FUNCTION continuum_register_trusted_database_identity(
  NAME, UUID, BOOLEAN, BOOLEAN
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_rotate_sync_database_identity(
  authorization_principal_id UUID,
  target_database_role NAME,
  target_service_principal_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  PERFORM continuum_install_sync_database_identity(
    target_database_role, target_service_principal_id
  );
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  INSERT INTO audit_log (principal_id, action, metadata)
  VALUES (authorization_principal_id, 'write', jsonb_build_object(
    'operation', 'entra_sync_identity_rotated',
    'database_role', target_database_role::text,
    'service_principal_id', target_service_principal_id));
END;
$$;
REVOKE ALL ON FUNCTION continuum_rotate_sync_database_identity(UUID, NAME, UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_fail_closed_on_principal_disable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE lifecycle_principal UUID := '00000000-0000-4000-8000-000000000011'::uuid;
BEGIN
  UPDATE service_api_keys
     SET revoked_at = COALESCE(revoked_at, now())
   WHERE principal_id = NEW.id AND revoked_at IS NULL;
  INSERT INTO continuum_entra_guarded_mutations
    (external_id, mutation_kind, backend_pid, transaction_id, authorization_principal_id)
  SELECT DISTINCT membership.source_id, 'deactivate', pg_backend_pid(), txid_current(),
         lifecycle_principal
    FROM scope_memberships membership
   WHERE membership.principal_id = NEW.id
     AND membership.source_kind = 'entra' AND membership.active
  ON CONFLICT DO NOTHING;
  UPDATE scope_memberships
     SET active = FALSE,
         deactivated_at = COALESCE(deactivated_at, now())
   WHERE principal_id = NEW.id AND active;
  DELETE FROM continuum_entra_guarded_mutations mutation
   WHERE mutation.mutation_kind = 'deactivate'
     AND mutation.backend_pid = pg_backend_pid()
     AND mutation.transaction_id = txid_current()
     AND mutation.authorization_principal_id = lifecycle_principal;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_operator_offboard_scope_access(
  authorization_principal_id UUID, target_scope_id UUID
) RETURNS TABLE(memberships_deactivated INTEGER, bindings_quarantined INTEGER)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  changed_memberships INTEGER;
  changed_bindings INTEGER;
  bound_run_id UUID;
  bound_principal_id UUID;
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  PERFORM pg_advisory_xact_lock(834641726154302119::bigint);
  SELECT run.run_id, run.principal_id
    INTO bound_run_id, bound_principal_id
    FROM principal_offboarding_runs run
    JOIN principal_user_scopes mapping
      ON mapping.principal_id = run.principal_id
     AND mapping.scope_id = target_scope_id
    JOIN scopes scope ON scope.id = mapping.scope_id AND scope.kind = 'user'
   WHERE run.completed_at IS NULL
     AND EXISTS (
       SELECT 1 FROM principal_offboarding_run_events started
        WHERE started.run_id = run.run_id AND started.phase = 'started'
     )
     AND NOT EXISTS (
       SELECT 1 FROM principal_offboarding_run_events completed
        WHERE completed.run_id = run.run_id AND completed.phase = 'completed'
     )
   FOR UPDATE OF run;
  IF bound_run_id IS NULL THEN
    RAISE EXCEPTION 'scope cleanup requires a started incomplete offboarding run bound to the owned user scope';
  END IF;
  INSERT INTO continuum_entra_guarded_mutations
    (external_id, mutation_kind, backend_pid, transaction_id, authorization_principal_id)
  SELECT DISTINCT membership.source_id, 'deactivate', pg_backend_pid(), txid_current(),
         authorization_principal_id
    FROM scope_memberships membership
   WHERE membership.scope_id = target_scope_id
     AND membership.source_kind = 'entra' AND membership.active
  ON CONFLICT DO NOTHING;
  INSERT INTO continuum_entra_guarded_mutations
    (external_id, mutation_kind, backend_pid, transaction_id, authorization_principal_id)
  SELECT binding.external_id, mutation_kind, pg_backend_pid(), txid_current(),
         authorization_principal_id
    FROM entra_groups binding
    CROSS JOIN (VALUES ('revoke'), ('quarantine')) mutation(mutation_kind)
   WHERE binding.scope_id = target_scope_id
     AND (binding.active OR binding.approval_revoked_at IS NULL)
  ON CONFLICT DO NOTHING;
  UPDATE scope_memberships SET active = FALSE,
         deactivated_at = COALESCE(deactivated_at, now())
   WHERE scope_id = target_scope_id AND active;
  GET DIAGNOSTICS changed_memberships = ROW_COUNT;
  UPDATE entra_groups SET active = FALSE,
         deactivated_at = COALESCE(deactivated_at, now()),
         approval_revoked_by = COALESCE(approval_revoked_by, authorization_principal_id),
         approval_revoked_at = COALESCE(approval_revoked_at, now()),
         quarantined_at = COALESCE(quarantined_at, now()),
         quarantine_reason = 'OWNED_SCOPE_OFFBOARDED'
   WHERE scope_id = target_scope_id AND (active OR approval_revoked_at IS NULL);
  GET DIAGNOSTICS changed_bindings = ROW_COUNT;
  DELETE FROM continuum_entra_guarded_mutations mutation
   WHERE mutation.backend_pid = pg_backend_pid()
     AND mutation.transaction_id = txid_current()
     AND mutation.authorization_principal_id = $1;
  INSERT INTO audit_log (principal_id, action, metadata)
  VALUES (authorization_principal_id, 'write', jsonb_build_object(
    'operation', 'offboarding_scope_access_closed',
    'run_id', bound_run_id,
    'principal_id', bound_principal_id,
    'scope_id', target_scope_id,
    'memberships_deactivated', changed_memberships,
    'bindings_quarantined', changed_bindings));
  RETURN QUERY SELECT changed_memberships, changed_bindings;
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_offboard_scope_access(UUID, UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_verify_database_identity_configuration()
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  schema_name TEXT;
  identity RECORD;
BEGIN
  SELECT namespace.nspname INTO schema_name
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = 'principals'::regclass;
  IF has_schema_privilege('public', schema_name, 'USAGE') THEN
    RAISE EXCEPTION 'PUBLIC retains application schema USAGE';
  END IF;
  IF (SELECT count(*) FROM continuum_trusted_database_identities WHERE can_sync) <> 1 THEN
    RAISE EXCEPTION 'exactly one active sync database identity is required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
    LEFT JOIN pg_roles role ON role.oid = identity.database_role_oid
    LEFT JOIN principals principal ON principal.id = identity.principal_id
     WHERE identity.can_approve = identity.can_sync
        OR role.oid IS NULL OR role.rolname <> identity.database_role::text
        OR principal.disabled_at IS NOT NULL
        OR (identity.can_sync AND principal.kind <> 'service')
        OR (identity.can_approve AND principal.kind <> 'user')
        OR (identity.can_approve AND NOT EXISTS (
          SELECT 1 FROM scope_memberships membership
          JOIN scopes scope ON scope.id = membership.scope_id
           WHERE membership.principal_id = identity.principal_id
             AND scope.kind = 'org' AND scope.name = ''
             AND membership.source_kind = 'manual'
             AND membership.source_id = 'manual'
             AND membership.role = 'admin' AND membership.active
        ))
  ) THEN
    RAISE EXCEPTION 'trusted database identity configuration is invalid';
  END IF;
  FOR identity IN
    SELECT database_role, can_sync
      FROM continuum_trusted_database_identities
  LOOP
    PERFORM continuum_validate_trusted_database_role(
      identity.database_role,
      CASE WHEN identity.can_sync THEN 'sync' ELSE 'approve' END,
      identity.can_sync
    );
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION continuum_verify_database_identity_configuration() FROM PUBLIC;

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT function.oid, function.proname,
           pg_get_function_identity_arguments(function.oid) AS arguments
      FROM pg_proc function
     WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
       AND function.proname = ANY(ARRAY[
         'continuum_validate_trusted_database_role',
         'continuum_retire_sync_database_identities',
         'continuum_install_sync_database_identity',
         'continuum_register_trusted_database_identity',
         'continuum_rotate_sync_database_identity',
         'continuum_fail_closed_on_principal_disable',
         'continuum_operator_offboard_scope_access',
         'continuum_verify_database_identity_configuration'
       ])
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, %I, pg_temp',
      schema_name, function_record.proname, function_record.arguments, schema_name);
  END LOOP;
END;
$harden$;
