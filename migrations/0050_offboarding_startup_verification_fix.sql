-- Repair the 0049 startup verifier for databases that already recorded 0049.
-- The original PL/pgSQL record variable shadowed its SQL table alias on a
-- freshly migrated database and raised "record is not assigned yet".
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION continuum_verify_database_identity_configuration()
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  schema_name TEXT;
  trusted_row RECORD;
BEGIN
  SELECT namespace.nspname INTO schema_name
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = 'principals'::regclass;
  IF has_schema_privilege('public', schema_name, 'USAGE') THEN
    RAISE EXCEPTION 'PUBLIC retains application schema USAGE';
  END IF;
  IF (SELECT count(*) FROM continuum_trusted_database_identities WHERE can_sync) <> 1 THEN
    RAISE EXCEPTION 'exactly one active sync database identity is required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM continuum_trusted_database_identities registry
    LEFT JOIN pg_roles role ON role.oid = registry.database_role_oid
    LEFT JOIN principals principal ON principal.id = registry.principal_id
     WHERE registry.can_approve = registry.can_sync
        OR role.oid IS NULL OR role.rolname <> registry.database_role::text
        OR principal.disabled_at IS NOT NULL
        OR (registry.can_sync AND principal.kind <> 'service')
        OR (registry.can_approve AND principal.kind <> 'user')
        OR (registry.can_approve AND NOT EXISTS (
          SELECT 1 FROM scope_memberships membership
          JOIN scopes scope ON scope.id = membership.scope_id
           WHERE membership.principal_id = registry.principal_id
             AND scope.kind = 'org' AND scope.name = ''
             AND membership.source_kind = 'manual'
             AND membership.source_id = 'manual'
             AND membership.role = 'admin' AND membership.active
        ))
  ) THEN
    RAISE EXCEPTION 'trusted database identity configuration is invalid';
  END IF;
  FOR trusted_row IN
    SELECT database_role, can_sync
      FROM continuum_trusted_database_identities
  LOOP
    PERFORM continuum_validate_trusted_database_role(
      trusted_row.database_role,
      CASE WHEN trusted_row.can_sync THEN 'sync' ELSE 'approve' END,
      trusted_row.can_sync
    );
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION continuum_verify_database_identity_configuration() FROM PUBLIC;

DO $harden$
DECLARE schema_name TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_verify_database_identity_configuration() SET search_path = pg_catalog, %I, pg_temp',
    schema_name, schema_name
  );
END;
$harden$;
