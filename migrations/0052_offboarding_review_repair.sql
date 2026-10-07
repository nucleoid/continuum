-- Forward-only repair for databases that already ledgered 0051 variants.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Fail before taking repair locks when an already-ledgered 0051 database has
-- ambiguous organization identity or a migration definer that cannot retire
-- its registered sync role during emergency rotation.
DO $preflight$
DECLARE
  migration_role_oid OID := (SELECT oid FROM pg_roles WHERE rolname = current_user);
  schema_oid OID := quote_ident(current_schema())::regnamespace;
  migration_superuser BOOLEAN;
  migration_createrole BOOLEAN;
  organization_count INTEGER;
BEGIN
  IF (SELECT relowner FROM pg_class WHERE oid = 'principals'::regclass)
       <> migration_role_oid
     OR EXISTS (
       SELECT 1 FROM pg_class relation
        WHERE relation.relnamespace = schema_oid
          AND relation.relowner <> migration_role_oid
     ) OR EXISTS (
       SELECT 1 FROM pg_proc function
        WHERE function.pronamespace = schema_oid
          AND function.proowner <> migration_role_oid
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend dependency
            JOIN pg_extension extension ON extension.oid = dependency.refobjid
             WHERE dependency.classid = 'pg_proc'::regclass
               AND dependency.objid = function.oid
               AND dependency.refclassid = 'pg_extension'::regclass
               AND dependency.deptype = 'e' AND extension.extname = 'vector')
     ) THEN
    RAISE EXCEPTION '0052 migration role must directly own every application object';
  END IF;
  SELECT count(*)::integer INTO organization_count FROM scopes WHERE kind = 'org';
  IF organization_count <> 1 OR NOT EXISTS (
    SELECT 1 FROM scopes WHERE kind = 'org' AND name = ''
  ) THEN
    RAISE EXCEPTION '0052 requires exactly one canonical organization scope';
  END IF;
  SELECT rolsuper, rolcreaterole
    INTO migration_superuser, migration_createrole
    FROM pg_roles WHERE oid = migration_role_oid;
  IF EXISTS (SELECT 1 FROM continuum_trusted_database_identities WHERE can_sync)
     AND NOT migration_superuser AND (
       NOT migration_createrole OR EXISTS (
         SELECT 1 FROM continuum_trusted_database_identities identity
          WHERE identity.can_sync AND NOT EXISTS (
            SELECT 1 FROM pg_auth_members membership
             WHERE membership.roleid = identity.database_role_oid
               AND membership.member = migration_role_oid
               AND membership.admin_option
               AND NOT membership.set_option AND NOT membership.inherit_option
          )
       )
     ) THEN
    RAISE EXCEPTION '0052 migration role requires CREATEROLE and ADMIN OPTION on every sync role';
  END IF;
END;
$preflight$;

ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE IF NOT EXISTS continuum_retired_sync_database_identities (
  database_role_oid OID PRIMARY KEY,
  database_role NAME NOT NULL,
  retired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE continuum_retired_sync_database_identities
  DROP CONSTRAINT IF EXISTS continuum_retired_sync_database_identities_database_role_key;
REVOKE ALL ON TABLE continuum_retired_sync_database_identities FROM PUBLIC;
CREATE TABLE IF NOT EXISTS continuum_database_identity_epoch (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  epoch UUID NOT NULL,
  cluster_system_identifier TEXT
);
ALTER TABLE continuum_database_identity_epoch
  ADD COLUMN IF NOT EXISTS cluster_system_identifier TEXT;
INSERT INTO continuum_database_identity_epoch
  (singleton, epoch, cluster_system_identifier)
VALUES (TRUE, gen_random_uuid(),
  (SELECT system_identifier::text FROM pg_control_system()))
ON CONFLICT (singleton) DO NOTHING;
UPDATE continuum_database_identity_epoch
   SET cluster_system_identifier =
     (SELECT system_identifier::text FROM pg_control_system())
 WHERE cluster_system_identifier IS NULL;
ALTER TABLE continuum_database_identity_epoch
  ALTER COLUMN cluster_system_identifier SET NOT NULL;
REVOKE ALL ON TABLE continuum_database_identity_epoch FROM PUBLIC;
CREATE TABLE IF NOT EXISTS continuum_unresolved_retired_sync_database_identities (
  database_role NAME NOT NULL,
  previous_database_role_oid OID NOT NULL,
  resolution_kind TEXT NOT NULL CHECK (resolution_kind IN ('superseded', 'restore_pending')),
  cluster_epoch UUID NOT NULL,
  marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (database_role, previous_database_role_oid)
);
ALTER TABLE continuum_unresolved_retired_sync_database_identities
  ADD COLUMN IF NOT EXISTS resolution_kind TEXT,
  ADD COLUMN IF NOT EXISTS cluster_epoch UUID;
UPDATE continuum_unresolved_retired_sync_database_identities
   SET resolution_kind = COALESCE(resolution_kind, 'restore_pending'),
       cluster_epoch = COALESCE(cluster_epoch,
         (SELECT epoch FROM continuum_database_identity_epoch WHERE singleton));
ALTER TABLE continuum_unresolved_retired_sync_database_identities
  ALTER COLUMN resolution_kind SET NOT NULL,
  ALTER COLUMN cluster_epoch SET NOT NULL,
  DROP CONSTRAINT IF EXISTS continuum_unresolved_retired_sync_database_identities_resolution_kind_check,
  ADD CONSTRAINT continuum_unresolved_retired_sync_database_identities_resolution_kind_check
    CHECK (resolution_kind IN ('superseded', 'restore_pending'));
ALTER TABLE continuum_unresolved_retired_sync_database_identities
  DROP CONSTRAINT IF EXISTS continuum_unresolved_retired_sync_database_identities_pkey,
  ADD CONSTRAINT continuum_unresolved_retired_sync_database_identities_pkey
    PRIMARY KEY (database_role, previous_database_role_oid);
REVOKE ALL ON TABLE continuum_unresolved_retired_sync_database_identities FROM PUBLIC;

-- Capability tables are transaction-local markers. Maintenance mode guarantees
-- no legitimate rows survive, so recreate them instead of attempting a partial
-- in-place repair of unknown edited-0051 shapes.
DROP TABLE continuum_entra_reapproval_requests,
  continuum_entra_guarded_mutations,
  continuum_principal_disable_requests CASCADE;
CREATE TABLE continuum_entra_reapproval_requests (
  external_id TEXT PRIMARY KEY,
  backend_pid INTEGER NOT NULL,
  transaction_id BIGINT NOT NULL,
  authorization_principal_id UUID NOT NULL REFERENCES principals(id)
);
CREATE TABLE continuum_entra_guarded_mutations (
  external_id TEXT NOT NULL,
  mutation_kind TEXT NOT NULL CHECK (
    mutation_kind IN ('deactivate', 'quarantine', 'revoke', 'delete')),
  backend_pid INTEGER NOT NULL,
  transaction_id BIGINT NOT NULL,
  authorization_principal_id UUID NOT NULL REFERENCES principals(id),
  PRIMARY KEY (external_id, mutation_kind, backend_pid, transaction_id)
);
CREATE TABLE continuum_principal_disable_requests (
  target_principal_id UUID NOT NULL REFERENCES principals(id),
  authorization_principal_id UUID NOT NULL REFERENCES principals(id),
  backend_pid INTEGER NOT NULL,
  transaction_id BIGINT NOT NULL,
  PRIMARY KEY (target_principal_id, backend_pid, transaction_id)
);

-- Keep the canonical constraint recreation below as an assertion that the
-- rebuilt definitions survive every supported catalog operation.
LOCK TABLE continuum_entra_guarded_mutations,
           continuum_principal_disable_requests IN ACCESS EXCLUSIVE MODE;
TRUNCATE continuum_entra_guarded_mutations, continuum_principal_disable_requests;

DO $drop_marker_auxiliary_objects$
DECLARE item RECORD;
BEGIN
  FOR item IN
    SELECT index_namespace.nspname, index_relation.relname
      FROM pg_index catalog_index
      JOIN pg_class table_relation ON table_relation.oid = catalog_index.indrelid
      JOIN pg_class index_relation ON index_relation.oid = catalog_index.indexrelid
      JOIN pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
     WHERE table_relation.oid IN (
       'continuum_entra_guarded_mutations'::regclass,
       'continuum_principal_disable_requests'::regclass)
       AND NOT EXISTS (
         SELECT 1 FROM pg_constraint constraint_row
          WHERE constraint_row.conindid = catalog_index.indexrelid)
  LOOP
    EXECUTE format('DROP INDEX %I.%I', item.nspname, item.relname);
  END LOOP;
  FOR item IN
    SELECT relation.relname, trigger_row.tgname
      FROM pg_trigger trigger_row
      JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
     WHERE relation.oid IN (
       'continuum_entra_guarded_mutations'::regclass,
       'continuum_principal_disable_requests'::regclass)
       AND NOT trigger_row.tgisinternal
  LOOP
    EXECUTE format('DROP TRIGGER %I ON %I', item.tgname, item.relname);
  END LOOP;
  FOR item IN
    SELECT schemaname, tablename, policyname FROM pg_policies
     WHERE schemaname = current_schema()
       AND tablename IN ('continuum_entra_guarded_mutations',
                         'continuum_principal_disable_requests')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I',
      item.policyname, item.schemaname, item.tablename);
  END LOOP;
