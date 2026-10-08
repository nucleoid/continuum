-- Forward-only compatibility, lifecycle, and stored-function repair after 0073.
-- The installation-wide repair is intentionally deferred to the online 0075 step.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE coordination_principal_privacy_progress
  ADD COLUMN repair_eligible BOOLEAN;
ALTER TABLE coordination_principal_privacy_progress
  DROP CONSTRAINT coordination_principal_privacy_progress_privacy_version_check;
ALTER TABLE coordination_principal_privacy_progress
  ADD CONSTRAINT coordination_principal_privacy_progress_privacy_version_check
  CHECK (privacy_version >= 1 AND privacy_version <= 3) NOT VALID;
ALTER TABLE coordination_principal_privacy_progress
  VALIDATE CONSTRAINT coordination_principal_privacy_progress_privacy_version_check;

CREATE TABLE coordination_v4_backfill_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  last_principal_id UUID,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO coordination_v4_backfill_state (singleton) VALUES (TRUE);
REVOKE ALL ON TABLE coordination_v4_backfill_state FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_set_coordination_repair_eligibility()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  NEW.repair_eligible := EXISTS (
    SELECT 1 FROM principals principal
     WHERE principal.id = NEW.principal_id
       AND principal.disabled_at IS NOT NULL
  ) AND EXISTS (
    SELECT 1 FROM principal_user_scopes mapping
     WHERE mapping.principal_id = NEW.principal_id
  );
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_set_coordination_repair_eligibility() FROM PUBLIC;
CREATE TRIGGER set_coordination_repair_eligibility
BEFORE INSERT OR UPDATE OF principal_id, privacy_version, completed_at
ON coordination_principal_privacy_progress
FOR EACH ROW EXECUTE FUNCTION continuum_set_coordination_repair_eligibility();

