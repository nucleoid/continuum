-- Forward-only remediation for upgrade negotiation, bounded discovery,
-- contention-safe privacy progress, and exact CRLF repair. Published
-- migrations 0054-0077 remain byte-identical.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- The function signature is the schema-version marker used by current
-- clients. Reaching 0079 requires the ledgered 0077 backfill prerequisite;
-- runtime roles need only resolve the signature and receive no new privilege.
CREATE OR REPLACE FUNCTION continuum_coordination_privacy_schema_ready()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE((
    SELECT state.completed
      FROM coordination_v5_backfill_state state
     WHERE state.singleton = TRUE
  ), FALSE);
$$;
REVOKE ALL ON FUNCTION continuum_coordination_privacy_schema_ready() FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_coordination_privacy_repair_candidates(
  after_principal_id UUID, target_principal_id UUID, row_limit INTEGER
) RETURNS TABLE(principal_id UUID, scope_id UUID, repair_state TEXT)
LANGUAGE sql STABLE AS $$
  WITH incomplete AS MATERIALIZED (
    SELECT progress.principal_id, mapping.scope_id,
           CASE WHEN principal.offboarded_at IS NOT NULL
                THEN 'offboarded'::text ELSE 'disabled_only'::text END AS repair_state
      FROM (
        SELECT progress.principal_id
          FROM coordination_principal_privacy_progress progress
         WHERE progress.repair_eligible IS TRUE
           AND (progress.privacy_version < 3 OR progress.completed_at IS NULL)
           AND progress.principal_id >= GREATEST(
             COALESCE(after_principal_id,
               '00000000-0000-0000-0000-000000000000'::uuid),
             COALESCE(target_principal_id,
               '00000000-0000-0000-0000-000000000000'::uuid))
           AND progress.principal_id <= COALESCE(
             target_principal_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
           AND (after_principal_id IS NULL
                OR progress.principal_id > after_principal_id)
         ORDER BY progress.principal_id LIMIT row_limit
      ) progress
      JOIN principals principal ON principal.id = progress.principal_id
      JOIN principal_user_scopes mapping ON mapping.principal_id = progress.principal_id
     ORDER BY progress.principal_id LIMIT row_limit
  ), legacy_incomplete AS MATERIALIZED (
    SELECT progress.principal_id, mapping.scope_id,
           CASE WHEN principal.offboarded_at IS NOT NULL
                THEN 'offboarded'::text ELSE 'disabled_only'::text END AS repair_state
      FROM (
        SELECT progress.principal_id
          FROM coordination_principal_privacy_progress progress
         WHERE progress.repair_eligible IS NOT TRUE
           AND (progress.privacy_version < 3 OR progress.completed_at IS NULL)
           AND progress.principal_id >= GREATEST(
             COALESCE(after_principal_id,
               '00000000-0000-0000-0000-000000000000'::uuid),
             COALESCE(target_principal_id,
               '00000000-0000-0000-0000-000000000000'::uuid))
           AND progress.principal_id <= COALESCE(
             target_principal_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
           AND (after_principal_id IS NULL
                OR progress.principal_id > after_principal_id)
         ORDER BY progress.principal_id LIMIT row_limit
      ) progress
      JOIN principals principal ON principal.id = progress.principal_id
       AND principal.disabled_at IS NOT NULL
      JOIN principal_user_scopes mapping ON mapping.principal_id = progress.principal_id
     ORDER BY progress.principal_id LIMIT row_limit
  ), dirty AS MATERIALIZED (
    SELECT marker.principal_id, mapping.scope_id,
           CASE WHEN principal.offboarded_at IS NOT NULL
                THEN 'offboarded'::text ELSE 'disabled_only'::text END AS repair_state
      FROM (
        SELECT marker.principal_id
          FROM coordination_privacy_dirty_principals marker
         WHERE marker.principal_id >= GREATEST(
             COALESCE(after_principal_id,
               '00000000-0000-0000-0000-000000000000'::uuid),
             COALESCE(target_principal_id,
               '00000000-0000-0000-0000-000000000000'::uuid))
           AND marker.principal_id <= COALESCE(
             target_principal_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
           AND (after_principal_id IS NULL
                OR marker.principal_id > after_principal_id)
         ORDER BY marker.principal_id LIMIT row_limit
      ) marker
      JOIN principals principal ON principal.id = marker.principal_id
       AND principal.disabled_at IS NOT NULL
      JOIN principal_user_scopes mapping ON mapping.principal_id = marker.principal_id
     ORDER BY marker.principal_id LIMIT row_limit
  ), candidates AS (
    SELECT * FROM incomplete
    UNION SELECT * FROM legacy_incomplete
    UNION SELECT * FROM dirty
  )
  SELECT candidates.principal_id, candidates.scope_id, candidates.repair_state
    FROM candidates ORDER BY candidates.principal_id LIMIT row_limit;
$$;

CREATE OR REPLACE FUNCTION continuum_refresh_coordination_privacy_dirty(
  target_principal_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE owned_scope_id UUID;
BEGIN
  BEGIN
    -- A locked marker represents conservative evidence that must not be
    -- deleted or allowed to roll back already-completed v3 scrub work.
    PERFORM 1 FROM coordination_privacy_dirty_principals
     WHERE principal_id = target_principal_id
     FOR UPDATE NOWAIT;

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
  EXCEPTION WHEN lock_not_available THEN
    RETURN;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_operator_scrub_coordination_principal(
  authorization_principal_id UUID, target_principal_id UUID,
  owned_scope_id UUID, batch_limit INTEGER DEFAULT 1000
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE detached_id CONSTANT UUID := '00000000-0000-4000-8000-000000000012';
DECLARE purged_count INTEGER := 0; DECLARE result JSONB; DECLARE reason TEXT := NULL;
DECLARE live_blocked_until TIMESTAMPTZ; DECLARE purge_busy BOOLEAN := FALSE;
BEGIN
  PERFORM continuum_require_coordination_privacy_client_v4();
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  SELECT min(lease.expires_at) INTO live_blocked_until
    FROM coordination_leases lease
   WHERE lease.principal_id = target_principal_id
     AND lease.scope_id <> owned_scope_id
     AND lease.released_at IS NULL
     AND lease.expires_at > clock_timestamp();
  IF live_blocked_until IS NOT NULL THEN
    RETURN jsonb_build_object(
      'audit_rows_scrubbed', 0, 'receipts_scrubbed', 0, 'leases_scrubbed', 0,
      'privacy_version', 3, 'complete', FALSE, 'progressed', FALSE,
      'blocked_until', live_blocked_until, 'reason', 'live_lease',
      'expired_detached_receipts_purged', 0);
  END IF;
  BEGIN
    result := continuum_operator_scrub_coordination_principal_v3(
      authorization_principal_id, target_principal_id, owned_scope_id, batch_limit);
  EXCEPTION WHEN lock_not_available THEN
    result := jsonb_build_object(
      'audit_rows_scrubbed', 0, 'receipts_scrubbed', 0, 'leases_scrubbed', 0,
      'privacy_version', 3, 'complete', FALSE, 'progressed', FALSE,
      'blocked_until', NULL, 'reason', 'lock_busy');
  END;
  IF result->>'reason' IS DISTINCT FROM 'lock_busy'
      AND EXISTS (
        SELECT 1 FROM coordination_operation_receipts receipt
         WHERE receipt.principal_id = detached_id
           AND receipt.retain_until <= clock_timestamp()
      ) THEN
    PERFORM 1 FROM coordination_principal_usage
      WHERE principal_id = detached_id FOR UPDATE SKIP LOCKED;
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
    ELSE
      purge_busy := TRUE;
    END IF;
  END IF;
  IF result->>'reason' IS DISTINCT FROM 'lock_busy' THEN
    PERFORM continuum_refresh_coordination_privacy_dirty(target_principal_id);
  END IF;
  IF COALESCE((result->>'complete')::boolean, FALSE) THEN reason := NULL;
  ELSIF result->>'blocked_until' IS NOT NULL THEN reason := 'live_lease';
  ELSIF result->>'reason' = 'lock_busy' THEN reason := 'lock_busy';
  ELSIF COALESCE((result->>'progressed')::boolean, FALSE) THEN reason := NULL;
  ELSIF purge_busy THEN reason := 'lock_busy';
  ELSIF EXISTS (SELECT 1 FROM coordination_operation_receipts receipt
                 WHERE receipt.principal_id = target_principal_id
                   AND receipt.scope_id <> owned_scope_id) THEN reason := 'detached_quota';
  ELSE reason := 'no_progress'; END IF;
  RETURN result || jsonb_build_object(
    'progressed', CASE WHEN result->>'blocked_until' IS NOT NULL THEN FALSE
      ELSE COALESCE((result->>'progressed')::boolean, FALSE) END,
    'reason', reason, 'expired_detached_receipts_purged', purged_count);
END;
$$;

-- Normalize CRLF pairs only. Meaningful lone CR bytes remain untouched, and
-- co-tenant, differently-owned, and extension-owned routines remain outside
-- Continuum's repair boundary.
DO $repair_crlf$
DECLARE routine RECORD; definition TEXT; normalized TEXT;
BEGIN
  FOR routine IN
    SELECT function.oid
      FROM pg_proc function
     WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
       AND function.proname LIKE 'continuum\_%' ESCAPE '\'
       AND function.proowner = current_user::regrole
       AND position(chr(13) || chr(10) IN function.prosrc) > 0
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend dependency
          WHERE dependency.classid = 'pg_proc'::regclass
            AND dependency.objid = function.oid
            AND dependency.refclassid = 'pg_extension'::regclass
            AND dependency.deptype = 'e')
  LOOP
    definition := pg_get_functiondef(routine.oid);
    normalized := replace(definition, chr(13) || chr(10), chr(10));
    IF normalized <> definition THEN EXECUTE normalized; END IF;
  END LOOP;
END;
$repair_crlf$;

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD;
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_coordination_privacy_schema_ready() '
    || 'SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  FOR function_record IN
    SELECT function.proname,
           pg_get_function_identity_arguments(function.oid) AS arguments
      FROM pg_proc function
     WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
       AND function.proname = ANY(ARRAY[
         'continuum_coordination_privacy_repair_candidates',
         'continuum_refresh_coordination_privacy_dirty',
         'continuum_operator_scrub_coordination_principal'])
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, %I, pg_temp',
      schema_name, function_record.proname, function_record.arguments, schema_name);
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC',
      schema_name, function_record.proname, function_record.arguments);
  END LOOP;
END;
$harden$;
