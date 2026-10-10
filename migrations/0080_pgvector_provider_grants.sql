-- Reconcile pgvector access against Continuum's exact application/operator
-- profiles. The extension may be provider-owned, but a SELECT-only reporting
-- role is never an application profile and must not participate in rollout.

CREATE TABLE continuum_pgvector_role_profiles (
  database_role_oid OID PRIMARY KEY,
  provider_schema_oid OID NOT NULL,
  profile_kind TEXT NOT NULL DEFAULT 'application'
    CHECK (profile_kind IN ('application', 'operator', 'sync', 'reporting')),
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE continuum_pgvector_role_profiles FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_pgvector_provider_is_tenant_managed()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT namespace.nspname = 'continuum_extensions'
     AND namespace.nspowner = application_relation.relowner
     AND NOT EXISTS (
       SELECT 1
         FROM pg_proc function
         JOIN pg_depend dependency
           ON dependency.classid = 'pg_proc'::regclass
          AND dependency.objid = function.oid
          AND dependency.refclassid = 'pg_extension'::regclass
          AND dependency.deptype = 'e'
        WHERE dependency.refobjid = extension.oid
          AND function.proowner <> application_relation.relowner
     )
     AND NOT EXISTS (
       SELECT 1
         FROM pg_proc function
         JOIN pg_depend dependency
           ON dependency.classid = 'pg_proc'::regclass
          AND dependency.objid = function.oid
          AND dependency.refclassid = 'pg_extension'::regclass
          AND dependency.deptype = 'e'
         CROSS JOIN LATERAL aclexplode(COALESCE(
           function.proacl, acldefault('f', function.proowner))) privilege
        WHERE dependency.refobjid = extension.oid
          AND privilege.grantee = 0
          AND privilege.grantor <> application_relation.relowner
     )
     AND NOT EXISTS (
       SELECT 1
         FROM aclexplode(COALESCE(
           namespace.nspacl, acldefault('n', namespace.nspowner))) privilege
        WHERE privilege.grantee = 0
          AND privilege.grantor <> application_relation.relowner
     )
     AND NOT EXISTS (
       SELECT 1
         FROM pg_depend dependency
         JOIN pg_class dependent_relation
           ON dependency.classid = 'pg_class'::regclass
          AND dependency.objid = dependent_relation.oid
         JOIN pg_namespace dependent_namespace
           ON dependent_namespace.oid = dependent_relation.relnamespace
         JOIN pg_type provider_type
           ON dependency.refclassid = 'pg_type'::regclass
          AND dependency.refobjid = provider_type.oid
        WHERE provider_type.typnamespace = extension.extnamespace
          AND provider_type.typname = 'vector'
          AND dependency.objsubid > 0
          AND dependent_namespace.oid NOT IN (
            application_relation.relnamespace, extension.extnamespace)
     )
    FROM pg_extension extension
    JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
    JOIN pg_class application_relation
      ON application_relation.oid = 'memories'::regclass
   WHERE extension.extname = 'vector'
$$;
REVOKE ALL ON FUNCTION continuum_pgvector_provider_is_tenant_managed() FROM PUBLIC;

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
  SELECT oid INTO target_role_oid FROM pg_roles WHERE rolname = target_database_role;
  IF target_role_oid IS NULL THEN
    RAISE EXCEPTION 'application vector profile role % does not exist',
      quote_ident(target_database_role);
  END IF;
  IF invoking_role_oid <> application_owner_oid
      AND invoking_role_oid <> target_role_oid THEN
    RAISE EXCEPTION
      'only the migration owner or the profiled role may validate an application vector profile';
  END IF;
  IF NOT continuum_application_profile_matches(target_database_role) THEN
    RAISE EXCEPTION 'role % does not hold an exact Continuum application or operator profile',
      quote_ident(target_database_role);
  END IF;

  -- Classification includes extension object ownership, grantors, and users.
  SELECT extension.extnamespace, namespace.nspname, namespace.nspowner
    INTO vector_schema_oid, vector_schema_name, vector_schema_owner_oid
    FROM pg_extension extension
    JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
   WHERE extension.extname = 'vector';
  IF vector_schema_oid IS NULL THEN
    RAISE EXCEPTION 'the vector extension is not installed';
  END IF;
  managed_provider := continuum_pgvector_provider_is_tenant_managed();

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

  IF NOT has_schema_privilege(target_database_role, vector_schema_oid, 'USAGE') THEN
    RAISE EXCEPTION
      'application vector profile % is missing effective USAGE on provider schema %; rerun scripts/grant-application-role.sql',
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
     AND NOT has_function_privilege(target_role_oid, function.oid, 'EXECUTE')
   ORDER BY function.oid
   LIMIT 1;
  IF missing_function IS NOT NULL THEN
    RAISE EXCEPTION
      'application vector profile % is missing effective EXECUTE on extension function %; rerun scripts/grant-application-role.sql',
      quote_ident(target_database_role), missing_function;
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
  -- Reconciliation mutates PUBLIC only for an exclusive tenant-managed provider.
  SELECT extension.extnamespace, namespace.nspname, namespace.nspowner
    INTO vector_schema_oid, vector_schema_name, vector_schema_owner_oid
    FROM pg_extension extension
    JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
   WHERE extension.extname = 'vector';
  IF vector_schema_oid IS NULL THEN
    RAISE EXCEPTION 'the vector extension is not installed';
  END IF;
  managed_provider := continuum_pgvector_provider_is_tenant_managed();

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
    WITH candidates AS MATERIALIZED (
      SELECT role.oid, role.rolname, profile.profile_kind
        FROM pg_roles role
        LEFT JOIN continuum_pgvector_role_profiles profile
          ON profile.database_role_oid = role.oid
       WHERE role.oid <> application_owner_oid
         AND (profile.database_role_oid IS NOT NULL OR EXISTS (
           SELECT 1 FROM pg_class relation
           CROSS JOIN LATERAL aclexplode(COALESCE(
             relation.relacl, acldefault('r', relation.relowner))) privilege
            WHERE relation.oid = 'memories'::regclass
              AND privilege.grantee = role.oid
              AND upper(privilege.privilege_type) = 'SELECT'
         ))
    ), checked AS MATERIALIZED (
      SELECT candidates.*, continuum_application_profile_matches(rolname) AS exact_profile
        FROM candidates
    )
    SELECT * FROM checked WHERE profile_kind IS NOT NULL OR exact_profile
  LOOP
    IF candidate.exact_profile OR candidate.profile_kind = 'reporting' THEN
      IF EXISTS (
        SELECT 1 FROM pg_namespace namespace
        CROSS JOIN LATERAL aclexplode(COALESCE(
          namespace.nspacl, acldefault('n', namespace.nspowner))) privilege
         WHERE namespace.oid = vector_schema_oid
           AND privilege.grantee = candidate.oid
           AND upper(privilege.privilege_type) = 'CREATE'
      ) THEN
        BEGIN
          EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I',
            vector_schema_name, candidate.rolname);
        EXCEPTION WHEN insufficient_privilege THEN
          RAISE EXCEPTION
            'provider owner must revoke CREATE on schema % from % before refreshing application grants',
            quote_ident(vector_schema_name), quote_ident(candidate.rolname);
        END;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_namespace namespace
        CROSS JOIN LATERAL aclexplode(COALESCE(
          namespace.nspacl, acldefault('n', namespace.nspowner))) privilege
         WHERE namespace.oid = vector_schema_oid
           AND privilege.grantee IN (0, candidate.oid)
           AND upper(privilege.privilege_type) = 'USAGE'
      ) THEN
        BEGIN
          EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I',
            vector_schema_name, candidate.rolname);
        EXCEPTION WHEN insufficient_privilege THEN
          RAISE EXCEPTION
            'provider owner must GRANT USAGE ON SCHEMA % TO % WITH GRANT OPTION before refreshing application grants',
            quote_ident(vector_schema_name),
            quote_ident((SELECT rolname FROM pg_roles WHERE oid = application_owner_oid));
        END;
      END IF;
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
        IF has_function_privilege(candidate.oid, vector_function.oid, 'EXECUTE') THEN
          CONTINUE;
        END IF;
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
        (database_role_oid, provider_schema_oid, profile_kind, refreshed_at)
      VALUES (
        candidate.oid, vector_schema_oid,
        COALESCE(candidate.profile_kind, 'application'), now()
      )
      ON CONFLICT (database_role_oid) DO UPDATE
        SET provider_schema_oid = EXCLUDED.provider_schema_oid,
            profile_kind = CASE
              WHEN continuum_pgvector_role_profiles.profile_kind = 'reporting'
                THEN 'reporting'
              ELSE EXCLUDED.profile_kind
            END,
            refreshed_at = EXCLUDED.refreshed_at;
    ELSIF candidate.profile_kind = 'sync' THEN
      IF vector_schema_oid <> application_schema_oid THEN
        EXECUTE format('REVOKE USAGE, CREATE ON SCHEMA %I FROM %I',
          vector_schema_name, candidate.rolname);
      END IF;
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
      UPDATE continuum_pgvector_role_profiles
         SET provider_schema_oid = vector_schema_oid, refreshed_at = now()
       WHERE database_role_oid = candidate.oid;
    ELSE
      BEGIN
        IF vector_schema_oid <> application_schema_oid THEN
          EXECUTE format('REVOKE USAGE, CREATE ON SCHEMA %I FROM %I',
            vector_schema_name, candidate.rolname);
        END IF;
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
        OR (profile.profile_kind NOT IN ('sync', 'reporting')
            AND NOT continuum_application_profile_matches(role.rolname))
  LOOP
    IF candidate.rolname IS NOT NULL THEN
      BEGIN
        IF vector_schema_oid <> application_schema_oid THEN
          EXECUTE format('REVOKE USAGE, CREATE ON SCHEMA %I FROM %I',
            vector_schema_name, candidate.rolname);
        END IF;
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
     WHERE profile.profile_kind IN ('application', 'operator')
  LOOP
    PERFORM continuum_assert_application_vector_profile(candidate.rolname);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION continuum_grant_application_vector_functions() FROM PUBLIC;

