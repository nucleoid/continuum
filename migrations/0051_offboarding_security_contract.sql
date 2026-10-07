-- Forward-only repair for databases that already ledgered earlier 0048-0050 variants.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Preflight must run before any maintenance-window change. The migration owner
-- must own (or inherit the effective owner role for) the application schema,
-- and directly own every application object that this repair replaces.
-- ALTER ROLE ... NOLOGIN also requires SUPERUSER, or CREATEROLE plus
-- ADMIN OPTION on each bound sync role under supported PostgreSQL 16 semantics.
DO $preflight$
DECLARE
  schema_oid OID := quote_ident(current_schema())::regnamespace;
  owner_oid OID;
  migration_role_oid OID := current_user::regrole::oid;
  owner_superuser BOOLEAN;
  owner_createrole BOOLEAN;
BEGIN
  SELECT namespace.nspowner INTO owner_oid
    FROM pg_namespace namespace WHERE namespace.oid = schema_oid;
  IF NOT pg_has_role(current_user, owner_oid, 'USAGE') THEN
    RAISE EXCEPTION 'migration owner must own or inherit the application schema owner role before 0051';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class relation
     WHERE relation.relnamespace = schema_oid
       AND relation.relowner <> current_user::regrole::oid
  ) OR EXISTS (
    SELECT 1 FROM pg_proc function
     WHERE function.pronamespace = schema_oid
       AND function.proowner <> current_user::regrole::oid
       -- Extension-owned routines are controlled by their extension owner on
       -- managed PostgreSQL. Continuum handles them explicitly below.
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend dependency
          WHERE dependency.classid = 'pg_proc'::regclass
            AND dependency.objid = function.oid
            AND dependency.refclassid = 'pg_extension'::regclass
            AND dependency.deptype = 'e'
       )
  ) THEN
    RAISE EXCEPTION 'migration owner must own every application table, sequence, index, and function before 0051';
  END IF;
  SELECT rolsuper, rolcreaterole INTO owner_superuser, owner_createrole
    FROM pg_roles WHERE oid = migration_role_oid;
  IF EXISTS (SELECT 1 FROM continuum_trusted_database_identities WHERE can_sync)
     AND NOT owner_superuser AND (
       NOT owner_createrole OR EXISTS (
         SELECT 1 FROM continuum_trusted_database_identities identity
          WHERE identity.can_sync AND NOT EXISTS (
            SELECT 1 FROM pg_auth_members membership
             WHERE membership.roleid = identity.database_role_oid
               AND membership.member = migration_role_oid AND membership.admin_option
               AND NOT membership.set_option AND NOT membership.inherit_option
          )
       )
     ) THEN
    RAISE EXCEPTION 'migration owner requires CREATEROLE and ADMIN OPTION on every sync role for ALTER ROLE NOLOGIN';
  END IF;
END;
$preflight$;

-- REASSERT_0049
CREATE UNIQUE INDEX IF NOT EXISTS continuum_trusted_database_identities_one_sync
  ON continuum_trusted_database_identities ((can_sync)) WHERE can_sync;

DO $public_acl$
DECLARE schema_name TEXT := current_schema(); function_signature TEXT;
BEGIN
  EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM PUBLIC', schema_name);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM PUBLIC', schema_name);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM PUBLIC', schema_name);
  FOR function_signature IN
    SELECT format('%I.%I(%s)', namespace.nspname, function.proname,
                  pg_get_function_identity_arguments(function.oid))
      FROM pg_proc function
      JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
     WHERE namespace.nspname = current_schema()
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend dependency
          WHERE dependency.classid = 'pg_proc'::regclass
            AND dependency.objid = function.oid
            AND dependency.refclassid = 'pg_extension'::regclass
            AND dependency.deptype = 'e'
       )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', function_signature);
  END LOOP;
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON TABLES FROM PUBLIC',
    current_user, schema_name);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM PUBLIC',
    current_user, schema_name);
  -- Function EXECUTE defaults are global per creating role. IN SCHEMA cannot
  -- remove PostgreSQL's built-in PUBLIC default; close it globally instead.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    current_user);