END;
$drop_marker_auxiliary_objects$;

ALTER TABLE continuum_entra_guarded_mutations
  DISABLE ROW LEVEL SECURITY,
  NO FORCE ROW LEVEL SECURITY,
  ALTER COLUMN external_id DROP DEFAULT,
  ALTER COLUMN mutation_kind DROP DEFAULT,
  ALTER COLUMN backend_pid DROP DEFAULT,
  ALTER COLUMN transaction_id DROP DEFAULT,
  ALTER COLUMN authorization_principal_id DROP DEFAULT;
ALTER TABLE continuum_principal_disable_requests
  DISABLE ROW LEVEL SECURITY,
  NO FORCE ROW LEVEL SECURITY,
  ALTER COLUMN target_principal_id DROP DEFAULT,
  ALTER COLUMN authorization_principal_id DROP DEFAULT,
  ALTER COLUMN backend_pid DROP DEFAULT,
  ALTER COLUMN transaction_id DROP DEFAULT;

DO $drop_marker_constraints$
DECLARE constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT catalog_constraint.conname, relation.relname
      FROM pg_constraint catalog_constraint
      JOIN pg_class relation ON relation.oid = catalog_constraint.conrelid
     WHERE catalog_constraint.conrelid IN (
       'continuum_entra_guarded_mutations'::regclass,
       'continuum_principal_disable_requests'::regclass
     )
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',
      constraint_row.relname, constraint_row.conname);
  END LOOP;
END;
$drop_marker_constraints$;

DO $drop_marker_extra_columns$
DECLARE column_row RECORD;
BEGIN
  FOR column_row IN
    SELECT relation.relname, attribute.attname
      FROM pg_attribute attribute
      JOIN pg_class relation ON relation.oid = attribute.attrelid
     WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
       AND (
         (relation.oid = 'continuum_entra_guarded_mutations'::regclass
          AND attribute.attname <> ALL (ARRAY[
            'external_id', 'mutation_kind', 'backend_pid', 'transaction_id',
            'authorization_principal_id']))
         OR
         (relation.oid = 'continuum_principal_disable_requests'::regclass
          AND attribute.attname <> ALL (ARRAY[
            'target_principal_id', 'authorization_principal_id',
            'backend_pid', 'transaction_id']))
       )
  LOOP
    EXECUTE format('ALTER TABLE %I DROP COLUMN %I',
      column_row.relname, column_row.attname);
  END LOOP;
END;
$drop_marker_extra_columns$;

ALTER TABLE continuum_entra_guarded_mutations
  ALTER COLUMN external_id TYPE TEXT USING external_id::text,
  ALTER COLUMN external_id SET NOT NULL,
  ALTER COLUMN mutation_kind TYPE TEXT USING mutation_kind::text,
  ALTER COLUMN mutation_kind SET NOT NULL,
  ALTER COLUMN backend_pid TYPE INTEGER USING backend_pid::integer,
  ALTER COLUMN backend_pid SET NOT NULL,
  ALTER COLUMN transaction_id TYPE BIGINT USING transaction_id::bigint,
  ALTER COLUMN transaction_id SET NOT NULL,
  ALTER COLUMN authorization_principal_id TYPE UUID USING authorization_principal_id::uuid,
  ALTER COLUMN authorization_principal_id SET NOT NULL,
  ADD CONSTRAINT continuum_entra_guarded_mutations_pkey
    PRIMARY KEY (external_id, mutation_kind, backend_pid, transaction_id),
  ADD CONSTRAINT continuum_entra_guarded_mutations_mutation_kind_check
    CHECK (mutation_kind IN ('deactivate', 'quarantine', 'revoke', 'delete')) NOT VALID,
  ADD CONSTRAINT continuum_entra_guarded_mutations_authorization_principal_id_fkey
    FOREIGN KEY (authorization_principal_id) REFERENCES principals(id) NOT VALID;
ALTER TABLE continuum_entra_guarded_mutations
  VALIDATE CONSTRAINT continuum_entra_guarded_mutations_mutation_kind_check;
ALTER TABLE continuum_entra_guarded_mutations
  VALIDATE CONSTRAINT continuum_entra_guarded_mutations_authorization_principal_id_fkey;

ALTER TABLE continuum_principal_disable_requests
  ALTER COLUMN target_principal_id TYPE UUID USING target_principal_id::uuid,
  ALTER COLUMN target_principal_id SET NOT NULL,
  ALTER COLUMN authorization_principal_id TYPE UUID USING authorization_principal_id::uuid,
  ALTER COLUMN authorization_principal_id SET NOT NULL,
  ALTER COLUMN backend_pid TYPE INTEGER USING backend_pid::integer,
  ALTER COLUMN backend_pid SET NOT NULL,
  ALTER COLUMN transaction_id TYPE BIGINT USING transaction_id::bigint,
  ALTER COLUMN transaction_id SET NOT NULL,
  ADD CONSTRAINT continuum_principal_disable_requests_pkey
    PRIMARY KEY (target_principal_id, backend_pid, transaction_id),
  ADD CONSTRAINT continuum_principal_disable_requests_target_principal_id_fkey
    FOREIGN KEY (target_principal_id) REFERENCES principals(id) NOT VALID,
  ADD CONSTRAINT continuum_principal_disable_requests_authorization_principal_id_fkey
    FOREIGN KEY (authorization_principal_id) REFERENCES principals(id) NOT VALID;
ALTER TABLE continuum_principal_disable_requests
  VALIDATE CONSTRAINT continuum_principal_disable_requests_target_principal_id_fkey;
ALTER TABLE continuum_principal_disable_requests
  VALIDATE CONSTRAINT continuum_principal_disable_requests_authorization_principal_id_fkey;

