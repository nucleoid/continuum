\if :{?continuum_sync_role}
\else
  \echo 'continuum_sync_role must name the expected active sync role'
  \quit
\endif
\if :{?continuum_operator_role}
\else
  \echo 'continuum_operator_role must name the expected operator role'
  \quit
\endif
\if :{?retired_sync_role}
\else
  \echo 'retired_sync_role must name the retired sync role'
  \quit
\endif
\if :{?continuum_schema}
\else
  \set continuum_schema public
\endif

SELECT :"continuum_schema".continuum_verify_database_identity_configuration();
SELECT :"continuum_schema".continuum_verify_sync_retirement_authority_configuration();

BEGIN;
CREATE TEMP TABLE continuum_identity_verification_input (
  active_sync NAME NOT NULL,
  expected_operator NAME NOT NULL,
  retired_sync NAME NOT NULL,
  application_schema NAME NOT NULL
) ON COMMIT DROP;
INSERT INTO continuum_identity_verification_input
VALUES (:'continuum_sync_role', :'continuum_operator_role',
        :'retired_sync_role', :'continuum_schema');

DO $verify$
DECLARE
  active_sync NAME;
  expected_operator NAME;
  retired_sync NAME;
  application_schema NAME;
  active_sync_valid BOOLEAN;
  operator_valid BOOLEAN;
BEGIN
  SELECT input.active_sync, input.expected_operator, input.retired_sync,
         input.application_schema
    INTO active_sync, expected_operator, retired_sync, application_schema
    FROM continuum_identity_verification_input input;
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
  IF EXISTS (
    SELECT 1 FROM pg_roles role
     WHERE role.rolname = retired_sync AND (
       role.rolcanlogin
       OR has_schema_privilege(retired_sync, application_schema, 'USAGE')
       OR has_table_privilege(retired_sync,
            format('%I.principals', application_schema), 'SELECT')
       OR has_sequence_privilege(retired_sync,
            format('%I.audit_log_id_seq', application_schema), 'USAGE')
     )
  ) THEN
    RAISE EXCEPTION 'retired sync role remains login-capable or retains application authority';
  END IF;
END;
$verify$;
ROLLBACK;
