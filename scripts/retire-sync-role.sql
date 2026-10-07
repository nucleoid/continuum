\set ON_ERROR_STOP on
\if :{?retired_sync_role}
\else
  \echo 'retired_sync_role must name the retired sync role'
\endif
\if :{?confirm_retired_sync_role_oid}
\else
  \echo 'confirm_retired_sync_role_oid must equal the reviewed PostgreSQL role OID'
\endif
\if :{?continuum_schema}
\else
  \set continuum_schema public
\endif

-- Run as the migration owner after stopping every Continuum process. This is
-- the explicit remediation path for an installation that recorded 0048 before
-- retired roles were changed to NOLOGIN.
BEGIN;
CREATE TEMP TABLE continuum_retired_sync_input (
  retired_sync NAME NOT NULL,
  confirmed_oid OID NOT NULL,
  application_schema NAME NOT NULL
) ON COMMIT DROP;
INSERT INTO continuum_retired_sync_input
VALUES (:'retired_sync_role', :'confirm_retired_sync_role_oid'::oid,
        :'continuum_schema');

DO $retire$
DECLARE
  retired_sync NAME;
  confirmed_oid OID;
  application_schema NAME;
  retired_oid OID;
  schema_oid OID;
  owner_oid OID;
  active_identity BOOLEAN;
BEGIN
  SELECT input.retired_sync, input.confirmed_oid, input.application_schema
    INTO retired_sync, confirmed_oid, application_schema
    FROM continuum_retired_sync_input input;
  SELECT role.oid INTO retired_oid FROM pg_roles role WHERE role.rolname = retired_sync;
  IF retired_oid IS NULL THEN
    RAISE EXCEPTION 'retired sync role does not exist';
  END IF;
  IF retired_oid <> confirmed_oid THEN
    RAISE EXCEPTION 'retired sync role OID confirmation does not match reviewed target';
  END IF;
  SELECT namespace.oid, relation.relowner INTO schema_oid, owner_oid
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = format('%I.principals', application_schema)::regclass;
  EXECUTE format(
    'SELECT EXISTS (
       SELECT 1 FROM %I.continuum_trusted_database_identities identity
        WHERE identity.database_role_oid = $1
     )', application_schema
  ) INTO active_identity USING retired_oid;
  IF active_identity THEN
    RAISE EXCEPTION 'refusing to retire an active trusted database identity';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members membership
     WHERE retired_oid IN (membership.roleid, membership.member)
       AND NOT (membership.roleid = retired_oid AND membership.member = owner_oid)
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace namespace
     WHERE namespace.oid = schema_oid AND namespace.nspowner = retired_oid
  ) OR EXISTS (
    SELECT 1 FROM pg_class relation
     WHERE relation.relnamespace = schema_oid AND relation.relowner = retired_oid
  ) OR EXISTS (
    SELECT 1 FROM pg_proc function
     WHERE function.pronamespace = schema_oid AND function.proowner = retired_oid
  ) THEN
    RAISE EXCEPTION 'retired sync role has membership or owns application objects';
  END IF;
  EXECUTE format(
    'SELECT %I.continuum_require_sync_retirement_authority($1)', application_schema
  ) USING retired_oid;
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I',
    application_schema, retired_sync);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I',
    application_schema, retired_sync);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM %I',
    application_schema, retired_sync);
  EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I',
    application_schema, retired_sync);
  EXECUTE format('ALTER ROLE %I NOLOGIN', retired_sync);
  EXECUTE format(
    'INSERT INTO %I.continuum_retired_sync_database_identities
       (database_role_oid, database_role)
     VALUES ($1, $2)
     ON CONFLICT (database_role_oid) DO UPDATE SET
       database_role = EXCLUDED.database_role, retired_at = now()',
    application_schema
  ) USING retired_oid, retired_sync;
END;
$retire$;
COMMIT;