REVOKE ALL ON TABLE continuum_entra_guarded_mutations,
  continuum_principal_disable_requests,
  continuum_entra_reapproval_requests FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_protect_capability_marker_write()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE table_owner OID; invoking_role_oid OID;
BEGIN
  SELECT relowner INTO table_owner FROM pg_class WHERE oid = TG_RELID;
  SELECT oid INTO invoking_role_oid FROM pg_roles WHERE rolname = current_user;
  IF invoking_role_oid IS DISTINCT FROM table_owner THEN
    RAISE EXCEPTION 'capability marker writes require the migration owner definer';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION continuum_protect_capability_marker_write() FROM PUBLIC;
CREATE TRIGGER protect_entra_reapproval_marker_write
  BEFORE INSERT OR UPDATE OR DELETE ON continuum_entra_reapproval_requests
  FOR EACH ROW EXECUTE FUNCTION continuum_protect_capability_marker_write();
CREATE TRIGGER protect_entra_guarded_marker_write
  BEFORE INSERT OR UPDATE OR DELETE ON continuum_entra_guarded_mutations
  FOR EACH ROW EXECUTE FUNCTION continuum_protect_capability_marker_write();
CREATE TRIGGER protect_principal_disable_marker_write
  BEFORE INSERT OR UPDATE OR DELETE ON continuum_principal_disable_requests
  FOR EACH ROW EXECUTE FUNCTION continuum_protect_capability_marker_write();

-- Resolve the singleton organization scope through an owner-controlled UUID.
CREATE TABLE IF NOT EXISTS continuum_canonical_org_scope (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  scope_id UUID NOT NULL UNIQUE REFERENCES scopes(id)
);
INSERT INTO continuum_canonical_org_scope (singleton, scope_id)
SELECT TRUE, scope.id FROM scopes scope
 WHERE scope.kind = 'org' AND scope.name = ''
ON CONFLICT (singleton) DO UPDATE SET scope_id = EXCLUDED.scope_id;
REVOKE ALL ON TABLE continuum_canonical_org_scope FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_org_scope_id()
RETURNS UUID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE canonical_id UUID;
BEGIN
  SELECT marker.scope_id INTO canonical_id
    FROM continuum_canonical_org_scope marker
    JOIN scopes scope ON scope.id = marker.scope_id
   WHERE marker.singleton AND scope.kind = 'org' AND scope.name = '';
  IF canonical_id IS NULL THEN
    RAISE EXCEPTION 'canonical organization scope marker is missing or invalid';
  END IF;
  RETURN canonical_id;
END;
$$;
REVOKE ALL ON FUNCTION continuum_org_scope_id() FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_protect_canonical_org_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE canonical_id UUID;
BEGIN
  SELECT scope_id INTO canonical_id
    FROM continuum_canonical_org_scope WHERE singleton;
  IF canonical_id IS NULL THEN
    IF TG_OP = 'INSERT' AND NEW.kind = 'org' AND NEW.name = ''
       AND NOT EXISTS (SELECT 1 FROM scopes) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'canonical organization scope marker is missing';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.kind = 'org' AND NEW.id <> canonical_id THEN
    RAISE EXCEPTION 'canonical organization scope is a singleton';
  END IF;
  IF TG_OP = 'DELETE' AND OLD.id = canonical_id THEN
    RAISE EXCEPTION 'canonical organization scope identity is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       (OLD.id = canonical_id AND (NEW.id, NEW.kind, NEW.name)
          IS DISTINCT FROM (OLD.id, OLD.kind, OLD.name))
       OR (OLD.id <> canonical_id AND NEW.kind = 'org')
     ) THEN
    RAISE EXCEPTION 'canonical organization scope identity is immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION continuum_protect_canonical_org_scope() FROM PUBLIC;
DROP TRIGGER IF EXISTS protect_canonical_org_scope ON scopes;
CREATE TRIGGER protect_canonical_org_scope
BEFORE INSERT OR DELETE OR UPDATE OF id, kind, name ON scopes
FOR EACH ROW EXECUTE FUNCTION continuum_protect_canonical_org_scope();

CREATE OR REPLACE FUNCTION continuum_bind_initial_org_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.kind = 'org' AND NEW.name = '' THEN
    INSERT INTO continuum_canonical_org_scope (singleton, scope_id)
    VALUES (TRUE, NEW.id)
    ON CONFLICT (singleton) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_bind_initial_org_scope() FROM PUBLIC;
DROP TRIGGER IF EXISTS bind_initial_org_scope ON scopes;
CREATE TRIGGER bind_initial_org_scope
AFTER INSERT ON scopes
FOR EACH ROW EXECUTE FUNCTION continuum_bind_initial_org_scope();

-- Every privileged runtime call revalidates role isolation. This catches a
-- later application-to-operator SET ROLE edge, not only rollout-time drift.
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
                  WHERE membership.principal_id = principal.id
                    AND membership.scope_id = continuum_org_scope_id()
                    AND membership.source_kind = 'manual'
                    AND membership.source_id = 'manual'
                    AND membership.role = 'admin' AND membership.active)
             WHEN 'sync' THEN identity.can_sync AND principal.kind = 'service'
             ELSE FALSE
           END
  ) THEN
    RAISE EXCEPTION 'operation requires a DB-bound trusted % identity', required_capability;
  END IF;
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
     WHERE identity.database_role_oid = (SELECT oid FROM pg_roles
       WHERE rolname = continuum_invoking_database_role())
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
     WHERE identity.database_role_oid = invoking_role_oid AND identity.can_sync
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

