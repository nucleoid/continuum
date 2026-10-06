-- Prevent temporary-schema relation shadowing in every Continuum security
-- definer and trigger function installed in the application schema.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $migration$
DECLARE
  schema_name TEXT := current_schema();
  function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT procedure.proname,
           pg_get_function_identity_arguments(procedure.oid) AS arguments
      FROM pg_proc procedure
     WHERE procedure.pronamespace = current_schema()::regnamespace
       AND procedure.proname LIKE 'continuum\_%' ESCAPE '\'
       AND procedure.proowner = current_user::regrole
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend dependency
          WHERE dependency.classid = 'pg_proc'::regclass
            AND dependency.objid = procedure.oid
            AND dependency.deptype = 'e'
       )
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, %I, pg_temp',
      schema_name, function_record.proname, function_record.arguments, schema_name
    );
  END LOOP;
END;
$migration$;
