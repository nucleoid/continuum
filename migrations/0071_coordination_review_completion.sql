-- Close the remaining production-plan, quota, and rollout grant gaps without
-- changing any published issue-7 migration.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION continuum_coordination_privacy_actual_state_is_erased(
  target_principal_id UUID, owned_scope_id UUID
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1
      FROM principal_user_scopes mapping
      JOIN coordination_principal_privacy_progress progress
        ON progress.principal_id = mapping.principal_id
     WHERE mapping.principal_id = target_principal_id
       AND mapping.scope_id = owned_scope_id
       AND progress.privacy_version >= 3
       AND progress.completed_at IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM audit_log audit
     WHERE audit.principal_id = target_principal_id
       AND audit.metadata->>'operation' IN (
         'lock_acquire', 'lock_renew', 'lock_release', 'lock_inspect')
       AND audit.metadata ?| ARRAY[
         'request_id','run_id','lease_id','resource','resource_sha256'])
  AND NOT EXISTS (
    SELECT 1 FROM coordination_operation_receipts receipt
     WHERE receipt.principal_id = target_principal_id
       AND receipt.scope_id <> owned_scope_id)
  AND NOT EXISTS (
    SELECT 1 FROM coordination_leases lease
     WHERE lease.principal_id = target_principal_id
       AND lease.scope_id <> owned_scope_id);
$$;
REVOKE ALL ON FUNCTION
  continuum_coordination_privacy_actual_state_is_erased(UUID, UUID) FROM PUBLIC;