END;
$public_acl$;

CREATE TABLE IF NOT EXISTS continuum_principal_disable_requests (
  target_principal_id UUID NOT NULL REFERENCES principals(id),
  authorization_principal_id UUID NOT NULL REFERENCES principals(id),
  backend_pid INTEGER NOT NULL,
  transaction_id BIGINT NOT NULL,
  PRIMARY KEY (target_principal_id, backend_pid, transaction_id)
);
REVOKE ALL ON TABLE continuum_principal_disable_requests FROM PUBLIC;

ALTER TABLE continuum_entra_guarded_mutations
  DROP CONSTRAINT IF EXISTS continuum_entra_guarded_mutations_mutation_kind_check;
ALTER TABLE continuum_entra_guarded_mutations
  ADD CONSTRAINT continuum_entra_guarded_mutations_mutation_kind_check
  CHECK (mutation_kind IN ('deactivate', 'quarantine', 'revoke', 'delete'));

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
     WHERE identity.database_role_oid = invoking_role_oid
       AND identity.principal_id = claimed_principal_id
       AND principal.disabled_at IS NULL
       AND CASE required_capability
             WHEN 'approve' THEN identity.can_approve AND principal.kind = 'user'
               AND EXISTS (
                 SELECT 1 FROM scope_memberships membership
                 JOIN scopes scope ON scope.id = membership.scope_id
                  WHERE membership.principal_id = principal.id
                    AND scope.kind = 'org' AND scope.name = ''
                    AND membership.source_kind = 'manual'
                    AND membership.source_id = 'manual'
                    AND membership.role = 'admin' AND membership.active)
             WHEN 'sync' THEN identity.can_sync AND principal.kind = 'service'
             ELSE FALSE
           END
  ) THEN
    RAISE EXCEPTION 'operation requires a DB-bound trusted % identity', required_capability;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_require_trusted_database_identity(UUID, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_protect_last_manual_org_admin_principal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  owner_oid OID;
  authorization_principal UUID;
  protected_principal BOOLEAN;
BEGIN
  IF NOT (OLD.disabled_at IS NULL
          AND (TG_OP = 'DELETE' OR NEW.disabled_at IS NOT NULL)) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  PERFORM pg_advisory_xact_lock(834641726154302120::bigint);
  SELECT relowner INTO owner_oid FROM pg_class WHERE oid = 'principals'::regclass;
  SELECT EXISTS (
    SELECT 1 FROM scope_memberships membership
    JOIN scopes scope ON scope.id = membership.scope_id
     WHERE membership.principal_id = OLD.id
       AND scope.kind = 'org' AND scope.name = ''
       AND membership.source_kind = 'manual' AND membership.source_id = 'manual'
       AND membership.active AND membership.role = 'admin'
    UNION ALL
    SELECT 1 FROM continuum_trusted_database_identities identity
     WHERE identity.principal_id = OLD.id AND identity.can_approve
  ) INTO protected_principal;
  IF protected_principal AND continuum_invoking_database_role()::regrole::oid <> owner_oid THEN
    SELECT request.authorization_principal_id INTO authorization_principal
      FROM continuum_principal_disable_requests request
     WHERE request.target_principal_id = OLD.id
       AND request.backend_pid = pg_backend_pid()
       AND request.transaction_id = txid_current();
    IF authorization_principal IS NULL THEN
      RAISE EXCEPTION 'manual administrator and bound operator disable requires the guarded approve path';
    END IF;
    PERFORM continuum_require_trusted_database_identity(authorization_principal, 'approve');
  END IF;
  IF EXISTS (
    SELECT 1 FROM scope_memberships membership
    JOIN scopes scope ON scope.id = membership.scope_id
     WHERE membership.principal_id = OLD.id
       AND scope.kind = 'org' AND scope.name = ''
       AND membership.source_kind = 'manual' AND membership.source_id = 'manual'
       AND membership.active AND membership.role = 'admin'
  ) AND NOT EXISTS (
    SELECT 1 FROM scope_memberships membership
    JOIN scopes scope ON scope.id = membership.scope_id
    JOIN principals principal ON principal.id = membership.principal_id
     WHERE scope.kind = 'org' AND scope.name = ''
       AND membership.source_kind = 'manual' AND membership.source_id = 'manual'
       AND membership.active AND membership.role = 'admin'
       AND principal.disabled_at IS NULL AND principal.id <> OLD.id
  ) THEN
    RAISE EXCEPTION 'cannot remove the last effective manual org administrator';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION continuum_protect_last_manual_org_admin_principal() FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_disable_principal(
  authorization_principal_id UUID, target_principal_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_variable
DECLARE protected_principal BOOLEAN; changed_count INTEGER;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM scope_memberships membership
    JOIN scopes scope ON scope.id = membership.scope_id
     WHERE membership.principal_id = target_principal_id
       AND scope.kind = 'org' AND scope.name = ''
       AND membership.source_kind = 'manual' AND membership.source_id = 'manual'
       AND membership.active AND membership.role = 'admin'
    UNION ALL
    SELECT 1 FROM continuum_trusted_database_identities identity
     WHERE identity.principal_id = target_principal_id AND identity.can_approve
  ) INTO protected_principal;
  IF protected_principal THEN
    PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  END IF;
  INSERT INTO continuum_principal_disable_requests
    (target_principal_id, authorization_principal_id, backend_pid, transaction_id)
  VALUES (target_principal_id, authorization_principal_id, pg_backend_pid(), txid_current())
  ON CONFLICT ON CONSTRAINT continuum_principal_disable_requests_pkey DO UPDATE SET
    authorization_principal_id = EXCLUDED.authorization_principal_id;
  UPDATE principals SET disabled_at = now()
   WHERE id = target_principal_id AND disabled_at IS NULL;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  DELETE FROM continuum_principal_disable_requests request
   WHERE request.target_principal_id = target_principal_id
     AND request.backend_pid = pg_backend_pid()
     AND request.transaction_id = txid_current();
  RETURN changed_count = 1;
END;
$$;
REVOKE ALL ON FUNCTION continuum_disable_principal(UUID, UUID) FROM PUBLIC;

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
  IF TG_TABLE_NAME = 'entra_groups' THEN
    IF TG_OP = 'UPDATE' AND OLD.external_id IS DISTINCT FROM NEW.external_id THEN
      RAISE EXCEPTION 'Entra group external_id is immutable';
    END IF;
  END IF;
  SELECT relowner INTO table_owner FROM pg_class WHERE oid = TG_RELID;
  SELECT oid INTO invoking_role_oid FROM pg_roles WHERE rolname = invoking_role;
  IF invoking_role_oid = table_owner THEN RETURN NEW; END IF;
  SELECT EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
    JOIN principals principal ON principal.id = identity.principal_id
     WHERE identity.database_role_oid = invoking_role_oid AND identity.can_sync
       AND principal.kind = 'service' AND principal.disabled_at IS NULL
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
    SELECT EXISTS (
      SELECT 1 FROM continuum_entra_reapproval_requests request
       WHERE request.external_id = NEW.external_id
         AND request.backend_pid = pg_backend_pid()
         AND request.transaction_id = txid_current()
    ) INTO has_reapproval;
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

CREATE OR REPLACE FUNCTION continuum_guard_entra_membership_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE owner_oid OID; authorization_principal UUID;
BEGIN
  IF OLD.source_kind <> 'entra' THEN RETURN OLD; END IF;
  SELECT relowner INTO owner_oid FROM pg_class WHERE oid = TG_RELID;
  IF continuum_invoking_database_role()::regrole::oid = owner_oid THEN RETURN OLD; END IF;
  SELECT mutation.authorization_principal_id INTO authorization_principal
    FROM continuum_entra_guarded_mutations mutation
   WHERE mutation.external_id = OLD.source_id
     AND mutation.mutation_kind = 'delete'
     AND mutation.backend_pid = pg_backend_pid()
     AND mutation.transaction_id = txid_current();
  IF authorization_principal IS NULL THEN
    RAISE EXCEPTION 'Entra membership deletion requires the guarded operator function';
  END IF;
  PERFORM continuum_require_trusted_database_identity(authorization_principal, 'approve');
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION continuum_guard_entra_membership_delete() FROM PUBLIC;

DROP TRIGGER IF EXISTS guard_entra_org_admin_memberships ON scope_memberships;
CREATE TRIGGER guard_entra_org_admin_memberships
BEFORE INSERT OR UPDATE ON scope_memberships FOR EACH ROW
EXECUTE FUNCTION continuum_guard_entra_admin_sources();
DROP TRIGGER IF EXISTS guard_entra_membership_deletes ON scope_memberships;
CREATE TRIGGER guard_entra_membership_deletes
BEFORE DELETE ON scope_memberships FOR EACH ROW
EXECUTE FUNCTION continuum_guard_entra_membership_delete();

CREATE OR REPLACE FUNCTION continuum_operator_remove_entra_membership(
  authorization_principal_id UUID, member_principal_id UUID,
  target_scope_id UUID, group_external_id TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE changed_count INTEGER;
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  INSERT INTO continuum_entra_guarded_mutations
    (external_id, mutation_kind, backend_pid, transaction_id, authorization_principal_id)
  VALUES (group_external_id, 'delete', pg_backend_pid(), txid_current(),
          authorization_principal_id)
  ON CONFLICT DO NOTHING;
  DELETE FROM scope_memberships membership
   WHERE membership.principal_id = member_principal_id
     AND membership.scope_id = target_scope_id
     AND membership.source_kind = 'entra'
     AND membership.source_id = group_external_id;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  DELETE FROM continuum_entra_guarded_mutations mutation
   WHERE mutation.external_id = group_external_id
     AND mutation.mutation_kind = 'delete'
     AND mutation.backend_pid = pg_backend_pid()
     AND mutation.transaction_id = txid_current()
     AND mutation.authorization_principal_id = $1;
  IF changed_count = 1 THEN
    INSERT INTO audit_log (principal_id, action, scope_id, metadata)
    VALUES (authorization_principal_id, 'write', target_scope_id, jsonb_build_object(
      'operation', 'entra_membership_removed',
      'member_principal_id', member_principal_id,
      'group_id', group_external_id));
  END IF;
  RETURN changed_count = 1;
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_remove_entra_membership(UUID, UUID, UUID, TEXT)
FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_fail_closed_on_principal_disable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE lifecycle_principal UUID := '00000000-0000-4000-8000-000000000011'::uuid;
BEGIN
  UPDATE service_api_keys SET revoked_at = COALESCE(revoked_at, now())
   WHERE principal_id = NEW.id AND revoked_at IS NULL;
  INSERT INTO continuum_entra_guarded_mutations
    (external_id, mutation_kind, backend_pid, transaction_id, authorization_principal_id)
  SELECT DISTINCT membership.source_id, 'deactivate', pg_backend_pid(), txid_current(),
         lifecycle_principal
    FROM scope_memberships membership
   WHERE membership.principal_id = NEW.id
     AND membership.source_kind = 'entra' AND membership.active
  ON CONFLICT DO NOTHING;
  UPDATE scope_memberships SET active = FALSE,
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
REVOKE ALL ON FUNCTION continuum_fail_closed_on_principal_disable() FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_assert_sync_role_allowlist(
  target_database_role NAME, target_service_principal_id UUID
) RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  schema_name TEXT;
  schema_oid OID;
  target_oid OID;
BEGIN
  SELECT namespace.nspname, namespace.oid INTO schema_name, schema_oid
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = 'principals'::regclass;
  SELECT role.oid INTO target_oid FROM pg_roles role
   WHERE role.rolname = target_database_role;
  IF target_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
    JOIN principals principal ON principal.id = identity.principal_id
     WHERE identity.database_role = target_database_role
       AND identity.database_role_oid = target_oid
       AND identity.principal_id = target_service_principal_id
       AND identity.can_sync AND NOT identity.can_approve
       AND principal.kind = 'service' AND principal.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'sync database identity binding is invalid';
  END IF;
  PERFORM continuum_validate_trusted_database_role(target_database_role, 'sync', TRUE);
  IF has_schema_privilege('public', schema_name, 'USAGE')
     OR has_schema_privilege('public', schema_name, 'CREATE') THEN
    RAISE EXCEPTION 'PUBLIC retains application schema privileges';
  END IF;
  IF NOT has_schema_privilege(target_database_role, schema_name, 'USAGE')
     OR has_schema_privilege(target_database_role, schema_name, 'CREATE') THEN
    RAISE EXCEPTION 'sync database identity schema privilege drift';
  END IF;
  IF EXISTS (
    WITH expected(object_name, privilege_type) AS (VALUES
      ('scopes', 'SELECT'), ('principals', 'SELECT'), ('principals', 'INSERT'),
      ('entra_groups', 'SELECT'), ('scope_memberships', 'SELECT'),
      ('entra_sync_state', 'SELECT'), ('audit_log', 'INSERT')
    ), actual AS (
      SELECT relation.relname::text AS object_name,
             upper(privilege.privilege_type)::text AS privilege_type
        FROM pg_class relation
        CROSS JOIN LATERAL aclexplode(COALESCE(
          relation.relacl,
          acldefault(CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
                     relation.relowner)
        )) privilege
       WHERE relation.relnamespace = schema_oid
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND privilege.grantee = target_oid
    )
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    UNION ALL
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
  ) THEN
    RAISE EXCEPTION 'sync database identity table privilege drift from exact allow-list';
  END IF;
  IF EXISTS (
    WITH expected(object_name, privilege_type) AS (VALUES
      ('audit_log_id_seq', 'USAGE'), ('audit_log_id_seq', 'SELECT')
    ), actual AS (
      SELECT relation.relname::text, upper(privilege.privilege_type)::text
        FROM pg_class relation
        CROSS JOIN LATERAL aclexplode(COALESCE(
          relation.relacl, acldefault('s', relation.relowner)
        )) privilege
       WHERE relation.relnamespace = schema_oid AND relation.relkind = 'S'
         AND privilege.grantee = target_oid
    )
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    UNION ALL
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
  ) THEN
    RAISE EXCEPTION 'sync database identity sequence privilege drift from exact allow-list';
  END IF;
  IF EXISTS (
    WITH expected(signature) AS (VALUES
      ('continuum_activate_entra_memberships(uuid,text,uuid[])'),
      ('continuum_require_sync_session(uuid)'),
      ('continuum_record_entra_sync_success(uuid,integer)'),
      ('continuum_record_entra_sync_failure(uuid,text,integer)'),
      ('continuum_sync_observe_entra_group(uuid,text,text)'),
      ('continuum_sync_deactivate_entra_memberships(uuid,text[],uuid[])'),
      ('continuum_sync_deactivate_entra_groups(uuid,text[])'),
      ('continuum_sync_quarantine_entra_group(uuid,text,text)'),
      ('continuum_verify_sync_database_identity(uuid)')
    ), actual AS (
      SELECT function.proname || '('
             || replace(oidvectortypes(function.proargtypes), ' ', '') || ')'
        FROM pg_proc function
        CROSS JOIN LATERAL aclexplode(COALESCE(
          function.proacl, acldefault('f', function.proowner)
        )) privilege
       WHERE function.pronamespace = schema_oid
         AND privilege.grantee = target_oid
         AND upper(privilege.privilege_type) = 'EXECUTE'
    )
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    UNION ALL
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
  ) THEN
    RAISE EXCEPTION 'sync database identity function privilege drift from exact allow-list';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(COALESCE(
      relation.relacl,
      acldefault(CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
                 relation.relowner)
    )) privilege
     WHERE relation.relnamespace = schema_oid AND privilege.grantee = 0
  ) OR EXISTS (
    SELECT 1 FROM pg_proc function
    CROSS JOIN LATERAL aclexplode(COALESCE(
      function.proacl, acldefault('f', function.proowner)
    )) privilege
     WHERE function.pronamespace = schema_oid
       AND privilege.grantee = 0
  ) OR EXISTS (
    SELECT 1 FROM pg_default_acl defaults
    CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege
     WHERE defaults.defaclrole = (SELECT relowner FROM pg_class WHERE oid = 'principals'::regclass)
       AND defaults.defaclnamespace IN (0, schema_oid) AND privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC or default application-schema privilege drift';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_assert_sync_role_allowlist(NAME, UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_verify_sync_database_identity(
  expected_service_principal_id UUID
) RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  invoking_role NAME := continuum_invoking_database_role();
  invoking_role_oid OID;
  owner_oid OID;
  session_role_oid OID := session_user::regrole::oid;
  session_superuser BOOLEAN;
BEGIN
  SELECT oid INTO invoking_role_oid FROM pg_roles WHERE rolname = invoking_role;
  SELECT relowner INTO owner_oid FROM pg_class WHERE oid = 'principals'::regclass;
  SELECT rolsuper INTO session_superuser FROM pg_roles WHERE oid = session_role_oid;
  IF session_role_oid = owner_oid OR session_superuser
     OR session_role_oid <> invoking_role_oid THEN
    RAISE EXCEPTION 'sync verification rejects owner, superuser, or SET ROLE sessions';
  END IF;
  PERFORM continuum_require_trusted_database_identity(expected_service_principal_id, 'sync');
  PERFORM continuum_assert_sync_role_allowlist(invoking_role, expected_service_principal_id);
END;
$$;
REVOKE ALL ON FUNCTION continuum_verify_sync_database_identity(UUID) FROM PUBLIC;

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
  SELECT namespace.nspname, namespace.oid, relation.relowner
    INTO schema_name, schema_oid, owner_oid
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
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
         AND NOT (allow_existing_sync AND identity.can_sync AND NOT identity.can_approve)
    ) THEN RAISE EXCEPTION 'sync database role already has trusted approval authority'; END IF;
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
DECLARE schema_name TEXT; schema_oid OID; owner_oid OID; old_identity RECORD;
BEGIN
  SELECT namespace.nspname, namespace.oid, relation.relowner
    INTO schema_name, schema_oid, owner_oid
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
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
         AND NOT (membership.roleid = old_identity.database_role_oid
                  AND membership.member = owner_oid)
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
  target_database_role NAME, target_service_principal_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE schema_name TEXT; target_oid OID; already_bound BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(834641726154302119::bigint);
  PERFORM pg_advisory_xact_lock(834641726154302120::bigint);
  IF NOT EXISTS (
    SELECT 1 FROM principals principal
     WHERE principal.id = target_service_principal_id
       AND principal.kind = 'service' AND principal.disabled_at IS NULL
  ) THEN RAISE EXCEPTION 'sync identity must be an enabled service principal'; END IF;
  SELECT EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
     WHERE identity.database_role = target_database_role
       AND identity.principal_id = target_service_principal_id
       AND identity.can_sync AND NOT identity.can_approve
  ) INTO already_bound;
  target_oid := continuum_validate_trusted_database_role(
    target_database_role, 'sync', already_bound);
  SELECT namespace.nspname INTO schema_name
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
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
    || '%I.continuum_sync_quarantine_entra_group(UUID, TEXT, TEXT), '
    || '%I.continuum_verify_sync_database_identity(UUID) TO %I',
    schema_name, schema_name, schema_name, schema_name, schema_name, schema_name,
    schema_name, schema_name, schema_name, target_database_role);
  INSERT INTO continuum_trusted_database_identities
    (database_role, database_role_oid, principal_id, can_approve, can_sync)
  VALUES (target_database_role, target_oid, target_service_principal_id, FALSE, TRUE)
  ON CONFLICT (database_role) DO UPDATE SET
    database_role_oid = EXCLUDED.database_role_oid,
    principal_id = EXCLUDED.principal_id, can_approve = FALSE, can_sync = TRUE;
