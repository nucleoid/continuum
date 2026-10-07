-- Close independent exact-head findings without rewriting application data.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 0046/0047 stored role names and could leave broad sync grants behind. Refuse
-- ambiguous states, preserve every approve-only operator, and remove only the
-- single unambiguous sync-only identity before installing the OID-bound model.
DO $upgrade$
DECLARE
  schema_name TEXT := current_schema();
  sync_identity RECORD;
  sync_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities
     WHERE can_approve AND can_sync
  ) THEN
    RAISE EXCEPTION 'unsafe mixed approve+sync database identity requires manual review';
  END IF;
  SELECT count(*)::integer INTO sync_count
    FROM continuum_trusted_database_identities WHERE can_sync;
  IF sync_count > 1 THEN
    RAISE EXCEPTION 'unsafe multiple legacy sync authorities require manual review';
  END IF;
  FOR sync_identity IN
    SELECT identity.database_role, role.oid AS current_oid
      FROM continuum_trusted_database_identities identity
      LEFT JOIN pg_roles role ON role.rolname = identity.database_role
     WHERE identity.can_sync AND NOT identity.can_approve
  LOOP
    IF sync_identity.current_oid IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM pg_auth_members membership
         WHERE membership.member = sync_identity.current_oid
      ) OR EXISTS (
        SELECT 1 FROM pg_namespace namespace
         WHERE namespace.oid = quote_ident(schema_name)::regnamespace
           AND namespace.nspowner = sync_identity.current_oid
      ) OR EXISTS (
        SELECT 1 FROM pg_class relation
         WHERE relation.relnamespace = quote_ident(schema_name)::regnamespace
           AND relation.relowner = sync_identity.current_oid
      ) OR EXISTS (
        SELECT 1 FROM pg_proc function
         WHERE function.pronamespace = quote_ident(schema_name)::regnamespace
           AND function.proowner = sync_identity.current_oid
      ) THEN
        RAISE EXCEPTION 'unsafe legacy sync authority inherits privileges or owns application objects';
      END IF;
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I',
        schema_name, sync_identity.database_role);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I',
        schema_name, sync_identity.database_role);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM %I',
        schema_name, sync_identity.database_role);
      EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I',
        schema_name, sync_identity.database_role);
    END IF;
    DELETE FROM continuum_trusted_database_identities
     WHERE database_role = sync_identity.database_role
       AND can_sync AND NOT can_approve;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
    LEFT JOIN pg_roles role ON role.rolname = identity.database_role
     WHERE identity.can_approve AND role.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'dropped operator database role requires explicit reviewed cleanup';
  END IF;
END;
$upgrade$;

ALTER TABLE continuum_trusted_database_identities
  ADD COLUMN database_role_oid OID;
UPDATE continuum_trusted_database_identities identity
   SET database_role_oid = role.oid
  FROM pg_roles role
 WHERE role.rolname = identity.database_role;
ALTER TABLE continuum_trusted_database_identities
  ALTER COLUMN database_role_oid SET NOT NULL,
  ADD CONSTRAINT continuum_trusted_database_identities_role_oid_key
    UNIQUE (database_role_oid),
  ADD CONSTRAINT continuum_trusted_database_identities_separate_capabilities
    CHECK (NOT (can_approve AND can_sync));

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
  SELECT oid INTO target_role_oid FROM pg_roles WHERE rolname = target_database_role;
  IF target_role_oid IS NULL THEN
    RAISE EXCEPTION 'trusted database role does not exist';
  END IF;
  IF sync_capability AND NOT EXISTS (
    SELECT 1 FROM principals p WHERE p.id = target_principal_id
      AND p.kind = 'service' AND p.disabled_at IS NULL
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
    (database_role, database_role_oid, principal_id, can_approve, can_sync)
  VALUES (target_database_role, target_role_oid, target_principal_id,
          approve_capability, sync_capability)
  ON CONFLICT (database_role) DO UPDATE SET
    database_role_oid = EXCLUDED.database_role_oid,
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
  invoking_role_oid OID;
  owner_oid OID;
BEGIN
  SELECT oid INTO invoking_role_oid FROM pg_roles WHERE rolname = invoking_role;
  SELECT relowner INTO owner_oid FROM pg_class WHERE oid = 'principals'::regclass;
  IF invoking_role_oid = owner_oid THEN RETURN; END IF;
  IF invoking_role_oid IS NULL OR required_capability NOT IN ('approve', 'sync')
     OR NOT EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
    JOIN principals p ON p.id = identity.principal_id
     WHERE identity.database_role_oid = invoking_role_oid
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
           END
  ) THEN
    RAISE EXCEPTION 'operation requires a DB-bound trusted % identity', required_capability;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_require_trusted_database_identity(UUID, TEXT) FROM PUBLIC;

