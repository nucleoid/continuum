\set ON_ERROR_STOP on
\if :{?continuum_schema}
\else
  \set continuum_schema public
\endif

-- Run as the tenant migration owner before 0080 and again before restarting
-- runtime processes. This inventories readers; it grants or revokes nothing.
BEGIN;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SELECT set_config('continuum.profile_preflight_schema', :'continuum_schema', TRUE);
DO $preflight$
DECLARE
  schema_name TEXT := current_setting('continuum.profile_preflight_schema');
  application_owner_oid OID;
  memory_relation_oid OID;
  candidate RECORD;
  exact_profile BOOLEAN;
BEGIN
  memory_relation_oid := format('%I.memories', schema_name)::regclass;
  SELECT relowner INTO application_owner_oid FROM pg_class WHERE oid = memory_relation_oid;
  IF application_owner_oid <> current_user::regrole::oid THEN
    RAISE EXCEPTION 'pgvector profile preflight requires the tenant migration owner';
  END IF;
  FOR candidate IN
    SELECT oid, rolname FROM pg_roles
     WHERE oid <> application_owner_oid
       AND has_table_privilege(oid, memory_relation_oid, 'SELECT')
     ORDER BY rolname
  LOOP
    exact_profile := FALSE;
    BEGIN
      EXECUTE format('SELECT %I.continuum_assert_application_role_allowlist($1, FALSE)', schema_name)
        USING candidate.rolname;
      exact_profile := TRUE;
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        EXECUTE format('SELECT %I.continuum_assert_application_role_allowlist($1, TRUE)', schema_name)
          USING candidate.rolname;
        exact_profile := TRUE;
      EXCEPTION WHEN OTHERS THEN
        -- Cancellation must retain the preflight's hard server deadline.
        NULL;
      END;
    END;
    IF NOT exact_profile THEN
      RAISE WARNING 'reader role % lacks an exact application/operator profile; classify it and regrant runtime roles before restart',
        quote_ident(candidate.rolname);
    END IF;
  END LOOP;
END;
$preflight$;
COMMIT;
