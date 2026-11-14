\set ON_ERROR_STOP on
\if :{?continuum_schema}
\else
  \set continuum_schema public
\endif
-- Migration owner only, existing dedicated isolated LOGIN only. This installs
-- capabilities; the separate bound operator reviews principal/scope/profile.
BEGIN;
SELECT set_config('continuum.extraction_grant_schema', :'continuum_schema', TRUE);
SELECT set_config('continuum.extraction_grant_role', :'continuum_extraction_worker_role', TRUE);
DO $worker$
DECLARE schema_name TEXT:=current_setting('continuum.extraction_grant_schema');
  target NAME:=current_setting('continuum.extraction_grant_role')::name; signature TEXT; owner_id OID;
BEGIN
  SELECT relowner INTO owner_id FROM pg_class WHERE oid=format('%I.memories',schema_name)::regclass;
  IF owner_id IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname=current_user) THEN RAISE insufficient_privilege USING MESSAGE='extraction grant requires migration owner'; END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I',schema_name,target);
  FOR signature IN EXECUTE format('SELECT unnest(%I.continuum_extraction_worker_signatures())',schema_name) LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',schema_name,signature,target);
  END LOOP;
  EXECUTE format('SELECT %I.continuum_extraction_assert_worker($1)',schema_name) USING target;
END;
$worker$;
COMMIT;
