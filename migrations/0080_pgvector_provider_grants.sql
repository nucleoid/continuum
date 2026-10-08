-- Keep application access to pgvector explicit when the extension is outside
-- the Continuum schema. Existing extension placement is preserved.

CREATE OR REPLACE FUNCTION continuum_grant_application_vector_functions()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  application_schema_oid OID;
  application_owner_oid OID;
  invoking_role_oid OID;
  vector_schema_oid OID;
  vector_schema_name NAME;
  vector_schema_owner_oid OID;
  target_role RECORD;
  vector_function RECORD;
BEGIN
  SELECT relation.relnamespace, relation.relowner
    INTO application_schema_oid, application_owner_oid
    FROM pg_class relation WHERE relation.oid = 'memories'::regclass;
  SELECT oid INTO invoking_role_oid
    FROM pg_roles WHERE rolname = continuum_invoking_database_role();
  IF invoking_role_oid <> application_owner_oid THEN
    RAISE EXCEPTION 'only the migration owner may refresh application extension grants';
  END IF;

  SELECT extension.extnamespace, namespace.nspname, namespace.nspowner
    INTO vector_schema_oid, vector_schema_name, vector_schema_owner_oid
    FROM pg_extension extension
    JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
   WHERE extension.extname = 'vector';
  IF vector_schema_oid IS NULL THEN
    RAISE EXCEPTION 'the vector extension is not installed';
  END IF;

  FOR target_role IN
    SELECT DISTINCT role.rolname
      FROM pg_class relation
      CROSS JOIN LATERAL aclexplode(COALESCE(
        relation.relacl, acldefault('r', relation.relowner))) privilege
      JOIN pg_roles role ON role.oid = privilege.grantee
     WHERE relation.oid = 'memories'::regclass
       AND upper(privilege.privilege_type) = 'SELECT'
       AND role.oid <> application_owner_oid
  LOOP
    IF NOT has_schema_privilege(target_role.rolname, vector_schema_oid, 'USAGE') THEN
      IF vector_schema_owner_oid <> application_owner_oid AND NOT EXISTS (
        SELECT 1
          FROM pg_namespace namespace
          CROSS JOIN LATERAL aclexplode(COALESCE(
            namespace.nspacl, acldefault('n', namespace.nspowner))) privilege
         WHERE namespace.oid = vector_schema_oid
           AND privilege.grantee = application_owner_oid
           AND upper(privilege.privilege_type) = 'USAGE'
           AND privilege.is_grantable
      ) THEN
        RAISE EXCEPTION
          'provider owner must GRANT USAGE ON SCHEMA % TO % WITH GRANT OPTION before refreshing application grants',
          quote_ident(vector_schema_name),
          quote_ident((SELECT rolname FROM pg_roles WHERE oid = application_owner_oid));
      END IF;
      BEGIN
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I',
          vector_schema_name, target_role.rolname);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE EXCEPTION
          'provider owner must GRANT USAGE ON SCHEMA % TO % before refreshing application grants',
          quote_ident(vector_schema_name), quote_ident(target_role.rolname);
      END;
    END IF;

    FOR vector_function IN
      SELECT function.oid,
             function.proowner,
             function.proowner = application_owner_oid OR EXISTS (
               SELECT 1
                 FROM aclexplode(COALESCE(
                   function.proacl, acldefault('f', function.proowner))) privilege
                WHERE privilege.grantee = application_owner_oid
                  AND upper(privilege.privilege_type) = 'EXECUTE'
                  AND privilege.is_grantable
             ) AS can_delegate,
             format('%I.%I(%s)', namespace.nspname, function.proname,
                    pg_get_function_identity_arguments(function.oid)) AS signature
        FROM pg_proc function
        JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
        JOIN pg_depend dependency
          ON dependency.classid = 'pg_proc'::regclass
         AND dependency.objid = function.oid
         AND dependency.refclassid = 'pg_extension'::regclass
         AND dependency.deptype = 'e'
        JOIN pg_extension extension ON extension.oid = dependency.refobjid
       WHERE extension.extname = 'vector'
    LOOP
      IF NOT has_function_privilege(
        target_role.rolname, vector_function.oid, 'EXECUTE'
      ) THEN
        IF NOT vector_function.can_delegate THEN
          RAISE EXCEPTION
            'extension owner must GRANT EXECUTE ON FUNCTION % TO % WITH GRANT OPTION before refreshing application grants',
            vector_function.signature,
            quote_ident((SELECT rolname FROM pg_roles WHERE oid = application_owner_oid));
        END IF;
        BEGIN
          EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',
            vector_function.signature, target_role.rolname);
        EXCEPTION WHEN insufficient_privilege THEN
          RAISE EXCEPTION
            'provider owner must GRANT EXECUTE ON FUNCTION % TO % before refreshing application grants',
            vector_function.signature, target_role.rolname;
        END;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION continuum_grant_application_vector_functions() FROM PUBLIC;

DO $harden$
DECLARE schema_name TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_grant_application_vector_functions() '
    || 'SET search_path = pg_catalog, %I, pg_temp',
    schema_name, schema_name);
END;
$harden$;

SELECT continuum_grant_application_vector_functions();
