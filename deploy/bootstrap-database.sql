\set ON_ERROR_STOP on
\set VERBOSITY terse
\set ECHO none
-- Fresh dedicated database only. Execute as its private DBA, with private
-- password environment supplied by the provisioning container, never -v secrets.
\getenv owner_password CONTINUUM_OWNER_PASSWORD
\getenv app_password CONTINUUM_APP_PASSWORD
\getenv operator_password CONTINUUM_OPERATOR_PASSWORD
\getenv sync_password CONTINUUM_SYNC_PASSWORD
BEGIN;
-- Suppress statement/error/duration logging before the first secret-bearing
-- statement. Superuser settings are transaction-local and restore on rollback.
SET LOCAL log_statement = 'none';
SET LOCAL log_min_error_statement = 'panic';
SET LOCAL log_error_verbosity = 'terse';
SET LOCAL log_min_duration_statement = -1;
SET LOCAL log_min_duration_sample = -1;
SET LOCAL log_duration = off;
SET LOCAL password_encryption = 'scram-sha-256';
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TEMP TABLE bootstrap_input ON COMMIT DROP AS
SELECT :'continuum_database'::text AS database_name,
       :'continuum_schema'::text AS app_schema,
       :'continuum_provider_schema'::text AS provider_schema,
       ARRAY[:'continuum_owner_role', :'continuum_app_role',
             :'continuum_operator_role', :'continuum_sync_role']::text[] AS roles,
       ARRAY[:'owner_password', :'app_password', :'operator_password', :'sync_password']::text[] AS passwords;
DO $bootstrap$
DECLARE i RECORD; n INTEGER;
BEGIN
  SELECT * INTO STRICT i FROM bootstrap_input;
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
     OR session_user <> current_user OR current_database() <> i.database_name THEN
    RAISE EXCEPTION 'fresh bootstrap requires the direct DBA in the declared database';
  END IF;
  IF i.app_schema IN ('public','pg_catalog','information_schema')
     OR i.provider_schema IN ('public','pg_catalog','information_schema')
     OR i.app_schema = i.provider_schema
     OR i.app_schema !~ '^[a-z][a-z0-9_]{0,62}$'
     OR i.provider_schema !~ '^[a-z][a-z0-9_]{0,62}$'
     OR (SELECT count(DISTINCT r) FROM unnest(i.roles) r) <> 4
     OR EXISTS (SELECT 1 FROM unnest(i.roles) r WHERE r !~ '^[a-z][a-z0-9_]{0,62}$')
     OR EXISTS (SELECT 1 FROM unnest(i.passwords) p WHERE octet_length(p) < 32 OR octet_length(p) > 4096)
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ANY(i.roles))
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN (i.app_schema,i.provider_schema))
     OR EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
     OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
                WHERE s.nspname NOT IN ('pg_catalog','information_schema') AND s.nspname !~ '^pg_') THEN
    RAISE EXCEPTION 'fresh bootstrap input or existing database state is invalid; use the upgrade runbook';
  END IF;
  FOR n IN 1..4 LOOP
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', i.roles[n], i.passwords[n]);
  END LOOP;
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', i.database_name);
  EXECUTE format('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  FOR n IN 1..4 LOOP
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', i.database_name, i.roles[n]);
  END LOOP;
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO %I', i.database_name, i.roles[1]);
  EXECUTE format('GRANT %I TO %I WITH ADMIN OPTION, SET FALSE, INHERIT FALSE', i.roles[4], i.roles[1]);
  EXECUTE format('CREATE SCHEMA %I AUTHORIZATION %I', i.app_schema, i.roles[1]);
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', i.app_schema);
  EXECUTE format('CREATE SCHEMA %I', i.provider_schema);
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', i.provider_schema);
  EXECUTE format('CREATE EXTENSION vector WITH SCHEMA %I', i.provider_schema);
  EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA %I FROM PUBLIC', i.provider_schema);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I WITH GRANT OPTION', i.provider_schema, i.roles[1]);
  EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO %I WITH GRANT OPTION', i.provider_schema, i.roles[1]);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC', i.roles[1]);
EXCEPTION WHEN OTHERS THEN
  -- Never propagate a dynamic CREATE ROLE's plaintext SQL via error context.
  RAISE EXCEPTION 'fresh database bootstrap failed; review approved inputs and database state' USING ERRCODE = SQLSTATE;
END;
$bootstrap$;
COMMIT;
