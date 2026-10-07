-- Forward-only repair for the database-identity restore and retirement contract.

CREATE OR REPLACE FUNCTION continuum_database_identity_provenance(
  expected_database_role NAME, expected_database_role_oid OID
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1
      FROM pg_roles role
     WHERE role.oid = expected_database_role_oid
       AND role.rolname = expected_database_role
  )
$$;
REVOKE ALL ON FUNCTION continuum_database_identity_provenance(NAME, OID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_require_database_identity_provenance(
  expected_database_role NAME DEFAULT NULL,
  expected_database_role_oid OID DEFAULT NULL,
  require_temporary_privilege BOOLEAN DEFAULT FALSE
) RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
  IF require_temporary_privilege
     AND NOT has_database_privilege(current_user, current_database(), 'TEMP') THEN
    RAISE EXCEPTION 'database identity rebind requires TEMPORARY privilege for the migration owner';
  END IF;
  IF expected_database_role IS NOT NULL
     AND NOT continuum_database_identity_provenance(
       expected_database_role, expected_database_role_oid) THEN
    RAISE EXCEPTION 'trusted sync or approval identity role name and OID provenance do not match; rebind is required';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_require_database_identity_provenance(NAME, OID, BOOLEAN)
FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_require_trusted_database_identity(
  claimed_principal_id UUID, required_capability TEXT
) RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  invoking_role NAME := continuum_invoking_database_role();
  invoking_role_oid OID; owner_oid OID;
BEGIN
  SELECT oid INTO invoking_role_oid FROM pg_roles WHERE rolname = invoking_role;
  SELECT relowner INTO owner_oid FROM pg_class WHERE oid = 'principals'::regclass;
  IF invoking_role_oid = owner_oid THEN RETURN; END IF;
  IF invoking_role_oid IS NULL OR required_capability NOT IN ('approve', 'sync')
     OR NOT EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
    JOIN principals principal ON principal.id = identity.principal_id
     WHERE identity.database_role = invoking_role
       AND identity.database_role_oid = invoking_role_oid
       AND identity.principal_id = claimed_principal_id
       AND principal.disabled_at IS NULL
       AND CASE required_capability
             WHEN 'approve' THEN identity.can_approve AND principal.kind = 'user'
               AND EXISTS (
                 SELECT 1 FROM scope_memberships membership
                  WHERE membership.principal_id = principal.id
                    AND membership.scope_id = continuum_org_scope_id()
                    AND membership.source_kind = 'manual'
                    AND membership.source_id = 'manual'
                    AND membership.role = 'admin' AND membership.active)
             WHEN 'sync' THEN identity.can_sync AND principal.kind = 'service'
             ELSE FALSE
           END
  ) THEN
    RAISE EXCEPTION 'operation requires a role-name/OID-bound trusted % identity',
      required_capability;
  END IF;
  PERFORM continuum_require_database_identity_provenance(invoking_role, invoking_role_oid);
  PERFORM continuum_validate_trusted_database_role(
    invoking_role, required_capability, required_capability = 'sync');