-- Runtime roles cannot read the owner-only profile registry directly. This
-- SECURITY DEFINER gate resolves the real session/SET ROLE identity and checks
-- only that role. Owner startup verifies registered profiles without altering
-- live privileges. Explicit owner grant/reconciliation commands revoke stale
-- grants; rollout must converge profiles before restarting runtime processes.
CREATE OR REPLACE FUNCTION continuum_assert_current_pgvector_profile()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  invoking_role NAME := continuum_invoking_database_role();
  invoking_role_oid OID;
  application_owner_oid OID;
  application_schema_oid OID;
  vector_schema_oid OID;
  profile_kind_value TEXT;
  candidate RECORD;
BEGIN
  SELECT oid INTO invoking_role_oid FROM pg_roles WHERE rolname = invoking_role;
  SELECT relation.relowner, relation.relnamespace
    INTO application_owner_oid, application_schema_oid
    FROM pg_class relation WHERE relation.oid = 'memories'::regclass;
  IF invoking_role_oid = application_owner_oid THEN
    -- Never retain a blocking advisory-lock snapshot: online index builders
    -- holding the migration lock can otherwise wait for this same transaction.
    IF NOT pg_try_advisory_xact_lock(7215328273579717613::bigint) THEN
      RAISE EXCEPTION 'pgvector profile verification is busy; retry after migration'
        USING ERRCODE = '55P03';
    END IF;
    SELECT extnamespace INTO vector_schema_oid
      FROM pg_extension WHERE extname = 'vector';
    FOR candidate IN
      SELECT profile.*, role.rolname
        FROM continuum_pgvector_role_profiles profile
        LEFT JOIN pg_roles role ON role.oid = profile.database_role_oid
       ORDER BY profile.database_role_oid
    LOOP
      IF candidate.rolname IS NULL
          OR candidate.provider_schema_oid <> vector_schema_oid THEN
        RAISE EXCEPTION 'registered pgvector profile drift; rerun the exact role grant profile';
      END IF;
      IF candidate.profile_kind IN ('application', 'operator') THEN
        PERFORM continuum_assert_application_vector_profile(candidate.rolname);
      ELSIF candidate.profile_kind = 'reporting' THEN
        IF has_schema_privilege(candidate.rolname, vector_schema_oid, 'CREATE')
            OR NOT has_schema_privilege(candidate.rolname, vector_schema_oid, 'USAGE')
            OR EXISTS (
              SELECT 1 FROM pg_proc function
              JOIN pg_depend dependency
                ON dependency.classid = 'pg_proc'::regclass
               AND dependency.objid = function.oid
               AND dependency.refclassid = 'pg_extension'::regclass
               AND dependency.deptype = 'e'
               WHERE dependency.refobjid = (SELECT oid FROM pg_extension WHERE extname = 'vector')
                 AND NOT has_function_privilege(candidate.rolname, function.oid, 'EXECUTE')
            ) THEN
          RAISE EXCEPTION 'registered pgvector reporting profile drift';
        END IF;
      ELSIF has_schema_privilege(candidate.rolname, vector_schema_oid, 'CREATE')
          OR (vector_schema_oid <> application_schema_oid
              AND has_schema_privilege(candidate.rolname, vector_schema_oid, 'USAGE')) THEN
        RAISE EXCEPTION 'registered pgvector sync profile drift';
      END IF;
    END LOOP;
    RETURN;
  END IF;

  SELECT extension.extnamespace INTO vector_schema_oid
    FROM pg_extension extension WHERE extension.extname = 'vector';
  SELECT profile.profile_kind INTO profile_kind_value
    FROM continuum_pgvector_role_profiles profile
   WHERE profile.database_role_oid = invoking_role_oid
     AND profile.provider_schema_oid = vector_schema_oid;
  IF profile_kind_value IS NULL THEN
    RAISE EXCEPTION
      'pgvector provider grant/profile drift detected for role %; rerun the exact role grant profile',
      quote_ident(invoking_role);
  END IF;
  IF has_schema_privilege(invoking_role, vector_schema_oid, 'CREATE') THEN
    RAISE EXCEPTION 'pgvector provider role % has forbidden CREATE', quote_ident(invoking_role);
  END IF;

  IF profile_kind_value IN ('application', 'operator') THEN
    PERFORM continuum_assert_application_vector_profile(invoking_role);
  ELSIF profile_kind_value = 'reporting' THEN
    IF NOT has_schema_privilege(invoking_role, vector_schema_oid, 'USAGE') OR EXISTS (
      SELECT 1
        FROM pg_proc function
        JOIN pg_depend dependency
          ON dependency.classid = 'pg_proc'::regclass
         AND dependency.objid = function.oid
         AND dependency.refclassid = 'pg_extension'::regclass
         AND dependency.deptype = 'e'
       WHERE dependency.refobjid = (SELECT oid FROM pg_extension WHERE extname = 'vector')
         AND NOT has_function_privilege(invoking_role, function.oid, 'EXECUTE')
    ) THEN
      RAISE EXCEPTION 'pgvector reporting profile drift detected for role %',
        quote_ident(invoking_role);
    END IF;
  ELSIF profile_kind_value = 'sync' AND vector_schema_oid <> application_schema_oid
      AND has_schema_privilege(invoking_role, vector_schema_oid, 'USAGE') THEN
    RAISE EXCEPTION 'pgvector sync profile retains provider-schema USAGE for role %',
      quote_ident(invoking_role);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_assert_current_pgvector_profile() FROM PUBLIC;

