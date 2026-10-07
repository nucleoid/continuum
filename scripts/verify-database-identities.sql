\set ON_ERROR_STOP on
\if :{?continuum_app_role}
\else
  \echo 'continuum_app_role must name the shared application role'
\endif
\if :{?continuum_sync_role}
\else
  \echo 'continuum_sync_role must name the expected active sync role'
\endif
\if :{?continuum_operator_role}
\else
  \echo 'continuum_operator_role must name the expected operator role'
\endif
\if :{?retired_sync_role}
\else
  \set retired_sync_role ''
\endif
\if :{?continuum_schema}
\else
  \set continuum_schema public
\endif

SELECT :"continuum_schema".continuum_verify_database_identity_configuration();
SELECT :"continuum_schema".continuum_verify_sync_retirement_authority_configuration();

BEGIN;
CREATE TEMP TABLE continuum_identity_verification_input (
  application_role NAME NOT NULL,
  active_sync NAME NOT NULL,
  expected_operator NAME NOT NULL,
  retired_sync NAME NOT NULL,
  application_schema NAME NOT NULL
) ON COMMIT DROP;
INSERT INTO continuum_identity_verification_input
VALUES (:'continuum_app_role', :'continuum_sync_role', :'continuum_operator_role',
        :'retired_sync_role', :'continuum_schema');

DO $verify$
DECLARE
  application_role NAME;
  active_sync NAME;
  expected_operator NAME;
  retired_sync NAME;
  application_schema NAME;
  owner_oid OID;
  active_sync_valid BOOLEAN;
  operator_valid BOOLEAN;
  unresolved_retired_name_reused BOOLEAN;
  retired_identity RECORD;
BEGIN
  SELECT input.application_role, input.active_sync, input.expected_operator, input.retired_sync,
         input.application_schema
    INTO application_role, active_sync, expected_operator, retired_sync, application_schema
    FROM continuum_identity_verification_input input;
  SELECT relation.relowner INTO owner_oid
    FROM pg_class relation
   WHERE relation.oid = format('%I.principals', application_schema)::regclass;
  EXECUTE format(
    'SELECT %I.continuum_assert_application_role_allowlist($1)', application_schema
  ) USING application_role;
  EXECUTE format(
    'SELECT EXISTS (
       SELECT 1 FROM %I.continuum_trusted_database_identities identity
       JOIN pg_roles role ON role.oid = identity.database_role_oid
        WHERE identity.database_role = $1
          AND role.rolname = $1
          AND identity.can_sync AND NOT identity.can_approve
     )', application_schema
  ) INTO active_sync_valid USING active_sync;
  IF NOT active_sync_valid THEN
    RAISE EXCEPTION 'expected active sync role is not the unique OID-bound sync identity';
  END IF;
  EXECUTE format(
    'SELECT EXISTS (
       SELECT 1 FROM %I.continuum_trusted_database_identities identity
       JOIN pg_roles role ON role.oid = identity.database_role_oid
        WHERE identity.database_role = $1
          AND role.rolname = $1
          AND identity.can_approve AND NOT identity.can_sync
     )', application_schema
  ) INTO operator_valid USING expected_operator;
  IF NOT operator_valid THEN
    RAISE EXCEPTION 'expected operator role is not OID-bound approval-only authority';
  END IF;
  EXECUTE format(
    'SELECT %I.continuum_assert_operator_role_allowlist($1)', application_schema
  ) USING expected_operator;
  IF retired_sync <> '' AND NOT EXISTS (
    SELECT 1 FROM pg_roles role WHERE role.rolname = retired_sync
  ) THEN
    RAISE EXCEPTION 'retired sync role does not exist';
  END IF;
  EXECUTE format(
    'SELECT EXISTS (
       SELECT 1 FROM %I.continuum_unresolved_retired_sync_database_identities unresolved
       JOIN pg_roles role ON role.rolname = unresolved.database_role
     )', application_schema
  ) INTO unresolved_retired_name_reused;
  IF unresolved_retired_name_reused THEN
    RAISE EXCEPTION 'an unresolved retired sync role name was recreated after logical restore';
  END IF;
  FOR retired_identity IN EXECUTE format(
    'SELECT history.database_role_oid, history.database_role
       FROM %I.continuum_retired_sync_database_identities history
       JOIN pg_roles bound_role
         ON bound_role.oid = history.database_role_oid
        AND bound_role.rolname = history.database_role
     UNION
     SELECT role.oid, role.rolname FROM pg_roles role
      WHERE $1 <> '''' AND role.rolname = $1', application_schema
  ) USING retired_sync
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_roles role
       WHERE role.rolname = retired_identity.database_role
         AND role.oid <> retired_identity.database_role_oid
    ) THEN
      RAISE EXCEPTION 'retired sync role name was reused by a different OID';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_roles role WHERE role.oid = retired_identity.database_role_oid
    ) THEN
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_roles role
       WHERE role.oid = retired_identity.database_role_oid AND role.rolcanlogin
    ) OR EXISTS (
      SELECT 1 FROM pg_auth_members membership
       WHERE retired_identity.database_role_oid IN (membership.roleid, membership.member)
         AND NOT (
           membership.roleid = retired_identity.database_role_oid
           AND membership.member = owner_oid
           AND membership.admin_option
           AND NOT membership.set_option
           AND NOT membership.inherit_option)
    ) OR EXISTS (
      SELECT 1 FROM pg_namespace namespace
      CROSS JOIN LATERAL aclexplode(COALESCE(
        namespace.nspacl, acldefault('n', namespace.nspowner))) privilege
       WHERE namespace.nspname = application_schema
         AND privilege.grantee = retired_identity.database_role_oid
    ) OR EXISTS (
      SELECT 1 FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(
        relation.relacl, acldefault(
          CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
          relation.relowner))) privilege
       WHERE namespace.nspname = application_schema
         AND privilege.grantee = retired_identity.database_role_oid
    ) OR EXISTS (
      SELECT 1 FROM pg_proc function
      JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(
        function.proacl, acldefault('f', function.proowner))) privilege
       WHERE namespace.nspname = application_schema
         AND privilege.grantee = retired_identity.database_role_oid
    ) THEN
      RAISE EXCEPTION 'retired sync role remains login-capable or retains membership/application authority';
    END IF;
  END LOOP;
END;
$verify$;
ROLLBACK;