CREATE OR REPLACE FUNCTION continuum_refresh_coordination_repair_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE coordination_principal_privacy_progress
     SET repair_eligible = NEW.disabled_at IS NOT NULL,
         updated_at = CASE WHEN repair_eligible IS DISTINCT FROM
           (NEW.disabled_at IS NOT NULL) THEN clock_timestamp() ELSE updated_at END
   WHERE principal_id = NEW.id;
  PERFORM continuum_refresh_coordination_privacy_dirty(NEW.id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_refresh_coordination_repair_lifecycle() FROM PUBLIC;
DROP TRIGGER refresh_coordination_privacy_dirty_from_principal ON principals;
CREATE TRIGGER refresh_coordination_privacy_dirty_from_principal
AFTER UPDATE OF disabled_at, offboarded_at, reactivated_at ON principals
FOR EACH ROW EXECUTE FUNCTION continuum_refresh_coordination_repair_lifecycle();

CREATE OR REPLACE FUNCTION continuum_backfill_coordination_v4(batch_limit INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE cursor_id UUID; selected_count INTEGER; next_cursor UUID;
DECLARE candidate RECORD;
BEGIN
  IF batch_limit < 1 OR batch_limit > 5000 THEN
    RAISE EXCEPTION 'coordination v4 backfill limit must be between 1 and 5000';
  END IF;
  SELECT last_principal_id INTO cursor_id
    FROM coordination_v4_backfill_state WHERE singleton = TRUE FOR UPDATE;
  CREATE TEMP TABLE IF NOT EXISTS coordination_v4_batch(
    principal_id UUID PRIMARY KEY
  ) ON COMMIT DELETE ROWS;
  INSERT INTO coordination_v4_batch(principal_id)
  SELECT progress.principal_id
    FROM coordination_principal_privacy_progress progress
   WHERE cursor_id IS NULL OR progress.principal_id > cursor_id
   ORDER BY progress.principal_id LIMIT batch_limit;
  GET DIAGNOSTICS selected_count = ROW_COUNT;
  FOR candidate IN SELECT principal_id FROM coordination_v4_batch ORDER BY principal_id LOOP
    UPDATE coordination_principal_privacy_progress progress
       SET repair_eligible = principal.disabled_at IS NOT NULL,
           updated_at = CASE WHEN progress.repair_eligible IS DISTINCT FROM
             (principal.disabled_at IS NOT NULL) THEN clock_timestamp()
             ELSE progress.updated_at END
      FROM principals principal
     WHERE progress.principal_id = candidate.principal_id
       AND principal.id = progress.principal_id;
    PERFORM continuum_refresh_coordination_privacy_dirty(candidate.principal_id);
  END LOOP;
  SELECT principal_id INTO next_cursor FROM coordination_v4_batch
   ORDER BY principal_id DESC LIMIT 1;
  UPDATE coordination_v4_backfill_state
     SET last_principal_id = COALESCE(next_cursor, last_principal_id),
         completed = selected_count < batch_limit,
         updated_at = clock_timestamp()
   WHERE singleton = TRUE;
  RETURN selected_count < batch_limit;
END;
$$;
REVOKE ALL ON FUNCTION continuum_backfill_coordination_v4(INTEGER) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_coordination_privacy_repair_candidates(
  after_principal_id UUID, target_principal_id UUID, row_limit INTEGER
) RETURNS TABLE(principal_id UUID, scope_id UUID, repair_state TEXT)
LANGUAGE sql STABLE AS $$
  WITH incomplete AS MATERIALIZED (
    SELECT progress.principal_id, mapping.scope_id,
           CASE WHEN principal.offboarded_at IS NOT NULL
                THEN 'offboarded'::text ELSE 'disabled_only'::text END AS repair_state
      FROM coordination_principal_privacy_progress progress
      JOIN principals principal ON principal.id = progress.principal_id
      JOIN principal_user_scopes mapping ON mapping.principal_id = progress.principal_id
     WHERE progress.repair_eligible IS TRUE
       AND (progress.privacy_version < 3 OR progress.completed_at IS NULL)
       AND (after_principal_id IS NULL OR progress.principal_id > after_principal_id)
       AND (target_principal_id IS NULL OR progress.principal_id = target_principal_id)
     ORDER BY progress.principal_id LIMIT row_limit
  ), dirty AS MATERIALIZED (
    SELECT marker.principal_id, mapping.scope_id,
           CASE WHEN principal.offboarded_at IS NOT NULL
                THEN 'offboarded'::text ELSE 'disabled_only'::text END AS repair_state
      FROM coordination_privacy_dirty_principals marker
      JOIN principals principal ON principal.id = marker.principal_id
       AND principal.disabled_at IS NOT NULL
      JOIN principal_user_scopes mapping ON mapping.principal_id = marker.principal_id
     WHERE (after_principal_id IS NULL OR marker.principal_id > after_principal_id)
       AND (target_principal_id IS NULL OR marker.principal_id = target_principal_id)
     ORDER BY marker.principal_id LIMIT row_limit
  ), candidates AS (SELECT * FROM incomplete UNION SELECT * FROM dirty)
  SELECT candidates.principal_id, candidates.scope_id, candidates.repair_state
    FROM candidates ORDER BY candidates.principal_id LIMIT row_limit;
$$;
REVOKE ALL ON FUNCTION
  continuum_coordination_privacy_repair_candidates(UUID, UUID, INTEGER) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_operator_scrub_coordination_principal(
  authorization_principal_id UUID, target_principal_id UUID,
  owned_scope_id UUID, batch_limit INTEGER DEFAULT 1000
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE detached_id CONSTANT UUID := '00000000-0000-4000-8000-000000000012';
DECLARE purged_count INTEGER := 0; DECLARE result JSONB; DECLARE reason TEXT := NULL;
DECLARE live_blocked_until TIMESTAMPTZ;
BEGIN
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
    PERFORM continuum_refresh_coordination_privacy_dirty(target_principal_id);
  EXCEPTION WHEN lock_not_available THEN
    -- continuum_refresh_coordination_privacy_dirty executes inside this guarded block.
    IF current_setting('continuum.client_coordination_privacy_version', TRUE)
        IS DISTINCT FROM '4' THEN
      RAISE feature_not_supported USING MESSAGE =
        'pre-0074 coordination privacy client refused after lock contention';
    END IF;
    result := jsonb_build_object(
      'audit_rows_scrubbed', 0, 'receipts_scrubbed', 0, 'leases_scrubbed', 0,
      'privacy_version', 3, 'complete', FALSE, 'progressed', FALSE,
      'blocked_until', NULL, 'reason', 'lock_busy');
  END;
  IF COALESCE((result->>'complete')::boolean, FALSE) THEN reason := NULL;
  ELSIF result->>'blocked_until' IS NOT NULL THEN reason := 'live_lease';
  ELSIF result->>'reason' IS NOT NULL THEN reason := result->>'reason';
  ELSIF COALESCE((result->>'progressed')::boolean, FALSE) THEN reason := NULL;
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
REVOKE ALL ON FUNCTION continuum_operator_scrub_coordination_principal(
  UUID, UUID, UUID, INTEGER) FROM PUBLIC;

-- PostgreSQL stores dollar-quoted bodies verbatim. Repair bodies installed by
-- pre-0065 CRLF execution, including lone CR remnants, without changing ACLs.
DO $repair_crlf$
DECLARE routine RECORD; definition TEXT; normalized TEXT;
BEGIN
  FOR routine IN
    SELECT function.oid
      FROM pg_proc function
     WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
       AND position(chr(13) IN function.prosrc) > 0
  LOOP
    definition := pg_get_functiondef(routine.oid);
    normalized := replace(replace(definition, chr(13) || chr(10), chr(10)), chr(13), chr(10));
    IF normalized <> definition THEN EXECUTE normalized; END IF;
  END LOOP;
END;
$repair_crlf$;

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT function.proname, pg_get_function_identity_arguments(function.oid) AS arguments
      FROM pg_proc function
     WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
       AND function.proname = ANY(ARRAY[
         'continuum_set_coordination_repair_eligibility',
         'continuum_refresh_coordination_repair_lifecycle',
         'continuum_backfill_coordination_v4',
         'continuum_coordination_privacy_repair_candidates',
         'continuum_operator_scrub_coordination_principal'])
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, %I, pg_temp',
      schema_name, function_record.proname, function_record.arguments, schema_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC',
      schema_name, function_record.proname, function_record.arguments);
  END LOOP;
END;
$harden$;