-- Extend the exact 0052 application/operator function profile without
-- changing the published migration. Existing exact profiles receive the new
-- gate first; then the 0052 validator's expected set is amended in place.
DO $extend_application_profile$
DECLARE
  application_owner_oid OID;
  candidate RECORD;
  validator_definition TEXT;
  sync_validator_definition TEXT;
  expected_marker CONSTANT TEXT :=
    '(''continuum_disable_principal(uuid,uuid)'')';
  caller_marker CONSTANT TEXT :=
    'IF (SELECT oid FROM pg_roles WHERE rolname = continuum_invoking_database_role()) <> owner_oid THEN';
  sync_expected_marker CONSTANT TEXT :=
    '(''continuum_verify_sync_database_identity(uuid)'')';
BEGIN
  SELECT relation.relowner INTO application_owner_oid
    FROM pg_class relation WHERE relation.oid = 'memories'::regclass;
  FOR candidate IN
    SELECT role.rolname
      FROM pg_roles role
     WHERE role.oid <> application_owner_oid
       AND EXISTS (
         SELECT 1 FROM pg_class relation
         CROSS JOIN LATERAL aclexplode(COALESCE(
           relation.relacl, acldefault('r', relation.relowner))) privilege
          WHERE relation.oid = 'memories'::regclass
            AND privilege.grantee = role.oid
            AND upper(privilege.privilege_type) = 'SELECT'
       )
       AND continuum_application_profile_matches(role.rolname)
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.continuum_assert_current_pgvector_profile() TO %I',
      current_schema(), candidate.rolname);
  END LOOP;

  SELECT pg_get_functiondef(
    'continuum_assert_application_role_allowlist(name,boolean)'::regprocedure
  ) INTO validator_definition;
  IF position(expected_marker IN validator_definition) = 0 THEN
    RAISE EXCEPTION
      '0080 could not locate the 0052 application function allow-list marker';
  END IF;
  validator_definition := replace(
    validator_definition,
    expected_marker,
    expected_marker || E',\n        (''continuum_assert_current_pgvector_profile()'')'
  );
  IF position(caller_marker IN validator_definition) = 0 THEN
    RAISE EXCEPTION
      '0080 could not locate the 0052 application validator caller guard';
  END IF;
  validator_definition := replace(
    validator_definition,
    caller_marker,
    'IF (SELECT oid FROM pg_roles WHERE rolname = '
      || 'continuum_invoking_database_role()) <> owner_oid'
      || E'\n    AND (SELECT oid FROM pg_roles WHERE rolname = '
      || 'continuum_invoking_database_role()) <> (SELECT oid FROM pg_roles WHERE rolname = target_database_role) THEN'
  );
  EXECUTE validator_definition;

  FOR candidate IN
    SELECT role.rolname
      FROM continuum_trusted_database_identities identity
      JOIN pg_roles role ON role.oid = identity.database_role_oid
     WHERE identity.can_sync AND NOT identity.can_approve
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.continuum_assert_current_pgvector_profile() TO %I',
      current_schema(), candidate.rolname);
  END LOOP;
  INSERT INTO continuum_pgvector_role_profiles
    (database_role_oid, provider_schema_oid, profile_kind, refreshed_at)
  SELECT role.oid, extension.extnamespace, 'sync', now()
    FROM continuum_trusted_database_identities identity
    JOIN pg_roles role
      ON role.oid = identity.database_role_oid
     AND role.rolname = identity.database_role
    CROSS JOIN pg_extension extension
   WHERE identity.can_sync AND NOT identity.can_approve
     AND extension.extname = 'vector'
  ON CONFLICT (database_role_oid) DO UPDATE SET
    provider_schema_oid = EXCLUDED.provider_schema_oid,
    profile_kind = 'sync', refreshed_at = EXCLUDED.refreshed_at;
  SELECT pg_get_functiondef(
    'continuum_assert_sync_role_allowlist(name,uuid)'::regprocedure
  ) INTO sync_validator_definition;
  IF position(sync_expected_marker IN sync_validator_definition) = 0 THEN
    RAISE EXCEPTION '0080 could not locate the 0052 sync function allow-list marker';
  END IF;
  sync_validator_definition := replace(
    sync_validator_definition,
    sync_expected_marker,
    sync_expected_marker || E',\n      (''continuum_assert_current_pgvector_profile()'')'
  );
  EXECUTE sync_validator_definition;
