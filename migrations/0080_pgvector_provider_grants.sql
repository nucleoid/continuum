-- Reconcile pgvector access against Continuum's exact application/operator
-- profiles. The extension may be provider-owned, but a SELECT-only reporting
-- role is never an application profile and must not participate in rollout.

CREATE TABLE continuum_pgvector_role_profiles (
  database_role_oid OID PRIMARY KEY,
  provider_schema_oid OID NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE continuum_pgvector_role_profiles FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_application_profile_matches(
  target_database_role NAME
) RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
  BEGIN
    PERFORM continuum_assert_application_role_allowlist(target_database_role, FALSE);
    RETURN TRUE;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  BEGIN
    PERFORM continuum_assert_application_role_allowlist(target_database_role, TRUE);
    RETURN TRUE;
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;
END;
$$;
REVOKE ALL ON FUNCTION continuum_application_profile_matches(NAME) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_assert_application_vector_profile(
  target_database_role NAME
) RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  application_schema_oid OID;
  application_owner_oid OID;
  invoking_role_oid OID;
  target_role_oid OID;
  vector_schema_oid OID;
  vector_schema_name NAME;
  vector_schema_owner_oid OID;
  managed_provider BOOLEAN;
  drift_role NAME;
  missing_function TEXT;
BEGIN
  SELECT relation.relnamespace, relation.relowner
    INTO application_schema_oid, application_owner_oid
    FROM pg_class relation WHERE relation.oid = 'memories'::regclass;
  SELECT oid INTO invoking_role_oid
    FROM pg_roles WHERE rolname = continuum_invoking_database_role();
  IF invoking_role_oid <> application_owner_oid THEN
    RAISE EXCEPTION 'only the migration owner may validate an application vector profile';
  END IF;
  SELECT oid INTO target_role_oid FROM pg_roles WHERE rolname = target_database_role;
  IF target_role_oid IS NULL THEN
    RAISE EXCEPTION 'application vector profile role % does not exist',
      quote_ident(target_database_role);
  END IF;
  IF NOT continuum_application_profile_matches(target_database_role) THEN
    RAISE EXCEPTION 'role % does not hold an exact Continuum application or operator profile',
      quote_ident(target_database_role);
  END IF;

  SELECT extension.extnamespace, namespace.nspname, namespace.nspowner
    INTO vector_schema_oid, vector_schema_name, vector_schema_owner_oid
    FROM pg_extension extension
    JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
   WHERE extension.extname = 'vector';
  IF vector_schema_oid IS NULL THEN
    RAISE EXCEPTION 'the vector extension is not installed';
  END IF;
  managed_provider := vector_schema_name = 'continuum_extensions'
    AND vector_schema_owner_oid = application_owner_oid;

  SELECT role.rolname INTO drift_role
    FROM pg_namespace namespace
    CROSS JOIN LATERAL aclexplode(COALESCE(
      namespace.nspacl, acldefault('n', namespace.nspowner))) privilege
    LEFT JOIN pg_roles role ON role.oid = privilege.grantee
   WHERE namespace.oid = vector_schema_oid
     AND upper(privilege.privilege_type) = 'CREATE'
     AND privilege.grantee <> namespace.nspowner
   ORDER BY privilege.grantee
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'pgvector provider schema % grants forbidden CREATE to %; revoke CREATE before rollout',
      quote_ident(vector_schema_name),
      CASE WHEN drift_role IS NULL THEN 'PUBLIC' ELSE quote_ident(drift_role) END;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_namespace namespace
    CROSS JOIN LATERAL aclexplode(COALESCE(
      namespace.nspacl, acldefault('n', namespace.nspowner))) privilege
     WHERE namespace.oid = vector_schema_oid
       AND privilege.grantee = target_role_oid
       AND upper(privilege.privilege_type) = 'USAGE'
  ) THEN
    RAISE EXCEPTION
      'application vector profile % is missing direct USAGE on provider schema %; rerun scripts/grant-application-role.sql',
      quote_ident(target_database_role), quote_ident(vector_schema_name);
  END IF;
  IF has_schema_privilege(target_database_role, vector_schema_oid, 'CREATE') THEN
    RAISE EXCEPTION
      'application vector profile % has forbidden CREATE on provider schema %',
      quote_ident(target_database_role), quote_ident(vector_schema_name);
  END IF;

  SELECT format('%I.%I(%s)', namespace.nspname, function.proname,
                pg_get_function_identity_arguments(function.oid))
    INTO missing_function
    FROM pg_proc function
    JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
    JOIN pg_depend dependency
      ON dependency.classid = 'pg_proc'::regclass
     AND dependency.objid = function.oid
     AND dependency.refclassid = 'pg_extension'::regclass
     AND dependency.deptype = 'e'
    JOIN pg_extension extension ON extension.oid = dependency.refobjid
   WHERE extension.extname = 'vector'
     AND NOT EXISTS (
       SELECT 1 FROM aclexplode(COALESCE(
         function.proacl, acldefault('f', function.proowner))) privilege
        WHERE privilege.grantee = target_role_oid
          AND upper(privilege.privilege_type) = 'EXECUTE'
     )
   ORDER BY function.oid
   LIMIT 1;
  IF missing_function IS NOT NULL THEN
    RAISE EXCEPTION
      'application vector profile % is missing direct EXECUTE on extension function %; rerun scripts/grant-application-role.sql',
      quote_ident(target_database_role), missing_function;
  END IF;

  SELECT role.rolname INTO drift_role
    FROM pg_roles role
   WHERE role.oid <> application_owner_oid
     AND NOT continuum_application_profile_matches(role.rolname)
     AND EXISTS (
       SELECT 1 FROM pg_class relation
       CROSS JOIN LATERAL aclexplode(COALESCE(
         relation.relacl,
         acldefault(CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
                    relation.relowner))) privilege
        WHERE relation.relnamespace = application_schema_oid
          AND privilege.grantee = role.oid
     )
     AND (
       EXISTS (
         SELECT 1 FROM pg_namespace namespace
         CROSS JOIN LATERAL aclexplode(COALESCE(
           namespace.nspacl, acldefault('n', namespace.nspowner))) privilege
          WHERE namespace.oid = vector_schema_oid
            AND privilege.grantee = role.oid
            AND upper(privilege.privilege_type) IN ('USAGE', 'CREATE')
       ) OR EXISTS (
         SELECT 1 FROM pg_proc function
         JOIN pg_depend dependency
           ON dependency.classid = 'pg_proc'::regclass
          AND dependency.objid = function.oid
          AND dependency.refclassid = 'pg_extension'::regclass
          AND dependency.deptype = 'e'
         JOIN pg_extension extension ON extension.oid = dependency.refobjid
         CROSS JOIN LATERAL aclexplode(COALESCE(
           function.proacl, acldefault('f', function.proowner))) privilege
          WHERE extension.extname = 'vector'
            AND privilege.grantee = role.oid
            AND upper(privilege.privilege_type) = 'EXECUTE'
       )
     )
   ORDER BY role.rolname
   LIMIT 1;
  IF drift_role IS NOT NULL THEN
    RAISE EXCEPTION
      'non-profile role % retains pgvector provider privileges; rerun the provider grant reconciler',
      quote_ident(drift_role);
  END IF;

  IF managed_provider AND (
    EXISTS (
      SELECT 1 FROM pg_namespace namespace
      CROSS JOIN LATERAL aclexplode(COALESCE(
        namespace.nspacl, acldefault('n', namespace.nspowner))) privilege
       WHERE namespace.oid = vector_schema_oid AND privilege.grantee = 0
         AND upper(privilege.privilege_type) IN ('USAGE', 'CREATE')
    ) OR EXISTS (
      SELECT 1 FROM pg_proc function
      JOIN pg_depend dependency
        ON dependency.classid = 'pg_proc'::regclass
       AND dependency.objid = function.oid
       AND dependency.refclassid = 'pg_extension'::regclass
       AND dependency.deptype = 'e'
      JOIN pg_extension extension ON extension.oid = dependency.refobjid
      CROSS JOIN LATERAL aclexplode(COALESCE(
        function.proacl, acldefault('f', function.proowner))) privilege
       WHERE extension.extname = 'vector' AND privilege.grantee = 0
         AND upper(privilege.privilege_type) = 'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION
      'PUBLIC pgvector privilege drift remains in managed provider schema %',
      quote_ident(vector_schema_name);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_assert_application_vector_profile(NAME) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_grant_application_vector_functions()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  application_schema_oid OID;
  application_owner_oid OID;
  invoking_role_oid OID;
  vector_schema_oid OID;
  vector_schema_name NAME;
  vector_schema_owner_oid OID;
  managed_provider BOOLEAN;
  candidate RECORD;
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
  managed_provider := vector_schema_name = 'continuum_extensions'
    AND vector_schema_owner_oid = application_owner_oid;

  IF EXISTS (
    SELECT 1 FROM pg_namespace namespace
    CROSS JOIN LATERAL aclexplode(COALESCE(
      namespace.nspacl, acldefault('n', namespace.nspowner))) privilege
     WHERE namespace.oid = vector_schema_oid
       AND upper(privilege.privilege_type) = 'CREATE'
       AND privilege.grantee <> namespace.nspowner
  ) THEN
    RAISE EXCEPTION
      'pgvector provider schema % grants forbidden CREATE to PUBLIC or a non-owner; revoke CREATE before rollout',
      quote_ident(vector_schema_name);
  END IF;

  IF managed_provider THEN
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', vector_schema_name);
    FOR vector_function IN
      SELECT format('%I.%I(%s)', namespace.nspname, function.proname,
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
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', vector_function.signature);
    END LOOP;
  END IF;

  FOR candidate IN
    SELECT role.oid, role.rolname,
           continuum_application_profile_matches(role.rolname) AS exact_profile
      FROM pg_roles role
     WHERE role.oid <> application_owner_oid
       AND EXISTS (
         SELECT 1 FROM pg_class relation
         CROSS JOIN LATERAL aclexplode(COALESCE(
           relation.relacl,
           acldefault(CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
                      relation.relowner))) privilege
          WHERE relation.relnamespace = application_schema_oid
            AND privilege.grantee = role.oid
       )
  LOOP
    IF candidate.exact_profile THEN
      BEGIN
        EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I',
          vector_schema_name, candidate.rolname);
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I',
          vector_schema_name, candidate.rolname);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE EXCEPTION
          'provider owner must GRANT USAGE ON SCHEMA % TO % WITH GRANT OPTION before refreshing application grants',
          quote_ident(vector_schema_name),
          quote_ident((SELECT rolname FROM pg_roles WHERE oid = application_owner_oid));
      END;
      FOR vector_function IN
        SELECT function.oid,
               function.proowner = application_owner_oid OR EXISTS (
                 SELECT 1 FROM aclexplode(COALESCE(
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
        IF NOT vector_function.can_delegate THEN
          RAISE EXCEPTION
            'extension owner must GRANT EXECUTE ON FUNCTION % TO % WITH GRANT OPTION before refreshing application grants',
            vector_function.signature,
            quote_ident((SELECT rolname FROM pg_roles WHERE oid = application_owner_oid));
        END IF;
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',
          vector_function.signature, candidate.rolname);
      END LOOP;
      INSERT INTO continuum_pgvector_role_profiles
        (database_role_oid, provider_schema_oid, refreshed_at)
      VALUES (candidate.oid, vector_schema_oid, now())
      ON CONFLICT (database_role_oid) DO UPDATE
        SET provider_schema_oid = EXCLUDED.provider_schema_oid,
            refreshed_at = EXCLUDED.refreshed_at;
    ELSE
      BEGIN
        EXECUTE format('REVOKE USAGE, CREATE ON SCHEMA %I FROM %I',
          vector_schema_name, candidate.rolname);
        FOR vector_function IN
          SELECT format('%I.%I(%s)', namespace.nspname, function.proname,
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
          EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I',
            vector_function.signature, candidate.rolname);
        END LOOP;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE EXCEPTION
          'provider owner must revoke pgvector grants from non-profile role % before rollout',
          quote_ident(candidate.rolname);
      END;
      DELETE FROM continuum_pgvector_role_profiles
       WHERE database_role_oid = candidate.oid;
    END IF;
  END LOOP;

  FOR candidate IN
    SELECT profile.database_role_oid AS oid, role.rolname
      FROM continuum_pgvector_role_profiles profile
      LEFT JOIN pg_roles role ON role.oid = profile.database_role_oid
     WHERE role.oid IS NULL
        OR NOT continuum_application_profile_matches(role.rolname)
  LOOP
    IF candidate.rolname IS NOT NULL THEN
      BEGIN
        EXECUTE format('REVOKE USAGE, CREATE ON SCHEMA %I FROM %I',
          vector_schema_name, candidate.rolname);
        FOR vector_function IN
          SELECT format('%I.%I(%s)', namespace.nspname, function.proname,
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
          EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I',
            vector_function.signature, candidate.rolname);
        END LOOP;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE EXCEPTION
          'provider owner must revoke stale pgvector grants from former profile role %',
          quote_ident(candidate.rolname);
      END;
    END IF;
    DELETE FROM continuum_pgvector_role_profiles
     WHERE database_role_oid = candidate.oid;
  END LOOP;

  FOR candidate IN
    SELECT role.rolname
      FROM continuum_pgvector_role_profiles profile
      JOIN pg_roles role ON role.oid = profile.database_role_oid
  LOOP
    PERFORM continuum_assert_application_vector_profile(candidate.rolname);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION continuum_grant_application_vector_functions() FROM PUBLIC;

DO $harden$
DECLARE schema_name TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_application_profile_matches(name) '
    || 'SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_assert_application_vector_profile(name) '
    || 'SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_grant_application_vector_functions() '
    || 'SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
END;
$harden$;

SELECT continuum_grant_application_vector_functions();
