-- Forward-only repair for bounded privacy discovery, lock contention, and the
-- detached receipt purge. Published migrations through 0072 remain unchanged.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- Completed principals are absent from the pending-progress index. Keep an
-- exact, trigger-maintained dirty set so steady-state discovery never walks
-- every clean completed principal.
CREATE TABLE coordination_privacy_dirty_principals (
  principal_id UUID PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  dirty_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON TABLE coordination_privacy_dirty_principals FROM PUBLIC;

CREATE FUNCTION continuum_refresh_coordination_privacy_dirty(
  target_principal_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE owned_scope_id UUID;
BEGIN
  DELETE FROM coordination_privacy_dirty_principals
   WHERE principal_id = target_principal_id;

  SELECT mapping.scope_id INTO owned_scope_id
    FROM principals principal
    JOIN principal_user_scopes mapping ON mapping.principal_id = principal.id
    JOIN coordination_principal_privacy_progress progress
      ON progress.principal_id = principal.id
   WHERE principal.id = target_principal_id
     AND principal.disabled_at IS NOT NULL
     AND progress.privacy_version >= 3
     AND progress.completed_at IS NOT NULL;
  IF owned_scope_id IS NULL THEN RETURN; END IF;

  IF EXISTS (
    SELECT 1 FROM audit_log audit
     WHERE audit.principal_id = target_principal_id
       AND audit.metadata->>'operation' IN (
         'lock_acquire', 'lock_renew', 'lock_release', 'lock_inspect')
       AND audit.metadata ?| ARRAY[
         'request_id','run_id','lease_id','resource','resource_sha256']
  ) OR EXISTS (
    SELECT 1 FROM coordination_operation_receipts receipt
     WHERE receipt.principal_id = target_principal_id
       AND receipt.scope_id <> owned_scope_id
  ) OR EXISTS (
    SELECT 1 FROM coordination_leases lease
     WHERE lease.principal_id = target_principal_id
       AND lease.scope_id <> owned_scope_id
  ) THEN
    INSERT INTO coordination_privacy_dirty_principals (principal_id)
    VALUES (target_principal_id)
    ON CONFLICT (principal_id) DO UPDATE SET dirty_at = clock_timestamp();
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_refresh_coordination_privacy_dirty(UUID) FROM PUBLIC;

CREATE FUNCTION continuum_mark_coordination_privacy_dirty_from_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.principal_id IS NOT NULL
      AND NEW.metadata->>'operation' IN (
        'lock_acquire', 'lock_renew', 'lock_release', 'lock_inspect')
      AND NEW.metadata ?| ARRAY[
        'request_id','run_id','lease_id','resource','resource_sha256'] THEN
    PERFORM continuum_refresh_coordination_privacy_dirty(NEW.principal_id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_mark_coordination_privacy_dirty_from_audit() FROM PUBLIC;
CREATE TRIGGER mark_coordination_privacy_dirty_from_audit
AFTER INSERT ON audit_log
FOR EACH ROW EXECUTE FUNCTION continuum_mark_coordination_privacy_dirty_from_audit();

CREATE FUNCTION continuum_mark_coordination_privacy_dirty_from_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_refresh_coordination_privacy_dirty(NEW.principal_id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_mark_coordination_privacy_dirty_from_state() FROM PUBLIC;
CREATE TRIGGER mark_coordination_privacy_dirty_from_receipt
AFTER INSERT ON coordination_operation_receipts
FOR EACH ROW EXECUTE FUNCTION continuum_mark_coordination_privacy_dirty_from_state();
CREATE TRIGGER mark_coordination_privacy_dirty_from_lease
AFTER INSERT ON coordination_leases
FOR EACH ROW EXECUTE FUNCTION continuum_mark_coordination_privacy_dirty_from_state();
CREATE TRIGGER refresh_coordination_privacy_dirty_from_progress
AFTER INSERT OR UPDATE OF privacy_version, completed_at
ON coordination_principal_privacy_progress
FOR EACH ROW EXECUTE FUNCTION continuum_mark_coordination_privacy_dirty_from_state();

CREATE FUNCTION continuum_refresh_coordination_privacy_dirty_from_principal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_refresh_coordination_privacy_dirty(NEW.id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_refresh_coordination_privacy_dirty_from_principal()
FROM PUBLIC;
CREATE TRIGGER refresh_coordination_privacy_dirty_from_principal
AFTER UPDATE OF disabled_at, offboarded_at ON principals
FOR EACH ROW EXECUTE FUNCTION continuum_refresh_coordination_privacy_dirty_from_principal();

-- One-time backfill starts from the three dirty indexes and applies eligibility
-- before insertion. Clean completed progress rows are never the driving set.
INSERT INTO coordination_privacy_dirty_principals (principal_id)
SELECT dirty.principal_id
  FROM (
    SELECT DISTINCT audit.principal_id
      FROM audit_log audit
     WHERE audit.metadata->>'operation' IN (
       'lock_acquire', 'lock_renew', 'lock_release', 'lock_inspect')
       AND audit.metadata ?| ARRAY[
         'request_id','run_id','lease_id','resource','resource_sha256']
    UNION
    SELECT receipt.principal_id
      FROM coordination_operation_receipts receipt
      JOIN principal_user_scopes mapping ON mapping.principal_id = receipt.principal_id
     WHERE receipt.scope_id <> mapping.scope_id
    UNION
    SELECT lease.principal_id
      FROM coordination_leases lease
      JOIN principal_user_scopes mapping ON mapping.principal_id = lease.principal_id
     WHERE lease.scope_id <> mapping.scope_id
  ) dirty
  JOIN principals principal ON principal.id = dirty.principal_id
  JOIN coordination_principal_privacy_progress progress
    ON progress.principal_id = dirty.principal_id
  JOIN principal_user_scopes mapping ON mapping.principal_id = dirty.principal_id
 WHERE principal.disabled_at IS NOT NULL
   AND progress.privacy_version >= 3
   AND progress.completed_at IS NOT NULL
ON CONFLICT (principal_id) DO NOTHING;

CREATE OR REPLACE FUNCTION continuum_coordination_privacy_repair_candidates(
  after_principal_id UUID, target_principal_id UUID, row_limit INTEGER
) RETURNS TABLE(principal_id UUID, scope_id UUID, repair_state TEXT)
LANGUAGE sql STABLE AS $$
  WITH incomplete AS MATERIALIZED (
    SELECT progress.principal_id, mapping.scope_id,
           CASE WHEN principal.offboarded_at IS NOT NULL
                THEN 'offboarded'::text ELSE 'disabled_only'::text END AS repair_state
      FROM coordination_principal_privacy_progress progress
      JOIN principals principal
        ON principal.id = progress.principal_id
       AND principal.disabled_at IS NOT NULL
      JOIN principal_user_scopes mapping ON mapping.principal_id = progress.principal_id
     WHERE (progress.privacy_version < 3 OR progress.completed_at IS NULL)
       AND progress.principal_id >= COALESCE(
         after_principal_id, '00000000-0000-0000-0000-000000000000'::uuid)
       AND (after_principal_id IS NULL OR progress.principal_id > after_principal_id)
       AND (target_principal_id IS NULL OR progress.principal_id = target_principal_id)
     ORDER BY progress.principal_id LIMIT row_limit
  ), dirty AS MATERIALIZED (
    SELECT marker.principal_id, mapping.scope_id,
           CASE WHEN principal.offboarded_at IS NOT NULL
                THEN 'offboarded'::text ELSE 'disabled_only'::text END AS repair_state
      FROM coordination_privacy_dirty_principals marker
      JOIN principals principal
        ON principal.id = marker.principal_id
       AND principal.disabled_at IS NOT NULL
      JOIN principal_user_scopes mapping ON mapping.principal_id = marker.principal_id
      JOIN coordination_principal_privacy_progress progress
        ON progress.principal_id = marker.principal_id
       AND progress.privacy_version >= 3
       AND progress.completed_at IS NOT NULL
     WHERE marker.principal_id >= COALESCE(
         after_principal_id, '00000000-0000-0000-0000-000000000000'::uuid)
       AND (after_principal_id IS NULL OR marker.principal_id > after_principal_id)
       AND (target_principal_id IS NULL OR marker.principal_id = target_principal_id)
     ORDER BY marker.principal_id LIMIT row_limit
  ), candidates AS (
    SELECT * FROM incomplete
    UNION
    SELECT * FROM dirty
  )
  SELECT candidates.principal_id, candidates.scope_id, candidates.repair_state
    FROM candidates ORDER BY candidates.principal_id LIMIT row_limit;
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

-- Direct SQL and old compatible callers cannot rely on a caller-provided
-- timeout. Convert principal/scope advisory contention and usage-row
-- contention into SQLSTATE 55P03 immediately. The supported wrapper catches
-- that state and returns a typed incomplete result.
CREATE FUNCTION continuum_coordination_require_advisory_lock(lock_key BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(lock_key) THEN
    RAISE lock_not_available USING MESSAGE = 'coordination privacy lock is busy';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_require_advisory_lock(BIGINT) FROM PUBLIC;

DO $bounded_v3$
DECLARE definition TEXT; revised TEXT;
DECLARE purge_block TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_operator_scrub_coordination_principal_v3(uuid,uuid,uuid,integer)'::regprocedure)
    INTO definition;
  revised := replace(definition,
    'PERFORM pg_advisory_xact_lock(hashtextextended(target_principal_id::text, 762));',
    'PERFORM continuum_coordination_require_advisory_lock(' ||
    'hashtextextended(target_principal_id::text, 762));');
  revised := replace(revised,
    'PERFORM pg_advisory_xact_lock(hashtextextended(locked_scope::text, 761));',
    'PERFORM continuum_coordination_require_advisory_lock(' ||
    'hashtextextended(locked_scope::text, 761));');
  purge_block :=
    '    WITH expired AS MATERIALIZED (' || chr(10) ||
    '      SELECT principal_id, operation, request_id' || chr(10) ||
    '        FROM coordination_operation_receipts' || chr(10) ||
    '       WHERE principal_id = detached_id AND retain_until <= clock_timestamp()' || chr(10) ||
    '       ORDER BY retain_until, operation, request_id' || chr(10) ||
    '       LIMIT 100 FOR UPDATE SKIP LOCKED' || chr(10) ||
    '    )' || chr(10) ||
    '    DELETE FROM coordination_operation_receipts receipt USING expired' || chr(10) ||
    '     WHERE receipt.principal_id = expired.principal_id' || chr(10) ||
    '       AND receipt.operation = expired.operation' || chr(10) ||
    '       AND receipt.request_id = expired.request_id;' || chr(10) || chr(10);
  revised := replace(revised, purge_block, '');
  revised := replace(revised,
    '     ORDER BY principal_id FOR UPDATE;',
    '     ORDER BY principal_id FOR UPDATE NOWAIT;');
  IF revised = definition
      OR position('pg_advisory_xact_lock(hashtextextended(target_principal_id' IN revised) > 0
      OR position('pg_advisory_xact_lock(hashtextextended(locked_scope' IN revised) > 0
      OR position('WHERE principal_id = detached_id AND retain_until' IN revised) > 0
      OR position('ORDER BY principal_id FOR UPDATE NOWAIT' IN revised) = 0 THEN
    RAISE EXCEPTION 'unable to install bounded coordination scrub lock order';
  END IF;
  EXECUTE revised;
END;
$bounded_v3$;

CREATE OR REPLACE FUNCTION continuum_operator_scrub_coordination_principal(
  authorization_principal_id UUID, target_principal_id UUID,
  owned_scope_id UUID, batch_limit INTEGER DEFAULT 1000
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE detached_id CONSTANT UUID := '00000000-0000-4000-8000-000000000012';
DECLARE purged_count INTEGER := 0;
DECLARE purge_busy BOOLEAN := FALSE;
DECLARE result JSONB;
DECLARE reason TEXT := NULL;
BEGIN
  BEGIN
    result := continuum_operator_scrub_coordination_principal_v3(
      authorization_principal_id, target_principal_id, owned_scope_id, batch_limit);
  EXCEPTION WHEN lock_not_available THEN
    result := jsonb_build_object(
      'audit_rows_scrubbed', 0, 'receipts_scrubbed', 0, 'leases_scrubbed', 0,
      'privacy_version', 3, 'complete', FALSE, 'progressed', FALSE,
      'blocked_until', NULL, 'reason', 'lock_busy');
  END;

  IF result->>'reason' IS DISTINCT FROM 'lock_busy' THEN
    BEGIN
      PERFORM 1 FROM coordination_principal_usage
       WHERE principal_id = detached_id FOR UPDATE NOWAIT;
      IF FOUND THEN
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
      END IF;
    EXCEPTION WHEN lock_not_available THEN
      purge_busy := TRUE;
    END;
  END IF;

  PERFORM continuum_refresh_coordination_privacy_dirty(target_principal_id);
  IF COALESCE((result->>'complete')::boolean, FALSE) THEN
    reason := NULL;
  ELSIF result->>'blocked_until' IS NOT NULL THEN
    reason := 'live_lease';
  ELSIF result->>'reason' IS NOT NULL THEN
    reason := result->>'reason';
  ELSIF COALESCE((result->>'progressed')::boolean, FALSE) THEN
    reason := NULL;
  ELSIF purge_busy THEN
    reason := 'lock_busy';
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
         'continuum_refresh_coordination_privacy_dirty',
         'continuum_mark_coordination_privacy_dirty_from_audit',
         'continuum_mark_coordination_privacy_dirty_from_state',
         'continuum_refresh_coordination_privacy_dirty_from_principal',
         'continuum_operator_list_coordination_privacy_repairs',
         'continuum_coordination_require_advisory_lock',
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