END;
$extend_application_profile$;

-- Keep database-side sync registration/rotation aligned with the extended
-- 0052 exact function profile. This is the path used by
-- continuum_register_trusted_database_identity(), not only the psql helper.
-- Extend the live hardened installer rather than copying an older body.
-- Its restore-pending, terminal OID, LOGIN, retirement-authority, and epoch
-- history safeguards remain the exact effective 0052/0053 contract.
DO $extend_sync_installer$
DECLARE
  definition TEXT;
  retire_marker CONSTANT TEXT := 'PERFORM continuum_retire_sync_database_identities(target_oid);';
  grant_marker CONSTANT TEXT := '%I.continuum_verify_sync_database_identity(UUID) TO %I';
  arguments_marker CONSTANT TEXT := 'schema_name, schema_name, schema_name, target_database_role);';
  registry_marker CONSTANT TEXT := 'INSERT INTO continuum_trusted_database_identities';
BEGIN
  SELECT pg_get_functiondef(
    'continuum_install_sync_database_identity(name,uuid)'::regprocedure
  ) INTO definition;
  IF position(retire_marker IN definition) = 0
      OR position(grant_marker IN definition) = 0
      OR position(arguments_marker IN definition) = 0
      OR position(registry_marker IN definition) = 0 THEN
    RAISE EXCEPTION '0080 could not locate the hardened sync installer extension markers';
  END IF;
  definition := replace(definition, retire_marker,
    retire_marker || E'\n  DELETE FROM continuum_pgvector_role_profiles'
      || E'\n   WHERE profile_kind = ''sync'' AND database_role_oid <> target_oid;');
  definition := replace(definition, grant_marker,
    '%I.continuum_verify_sync_database_identity(UUID), '
      || '%I.continuum_assert_current_pgvector_profile() TO %I');
  definition := replace(definition, arguments_marker,
    'schema_name, schema_name, schema_name, schema_name, target_database_role);');
  definition := replace(definition, registry_marker,
    $profile$INSERT INTO continuum_pgvector_role_profiles
    (database_role_oid, provider_schema_oid, profile_kind, refreshed_at)
  SELECT target_oid, extension.extnamespace, 'sync', now()
    FROM pg_extension extension WHERE extension.extname = 'vector'
  ON CONFLICT (database_role_oid) DO UPDATE SET
    provider_schema_oid = EXCLUDED.provider_schema_oid,
    profile_kind = 'sync', refreshed_at = EXCLUDED.refreshed_at;
  $profile$ || registry_marker);
  EXECUTE definition;