END;
$$;
REVOKE ALL ON FUNCTION continuum_install_sync_database_identity(NAME, UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_register_trusted_database_identity(
  target_database_role NAME, target_principal_id UUID,
  approve_capability BOOLEAN, sync_capability BOOLEAN
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE target_role_oid OID;
BEGIN
  IF NOT (approve_capability OR sync_capability) OR (approve_capability AND sync_capability) THEN
    RAISE EXCEPTION 'exactly one trusted database capability is required';
  END IF;
  IF sync_capability THEN
    PERFORM continuum_install_sync_database_identity(target_database_role, target_principal_id);
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
  ) THEN RAISE EXCEPTION 'operator identity must be an effective manual org administrator'; END IF;
  target_role_oid := continuum_validate_trusted_database_role(
    target_database_role, 'approve', FALSE);
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

CREATE OR REPLACE FUNCTION continuum_operator_offboard_scope_access(
  authorization_principal_id UUID, target_scope_id UUID
) RETURNS TABLE(memberships_deactivated INTEGER, bindings_quarantined INTEGER)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  changed_memberships INTEGER; changed_bindings INTEGER;
  bound_run_id UUID; bound_principal_id UUID;
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  PERFORM pg_advisory_xact_lock(834641726154302119::bigint);
  SELECT run.run_id, run.principal_id INTO bound_run_id, bound_principal_id
    FROM principal_offboarding_runs run
    JOIN principal_user_scopes mapping
      ON mapping.principal_id = run.principal_id AND mapping.scope_id = target_scope_id
    JOIN scopes scope ON scope.id = mapping.scope_id AND scope.kind = 'user'
   WHERE run.completed_at IS NULL
     AND EXISTS (
       SELECT 1 FROM principal_offboarding_run_events started
        WHERE started.run_id = run.run_id AND started.phase = 'started')
     AND NOT EXISTS (
       SELECT 1 FROM principal_offboarding_run_events completed
        WHERE completed.run_id = run.run_id AND completed.phase = 'completed')
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
    'operation', 'offboarding_scope_access_closed', 'run_id', bound_run_id,
    'principal_id', bound_principal_id, 'scope_id', target_scope_id,
    'memberships_deactivated', changed_memberships,
    'bindings_quarantined', changed_bindings));
  RETURN QUERY SELECT changed_memberships, changed_bindings;
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_offboard_scope_access(UUID, UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_verify_database_identity_configuration()
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE schema_name TEXT; trusted_row RECORD;
BEGIN
  SELECT namespace.nspname INTO schema_name
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = 'principals'::regclass;
  IF has_schema_privilege('public', schema_name, 'USAGE')
     OR has_schema_privilege('public', schema_name, 'CREATE') THEN
    RAISE EXCEPTION 'PUBLIC retains application schema privileges';
  END IF;
  IF (SELECT count(*) FROM continuum_trusted_database_identities WHERE can_sync) <> 1 THEN
    RAISE EXCEPTION 'exactly one active sync database identity is required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities registry
    LEFT JOIN pg_roles role ON role.oid = registry.database_role_oid
    LEFT JOIN principals principal ON principal.id = registry.principal_id
     WHERE registry.can_approve = registry.can_sync
        OR role.oid IS NULL OR role.rolname <> registry.database_role::text
        OR principal.disabled_at IS NOT NULL
        OR (registry.can_sync AND principal.kind <> 'service')
        OR (registry.can_approve AND principal.kind <> 'user')
        OR (registry.can_approve AND NOT EXISTS (
          SELECT 1 FROM scope_memberships membership
          JOIN scopes scope ON scope.id = membership.scope_id
           WHERE membership.principal_id = registry.principal_id
             AND scope.kind = 'org' AND scope.name = ''
             AND membership.source_kind = 'manual' AND membership.source_id = 'manual'
             AND membership.role = 'admin' AND membership.active
        ))
  ) THEN RAISE EXCEPTION 'trusted database identity configuration is invalid'; END IF;
  FOR trusted_row IN
    SELECT database_role, principal_id, can_sync FROM continuum_trusted_database_identities
  LOOP
    PERFORM continuum_validate_trusted_database_role(
      trusted_row.database_role,
      CASE WHEN trusted_row.can_sync THEN 'sync' ELSE 'approve' END,
      trusted_row.can_sync);
    IF trusted_row.can_sync THEN
      PERFORM continuum_assert_sync_role_allowlist(
        trusted_row.database_role, trusted_row.principal_id);
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION continuum_verify_database_identity_configuration() FROM PUBLIC;