-- Incomplete progress and completed-but-dirty state are separate branches.
-- The latter starts from dirty indexes, never from every completed principal.
CREATE OR REPLACE FUNCTION continuum_operator_list_coordination_privacy_repairs(
  authorization_principal_id UUID, after_principal_id UUID,
  target_principal_id UUID, row_limit INTEGER
) RETURNS TABLE(principal_id UUID, scope_id UUID, repair_state TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  IF row_limit < 1 OR row_limit > 1000 THEN
    RAISE EXCEPTION 'coordination privacy repair list limit must be between 1 and 1000';
  END IF;
  RETURN QUERY
  WITH incomplete AS MATERIALIZED (
    SELECT progress.principal_id
      FROM coordination_principal_privacy_progress progress
     WHERE (progress.privacy_version < 3 OR progress.completed_at IS NULL)
       AND (target_principal_id IS NULL OR progress.principal_id = target_principal_id)
       AND (after_principal_id IS NULL OR progress.principal_id > after_principal_id)
     ORDER BY progress.principal_id LIMIT row_limit
  ), dirty_completed AS MATERIALIZED (
    SELECT dirty.principal_id
      FROM (
        SELECT DISTINCT audit.principal_id
          FROM audit_log audit
         WHERE audit.metadata->>'operation' IN (
           'lock_acquire', 'lock_renew', 'lock_release', 'lock_inspect')
           AND audit.metadata ?| ARRAY[
             'request_id','run_id','lease_id','resource','resource_sha256']
           AND (target_principal_id IS NULL OR audit.principal_id = target_principal_id)
           AND (after_principal_id IS NULL OR audit.principal_id > after_principal_id)
        UNION
        SELECT receipt.principal_id
          FROM coordination_operation_receipts receipt
          JOIN principal_user_scopes mapping
            ON mapping.principal_id = receipt.principal_id
         WHERE receipt.scope_id <> mapping.scope_id
           AND (target_principal_id IS NULL OR receipt.principal_id = target_principal_id)
           AND (after_principal_id IS NULL OR receipt.principal_id > after_principal_id)
        UNION
        SELECT lease.principal_id
          FROM coordination_leases lease
          JOIN principal_user_scopes mapping
            ON mapping.principal_id = lease.principal_id
         WHERE lease.scope_id <> mapping.scope_id
           AND (target_principal_id IS NULL OR lease.principal_id = target_principal_id)
           AND (after_principal_id IS NULL OR lease.principal_id > after_principal_id)
      ) dirty
      JOIN coordination_principal_privacy_progress progress
        ON progress.principal_id = dirty.principal_id
       AND progress.privacy_version >= 3
       AND progress.completed_at IS NOT NULL
     ORDER BY dirty.principal_id LIMIT row_limit
  ), candidates AS MATERIALIZED (
    SELECT incomplete.principal_id FROM incomplete
    UNION
    SELECT dirty_completed.principal_id FROM dirty_completed
  )
  SELECT principal.id, mapping.scope_id,
         CASE WHEN principal.offboarded_at IS NOT NULL
              THEN 'offboarded'::text ELSE 'disabled_only'::text END
    FROM candidates
    JOIN principals principal ON principal.id = candidates.principal_id
    JOIN principal_user_scopes mapping ON mapping.principal_id = principal.id
   WHERE principal.disabled_at IS NOT NULL
   ORDER BY principal.id LIMIT row_limit;
END;
$$;
REVOKE ALL ON FUNCTION
  continuum_operator_list_coordination_privacy_repairs(UUID, UUID, UUID, INTEGER)
FROM PUBLIC;

-- Keep the reviewed v3 scrub intact behind a wrapper. Purging before the
-- legacy function freezes its candidate page makes freed quota usable in the
-- same call.
ALTER FUNCTION continuum_operator_scrub_coordination_principal(
  UUID, UUID, UUID, INTEGER)
  RENAME TO continuum_operator_scrub_coordination_principal_v3;

CREATE FUNCTION continuum_operator_scrub_coordination_principal(
  authorization_principal_id UUID, target_principal_id UUID,
  owned_scope_id UUID, batch_limit INTEGER DEFAULT 1000
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET statement_timeout = '5s' AS $$
DECLARE detached_id CONSTANT UUID := '00000000-0000-4000-8000-000000000012';
DECLARE purged_count INTEGER := 0;
DECLARE result JSONB;
DECLARE reason TEXT := NULL;
BEGIN
  WITH expired AS MATERIALIZED (
    SELECT principal_id, operation, request_id
      FROM coordination_operation_receipts
     WHERE principal_id = detached_id AND retain_until <= clock_timestamp()
     ORDER BY retain_until, operation, request_id
     LIMIT 100 FOR UPDATE
  ), removed AS (
    DELETE FROM coordination_operation_receipts receipt USING expired
     WHERE receipt.principal_id = expired.principal_id
       AND receipt.operation = expired.operation
       AND receipt.request_id = expired.request_id RETURNING 1
  ) SELECT count(*)::int INTO purged_count FROM removed;

  result := continuum_operator_scrub_coordination_principal_v3(
    authorization_principal_id, target_principal_id, owned_scope_id, batch_limit);
  IF COALESCE((result->>'complete')::boolean, FALSE) THEN
    reason := NULL;
  ELSIF result->>'blocked_until' IS NOT NULL THEN
    reason := 'live_lease';
  ELSIF COALESCE((result->>'progressed')::boolean, FALSE) THEN
    reason := NULL;
  ELSIF EXISTS (
    SELECT 1 FROM coordination_operation_receipts receipt
     WHERE receipt.principal_id = target_principal_id
       AND receipt.scope_id <> owned_scope_id
  ) THEN
    reason := 'detached_quota';
  ELSE
    reason := 'no_progress';
  END IF;
  RETURN result || jsonb_build_object(
    'progressed', COALESCE((result->>'progressed')::boolean, FALSE),
    'reason', reason,
    'expired_detached_receipts_purged', purged_count);
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_scrub_coordination_principal(
  UUID, UUID, UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION continuum_operator_scrub_coordination_principal_v3(
  UUID, UUID, UUID, INTEGER) FROM PUBLIC;

-- The 3-argument list overload was the published least-privilege contract.
-- Preserve its existing EXECUTE holders on the cursor overload. Likewise move
-- scrub holders from the renamed v3 implementation to the supported wrapper.
DO $upgrade_acl$
DECLARE schema_name TEXT := current_schema(); grant_record RECORD;
BEGIN
  FOR grant_record IN
    SELECT DISTINCT role.rolname
      FROM pg_proc function
      CROSS JOIN LATERAL aclexplode(COALESCE(
        function.proacl, acldefault('f', function.proowner))) privilege
      JOIN pg_roles role ON role.oid = privilege.grantee
     WHERE function.oid =
       'continuum_operator_list_coordination_privacy_repairs(uuid,uuid,integer)'::regprocedure
       AND privilege.grantee NOT IN (0, function.proowner)
       AND upper(privilege.privilege_type) = 'EXECUTE'
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.continuum_operator_list_coordination_privacy_repairs(UUID, UUID, UUID, INTEGER) TO %I',
      schema_name, grant_record.rolname);
  END LOOP;

  FOR grant_record IN
    SELECT DISTINCT role.rolname
      FROM pg_proc function
      CROSS JOIN LATERAL aclexplode(COALESCE(
        function.proacl, acldefault('f', function.proowner))) privilege
      JOIN pg_roles role ON role.oid = privilege.grantee
     WHERE function.oid =
       'continuum_operator_scrub_coordination_principal_v3(uuid,uuid,uuid,integer)'::regprocedure
       AND privilege.grantee NOT IN (0, function.proowner)
       AND upper(privilege.privilege_type) = 'EXECUTE'
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.continuum_operator_scrub_coordination_principal(UUID, UUID, UUID, INTEGER) TO %I',
      schema_name, grant_record.rolname);
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %I.continuum_operator_scrub_coordination_principal_v3(UUID, UUID, UUID, INTEGER) FROM %I',
      schema_name, grant_record.rolname);
  END LOOP;
END;
$upgrade_acl$;

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT function.proname,
           pg_get_function_identity_arguments(function.oid) AS arguments
      FROM pg_proc function
     WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
       AND function.proname = ANY(ARRAY[
         'continuum_coordination_privacy_actual_state_is_erased',
         'continuum_operator_list_coordination_privacy_repairs',
         'continuum_operator_scrub_coordination_principal',
         'continuum_operator_scrub_coordination_principal_v3'
       ])
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, %I, pg_temp',
      schema_name, function_record.proname, function_record.arguments, schema_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC',
      schema_name, function_record.proname, function_record.arguments);
  END LOOP;
END;
$harden$;