END;
$extend_sync_installer$;

CREATE OR REPLACE FUNCTION continuum_register_pgvector_reporting_profile(
  target_database_role NAME,
  enabled BOOLEAN DEFAULT TRUE
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  application_owner_oid OID;
  application_schema_name NAME;
  invoking_role_oid OID;
  target_role_oid OID;
  vector_schema_oid OID;
BEGIN
  SELECT relation.relowner, namespace.nspname
    INTO application_owner_oid, application_schema_name
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = 'memories'::regclass;
  SELECT oid INTO invoking_role_oid
    FROM pg_roles WHERE rolname = continuum_invoking_database_role();
  IF invoking_role_oid <> application_owner_oid THEN
    RAISE EXCEPTION 'only the migration owner may register pgvector reporting profiles';
  END IF;
  SELECT oid INTO target_role_oid FROM pg_roles WHERE rolname = target_database_role;
  IF target_role_oid IS NULL OR target_role_oid = application_owner_oid THEN
    RAISE EXCEPTION 'reporting profile role % must be an existing non-owner role',
      quote_ident(target_database_role);
  END IF;
  SELECT extnamespace INTO vector_schema_oid
    FROM pg_extension WHERE extname = 'vector';
  IF enabled THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.continuum_assert_current_pgvector_profile() TO %I',
      application_schema_name, target_database_role);
    INSERT INTO continuum_pgvector_role_profiles
      (database_role_oid, provider_schema_oid, profile_kind, refreshed_at)
    VALUES (target_role_oid, vector_schema_oid, 'reporting', now())
    ON CONFLICT (database_role_oid) DO UPDATE
      SET provider_schema_oid = EXCLUDED.provider_schema_oid,
          profile_kind = 'reporting',
          refreshed_at = EXCLUDED.refreshed_at;
  ELSE
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %I.continuum_assert_current_pgvector_profile() FROM %I',
      application_schema_name, target_database_role);
    -- Make the existing row stale so the owner reconciler revokes provider
    -- grants before deleting the registration.
    UPDATE continuum_pgvector_role_profiles
       SET profile_kind = 'application', refreshed_at = now()
     WHERE database_role_oid = target_role_oid;
  END IF;
  PERFORM continuum_grant_application_vector_functions();
END;
$$;
REVOKE ALL ON FUNCTION continuum_register_pgvector_reporting_profile(NAME, BOOLEAN)
FROM PUBLIC;

DO $harden$
DECLARE schema_name TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_pgvector_provider_is_tenant_managed() '
    || 'SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_assert_application_role_allowlist(name, boolean) '
    || 'SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_assert_sync_role_allowlist(name, uuid) '
    || 'SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_install_sync_database_identity(name, uuid) '
    || 'SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_application_profile_matches(name) '
    || 'SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_assert_application_vector_profile(name) '
    || 'SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_grant_application_vector_functions() '
    || 'SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_assert_current_pgvector_profile() '
    || 'SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_register_pgvector_reporting_profile(name, boolean) '
    || 'SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
END;
$harden$;

SELECT continuum_grant_application_vector_functions();
