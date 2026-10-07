-- Repair discovery, detached purge contention, and review evidence after the
-- published 0070/0071 migrations. Those files remain byte-identical.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- This invoker helper is the one production candidate query used by the
-- trusted four-argument operator function. Keeping the query in a SQL function
-- makes its real plan observable with EXPLAIN while the outer function retains
-- the database-identity check. It has no runtime-role grant of its own.
CREATE FUNCTION continuum_coordination_privacy_repair_candidates(
  after_principal_id UUID, target_principal_id UUID, row_limit INTEGER
) RETURNS TABLE(principal_id UUID, scope_id UUID, repair_state TEXT)
LANGUAGE sql STABLE AS $$
  SELECT principal.id, mapping.scope_id,
         CASE WHEN principal.offboarded_at IS NOT NULL
              THEN 'offboarded'::text ELSE 'disabled_only'::text END
    FROM coordination_principal_privacy_progress progress
    JOIN principals principal
      ON principal.id = progress.principal_id
     AND principal.disabled_at IS NOT NULL
    JOIN principal_user_scopes mapping
      ON mapping.principal_id = progress.principal_id
   WHERE (target_principal_id IS NULL OR progress.principal_id = target_principal_id)
     AND (after_principal_id IS NULL OR progress.principal_id > after_principal_id)
     AND (
       progress.privacy_version < 3
       OR progress.completed_at IS NULL
       OR (
         progress.privacy_version >= 3
         AND progress.completed_at IS NOT NULL
         AND (
           EXISTS (
             SELECT 1
               FROM audit_log audit
              WHERE audit.principal_id = progress.principal_id
                AND audit.metadata->>'operation' IN (
                  'lock_acquire', 'lock_renew', 'lock_release', 'lock_inspect')
                AND audit.metadata ?| ARRAY[
                  'request_id','run_id','lease_id','resource','resource_sha256'])
           OR EXISTS (
             SELECT 1
               FROM coordination_operation_receipts receipt
              WHERE receipt.principal_id = progress.principal_id
                AND receipt.scope_id <> mapping.scope_id)
           OR EXISTS (
             SELECT 1
               FROM coordination_leases lease
              WHERE lease.principal_id = progress.principal_id
                AND lease.scope_id <> mapping.scope_id)
         )
       )
     )
   ORDER BY progress.principal_id
   LIMIT row_limit;
$$;
REVOKE ALL ON FUNCTION
  continuum_coordination_privacy_repair_candidates(UUID, UUID, INTEGER)
FROM PUBLIC;

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
  SELECT candidate.principal_id, candidate.scope_id, candidate.repair_state
    FROM continuum_coordination_privacy_repair_candidates(
      after_principal_id, target_principal_id, row_limit) candidate;
END;
$$;
REVOKE ALL ON FUNCTION
  continuum_operator_list_coordination_privacy_repairs(UUID, UUID, UUID, INTEGER)
FROM PUBLIC;

-- Replace only the 0071 wrapper. The reviewed v3 implementation remains
-- behaviorally unchanged except for its nested detached purge lock policy.
-- Both purge layers must skip a locked row or the inner v3 call can still
-- queue behind an unrelated scrub.
DO $skip_locked_v3$
DECLARE definition TEXT; revised TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_operator_scrub_coordination_principal_v3(uuid,uuid,uuid,integer)'::regprocedure)
    INTO definition;
  revised := replace(
    definition, 'LIMIT 100 FOR UPDATE', 'LIMIT 100 FOR UPDATE SKIP LOCKED');
  IF revised = definition
      OR position('LIMIT 100 FOR UPDATE SKIP LOCKED' IN revised) = 0 THEN
    RAISE EXCEPTION 'unable to bound detached purge lock waits in v3 scrub';
  END IF;
  EXECUTE revised;
END;
$skip_locked_v3$;

-- SKIP LOCKED prevents one detached receipt from serializing independent
-- scrubs, and the caller's SET LOCAL timeout bounds the complete call.
CREATE OR REPLACE FUNCTION continuum_operator_scrub_coordination_principal(
  authorization_principal_id UUID, target_principal_id UUID,
  owned_scope_id UUID, batch_limit INTEGER DEFAULT 1000
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
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
     LIMIT 100 FOR UPDATE SKIP LOCKED
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

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT function.proname,
           pg_get_function_identity_arguments(function.oid) AS arguments
      FROM pg_proc function
     WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
       AND function.proname = ANY(ARRAY[
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