CREATE TABLE continuum_entra_guarded_mutations (
  external_id TEXT NOT NULL,
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('deactivate', 'quarantine', 'revoke')),
  backend_pid INTEGER NOT NULL,
  transaction_id BIGINT NOT NULL,
  authorization_principal_id UUID NOT NULL REFERENCES principals(id),
  PRIMARY KEY (external_id, mutation_kind, backend_pid, transaction_id)
);
REVOKE ALL ON TABLE continuum_entra_guarded_mutations FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_guard_entra_admin_sources()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  table_owner OID;
  invoking_role NAME := continuum_invoking_database_role();
  invoking_role_oid OID;
  trusted_sync BOOLEAN := FALSE;
  has_reapproval BOOLEAN := FALSE;
  has_guarded_deactivation BOOLEAN := FALSE;
  has_guarded_quarantine BOOLEAN := FALSE;
  has_guarded_revocation BOOLEAN := FALSE;
BEGIN
  -- A binding's immutable provider identity is never rewritten. Guarded
  -- reapproval updates the approved target and metadata, not external_id.
  IF TG_TABLE_NAME = 'entra_groups' THEN
    IF TG_OP = 'UPDATE' AND OLD.external_id IS DISTINCT FROM NEW.external_id THEN
      RAISE EXCEPTION 'Entra group external_id is immutable';
    END IF;
  END IF;
  SELECT relowner INTO table_owner FROM pg_class WHERE oid = TG_RELID;
  SELECT oid INTO invoking_role_oid FROM pg_roles WHERE rolname = invoking_role;
  IF invoking_role_oid = table_owner THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
    JOIN principals p ON p.id = identity.principal_id
     WHERE identity.database_role_oid = invoking_role_oid AND identity.can_sync
       AND p.kind = 'service' AND p.disabled_at IS NULL
  ) INTO trusted_sync;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'entra_groups' THEN
      SELECT bool_or(mutation_kind = 'deactivate'),
             bool_or(mutation_kind = 'quarantine'), bool_or(mutation_kind = 'revoke')
        INTO has_guarded_deactivation, has_guarded_quarantine, has_guarded_revocation
        FROM continuum_entra_guarded_mutations mutation
       WHERE mutation.external_id = NEW.external_id
         AND mutation.backend_pid = pg_backend_pid()
         AND mutation.transaction_id = txid_current();
    ELSE
      SELECT bool_or(mutation_kind = 'deactivate'),
             bool_or(mutation_kind = 'quarantine'), bool_or(mutation_kind = 'revoke')
        INTO has_guarded_deactivation, has_guarded_quarantine, has_guarded_revocation
        FROM continuum_entra_guarded_mutations mutation
       WHERE mutation.external_id = NEW.source_id
         AND mutation.backend_pid = pg_backend_pid()
         AND mutation.transaction_id = txid_current();
    END IF;
  END IF;
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
      IF TG_OP = 'UPDATE'
         AND (OLD.approval_revoked_by IS DISTINCT FROM NEW.approval_revoked_by
              OR OLD.approval_revoked_at IS DISTINCT FROM NEW.approval_revoked_at)
         AND NOT COALESCE(has_guarded_revocation, FALSE)
         AND NOT has_reapproval THEN
        RAISE EXCEPTION 'Entra binding revocation requires the guarded operator function';
      END IF;
      IF TG_OP = 'UPDATE'
         AND (OLD.quarantined_at IS DISTINCT FROM NEW.quarantined_at
              OR OLD.quarantine_reason IS DISTINCT FROM NEW.quarantine_reason)
         AND NOT COALESCE(has_guarded_quarantine, FALSE)
         AND NOT has_reapproval THEN
        RAISE EXCEPTION 'Entra binding quarantine requires the guarded sync function';
      END IF;
      IF TG_OP = 'UPDATE' AND OLD.active AND NOT NEW.active
         AND NOT (COALESCE(has_guarded_deactivation, FALSE)
                  OR COALESCE(has_guarded_quarantine, FALSE)
                  OR COALESCE(has_guarded_revocation, FALSE)) THEN
        RAISE EXCEPTION 'Entra binding deactivation requires a guarded function';
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
    IF TG_OP = 'UPDATE' AND OLD.source_kind = 'entra' AND OLD.active AND NOT NEW.active
       AND NOT (COALESCE(has_guarded_deactivation, FALSE)
                OR COALESCE(has_guarded_quarantine, FALSE)
                OR COALESCE(has_guarded_revocation, FALSE)) THEN
      RAISE EXCEPTION 'Entra membership deactivation requires a guarded function';
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
  INSERT INTO continuum_entra_guarded_mutations
    (external_id, mutation_kind, backend_pid, transaction_id, authorization_principal_id)
  SELECT DISTINCT membership.source_id, 'deactivate', pg_backend_pid(), txid_current(),
         authorization_principal_id
    FROM scope_memberships membership
   WHERE membership.source_kind = 'entra' AND membership.active
     AND (group_external_ids IS NULL OR membership.source_id = ANY(group_external_ids))
  ON CONFLICT DO NOTHING;
  UPDATE scope_memberships SET active = FALSE,
         deactivated_at = COALESCE(deactivated_at, now()), synced_at = now()
   WHERE source_kind = 'entra' AND active
     AND (group_external_ids IS NULL OR source_id = ANY(group_external_ids))
     AND (retained_principal_ids IS NULL
          OR NOT (principal_id = ANY(retained_principal_ids)));
  GET DIAGNOSTICS changed = ROW_COUNT;
  DELETE FROM continuum_entra_guarded_mutations mutation
   WHERE mutation.mutation_kind = 'deactivate'
     AND mutation.backend_pid = pg_backend_pid()
     AND mutation.transaction_id = txid_current()
     AND mutation.authorization_principal_id = $1;
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
  INSERT INTO continuum_entra_guarded_mutations
    (external_id, mutation_kind, backend_pid, transaction_id, authorization_principal_id)
  SELECT external_id, 'deactivate', pg_backend_pid(), txid_current(),
         authorization_principal_id
    FROM unnest(group_external_ids) external_id
  ON CONFLICT DO NOTHING;
  UPDATE entra_groups SET active = FALSE,
         deactivated_at = COALESCE(deactivated_at, now())
   WHERE active AND external_id = ANY(group_external_ids);
  GET DIAGNOSTICS changed = ROW_COUNT;
  DELETE FROM continuum_entra_guarded_mutations mutation
   WHERE mutation.mutation_kind = 'deactivate'
     AND mutation.backend_pid = pg_backend_pid()
     AND mutation.transaction_id = txid_current()
     AND mutation.authorization_principal_id = $1;
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
  INSERT INTO continuum_entra_guarded_mutations
    (external_id, mutation_kind, backend_pid, transaction_id, authorization_principal_id)
  VALUES (group_external_id, 'quarantine', pg_backend_pid(), txid_current(),
          authorization_principal_id)
  ON CONFLICT DO NOTHING;
  SELECT active INTO was_active FROM entra_groups
   WHERE external_id = group_external_id AND approval_revoked_at IS NULL;
  UPDATE entra_groups SET active = FALSE,
         deactivated_at = COALESCE(deactivated_at, now()),
         quarantined_at = COALESCE(quarantined_at, now()),
         quarantine_reason = quarantine_code
   WHERE external_id = group_external_id AND approval_revoked_at IS NULL;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  DELETE FROM continuum_entra_guarded_mutations mutation
   WHERE mutation.external_id = group_external_id
     AND mutation.mutation_kind = 'quarantine'
     AND mutation.backend_pid = pg_backend_pid()
     AND mutation.transaction_id = txid_current();
  RETURN changed_count > 0 AND COALESCE(was_active, FALSE);