END;
$$;
REVOKE ALL ON FUNCTION continuum_require_trusted_database_identity(UUID, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_validate_entra_guard_markers(
  guarded_external_id TEXT
) RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  lifecycle_principal CONSTANT UUID := '00000000-0000-4000-8000-000000000011'::uuid;
  marker RECORD;
  capability TEXT;
  invoking_role NAME := continuum_invoking_database_role();
  invoking_role_oid OID := (SELECT oid FROM pg_roles
    WHERE rolname = continuum_invoking_database_role());
BEGIN
  FOR marker IN
    SELECT mutation_kind, authorization_principal_id
      FROM continuum_entra_guarded_mutations
     WHERE external_id = guarded_external_id
       AND backend_pid = pg_backend_pid()
       AND transaction_id = txid_current()
  LOOP
    IF marker.authorization_principal_id = lifecycle_principal
       AND marker.mutation_kind = 'deactivate' AND pg_trigger_depth() > 1 THEN
      CONTINUE;
    END IF;
    SELECT CASE WHEN identity.can_sync THEN 'sync' ELSE 'approve' END
      INTO capability
      FROM continuum_trusted_database_identities identity
     WHERE identity.database_role = invoking_role
       AND identity.database_role_oid = invoking_role_oid
       AND identity.principal_id = marker.authorization_principal_id
       AND ((marker.mutation_kind IN ('deactivate', 'quarantine') AND
             (identity.can_sync OR identity.can_approve))
            OR (marker.mutation_kind IN ('revoke', 'delete') AND identity.can_approve));
    IF capability IS NULL THEN
      RAISE EXCEPTION 'guarded Entra mutation marker lacks trusted runtime authority';
    END IF;
    PERFORM continuum_require_trusted_database_identity(
      marker.authorization_principal_id, capability);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION continuum_validate_entra_guard_markers(TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_guard_entra_admin_sources()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  table_owner OID;
  invoking_role NAME := continuum_invoking_database_role();
  invoking_role_oid OID;
  trusted_sync BOOLEAN := FALSE;
  has_reapproval BOOLEAN := FALSE;
  reapproval_principal_id UUID;
  has_guarded_deactivation BOOLEAN := FALSE;
  has_guarded_quarantine BOOLEAN := FALSE;
  has_guarded_revocation BOOLEAN := FALSE;
  guarded_external_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'entra_groups' THEN
    IF TG_OP = 'UPDATE' AND OLD.external_id IS DISTINCT FROM NEW.external_id THEN
      RAISE EXCEPTION 'Entra group external_id is immutable';
    END IF;
    guarded_external_id := NEW.external_id;
  ELSE
    guarded_external_id := NEW.source_id;
  END IF;
  SELECT relowner INTO table_owner FROM pg_class WHERE oid = TG_RELID;
  SELECT oid INTO invoking_role_oid FROM pg_roles WHERE rolname = invoking_role;
  IF invoking_role_oid = table_owner THEN RETURN NEW; END IF;
  SELECT EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
    JOIN principals principal ON principal.id = identity.principal_id
     WHERE identity.database_role = invoking_role
       AND identity.database_role_oid = invoking_role_oid
       AND identity.can_sync
       AND principal.kind = 'service' AND principal.disabled_at IS NULL
  ) INTO trusted_sync;
  IF TG_OP = 'UPDATE' THEN
    SELECT bool_or(mutation_kind = 'deactivate'),
           bool_or(mutation_kind = 'quarantine'), bool_or(mutation_kind = 'revoke')
      INTO has_guarded_deactivation, has_guarded_quarantine, has_guarded_revocation
      FROM continuum_entra_guarded_mutations mutation
     WHERE mutation.external_id = guarded_external_id
       AND mutation.backend_pid = pg_backend_pid()
       AND mutation.transaction_id = txid_current();
    IF COALESCE(has_guarded_deactivation, FALSE)
       OR COALESCE(has_guarded_quarantine, FALSE)
       OR COALESCE(has_guarded_revocation, FALSE) THEN
      PERFORM continuum_validate_entra_guard_markers(guarded_external_id);
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'entra_groups' THEN
    SELECT request.authorization_principal_id
      INTO reapproval_principal_id
      FROM continuum_entra_reapproval_requests request
       WHERE request.external_id = NEW.external_id
         AND request.backend_pid = pg_backend_pid()
         AND request.transaction_id = txid_current()
       LIMIT 1;
    has_reapproval := reapproval_principal_id IS NOT NULL;
    IF has_reapproval THEN
      PERFORM continuum_require_trusted_database_identity(
        reapproval_principal_id, 'approve');
    END IF;
    IF NEW.approved_by IS NOT NULL AND (
         TG_OP = 'INSERT' OR OLD.approved_by IS DISTINCT FROM NEW.approved_by
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
    IF TG_OP = 'UPDATE'
       AND (OLD.approval_revoked_by IS DISTINCT FROM NEW.approval_revoked_by
            OR OLD.approval_revoked_at IS DISTINCT FROM NEW.approval_revoked_at)
       AND NOT COALESCE(has_guarded_revocation, FALSE) AND NOT has_reapproval THEN
      RAISE EXCEPTION 'Entra binding revocation requires the guarded operator function';
    END IF;
    IF TG_OP = 'UPDATE'
       AND (OLD.quarantined_at IS DISTINCT FROM NEW.quarantined_at
            OR OLD.quarantine_reason IS DISTINCT FROM NEW.quarantine_reason)
       AND NOT COALESCE(has_guarded_quarantine, FALSE) AND NOT has_reapproval THEN
      RAISE EXCEPTION 'Entra binding quarantine requires the guarded sync function';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.active AND NOT NEW.active
       AND NOT (COALESCE(has_guarded_deactivation, FALSE)
                OR COALESCE(has_guarded_quarantine, FALSE)
                OR COALESCE(has_guarded_revocation, FALSE)) THEN
      RAISE EXCEPTION 'Entra binding deactivation requires a guarded function';
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND (OLD.source_kind = 'entra' OR NEW.source_kind = 'entra')
       AND (OLD.principal_id IS DISTINCT FROM NEW.principal_id
            OR OLD.source_kind IS DISTINCT FROM NEW.source_kind
            OR OLD.source_id IS DISTINCT FROM NEW.source_id) THEN
      RAISE EXCEPTION 'Entra membership principal and source identity are immutable';
    END IF;
    IF NEW.source_kind = 'entra' AND NEW.active
       AND (TG_OP = 'INSERT' OR NOT OLD.active OR OLD.role IS DISTINCT FROM NEW.role
            OR OLD.scope_id IS DISTINCT FROM NEW.scope_id) AND NOT trusted_sync THEN
      RAISE EXCEPTION 'Entra membership activation requires trusted sync';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.source_kind = 'entra' AND OLD.active AND NOT NEW.active
       AND NOT (COALESCE(has_guarded_deactivation, FALSE)
                OR COALESCE(has_guarded_quarantine, FALSE)
                OR COALESCE(has_guarded_revocation, FALSE)) THEN
      RAISE EXCEPTION 'Entra membership deactivation requires a guarded function';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_guard_entra_admin_sources() FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_validate_trusted_database_role(
  target_database_role NAME, required_capability TEXT,
  allow_existing_sync BOOLEAN DEFAULT FALSE
) RETURNS OID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  schema_name TEXT; schema_oid OID; owner_oid OID; target_oid OID;
  target_superuser BOOLEAN; target_createdb BOOLEAN; target_createrole BOOLEAN;
  target_replication BOOLEAN; target_bypassrls BOOLEAN; existing_sync BOOLEAN;
BEGIN
  IF required_capability NOT IN ('approve', 'sync') THEN
    RAISE EXCEPTION 'invalid trusted database capability';
  END IF;
  SELECT oid, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    INTO target_oid, target_superuser, target_createdb, target_createrole,
         target_replication, target_bypassrls
    FROM pg_roles WHERE rolname = target_database_role;
  IF target_oid IS NULL THEN RAISE EXCEPTION 'trusted database role does not exist'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_parameter_acl parameter_acl
    CROSS JOIN LATERAL aclexplode(parameter_acl.paracl) privilege
     WHERE privilege.grantee IN (0, target_oid)
  ) OR EXISTS (
    SELECT 1 FROM pg_db_role_setting setting WHERE setting.setrole = target_oid
  ) THEN
    RAISE EXCEPTION 'trusted database role has parameter privilege or role-setting drift';
  END IF;
  SELECT namespace.nspname, namespace.oid, relation.relowner
    INTO schema_name, schema_oid, owner_oid
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = 'principals'::regclass;
  SELECT EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
     WHERE identity.database_role = target_database_role
       AND identity.database_role_oid = target_oid AND identity.can_sync
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
    SELECT 1 FROM pg_auth_members membership
     WHERE target_oid IN (membership.roleid, membership.member)
       AND NOT (membership.roleid = target_oid AND membership.member = owner_oid
                AND membership.admin_option
                AND NOT membership.set_option AND NOT membership.inherit_option)
  ) THEN
    RAISE EXCEPTION 'trusted database role must be isolated from every membership and SET ROLE edge';
  END IF;
  IF required_capability = 'sync' THEN
    IF EXISTS (
      SELECT 1 FROM continuum_trusted_database_identities identity
       WHERE identity.database_role_oid = target_oid
         AND NOT (allow_existing_sync AND identity.can_sync AND NOT identity.can_approve
                  AND identity.database_role = target_database_role)
    ) THEN RAISE EXCEPTION 'sync database role already has trusted approval or mismatched authority'; END IF;
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
    IF has_table_privilege(target_database_role, format('%I.memories', schema_name), 'SELECT')
       OR has_function_privilege(target_database_role,
         format('%I.continuum_operator_reactivate_principal(uuid,uuid)', schema_name),
         'EXECUTE') THEN
      RAISE EXCEPTION 'sync database role has memory-read or operator authority';
    END IF;
  ELSE
    IF existing_sync OR has_schema_privilege(target_database_role, schema_name, 'CREATE')
       OR has_table_privilege(target_database_role, format('%I.entra_groups', schema_name), 'UPDATE')
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
  schema_name TEXT; schema_oid OID; owner_oid OID; old_identity RECORD;
  column_privilege RECORD; history_row_count INTEGER;