CREATE OR REPLACE FUNCTION continuum_upsert_entra_group_binding(
  authorization_principal_id UUID, group_external_id TEXT, group_display_name TEXT,
  target_scope_id UUID, target_role TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE existed BOOLEAN;
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  SELECT EXISTS(SELECT 1 FROM entra_groups WHERE external_id = group_external_id) INTO existed;
  INSERT INTO continuum_entra_reapproval_requests
    (external_id, backend_pid, transaction_id, authorization_principal_id)
  VALUES (group_external_id, pg_backend_pid(), txid_current(), authorization_principal_id)
  ON CONFLICT (external_id) DO UPDATE SET
    backend_pid = EXCLUDED.backend_pid,
    transaction_id = EXCLUDED.transaction_id,
    authorization_principal_id = EXCLUDED.authorization_principal_id;
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
  DELETE FROM continuum_entra_reapproval_requests
   WHERE external_id = group_external_id;
  RETURN existed;
END;
$$;
REVOKE ALL ON FUNCTION continuum_upsert_entra_group_binding(
  UUID, TEXT, TEXT, UUID, TEXT) FROM PUBLIC;

-- Reassert every trigger affected by edited 0048-0051 migration variants.
DROP TRIGGER IF EXISTS protect_last_manual_org_admin_principal ON principals;
CREATE TRIGGER protect_last_manual_org_admin_principal
BEFORE DELETE OR UPDATE OF disabled_at ON principals
FOR EACH ROW EXECUTE FUNCTION continuum_protect_last_manual_org_admin_principal();
DROP TRIGGER IF EXISTS fail_closed_on_principal_disable ON principals;
CREATE TRIGGER fail_closed_on_principal_disable
AFTER UPDATE OF disabled_at ON principals
FOR EACH ROW
WHEN (OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL)
EXECUTE FUNCTION continuum_fail_closed_on_principal_disable();
DROP TRIGGER IF EXISTS guard_entra_binding_approvals ON entra_groups;
CREATE TRIGGER guard_entra_binding_approvals
BEFORE INSERT OR UPDATE ON entra_groups FOR EACH ROW
EXECUTE FUNCTION continuum_guard_entra_admin_sources();
DROP TRIGGER IF EXISTS guard_entra_org_admin_memberships ON scope_memberships;
CREATE TRIGGER guard_entra_org_admin_memberships
BEFORE INSERT OR UPDATE ON scope_memberships FOR EACH ROW
EXECUTE FUNCTION continuum_guard_entra_admin_sources();
DROP TRIGGER IF EXISTS guard_entra_membership_deletes ON scope_memberships;
CREATE TRIGGER guard_entra_membership_deletes
BEFORE DELETE ON scope_memberships FOR EACH ROW
EXECUTE FUNCTION continuum_guard_entra_membership_delete();

CREATE OR REPLACE FUNCTION continuum_assert_sync_role_allowlist(
  target_database_role NAME, target_service_principal_id UUID
) RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE schema_name TEXT; schema_oid OID; target_oid OID;
BEGIN
  SELECT namespace.nspname, namespace.oid INTO schema_name, schema_oid
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = 'principals'::regclass;
  SELECT role.oid INTO target_oid FROM pg_roles role WHERE role.rolname = target_database_role;
  IF target_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities identity
    JOIN principals principal ON principal.id = identity.principal_id
     WHERE identity.database_role = target_database_role
       AND identity.database_role_oid = target_oid
       AND identity.principal_id = target_service_principal_id
       AND identity.can_sync AND NOT identity.can_approve
       AND principal.kind = 'service' AND principal.disabled_at IS NULL
  ) THEN RAISE EXCEPTION 'sync database identity binding is invalid'; END IF;
  PERFORM continuum_validate_trusted_database_role(target_database_role, 'sync', TRUE);
  IF EXISTS (
    SELECT 1 FROM pg_parameter_acl parameter_acl
    CROSS JOIN LATERAL aclexplode(parameter_acl.paracl) privilege
     WHERE privilege.grantee IN (0, target_oid)
  ) OR EXISTS (
    SELECT 1 FROM pg_db_role_setting setting WHERE setting.setrole = target_oid
  ) THEN
    RAISE EXCEPTION 'sync database identity parameter privilege or role-setting drift';
  END IF;
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
      SELECT relation.relname::text, upper(privilege.privilege_type)::text
        FROM pg_class relation
        CROSS JOIN LATERAL aclexplode(CASE WHEN cardinality(relation.relacl) > 0
          THEN relation.relacl ELSE acldefault(
            CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
            relation.relowner) END) privilege
       WHERE relation.relnamespace = schema_oid
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND privilege.grantee = target_oid
    )
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    UNION ALL (SELECT * FROM expected EXCEPT SELECT * FROM actual)
  ) THEN RAISE EXCEPTION 'sync database identity table privilege drift from exact allow-list'; END IF;
  IF EXISTS (
    WITH column_acls AS MATERIALIZED (
      SELECT attribute.attrelid, attribute.attacl
        FROM pg_attribute attribute
       WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
         AND cardinality(attribute.attacl) > 0
    )
    SELECT 1 FROM column_acls attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege
     WHERE relation.relnamespace = schema_oid AND privilege.grantee = target_oid
  ) THEN RAISE EXCEPTION 'sync database identity column privilege drift from exact allow-list'; END IF;
  IF EXISTS (
    WITH expected(object_name, privilege_type) AS (VALUES
      ('audit_log_id_seq', 'USAGE'), ('audit_log_id_seq', 'SELECT')
    ), actual AS (
      SELECT relation.relname::text, upper(privilege.privilege_type)::text
        FROM pg_class relation
        CROSS JOIN LATERAL aclexplode(COALESCE(
          relation.relacl, acldefault('s', relation.relowner))) privilege
       WHERE relation.relnamespace = schema_oid AND relation.relkind = 'S'
         AND privilege.grantee = target_oid
    )
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    UNION ALL (SELECT * FROM expected EXCEPT SELECT * FROM actual)
  ) THEN RAISE EXCEPTION 'sync database identity sequence privilege drift from exact allow-list'; END IF;
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
      SELECT function.proname || '(' || replace(oidvectortypes(function.proargtypes), ' ', '') || ')'
        FROM pg_proc function
        CROSS JOIN LATERAL aclexplode(COALESCE(
          function.proacl, acldefault('f', function.proowner))) privilege
       WHERE function.pronamespace = schema_oid AND privilege.grantee = target_oid
         AND upper(privilege.privilege_type) = 'EXECUTE'
    )
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    UNION ALL (SELECT * FROM expected EXCEPT SELECT * FROM actual)
  ) THEN RAISE EXCEPTION 'sync database identity function privilege drift from exact allow-list'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(COALESCE(
      relation.relacl,
      acldefault(CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
                 relation.relowner))) privilege
     WHERE relation.relnamespace = schema_oid AND privilege.grantee = 0
  ) OR EXISTS (
    WITH column_acls AS MATERIALIZED (
      SELECT attribute.attrelid, attribute.attacl
        FROM pg_attribute attribute
       WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
         AND cardinality(attribute.attacl) > 0
    )
    SELECT 1 FROM column_acls attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege
     WHERE relation.relnamespace = schema_oid AND privilege.grantee = 0
  ) OR EXISTS (
    SELECT 1 FROM pg_proc function
    CROSS JOIN LATERAL aclexplode(COALESCE(
      function.proacl, acldefault('f', function.proowner))) privilege
     WHERE function.pronamespace = schema_oid AND privilege.grantee = 0
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend dependency
         JOIN pg_extension extension ON extension.oid = dependency.refobjid
          WHERE dependency.classid = 'pg_proc'::regclass
            AND dependency.objid = function.oid
            AND dependency.refclassid = 'pg_extension'::regclass
            AND dependency.deptype = 'e' AND extension.extname = 'vector')
  ) OR EXISTS (
    SELECT 1 FROM pg_default_acl defaults
    CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege
     WHERE defaults.defaclrole = (SELECT relowner FROM pg_class WHERE oid = 'principals'::regclass)
       AND defaults.defaclnamespace IN (0, schema_oid) AND privilege.grantee = 0
  ) THEN RAISE EXCEPTION 'PUBLIC or default application-schema privilege drift'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_assert_sync_role_allowlist(NAME, UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_verify_sync_database_identity(
  expected_service_principal_id UUID
) RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  invoking_role NAME := continuum_invoking_database_role();
  invoking_role_oid OID; owner_oid OID; invoking_superuser BOOLEAN;
  session_role_oid OID := (SELECT oid FROM pg_roles WHERE rolname = session_user);
  session_superuser BOOLEAN;
BEGIN
  SELECT oid, rolsuper INTO invoking_role_oid, invoking_superuser
    FROM pg_roles WHERE rolname = invoking_role;
  SELECT relowner INTO owner_oid FROM pg_class WHERE oid = 'principals'::regclass;
  SELECT rolsuper INTO session_superuser FROM pg_roles WHERE oid = session_role_oid;
  IF invoking_role_oid = owner_oid OR invoking_superuser
     OR session_role_oid = owner_oid OR session_superuser
     OR session_role_oid <> invoking_role_oid THEN
    RAISE EXCEPTION 'sync verification rejects owner, superuser, or SET ROLE sessions';
  END IF;
  PERFORM continuum_require_trusted_database_identity(expected_service_principal_id, 'sync');
  PERFORM continuum_assert_sync_role_allowlist(invoking_role, expected_service_principal_id);
END;
$$;
REVOKE ALL ON FUNCTION continuum_verify_sync_database_identity(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_require_sync_retirement_authority(
  target_database_role_oid OID
) RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE definer_oid OID := (SELECT oid FROM pg_roles WHERE rolname = current_user);
        definer_superuser BOOLEAN; definer_createrole BOOLEAN;
BEGIN
  SELECT rolsuper, rolcreaterole INTO definer_superuser, definer_createrole
    FROM pg_roles WHERE oid = definer_oid;
  IF NOT definer_superuser AND (
       NOT definer_createrole OR NOT EXISTS (
         SELECT 1 FROM pg_auth_members membership
          WHERE membership.roleid = target_database_role_oid
            AND membership.member = definer_oid AND membership.admin_option
            AND NOT membership.set_option AND NOT membership.inherit_option)
     ) THEN
    RAISE EXCEPTION 'migration definer requires CREATEROLE and ADMIN OPTION on sync role for retirement';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_require_sync_retirement_authority(OID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_verify_sync_retirement_authority_configuration()
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE identity RECORD;
BEGIN
  FOR identity IN
    SELECT database_role_oid FROM continuum_trusted_database_identities WHERE can_sync
  LOOP
    PERFORM continuum_require_sync_retirement_authority(identity.database_role_oid);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION continuum_verify_sync_retirement_authority_configuration() FROM PUBLIC;
SELECT continuum_verify_sync_retirement_authority_configuration();

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
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I',
      schema_name, old_identity.rolname);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I',
      schema_name, old_identity.rolname);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM %I',
      schema_name, old_identity.rolname);
    EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I', schema_name, old_identity.rolname);
    EXECUTE format('ALTER ROLE %I NOLOGIN PASSWORD NULL', old_identity.rolname);
    INSERT INTO continuum_retired_sync_database_identities
      (database_role_oid, database_role)
    VALUES (old_identity.database_role_oid, old_identity.rolname)
    ON CONFLICT (database_role_oid) DO UPDATE SET
      database_role = EXCLUDED.database_role,
      retired_at = now();
    DELETE FROM continuum_trusted_database_identities
     WHERE database_role_oid = old_identity.database_role_oid AND can_sync AND NOT can_approve;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION continuum_retire_sync_database_identities(OID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_install_sync_database_identity(
  target_database_role NAME, target_service_principal_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE schema_name TEXT; target_oid OID; already_bound BOOLEAN; current_epoch UUID;
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
  SELECT epoch INTO current_epoch
    FROM continuum_database_identity_epoch WHERE singleton;
  IF EXISTS (
    SELECT 1 FROM continuum_unresolved_retired_sync_database_identities
     WHERE database_role = target_database_role
       AND resolution_kind = 'restore_pending'
  ) THEN
    RAISE EXCEPTION 'restore-pending retired sync identity must be rebound or explicitly superseded by the migration owner first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM continuum_retired_sync_database_identities
     WHERE database_role_oid = target_oid
  ) OR EXISTS (
    SELECT 1 FROM continuum_unresolved_retired_sync_database_identities
     WHERE previous_database_role_oid = target_oid
       AND cluster_epoch = current_epoch
  ) THEN
    RAISE EXCEPTION 'previously retired sync role OID is terminal and cannot be reinstalled';
  END IF;
  IF NOT (SELECT rolcanlogin FROM pg_roles WHERE oid = target_oid) THEN
    RAISE EXCEPTION 'sync database role must be LOGIN-capable before installation';
  END IF;
  -- Prove now that this definer can revoke the target during the next rotation.
  PERFORM continuum_require_sync_retirement_authority(target_oid);
  SELECT namespace.nspname INTO schema_name
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = 'principals'::regclass;
  -- Preserve only absent prior generations outside the live retired-role
  -- registry. A still-existing OID remains terminal even after a role rename.
  INSERT INTO continuum_unresolved_retired_sync_database_identities
    (database_role, previous_database_role_oid, resolution_kind, cluster_epoch, marked_at)
  SELECT history.database_role, history.database_role_oid, 'superseded',
         current_epoch, history.retired_at
    FROM continuum_retired_sync_database_identities history
   WHERE history.database_role = target_database_role
     AND history.database_role_oid <> target_oid
     AND NOT EXISTS (
       SELECT 1 FROM pg_roles role WHERE role.oid = history.database_role_oid)
  ON CONFLICT (database_role, previous_database_role_oid) DO UPDATE SET
    resolution_kind = 'superseded',
    cluster_epoch = EXCLUDED.cluster_epoch,
    marked_at = LEAST(
      continuum_unresolved_retired_sync_database_identities.marked_at,
      EXCLUDED.marked_at);
  DELETE FROM continuum_retired_sync_database_identities
   WHERE database_role = target_database_role AND database_role_oid <> target_oid
     AND NOT EXISTS (
       SELECT 1 FROM pg_roles role
        WHERE role.oid = continuum_retired_sync_database_identities.database_role_oid);
  PERFORM continuum_retire_sync_database_identities(target_oid);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I',
    schema_name, target_database_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I',
    schema_name, target_database_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM %I',
    schema_name, target_database_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I', schema_name, target_database_role);
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

CREATE OR REPLACE FUNCTION continuum_supersede_restore_pending_sync_identity(
  target_database_role NAME, expected_previous_database_role_oid OID,
  confirmation TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE owner_oid OID; invoking_oid OID; replacement_oid OID;
BEGIN
  IF confirmation <> 'SUPERSEDE RESTORE-PENDING SYNC IDENTITY' THEN
    RAISE EXCEPTION 'restore-pending supersession requires exact confirmation';
  END IF;
  SELECT relowner INTO owner_oid FROM pg_class WHERE oid = 'principals'::regclass;
  SELECT oid INTO invoking_oid FROM pg_roles WHERE rolname = continuum_invoking_database_role();
  IF invoking_oid IS DISTINCT FROM owner_oid THEN
    RAISE EXCEPTION 'only the migration owner may supersede a restore-pending sync identity';
  END IF;
  PERFORM pg_advisory_xact_lock(834641726154302119::bigint);
  PERFORM pg_advisory_xact_lock(834641726154302120::bigint);
  LOCK TABLE continuum_retired_sync_database_identities,
             continuum_unresolved_retired_sync_database_identities
    IN SHARE ROW EXCLUSIVE MODE;
  SELECT oid INTO replacement_oid FROM pg_roles WHERE rolname = target_database_role;
  IF replacement_oid IS NULL OR replacement_oid = expected_previous_database_role_oid THEN
    RAISE EXCEPTION 'supersession requires an existing same-name role with a different OID';
  END IF;
  UPDATE continuum_unresolved_retired_sync_database_identities
     SET resolution_kind = 'superseded'
   WHERE database_role = target_database_role
     AND previous_database_role_oid = expected_previous_database_role_oid
     AND resolution_kind = 'restore_pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'matching restore-pending sync identity was not found';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_supersede_restore_pending_sync_identity(
  NAME, OID, TEXT) FROM PUBLIC;

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
  IF NOT EXISTS (
    SELECT 1 FROM principals principal
    JOIN scope_memberships membership ON membership.principal_id = principal.id
    JOIN scopes scope ON scope.id = membership.scope_id
     WHERE principal.id = target_principal_id
       AND principal.kind = 'user' AND principal.disabled_at IS NULL
       AND scope.id = continuum_org_scope_id()
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

CREATE OR REPLACE FUNCTION continuum_operator_pseudonymize_scope(
  authorization_principal_id UUID,
  target_scope_id UUID,
  pseudonym TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  IF pseudonym IS NULL OR btrim(pseudonym) = '' THEN
    RAISE EXCEPTION 'scope pseudonym must not be empty';
  END IF;
  UPDATE scopes SET name = pseudonym
   WHERE id = target_scope_id
     AND kind = 'user'
     AND id <> continuum_org_scope_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only an existing non-organization user scope may be pseudonymized';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_pseudonymize_scope(UUID, UUID, TEXT) FROM PUBLIC;

DROP FUNCTION IF EXISTS continuum_assert_application_role_allowlist(NAME);
CREATE OR REPLACE FUNCTION continuum_assert_application_role_allowlist(
  target_database_role NAME, operator_profile BOOLEAN DEFAULT FALSE
) RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE schema_oid OID; owner_oid OID; target_oid OID;
BEGIN
  SELECT relation.relnamespace, relation.relowner INTO schema_oid, owner_oid
    FROM pg_class relation WHERE relation.oid = 'principals'::regclass;
  IF (SELECT oid FROM pg_roles WHERE rolname = continuum_invoking_database_role()) <> owner_oid THEN
    RAISE EXCEPTION 'only the migration owner may validate an application role';
  END IF;
  SELECT oid INTO target_oid FROM pg_roles WHERE rolname = target_database_role;
  IF target_oid IS NULL THEN RAISE EXCEPTION 'application role does not exist'; END IF;
  IF operator_profile THEN
    IF NOT EXISTS (
      SELECT 1 FROM continuum_trusted_database_identities identity
       WHERE identity.database_role_oid = target_oid
         AND identity.can_approve AND NOT identity.can_sync
    ) THEN RAISE EXCEPTION 'operator role is not OID-bound approval-only authority'; END IF;
    PERFORM continuum_validate_trusted_database_role(
      target_database_role, 'approve', FALSE);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_parameter_acl parameter_acl
    CROSS JOIN LATERAL aclexplode(parameter_acl.paracl) privilege
     WHERE privilege.grantee IN (0, target_oid)
  ) OR EXISTS (
    SELECT 1 FROM pg_db_role_setting setting WHERE setting.setrole = target_oid
  ) THEN
    RAISE EXCEPTION 'application role parameter privilege or role-setting drift';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles role WHERE role.oid = target_oid
      AND (role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
           OR role.rolreplication OR role.rolbypassrls)
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members membership
     WHERE membership.member = target_oid
        OR (membership.roleid = target_oid AND membership.member <> owner_oid)
  ) OR NOT has_schema_privilege(target_database_role, schema_oid, 'USAGE')
    OR has_schema_privilege(target_database_role, schema_oid, 'CREATE')
    OR EXISTS (
      SELECT 1 FROM pg_namespace namespace
      CROSS JOIN LATERAL aclexplode(COALESCE(
        namespace.nspacl, acldefault('n', namespace.nspowner))) privilege
       WHERE namespace.oid = schema_oid AND privilege.grantee = 0
    ) THEN
    RAISE EXCEPTION 'application role has privileged attributes or membership-edge drift';
  END IF;
  IF EXISTS (
    WITH expected(object_name, privilege_type) AS (VALUES
      ('principals','SELECT'),('principals','INSERT'),('principals','UPDATE'),
      ('scopes','SELECT'),('scopes','INSERT'),
      ('memories','SELECT'),('memories','INSERT'),('memories','UPDATE'),
      ('entra_groups','SELECT'),
      ('scope_memberships','SELECT'),('scope_memberships','INSERT'),
      ('scope_memberships','UPDATE'),('scope_memberships','DELETE'),
      ('memory_embeddings','SELECT'),('memory_embeddings','INSERT'),
      ('memory_embeddings','UPDATE'),('memory_embeddings','DELETE'),
      ('service_api_keys','SELECT'),('service_api_keys','INSERT'),('service_api_keys','UPDATE'),
      ('ingest_deliveries','SELECT'),('ingest_deliveries','INSERT'),('ingest_deliveries','UPDATE'),
      ('entra_sync_state','SELECT'),
      ('principal_user_scopes','SELECT'),('principal_user_scopes','INSERT'),
      ('principal_user_scopes','UPDATE'),('principal_offboarding_runs','SELECT'),
      ('audit_log','SELECT'),('audit_log','INSERT'),
      ('principal_aliases','SELECT'),('principal_aliases','DELETE'),
      ('audit_log_offboarding_scopes','SELECT'),
      ('audit_log_offboarding_backfill_state','SELECT'),
      ('principal_user_scope_approvals','SELECT'),
      ('principal_offboarding_events','SELECT'),
      ('principal_offboarding_run_events','SELECT'),
      ('principal_offboarding_takeover_events','SELECT')
    ), actual AS (
      SELECT relation.relname::text, upper(privilege.privilege_type)::text
        FROM pg_class relation
        CROSS JOIN LATERAL aclexplode(CASE WHEN cardinality(relation.relacl) > 0
          THEN relation.relacl ELSE acldefault(
            CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
            relation.relowner) END) privilege
       WHERE relation.relnamespace = schema_oid
         AND relation.relkind IN ('r','p','v','m','f') AND privilege.grantee = target_oid
    )
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    UNION ALL (SELECT * FROM expected EXCEPT SELECT * FROM actual)
  ) THEN RAISE EXCEPTION 'application role table privilege drift from exact allow-list'; END IF;
  IF EXISTS (
    WITH column_acls AS MATERIALIZED (
      SELECT attribute.attrelid, attribute.attacl
        FROM pg_attribute attribute
       WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
         AND cardinality(attribute.attacl) > 0
    )
    SELECT 1 FROM column_acls attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege
     WHERE relation.relnamespace = schema_oid AND privilege.grantee = target_oid
  ) THEN RAISE EXCEPTION 'application role column privilege drift from exact allow-list'; END IF;
  IF EXISTS (
    WITH expected(object_name, privilege_type) AS (VALUES
      ('audit_log_id_seq','USAGE'),('audit_log_id_seq','SELECT'),
      ('principal_user_scope_approvals_id_seq','USAGE'),
      ('principal_user_scope_approvals_id_seq','SELECT'),
      ('principal_offboarding_run_events_id_seq','USAGE'),
      ('principal_offboarding_run_events_id_seq','SELECT')
    ), actual AS (
      SELECT relation.relname::text, upper(privilege.privilege_type)::text
        FROM pg_class relation
        CROSS JOIN LATERAL aclexplode(COALESCE(
          relation.relacl, acldefault('s', relation.relowner))) privilege
       WHERE relation.relnamespace = schema_oid AND relation.relkind = 'S'
         AND privilege.grantee = target_oid
    )
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    UNION ALL (SELECT * FROM expected EXCEPT SELECT * FROM actual)
  ) THEN RAISE EXCEPTION 'application role sequence privilege drift from exact allow-list'; END IF;
  IF EXISTS (
    WITH expected(signature) AS (
      SELECT signature FROM (VALUES
        ('continuum_org_scope_id()'),
        ('continuum_audit_retention_minimum_days()'),
        ('continuum_offboarding_expected_audit_metadata(jsonb)'),
        ('continuum_membership_is_effective(boolean,text)'),
        ('continuum_disable_principal(uuid,uuid)')
      ) application(signature)
      UNION ALL
      SELECT signature FROM (VALUES
        ('continuum_create_user_scope_approval(uuid,uuid,uuid,uuid[],text)'),
        ('continuum_upsert_entra_group_binding(uuid,text,text,uuid,text)'),
        ('continuum_operator_revoke_entra_group_binding(uuid,text)'),
        ('continuum_operator_offboard_scope_access(uuid,uuid)'),
        ('continuum_operator_pseudonymize_scope(uuid,uuid,text)'),
        ('continuum_change_manual_org_admin(uuid,uuid,text,boolean)'),
        ('continuum_takeover_manual_org_admin(uuid,uuid,uuid)'),
        ('continuum_operator_complete_offboarding_run(uuid,uuid,jsonb)'),
        ('continuum_operator_get_offboarding_run(uuid,uuid)'),
        ('continuum_operator_authorize_audit_retention(uuid)'),
        ('continuum_operator_resume_offboarding_run(uuid,uuid)'),
        ('continuum_operator_restart_offboarding_run(uuid,uuid,jsonb)'),
        ('continuum_operator_write_offboarding_run(uuid,uuid,text,jsonb)'),
        ('continuum_operator_start_offboarding_run(uuid,uuid,jsonb)'),
        ('continuum_operator_redact_offboarding_audit(uuid,uuid,bigint[])'),
        ('continuum_operator_record_offboarding_event(uuid)'),
        ('continuum_operator_apply_audit_retention(uuid,timestampwithtimezone,integer,uuid,integer,jsonb,text,text)'),
        ('continuum_operator_reactivate_principal(uuid,uuid)'),
        ('continuum_operator_remove_entra_membership(uuid,uuid,uuid,text)'),
        ('continuum_rotate_sync_database_identity(uuid,name,uuid)'),
        ('continuum_cleanup_legacy_offboarding_audit_requests(integer)')
      ) operator(signature) WHERE operator_profile
    ), actual AS (
      SELECT function.proname || '(' || replace(oidvectortypes(function.proargtypes), ' ', '') || ')'
        FROM pg_proc function
        CROSS JOIN LATERAL aclexplode(COALESCE(
          function.proacl, acldefault('f', function.proowner))) privilege
       WHERE function.pronamespace = schema_oid AND privilege.grantee = target_oid
         AND upper(privilege.privilege_type) = 'EXECUTE'
         AND NOT EXISTS (
           SELECT 1 FROM pg_depend dependency
           JOIN pg_extension extension ON extension.oid = dependency.refobjid
            WHERE dependency.classid = 'pg_proc'::regclass
              AND dependency.objid = function.oid
              AND dependency.refclassid = 'pg_extension'::regclass
              AND dependency.deptype = 'e' AND extension.extname = 'vector')
    )
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    UNION ALL (SELECT * FROM expected EXCEPT SELECT * FROM actual)
  ) THEN RAISE EXCEPTION 'application role function privilege drift from exact allow-list'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(COALESCE(
      relation.relacl,
      acldefault(CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
                 relation.relowner))) privilege
     WHERE relation.relnamespace = schema_oid AND privilege.grantee = 0
  ) OR EXISTS (
    WITH column_acls AS MATERIALIZED (
      SELECT attribute.attrelid, attribute.attacl
        FROM pg_attribute attribute
       WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
         AND cardinality(attribute.attacl) > 0
    )
    SELECT 1 FROM column_acls attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege
     WHERE relation.relnamespace = schema_oid AND privilege.grantee = 0
  ) OR EXISTS (
    SELECT 1 FROM pg_proc function
    CROSS JOIN LATERAL aclexplode(COALESCE(
      function.proacl, acldefault('f', function.proowner))) privilege
     WHERE function.pronamespace = schema_oid AND privilege.grantee = 0
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend dependency
         JOIN pg_extension extension ON extension.oid = dependency.refobjid
          WHERE dependency.classid = 'pg_proc'::regclass
            AND dependency.objid = function.oid
            AND dependency.refclassid = 'pg_extension'::regclass
            AND dependency.deptype = 'e' AND extension.extname = 'vector')
  ) OR EXISTS (
    SELECT 1 FROM pg_default_acl defaults
    CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege
     WHERE defaults.defaclrole = owner_oid
       AND defaults.defaclnamespace IN (0, schema_oid)
       AND privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC or default application-schema privilege drift';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_assert_application_role_allowlist(NAME, BOOLEAN) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_assert_operator_role_allowlist(
  target_database_role NAME
) RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_assert_application_role_allowlist(target_database_role, TRUE);
END;
$$;
REVOKE ALL ON FUNCTION continuum_assert_operator_role_allowlist(NAME) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_rebind_database_identity_oids(
  confirmation TEXT
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  owner_oid OID;
  invoking_oid OID;
  previous_epoch UUID;
  restored_epoch UUID := gen_random_uuid();
  previous_system_identifier TEXT;
  current_system_identifier TEXT :=
    (SELECT system_identifier::text FROM pg_control_system());
  identity_record RECORD;
  changed_count INTEGER := 0;
BEGIN
  IF confirmation <> 'REBIND AFTER LOGICAL RESTORE' THEN
    RAISE EXCEPTION 'logical-restore OID rebind requires exact confirmation';
  END IF;
  SELECT relowner INTO owner_oid FROM pg_class WHERE oid = 'principals'::regclass;
  SELECT oid INTO invoking_oid FROM pg_roles WHERE rolname = continuum_invoking_database_role();
  IF invoking_oid IS DISTINCT FROM owner_oid THEN
    RAISE EXCEPTION 'only the migration owner may rebind database identity OIDs';
  END IF;
  LOCK TABLE continuum_trusted_database_identities,
             continuum_retired_sync_database_identities,
             continuum_unresolved_retired_sync_database_identities,
             continuum_database_identity_epoch
    IN ACCESS EXCLUSIVE MODE;
  SELECT epoch, cluster_system_identifier
    INTO previous_epoch, previous_system_identifier
    FROM continuum_database_identity_epoch WHERE singleton;
  IF current_system_identifier = previous_system_identifier AND EXISTS (
    SELECT 1
      FROM continuum_retired_sync_database_identities history
      JOIN pg_roles live_role ON live_role.oid = history.database_role_oid
     WHERE live_role.rolname <> history.database_role
       AND NOT (
         EXISTS (
           SELECT 1 FROM pg_roles restored_role
           JOIN continuum_retired_sync_database_identities target_history
             ON target_history.database_role_oid = restored_role.oid
            WHERE restored_role.rolname = history.database_role)
         AND EXISTS (
           SELECT 1 FROM continuum_retired_sync_database_identities peer_history
            WHERE peer_history.database_role = live_role.rolname)
       )
  ) THEN
    RAISE EXCEPTION 'a live retired role OID was renamed outside a complete retired-role restore mapping';
  END IF;
  UPDATE continuum_database_identity_epoch
     SET epoch = restored_epoch,
         cluster_system_identifier = current_system_identifier
   WHERE singleton;
  CREATE TEMP TABLE continuum_active_identity_rebind_plan ON COMMIT DROP AS
    SELECT bound_identity.database_role,
           bound_identity.database_role_oid AS previous_oid,
           role.oid AS restored_oid, bound_identity.principal_id,
           bound_identity.can_approve, bound_identity.can_sync,
           bound_identity.created_at
      FROM continuum_trusted_database_identities bound_identity
      LEFT JOIN pg_roles role ON role.rolname = bound_identity.database_role;
  IF EXISTS (SELECT 1 FROM continuum_active_identity_rebind_plan WHERE restored_oid IS NULL) THEN
    RAISE EXCEPTION 'one or more trusted database roles do not exist after restore';
  END IF;
  IF EXISTS (
    SELECT restored_oid FROM continuum_active_identity_rebind_plan
     GROUP BY restored_oid HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'restored database role OIDs are not unique';
  END IF;
  SELECT count(*) INTO changed_count
    FROM continuum_active_identity_rebind_plan WHERE restored_oid <> previous_oid;
  DELETE FROM continuum_trusted_database_identities;
  INSERT INTO continuum_trusted_database_identities
    (database_role, database_role_oid, principal_id, can_approve, can_sync, created_at)
  SELECT database_role, restored_oid, principal_id, can_approve, can_sync, created_at
    FROM continuum_active_identity_rebind_plan;

  -- A retired generation with the same name as an active restored identity is
  -- historical, not the active role. Archive it before resolving retirement.
  UPDATE continuum_unresolved_retired_sync_database_identities unresolved
     SET resolution_kind = 'superseded'
    FROM continuum_active_identity_rebind_plan active
   WHERE unresolved.database_role = active.database_role
     AND unresolved.resolution_kind = 'restore_pending';
  INSERT INTO continuum_unresolved_retired_sync_database_identities
    (database_role, previous_database_role_oid, resolution_kind, cluster_epoch, marked_at)
  SELECT history.database_role, history.database_role_oid, 'superseded',
         previous_epoch, history.retired_at
    FROM continuum_retired_sync_database_identities history
    JOIN continuum_active_identity_rebind_plan active
      ON active.database_role = history.database_role
   WHERE history.database_role_oid <> active.restored_oid
     AND NOT EXISTS (
       SELECT 1 FROM pg_roles role WHERE role.oid = history.database_role_oid)
  ON CONFLICT (database_role, previous_database_role_oid) DO UPDATE SET
    resolution_kind = 'superseded',
    cluster_epoch = EXCLUDED.cluster_epoch,
    marked_at = LEAST(
      continuum_unresolved_retired_sync_database_identities.marked_at,
      EXCLUDED.marked_at);
  DELETE FROM continuum_retired_sync_database_identities history
   USING continuum_active_identity_rebind_plan active
   WHERE history.database_role = active.database_role
     AND history.database_role_oid <> active.restored_oid
     AND NOT EXISTS (
       SELECT 1 FROM pg_roles role WHERE role.oid = history.database_role_oid);

  -- A later restore stage may recreate a previously unresolved retired role.
  -- Resolve exactly one archived generation when the name is not active.
  CREATE TEMP TABLE continuum_unresolved_identity_rebind_plan ON COMMIT DROP AS
    SELECT unresolved.database_role, unresolved.previous_database_role_oid,
           unresolved.marked_at, role.oid AS restored_oid
      FROM continuum_unresolved_retired_sync_database_identities unresolved
      JOIN pg_roles role ON role.rolname = unresolved.database_role
      LEFT JOIN continuum_active_identity_rebind_plan active
        ON active.database_role = unresolved.database_role
      LEFT JOIN continuum_retired_sync_database_identities current_history
        ON current_history.database_role = unresolved.database_role
     WHERE active.database_role IS NULL
       AND current_history.database_role IS NULL
       AND unresolved.resolution_kind = 'restore_pending';
  IF EXISTS (
    SELECT database_role FROM continuum_unresolved_identity_rebind_plan
     GROUP BY database_role HAVING count(*) <> 1
  ) OR EXISTS (
    SELECT restored_oid FROM continuum_unresolved_identity_rebind_plan
     GROUP BY restored_oid HAVING count(*) <> 1
  ) OR EXISTS (
    SELECT 1 FROM continuum_unresolved_identity_rebind_plan plan
    JOIN continuum_retired_sync_database_identities history
      ON history.database_role_oid = plan.restored_oid
     AND history.database_role <> plan.database_role
  ) THEN
    RAISE EXCEPTION 'unresolved retired database identity restore mapping is ambiguous';
  END IF;
  INSERT INTO continuum_retired_sync_database_identities
    (database_role_oid, database_role, retired_at)
  SELECT restored_oid, database_role, marked_at
    FROM continuum_unresolved_identity_rebind_plan
  ON CONFLICT (database_role_oid) DO UPDATE SET
    database_role = EXCLUDED.database_role,
    retired_at = LEAST(
      continuum_retired_sync_database_identities.retired_at,
      EXCLUDED.retired_at);
  DELETE FROM continuum_unresolved_retired_sync_database_identities unresolved
   USING continuum_unresolved_identity_rebind_plan plan
   WHERE unresolved.database_role = plan.database_role
     AND unresolved.previous_database_role_oid = plan.previous_database_role_oid;
  SELECT changed_count + count(*) INTO changed_count
    FROM continuum_unresolved_identity_rebind_plan;

  CREATE TEMP TABLE continuum_retired_identity_rebind_plan ON COMMIT DROP AS
    SELECT history.database_role, history.database_role_oid AS previous_oid,
           role.oid AS restored_oid, history.retired_at
      FROM continuum_retired_sync_database_identities history
      LEFT JOIN pg_roles role ON role.rolname = history.database_role;
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
  SELECT database_role, previous_oid, 'restore_pending', previous_epoch
    FROM continuum_retired_identity_rebind_plan
   WHERE restored_oid IS NULL
  ON CONFLICT (database_role, previous_database_role_oid) DO UPDATE SET
    resolution_kind = 'restore_pending',
    cluster_epoch = EXCLUDED.cluster_epoch,
    marked_at = now();
  DELETE FROM continuum_retired_sync_database_identities;
  INSERT INTO continuum_retired_sync_database_identities
    (database_role_oid, database_role, retired_at)
  SELECT restored_oid, database_role, retired_at
    FROM continuum_retired_identity_rebind_plan WHERE restored_oid IS NOT NULL;
  SELECT changed_count + count(*) INTO changed_count
    FROM continuum_retired_identity_rebind_plan
   WHERE restored_oid IS DISTINCT FROM previous_oid;

  FOR identity_record IN
    SELECT database_role, can_sync FROM continuum_trusted_database_identities
  LOOP
    PERFORM continuum_validate_trusted_database_role(
      identity_record.database_role,
      CASE WHEN identity_record.can_sync THEN 'sync' ELSE 'approve' END,
      identity_record.can_sync);
  END LOOP;
  RETURN changed_count;
END;
$$;
REVOKE ALL ON FUNCTION continuum_rebind_database_identity_oids(TEXT) FROM PUBLIC;

-- Reinstall the extension grant refresher for databases that already ledgered
-- an older 0051. Resolve application roles from the memories relation OID, not
-- current_schema(), because hardened definers deliberately put pg_catalog first.
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
      IF NOT has_function_privilege(target_role.rolname,
                                    vector_function.signature, 'EXECUTE') THEN
        IF vector_function.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) THEN
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

-- Extension updates may add provider-owned pgvector routines. Refresh direct
-- grants where Continuum owns them, accept extension-owner PUBLIC execution,
-- and fail with an actionable pregrant requirement for managed non-owner
-- layouts that revoke PUBLIC. Application-owned functions remain fail-closed.
SELECT continuum_grant_application_vector_functions();

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT function.proname, pg_get_function_identity_arguments(function.oid) AS arguments
      FROM pg_proc function
     WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
       AND function.proname = ANY(ARRAY[
         'continuum_org_scope_id', 'continuum_protect_canonical_org_scope',
         'continuum_bind_initial_org_scope',
         'continuum_protect_capability_marker_write',
         'continuum_require_trusted_database_identity',
         'continuum_validate_entra_guard_markers', 'continuum_guard_entra_admin_sources',
         'continuum_upsert_entra_group_binding',
         'continuum_assert_sync_role_allowlist', 'continuum_verify_sync_database_identity',
         'continuum_require_sync_retirement_authority',
         'continuum_verify_sync_retirement_authority_configuration',
         'continuum_retire_sync_database_identities',
         'continuum_install_sync_database_identity',
         'continuum_supersede_restore_pending_sync_identity',
         'continuum_register_trusted_database_identity',
         'continuum_operator_pseudonymize_scope',
         'continuum_assert_application_role_allowlist',
         'continuum_assert_operator_role_allowlist',
         'continuum_rebind_database_identity_oids',
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
