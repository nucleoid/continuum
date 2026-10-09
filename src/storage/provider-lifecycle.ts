import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/** Reconcile and verify the current tenant's exact pgvector provider profiles. */
export async function reconcilePgvectorProviderGrants(db: Queryable): Promise<void> {
  const result = await db.query<{
    owner: boolean;
    usage: boolean;
    create: boolean;
    functions: boolean;
    applicationSchemaProvider: boolean;
    applicationProfile: boolean;
    syncProfile: boolean;
  }>(`
    SELECT relation.relowner = current_user::regrole::oid AS owner,
           has_schema_privilege(current_user, extension.extnamespace, 'USAGE') AS usage,
           has_schema_privilege(current_user, extension.extnamespace, 'CREATE') AS create,
           COALESCE((
             SELECT bool_and(has_function_privilege(current_user, function.oid, 'EXECUTE'))
               FROM pg_proc function
               JOIN pg_depend dependency
                 ON dependency.classid = 'pg_proc'::regclass
                AND dependency.objid = function.oid
                AND dependency.refclassid = 'pg_extension'::regclass
                AND dependency.deptype = 'e'
              WHERE dependency.refobjid = extension.oid
           ), TRUE) AS functions,
           relation.relnamespace = extension.extnamespace AS "applicationSchemaProvider",
           has_function_privilege(
             current_user, 'continuum_org_scope_id()'::regprocedure, 'EXECUTE'
           ) AS "applicationProfile",
           has_function_privilege(
             current_user,
             'continuum_verify_sync_database_identity(uuid)'::regprocedure,
             'EXECUTE'
           ) AS "syncProfile"
      FROM pg_extension extension
      JOIN pg_class relation ON relation.oid = 'memories'::regclass
     WHERE extension.extname = 'vector'
  `);
  const profile = result.rows[0];
  if (profile?.owner) {
    const drift = await db.query<{ drift: boolean }>(`
      WITH provider AS (
        SELECT extension.oid AS extension_oid,
               extension.extnamespace AS provider_schema_oid,
               namespace.nspowner AS provider_owner_oid,
               namespace.nspname = 'continuum_extensions'
                 AND namespace.nspowner = relation.relowner AS managed,
               relation.relnamespace AS application_schema_oid,
               relation.relowner AS application_owner_oid
          FROM pg_extension extension
          JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
          JOIN pg_class relation ON relation.oid = 'memories'::regclass
         WHERE extension.extname = 'vector'
      )
      SELECT
        EXISTS (
          SELECT 1 FROM provider
          JOIN pg_namespace namespace ON namespace.oid = provider.provider_schema_oid
          CROSS JOIN LATERAL aclexplode(COALESCE(
            namespace.nspacl, acldefault('n', namespace.nspowner))) privilege
         WHERE upper(privilege.privilege_type) = 'CREATE'
           AND privilege.grantee <> namespace.nspowner
        )
        OR EXISTS (
          SELECT 1 FROM provider
          CROSS JOIN continuum_pgvector_role_profiles profile
          LEFT JOIN pg_roles role ON role.oid = profile.database_role_oid
         WHERE role.oid IS NULL
            OR profile.provider_schema_oid <> provider.provider_schema_oid
            OR has_schema_privilege(role.oid, provider.provider_schema_oid, 'CREATE')
            OR (
              profile.profile_kind IN ('application', 'operator', 'reporting')
              AND (
                NOT has_schema_privilege(role.oid, provider.provider_schema_oid, 'USAGE')
                OR EXISTS (
                  SELECT 1 FROM pg_proc function
                  JOIN pg_depend dependency
                    ON dependency.classid = 'pg_proc'::regclass
                   AND dependency.objid = function.oid
                   AND dependency.refclassid = 'pg_extension'::regclass
                   AND dependency.deptype = 'e'
                   WHERE dependency.refobjid = provider.extension_oid
                     AND NOT has_function_privilege(role.oid, function.oid, 'EXECUTE')
                )
              )
            )
            OR (
              profile.profile_kind = 'sync'
              AND provider.provider_schema_oid <> provider.application_schema_oid
              AND EXISTS (
                SELECT 1 FROM pg_namespace namespace
                CROSS JOIN LATERAL aclexplode(COALESCE(
                  namespace.nspacl, acldefault('n', namespace.nspowner))) privilege
                 WHERE namespace.oid = provider.provider_schema_oid
                   AND privilege.grantee = profile.database_role_oid
                   AND upper(privilege.privilege_type) IN ('USAGE', 'CREATE')
              )
            )
        )
        OR EXISTS (
          SELECT 1 FROM provider
          JOIN pg_namespace namespace ON namespace.oid = provider.provider_schema_oid
          CROSS JOIN LATERAL aclexplode(COALESCE(
            namespace.nspacl, acldefault('n', namespace.nspowner))) privilege
         WHERE provider.provider_schema_oid <> provider.application_schema_oid
           AND privilege.grantee NOT IN (0, provider.provider_owner_oid)
           AND upper(privilege.privilege_type) IN ('USAGE', 'CREATE')
           AND NOT EXISTS (
             SELECT 1 FROM continuum_pgvector_role_profiles profile
              WHERE profile.database_role_oid = privilege.grantee
                AND profile.provider_schema_oid = provider.provider_schema_oid
           )
        )
        OR EXISTS (
          SELECT 1 FROM provider
          JOIN pg_proc function ON TRUE
          JOIN pg_depend dependency
            ON dependency.classid = 'pg_proc'::regclass
           AND dependency.objid = function.oid
           AND dependency.refclassid = 'pg_extension'::regclass
           AND dependency.deptype = 'e'
           AND dependency.refobjid = provider.extension_oid
          CROSS JOIN LATERAL aclexplode(COALESCE(
            function.proacl, acldefault('f', function.proowner))) privilege
         WHERE privilege.grantee NOT IN (0, function.proowner)
           AND upper(privilege.privilege_type) = 'EXECUTE'
           AND NOT EXISTS (
             SELECT 1 FROM continuum_pgvector_role_profiles profile
              WHERE profile.database_role_oid = privilege.grantee
                AND profile.provider_schema_oid = provider.provider_schema_oid
           )
        )
        OR EXISTS (
          SELECT 1 FROM provider
          JOIN pg_namespace namespace ON namespace.oid = provider.provider_schema_oid
          CROSS JOIN LATERAL aclexplode(COALESCE(
            namespace.nspacl, acldefault('n', namespace.nspowner))) privilege
         WHERE provider.managed AND privilege.grantee = 0
           AND upper(privilege.privilege_type) IN ('USAGE', 'CREATE')
        )
        OR EXISTS (
          SELECT 1 FROM provider
          JOIN pg_proc function ON TRUE
          JOIN pg_depend dependency
            ON dependency.classid = 'pg_proc'::regclass
           AND dependency.objid = function.oid
           AND dependency.refclassid = 'pg_extension'::regclass
           AND dependency.deptype = 'e'
           AND dependency.refobjid = provider.extension_oid
          CROSS JOIN LATERAL aclexplode(COALESCE(
            function.proacl, acldefault('f', function.proowner))) privilege
         WHERE provider.managed AND privilege.grantee = 0
           AND upper(privilege.privilege_type) = 'EXECUTE'
        ) AS drift
    `);
    if (drift.rows[0]?.drift) {
      await db.query('SELECT continuum_grant_application_vector_functions()');
    }
    return;
  }
  const validApplication = profile?.applicationProfile
    && profile.usage && profile.functions && !profile.create;
  const validSync = profile?.syncProfile && !profile.applicationProfile
    && !profile.create
    && (profile.applicationSchemaProvider || !profile.usage);
  if (!validApplication && !validSync) {
    throw new Error(
      'pgvector provider grant/profile drift detected; rerun the exact role grant profile',
    );
  }
}