BEGIN
  SELECT namespace.nspname, namespace.oid, relation.relowner
    INTO schema_name, schema_oid, owner_oid
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = 'principals'::regclass;
  FOR old_identity IN
    SELECT identity.database_role_oid, identity.database_role, role.rolname
      FROM continuum_trusted_database_identities identity
      LEFT JOIN pg_roles role ON role.oid = identity.database_role_oid
     WHERE identity.can_sync AND identity.database_role_oid <> retained_role_oid
     FOR UPDATE OF identity
  LOOP
    IF old_identity.rolname IS NULL THEN
      RAISE EXCEPTION 'retired sync database role no longer resolves by OID';
    END IF;
    PERFORM continuum_require_database_identity_provenance(
      old_identity.database_role, old_identity.database_role_oid);
    PERFORM continuum_require_sync_retirement_authority(old_identity.database_role_oid);
    IF EXISTS (
      SELECT 1 FROM pg_auth_members membership
       WHERE old_identity.database_role_oid IN (membership.roleid, membership.member)
         AND NOT (membership.roleid = old_identity.database_role_oid
                  AND membership.member = owner_oid
                  AND membership.admin_option
                  AND NOT membership.set_option
                  AND NOT membership.inherit_option)
    ) OR EXISTS (
      SELECT 1 FROM pg_namespace WHERE oid = schema_oid AND nspowner = old_identity.database_role_oid
    ) OR EXISTS (
      SELECT 1 FROM pg_class WHERE relnamespace = schema_oid AND relowner = old_identity.database_role_oid
    ) OR EXISTS (
      SELECT 1 FROM pg_proc WHERE pronamespace = schema_oid AND proowner = old_identity.database_role_oid
    ) THEN RAISE EXCEPTION 'retired sync database role has membership or owns application objects'; END IF;

    INSERT INTO continuum_retired_sync_database_identities
      (database_role_oid, database_role)
    VALUES (old_identity.database_role_oid, old_identity.database_role)
    ON CONFLICT (database_role_oid) DO UPDATE SET
      database_role = EXCLUDED.database_role,
      cluster_epoch = EXCLUDED.cluster_epoch,
      retired_at = now();
    GET DIAGNOSTICS history_row_count = ROW_COUNT;
    IF history_row_count <> 1 THEN
      RAISE EXCEPTION 'terminal retirement history was not recorded';
    END IF;

    FOR column_privilege IN
      SELECT namespace.nspname, relation.relname, attribute.attname
        FROM pg_attribute attribute
        JOIN pg_class relation ON relation.oid = attribute.attrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege
       WHERE relation.relnamespace = schema_oid
         AND attribute.attnum > 0 AND NOT attribute.attisdropped
         AND attribute.attacl IS NOT NULL
         AND privilege.grantee = old_identity.database_role_oid
    LOOP
      EXECUTE format('REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM %I',
        column_privilege.attname, column_privilege.nspname,
        column_privilege.relname, old_identity.rolname);
    END LOOP;
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I',
      schema_name, old_identity.rolname);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I',
      schema_name, old_identity.rolname);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM %I',
      schema_name, old_identity.rolname);
    EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I', schema_name, old_identity.rolname);
    EXECUTE format('ALTER ROLE %I NOLOGIN PASSWORD NULL', old_identity.rolname);
    DELETE FROM continuum_trusted_database_identities
     WHERE database_role = old_identity.database_role
       AND database_role_oid = old_identity.database_role_oid
       AND can_sync AND NOT can_approve;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION continuum_retire_sync_database_identities(OID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_register_trusted_database_identity(
  target_database_role NAME, target_principal_id UUID,
  approve_capability BOOLEAN, sync_capability BOOLEAN
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE target_role_oid OID; current_epoch UUID;
BEGIN
  IF NOT (approve_capability OR sync_capability) OR (approve_capability AND sync_capability) THEN
    RAISE EXCEPTION 'exactly one trusted database capability is required';
  END IF;
  IF sync_capability THEN
    PERFORM continuum_install_sync_database_identity(target_database_role, target_principal_id);
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(834641726154302120::bigint);
  IF EXISTS (
    SELECT 1 FROM continuum_unresolved_retired_sync_database_identities
     WHERE database_role = target_database_role
       AND resolution_kind = 'restore_pending'
  ) THEN
    RAISE EXCEPTION 'restore-pending retired sync identity must be explicitly superseded before approval registration';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM principals principal
    JOIN scope_memberships membership ON membership.principal_id = principal.id
     WHERE principal.id = target_principal_id
       AND principal.kind = 'user' AND principal.disabled_at IS NULL
       AND membership.scope_id = continuum_org_scope_id()
       AND membership.source_kind = 'manual' AND membership.source_id = 'manual'
       AND membership.role = 'admin' AND membership.active
  ) THEN RAISE EXCEPTION 'operator identity must be an effective manual org administrator'; END IF;
  target_role_oid := continuum_validate_trusted_database_role(
    target_database_role, 'approve', FALSE);
  SELECT epoch INTO current_epoch
    FROM continuum_database_identity_epoch WHERE singleton;
  IF EXISTS (
    SELECT 1 FROM continuum_retired_sync_database_identities
     WHERE database_role_oid = target_role_oid
  ) OR EXISTS (
    SELECT 1 FROM continuum_unresolved_retired_sync_database_identities
     WHERE previous_database_role_oid = target_role_oid
       AND cluster_epoch = current_epoch
  ) THEN
    RAISE EXCEPTION 'previously retired sync role OID is terminal and cannot become approval authority';
  END IF;
  INSERT INTO continuum_trusted_database_identities
    (database_role, database_role_oid, principal_id, can_approve, can_sync)
  VALUES (target_database_role, target_role_oid, target_principal_id, TRUE, FALSE)
  ON CONFLICT (database_role) DO UPDATE SET
    database_role_oid = EXCLUDED.database_role_oid,
    principal_id = EXCLUDED.principal_id, can_approve = TRUE, can_sync = FALSE;
END;
$$;
REVOKE ALL ON FUNCTION continuum_register_trusted_database_identity(
  NAME, UUID, BOOLEAN, BOOLEAN) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_rotate_sync_database_identity(
  authorization_principal_id UUID, target_database_role NAME,
  target_service_principal_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Match rebind's lock order before the first registry authorization read.
  PERFORM pg_advisory_xact_lock(834641726154302119::bigint);
  PERFORM pg_advisory_xact_lock(834641726154302120::bigint);
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  PERFORM continuum_install_sync_database_identity(
    target_database_role, target_service_principal_id);
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  INSERT INTO audit_log (principal_id, action, metadata)
  VALUES (authorization_principal_id, 'write', jsonb_build_object(
    'operation', 'entra_sync_identity_rotated',
    'database_role', target_database_role::text,
    'service_principal_id', target_service_principal_id));
END;
$$;
REVOKE ALL ON FUNCTION continuum_rotate_sync_database_identity(UUID, NAME, UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_rebind_database_identity_oids(
  confirmation TEXT, oid_provenance TEXT
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  owner_oid OID;
  invoking_oid OID;
  previous_epoch UUID;
  restored_epoch UUID := gen_random_uuid();
  identity_record RECORD;
  changed_count INTEGER := 0;
BEGIN
  IF confirmation <> 'REBIND DATABASE IDENTITIES' THEN
    RAISE EXCEPTION 'database identity rebind requires exact confirmation';
  END IF;
  IF oid_provenance NOT IN ('PRESERVED OID NAMESPACE', 'FOREIGN OID NAMESPACE') THEN
    RAISE EXCEPTION 'database identity rebind requires explicit preserved or foreign OID provenance';
  END IF;
  SELECT relowner INTO owner_oid FROM pg_class WHERE oid = 'principals'::regclass;
  SELECT oid INTO invoking_oid FROM pg_roles WHERE rolname = continuum_invoking_database_role();
  IF invoking_oid IS DISTINCT FROM owner_oid THEN
    RAISE EXCEPTION 'only the migration owner may rebind database identity OIDs';
  END IF;
  PERFORM pg_advisory_xact_lock(834641726154302119::bigint);
  PERFORM pg_advisory_xact_lock(834641726154302120::bigint);
  PERFORM continuum_require_database_identity_provenance(NULL, NULL, TRUE);
  LOCK TABLE continuum_trusted_database_identities,
             continuum_retired_sync_database_identities,
             continuum_unresolved_retired_sync_database_identities,
             continuum_database_identity_epoch
    IN ACCESS EXCLUSIVE MODE;
  SELECT epoch INTO previous_epoch
    FROM continuum_database_identity_epoch WHERE singleton;
  CREATE TEMP TABLE continuum_database_role_rebind_snapshot ON COMMIT DROP AS
    SELECT oid, rolname FROM pg_roles;

  IF oid_provenance = 'PRESERVED OID NAMESPACE' THEN
    IF EXISTS (
      SELECT 1 FROM continuum_trusted_database_identities identity
      LEFT JOIN continuum_database_role_rebind_snapshot live_role
        ON live_role.oid = identity.database_role_oid
       WHERE live_role.oid IS NULL OR live_role.rolname <> identity.database_role
    ) THEN
      RAISE EXCEPTION 'preserved OID namespace does not match an active database identity';
    END IF;
    IF EXISTS (
      SELECT 1 FROM continuum_retired_sync_database_identities history
      LEFT JOIN continuum_database_role_rebind_snapshot live_by_oid
        ON live_by_oid.oid = history.database_role_oid
       WHERE (live_by_oid.oid IS NOT NULL AND live_by_oid.rolname <> history.database_role)
          OR (live_by_oid.oid IS NULL AND EXISTS (
                SELECT 1 FROM continuum_database_role_rebind_snapshot live_by_name
                 WHERE live_by_name.rolname = history.database_role))
    ) THEN
      RAISE EXCEPTION 'a retired OID was renamed or substituted in the declared preserved OID namespace';
    END IF;
    INSERT INTO continuum_unresolved_retired_sync_database_identities
      (database_role, previous_database_role_oid, resolution_kind, cluster_epoch, marked_at)
    SELECT history.database_role, history.database_role_oid, 'superseded',
           history.cluster_epoch, history.retired_at
      FROM continuum_retired_sync_database_identities history
      LEFT JOIN continuum_database_role_rebind_snapshot live_role
        ON live_role.oid = history.database_role_oid
     WHERE live_role.oid IS NULL
    ON CONFLICT (database_role, previous_database_role_oid) DO UPDATE SET
      resolution_kind = 'superseded',
      cluster_epoch = EXCLUDED.cluster_epoch,
      marked_at = LEAST(
        continuum_unresolved_retired_sync_database_identities.marked_at,
        EXCLUDED.marked_at);
    DELETE FROM continuum_retired_sync_database_identities history
     WHERE NOT EXISTS (
       SELECT 1 FROM continuum_database_role_rebind_snapshot live_role
        WHERE live_role.oid = history.database_role_oid);
    restored_epoch := previous_epoch;
  ELSE
    UPDATE continuum_database_identity_epoch
       SET epoch = restored_epoch
     WHERE singleton;
  END IF;

  CREATE TEMP TABLE continuum_active_identity_rebind_plan ON COMMIT DROP AS
    SELECT bound_identity.database_role,
           bound_identity.database_role_oid AS previous_oid,
           role.oid AS restored_oid, bound_identity.principal_id,
           bound_identity.can_approve, bound_identity.can_sync,
           bound_identity.created_at
      FROM continuum_trusted_database_identities bound_identity
      LEFT JOIN continuum_database_role_rebind_snapshot role
        ON role.rolname = bound_identity.database_role;
  IF EXISTS (SELECT 1 FROM continuum_active_identity_rebind_plan WHERE restored_oid IS NULL) THEN
    RAISE EXCEPTION 'one or more trusted database roles do not exist after restore';
  END IF;
  IF EXISTS (
    SELECT restored_oid FROM continuum_active_identity_rebind_plan
     GROUP BY restored_oid HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'restored database role OIDs are not unique';
  END IF;
  IF EXISTS (
    SELECT 1 FROM continuum_unresolved_retired_sync_database_identities unresolved
    JOIN continuum_active_identity_rebind_plan active
      ON active.database_role = unresolved.database_role
     WHERE unresolved.resolution_kind = 'restore_pending'
  ) THEN
    RAISE EXCEPTION 'restore-pending identity must be explicitly superseded before rebind';
  END IF;
  SELECT count(*) INTO changed_count
    FROM continuum_active_identity_rebind_plan WHERE restored_oid <> previous_oid;
  DELETE FROM continuum_trusted_database_identities;
  INSERT INTO continuum_trusted_database_identities
    (database_role, database_role_oid, principal_id, can_approve, can_sync, created_at)
  SELECT database_role, restored_oid, principal_id, can_approve, can_sync, created_at
    FROM continuum_active_identity_rebind_plan;

  IF oid_provenance = 'FOREIGN OID NAMESPACE' THEN
    INSERT INTO continuum_unresolved_retired_sync_database_identities
      (database_role, previous_database_role_oid, resolution_kind, cluster_epoch, marked_at)
    SELECT history.database_role, history.database_role_oid, 'superseded',
           history.cluster_epoch, history.retired_at
      FROM continuum_retired_sync_database_identities history
      JOIN continuum_active_identity_rebind_plan active
        ON active.database_role = history.database_role
    ON CONFLICT (database_role, previous_database_role_oid) DO UPDATE SET
      resolution_kind = 'superseded',
      cluster_epoch = EXCLUDED.cluster_epoch,
      marked_at = LEAST(
        continuum_unresolved_retired_sync_database_identities.marked_at,
        EXCLUDED.marked_at);
    DELETE FROM continuum_retired_sync_database_identities history
     USING continuum_active_identity_rebind_plan active
     WHERE history.database_role = active.database_role;
  END IF;

  CREATE TEMP TABLE continuum_unresolved_identity_rebind_plan ON COMMIT DROP AS
    SELECT unresolved.database_role, unresolved.previous_database_role_oid,
           unresolved.marked_at, role.oid AS restored_oid
      FROM continuum_unresolved_retired_sync_database_identities unresolved
      JOIN continuum_database_role_rebind_snapshot role
        ON role.rolname = unresolved.database_role
      LEFT JOIN continuum_active_identity_rebind_plan active
        ON active.database_role = unresolved.database_role
      LEFT JOIN continuum_retired_sync_database_identities current_history
        ON current_history.database_role = unresolved.database_role
     WHERE active.database_role IS NULL
       AND current_history.database_role IS NULL
       AND unresolved.resolution_kind = 'restore_pending'
       AND oid_provenance = 'FOREIGN OID NAMESPACE';
  IF EXISTS (
    SELECT database_role FROM continuum_unresolved_identity_rebind_plan
     GROUP BY database_role HAVING count(*) <> 1
  ) OR EXISTS (
    SELECT restored_oid FROM continuum_unresolved_identity_rebind_plan
     GROUP BY restored_oid HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'unresolved retired database identity restore mapping is ambiguous';
  END IF;

  CREATE TEMP TABLE continuum_retired_identity_rebind_plan ON COMMIT DROP AS
    SELECT history.database_role, history.database_role_oid AS previous_oid,
           role.oid AS restored_oid, history.retired_at, history.cluster_epoch
      FROM continuum_retired_sync_database_identities history
      LEFT JOIN continuum_database_role_rebind_snapshot role
        ON role.rolname = history.database_role;
  IF EXISTS (
    SELECT database_role FROM continuum_retired_identity_rebind_plan
     GROUP BY database_role HAVING count(*) <> 1
  ) OR EXISTS (
    SELECT restored_oid FROM continuum_retired_identity_rebind_plan
     WHERE restored_oid IS NOT NULL GROUP BY restored_oid HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'retired database identity restore mapping is ambiguous';
  END IF;
  IF EXISTS (
    SELECT 1 FROM continuum_retired_identity_rebind_plan retired
    JOIN continuum_active_identity_rebind_plan active
      ON active.restored_oid = retired.restored_oid
  ) OR EXISTS (
    SELECT 1 FROM continuum_unresolved_identity_rebind_plan unresolved
    JOIN continuum_active_identity_rebind_plan active
      ON active.restored_oid = unresolved.restored_oid
  ) OR EXISTS (
    SELECT 1 FROM continuum_unresolved_identity_rebind_plan unresolved
    JOIN continuum_retired_identity_rebind_plan retired
      ON retired.restored_oid = unresolved.restored_oid
  ) THEN
    RAISE EXCEPTION 'a restored database role OID cannot be both active and retired';
  END IF;
  UPDATE continuum_unresolved_retired_sync_database_identities unresolved
     SET resolution_kind = 'superseded'
    FROM continuum_retired_identity_rebind_plan plan
   WHERE unresolved.database_role = plan.database_role
     AND unresolved.resolution_kind = 'restore_pending'
     AND plan.restored_oid IS NULL;
  INSERT INTO continuum_unresolved_retired_sync_database_identities
    (database_role, previous_database_role_oid, resolution_kind, cluster_epoch)
  SELECT database_role, previous_oid, 'restore_pending', cluster_epoch
    FROM continuum_retired_identity_rebind_plan
   WHERE restored_oid IS NULL
  ON CONFLICT (database_role, previous_database_role_oid) DO UPDATE SET
    resolution_kind = 'restore_pending',
    cluster_epoch = EXCLUDED.cluster_epoch,
    marked_at = now();
  DELETE FROM continuum_unresolved_retired_sync_database_identities unresolved
   USING continuum_unresolved_identity_rebind_plan plan
   WHERE unresolved.database_role = plan.database_role
     AND unresolved.previous_database_role_oid = plan.previous_database_role_oid;
  DELETE FROM continuum_retired_sync_database_identities;
  INSERT INTO continuum_retired_sync_database_identities
    (database_role_oid, database_role, retired_at, cluster_epoch)
  SELECT restored_oid, database_role, retired_at, restored_epoch
    FROM continuum_retired_identity_rebind_plan WHERE restored_oid IS NOT NULL;
  INSERT INTO continuum_retired_sync_database_identities
    (database_role_oid, database_role, retired_at, cluster_epoch)
  SELECT restored_oid, database_role, marked_at, restored_epoch
    FROM continuum_unresolved_identity_rebind_plan;
  SELECT changed_count
       + (SELECT count(*) FROM continuum_unresolved_identity_rebind_plan)
       + (SELECT count(*) FROM continuum_retired_identity_rebind_plan
           WHERE restored_oid IS DISTINCT FROM previous_oid)
    INTO changed_count;

  FOR identity_record IN
    SELECT database_role, database_role_oid, can_sync
      FROM continuum_trusted_database_identities
  LOOP
    PERFORM continuum_require_database_identity_provenance(
      identity_record.database_role, identity_record.database_role_oid);
    PERFORM continuum_validate_trusted_database_role(
      identity_record.database_role,
      CASE WHEN identity_record.can_sync THEN 'sync' ELSE 'approve' END,
      identity_record.can_sync);
  END LOOP;
  IF EXISTS (
    SELECT oid, rolname FROM pg_roles
    EXCEPT
    SELECT oid, rolname FROM continuum_database_role_rebind_snapshot
  ) OR EXISTS (
    SELECT oid, rolname FROM continuum_database_role_rebind_snapshot
    EXCEPT
    SELECT oid, rolname FROM pg_roles
  ) THEN
    RAISE EXCEPTION 'database role catalog changed during identity rebind';
  END IF;
  RETURN changed_count;
END;
$$;
REVOKE ALL ON FUNCTION continuum_rebind_database_identity_oids(TEXT, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_assert_operator_role_allowlist(
  target_database_role NAME
) RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE target_oid OID := (SELECT oid FROM pg_roles WHERE rolname = target_database_role);
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
     WHERE identity.database_role = target_database_role
       AND identity.database_role_oid = target_oid
       AND identity.can_approve AND NOT identity.can_sync
  ) THEN
    RAISE EXCEPTION 'operator role is not role-name/OID-bound approval-only authority';
  END IF;
  PERFORM continuum_assert_application_role_allowlist(target_database_role, TRUE);
END;
$$;
REVOKE ALL ON FUNCTION continuum_assert_operator_role_allowlist(NAME) FROM PUBLIC;

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT function.proname, pg_get_function_identity_arguments(function.oid) AS arguments
      FROM pg_proc function
     WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
       AND function.proname = ANY(ARRAY[
         'continuum_database_identity_provenance',
         'continuum_require_database_identity_provenance',
         'continuum_require_trusted_database_identity',
         'continuum_validate_entra_guard_markers',
         'continuum_guard_entra_admin_sources',
         'continuum_validate_trusted_database_role',
         'continuum_retire_sync_database_identities',
         'continuum_register_trusted_database_identity',
         'continuum_rotate_sync_database_identity',
         'continuum_rebind_database_identity_oids',
         'continuum_assert_operator_role_allowlist'
       ])
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, %I, pg_temp',
      schema_name, function_record.proname, function_record.arguments, schema_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC',
      schema_name, function_record.proname, function_record.arguments);
  END LOOP;
END;
$harden$;