END;
$$;
REVOKE ALL ON FUNCTION continuum_sync_quarantine_entra_group(UUID, TEXT, TEXT) FROM PUBLIC;

CREATE FUNCTION continuum_operator_revoke_entra_group_binding(
  authorization_principal_id UUID, group_external_id TEXT
) RETURNS TABLE(scope_id UUID, binding_role TEXT, memberships_deactivated INTEGER)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  target_scope_id UUID;
  target_role TEXT;
  changed INTEGER;
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  IF NOT EXISTS (
    SELECT 1 FROM principals principal
    JOIN scope_memberships membership ON membership.principal_id = principal.id
    JOIN scopes scope ON scope.id = membership.scope_id
     WHERE principal.id = authorization_principal_id
       AND principal.kind = 'user' AND principal.disabled_at IS NULL
       AND scope.kind = 'org' AND scope.name = ''
       AND membership.source_kind = 'manual' AND membership.source_id = 'manual'
       AND membership.role = 'admin' AND membership.active
  ) THEN
    RAISE EXCEPTION 'binding revocation requires an effective manual org administrator';
  END IF;
  PERFORM pg_advisory_xact_lock(834641726154302119::bigint);
  SELECT binding.scope_id, binding.role INTO target_scope_id, target_role
    FROM entra_groups binding
   WHERE binding.external_id = group_external_id
     AND binding.approved_by IS NOT NULL
     AND binding.approval_revoked_at IS NULL
   FOR UPDATE;
  IF target_scope_id IS NULL THEN RETURN; END IF;
  INSERT INTO continuum_entra_guarded_mutations
    (external_id, mutation_kind, backend_pid, transaction_id, authorization_principal_id)
  VALUES (group_external_id, 'revoke', pg_backend_pid(), txid_current(),
          authorization_principal_id);
  UPDATE scope_memberships SET active = FALSE,
         deactivated_at = COALESCE(deactivated_at, now()), synced_at = now()
   WHERE source_kind = 'entra' AND source_id = group_external_id AND active;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF NOT EXISTS (
    SELECT 1 FROM scope_memberships membership
    JOIN scopes scope ON scope.id = membership.scope_id
    JOIN principals principal ON principal.id = membership.principal_id
     WHERE scope.kind = 'org' AND scope.name = ''
       AND membership.active AND membership.role = 'admin'
       AND principal.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'binding revocation cannot remove the last org administrator';
  END IF;
  UPDATE entra_groups SET active = FALSE,
         deactivated_at = COALESCE(deactivated_at, now()),
         approval_revoked_by = authorization_principal_id,
         approval_revoked_at = now()
   WHERE external_id = group_external_id;
  DELETE FROM continuum_entra_guarded_mutations mutation
   WHERE mutation.external_id = group_external_id
     AND mutation.mutation_kind = 'revoke'
     AND mutation.backend_pid = pg_backend_pid()
     AND mutation.transaction_id = txid_current();
  RETURN QUERY SELECT target_scope_id, target_role, changed;
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_revoke_entra_group_binding(UUID, TEXT) FROM PUBLIC;

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
  schema_oid OID;
  owner_oid OID;
  target_oid OID;
  target_superuser BOOLEAN;
  target_createrole BOOLEAN;
  target_bypassrls BOOLEAN;
  old_identity RECORD;
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  -- Match sync/offboarding lock order before the admin/operator safety lock.
  PERFORM pg_advisory_xact_lock(834641726154302119::bigint);
  PERFORM pg_advisory_xact_lock(834641726154302120::bigint);
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');

  SELECT oid, rolsuper, rolcreaterole, rolbypassrls
    INTO target_oid, target_superuser, target_createrole, target_bypassrls FROM pg_roles
   WHERE rolname = target_database_role;
  IF target_oid IS NULL THEN
    RAISE EXCEPTION 'sync database role must be an existing role';
  END IF;
  SELECT namespace.nspname, namespace.oid, relation.relowner
    INTO schema_name, schema_oid, owner_oid
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = 'principals'::regclass;
  IF target_superuser OR target_createrole OR target_bypassrls OR target_oid = owner_oid
     OR has_schema_privilege(target_database_role, schema_name, 'CREATE')
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE oid = schema_oid AND nspowner = target_oid)
     OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = schema_oid
                 AND relowner = target_oid)
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = schema_oid
                 AND proowner = target_oid) THEN
    RAISE EXCEPTION 'sync database role must be isolated and cannot have privileged attributes, schema CREATE, or ownership';
  END IF;
  IF EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
     WHERE identity.database_role_oid = target_oid
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members membership
     WHERE target_oid IN (membership.roleid, membership.member)
  ) THEN
    RAISE EXCEPTION 'sync database role must be isolated from every membership and SET ROLE edge';
  END IF;
  IF EXISTS (
       SELECT 1 FROM pg_class relation
        WHERE relation.relnamespace = schema_oid
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND has_table_privilege(target_database_role, relation.oid,
                'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     ) OR has_table_privilege(target_database_role,
       format('%I.memories', schema_name), 'SELECT')
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
  EXECUTE format('REVOKE UPDATE ON TABLE %I.scope_memberships, %I.entra_groups FROM %I',
    schema_name, schema_name, target_database_role);

  FOR old_identity IN
    SELECT identity.database_role, identity.database_role_oid,
           role.rolname AS current_role_name
      FROM continuum_trusted_database_identities identity
      LEFT JOIN pg_roles role ON role.oid = identity.database_role_oid
     WHERE identity.can_sync AND identity.database_role_oid <> target_oid
     FOR UPDATE OF identity
  LOOP
    IF old_identity.current_role_name IS NOT NULL AND (
      EXISTS (SELECT 1 FROM pg_auth_members membership
               WHERE membership.member = old_identity.database_role_oid)
      OR EXISTS (SELECT 1 FROM pg_namespace namespace
                  WHERE namespace.oid = schema_oid
                    AND namespace.nspowner = old_identity.database_role_oid)
      OR EXISTS (SELECT 1 FROM pg_class relation
                  WHERE relation.relnamespace = schema_oid
                    AND relation.relowner = old_identity.database_role_oid)
      OR EXISTS (SELECT 1 FROM pg_proc function
                  WHERE function.pronamespace = schema_oid
                    AND function.proowner = old_identity.database_role_oid)
    ) THEN
      RAISE EXCEPTION 'rotated sync role inherits authority or owns application objects';
    END IF;
    DELETE FROM continuum_trusted_database_identities
     WHERE database_role_oid = old_identity.database_role_oid
       AND can_sync AND NOT can_approve;
    IF old_identity.current_role_name IS NOT NULL THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I',
        schema_name, old_identity.current_role_name);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I',
        schema_name, old_identity.current_role_name);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM %I',
        schema_name, old_identity.current_role_name);
      EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I',
        schema_name, old_identity.current_role_name);
    END IF;
  END LOOP;

  INSERT INTO continuum_trusted_database_identities
    (database_role, database_role_oid, principal_id, can_approve, can_sync)
  VALUES (target_database_role, target_oid, target_service_principal_id, FALSE, TRUE)
  ON CONFLICT (database_role) DO UPDATE SET
    database_role_oid = EXCLUDED.database_role_oid,
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
        'continuum_register_trusted_database_identity',
        'continuum_require_trusted_database_identity',
        'continuum_guard_entra_admin_sources',
        'continuum_sync_observe_entra_group',
        'continuum_sync_deactivate_entra_memberships',
        'continuum_sync_deactivate_entra_groups',
        'continuum_sync_quarantine_entra_group',
        'continuum_operator_revoke_entra_group_binding',
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