-- PostgreSQL grants EXECUTE on newly-created functions to PUBLIC by default.
-- 0051 closes that default for the entire application schema, including
-- extension-owned routines. Application roles still need pgvector's routines,
-- so restore those grants directly to roles that already hold the application
-- profile's direct memories SELECT grant. Sync roles never hold that grant.
CREATE OR REPLACE FUNCTION continuum_grant_application_vector_functions()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  schema_oid OID;
  owner_oid OID;
  invoking_role_oid OID;
  target_role RECORD;
  vector_function RECORD;
BEGIN
  SELECT relation.relnamespace, relation.relowner
    INTO schema_oid, owner_oid
    FROM pg_class relation WHERE relation.oid = 'memories'::regclass;
  SELECT oid INTO invoking_role_oid
    FROM pg_roles WHERE rolname = continuum_invoking_database_role();
  IF invoking_role_oid <> owner_oid THEN
    RAISE EXCEPTION 'only the migration owner may refresh application extension grants';
  END IF;

  FOR target_role IN
    SELECT DISTINCT role.rolname
      FROM pg_class relation
      CROSS JOIN LATERAL aclexplode(COALESCE(
        relation.relacl, acldefault('r', relation.relowner))) privilege
      JOIN pg_roles role ON role.oid = privilege.grantee
     WHERE relation.oid = 'memories'::regclass
       AND upper(privilege.privilege_type) = 'SELECT'
       AND role.oid <> owner_oid
  LOOP
    FOR vector_function IN
      SELECT format('%I.%I(%s)', namespace.nspname, function.proname,
                    pg_get_function_identity_arguments(function.oid)) AS signature,
             function.proowner
        FROM pg_proc function
        JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
        JOIN pg_depend dependency
          ON dependency.classid = 'pg_proc'::regclass
         AND dependency.objid = function.oid
         AND dependency.refclassid = 'pg_extension'::regclass
         AND dependency.deptype = 'e'
        JOIN pg_extension extension ON extension.oid = dependency.refobjid
       WHERE function.pronamespace = schema_oid AND extension.extname = 'vector'
    LOOP
      -- Managed services may own pgvector with a provider role. Keep PUBLIC
      -- extension execution when supplied by that owner; grant directly only
      -- when this migration role owns the routine. A non-PUBLIC managed layout
      -- must pregrant EXECUTE to the application role before this refresh.
      IF NOT has_function_privilege(target_role.rolname,
                                    vector_function.signature, 'EXECUTE') THEN
        IF vector_function.proowner = current_user::regrole::oid THEN
          EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',
            vector_function.signature, target_role.rolname);
        ELSE
          RAISE EXCEPTION 'extension owner must grant EXECUTE on % to application role %',
            vector_function.signature, target_role.rolname;
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION continuum_grant_application_vector_functions() FROM PUBLIC;

SELECT continuum_grant_application_vector_functions();

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT function.proname,
           pg_get_function_identity_arguments(function.oid) AS arguments
      FROM pg_proc function
     WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
       AND function.proname = ANY(ARRAY[
         'continuum_require_trusted_database_identity',
         'continuum_protect_last_manual_org_admin_principal',
         'continuum_disable_principal',
         'continuum_guard_entra_admin_sources',
         'continuum_guard_entra_membership_delete',
         'continuum_operator_remove_entra_membership',
         'continuum_fail_closed_on_principal_disable',
         'continuum_assert_sync_role_allowlist',
         'continuum_verify_sync_database_identity',
         'continuum_validate_trusted_database_role',
         'continuum_retire_sync_database_identities',
         'continuum_install_sync_database_identity',
         'continuum_register_trusted_database_identity',
         'continuum_rotate_sync_database_identity',
         'continuum_operator_offboard_scope_access',
         'continuum_verify_database_identity_configuration',
         'continuum_grant_application_vector_functions'
       ])
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, %I, pg_temp',
      schema_name, function_record.proname, function_record.arguments, schema_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC',
      schema_name, function_record.proname, function_record.arguments);
  END LOOP;
END;
$harden$;
