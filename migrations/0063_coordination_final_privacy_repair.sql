-- Forward-only repair for final coordination privacy and concurrency review.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE coordination_principal_privacy_progress
  ADD COLUMN IF NOT EXISTS privacy_version INTEGER NOT NULL DEFAULT 1
    CHECK (privacy_version BETWEEN 1 AND 2),
  ADD COLUMN IF NOT EXISTS audit_cursor_id BIGINT NOT NULL DEFAULT 0
    CHECK (audit_cursor_id >= 0),
  ADD COLUMN IF NOT EXISTS audit_rows_scrubbed BIGINT NOT NULL DEFAULT 0
    CHECK (audit_rows_scrubbed >= 0);

-- Versions 0059 and 0060 could report completion before role and other-user
-- scope rows, or linked audit metadata, had been visited. Reopen those rows;
-- the version is promoted only after every v2 phase proves exhaustion.
UPDATE coordination_principal_privacy_progress
   SET completed_at = NULL, audit_cursor_id = 0, updated_at = clock_timestamp()
 WHERE privacy_version = 1;

CREATE OR REPLACE FUNCTION continuum_coordination_privacy_membership_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE locked_scope UUID;
BEGIN
  IF TG_OP = 'UPDATE'
      AND NEW.active IS NOT DISTINCT FROM OLD.active
      AND NEW.scope_id IS NOT DISTINCT FROM OLD.scope_id THEN
    RETURN NEW;
  END IF;

  -- Membership insertion, activation, deactivation, and scope movement share
  -- one per-scope lock protocol with both privacy operators. Lock old/new IDs
  -- in UUID order so a scope move cannot invert the order.
  FOR locked_scope IN
    SELECT DISTINCT scope_id FROM (
      SELECT NEW.scope_id
      UNION ALL
      SELECT CASE WHEN TG_OP = 'UPDATE' THEN OLD.scope_id END
    ) candidate(scope_id)
    WHERE scope_id IS NOT NULL ORDER BY scope_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(locked_scope::text, 761));
  END LOOP;

  IF NOT NEW.active OR NOT EXISTS (
    SELECT 1 FROM coordination_scope_privacy_progress
     WHERE scope_id = NEW.scope_id
  ) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM principal_user_scopes mapping
    JOIN principals principal ON principal.id = mapping.principal_id
     WHERE mapping.scope_id = NEW.scope_id
       AND mapping.principal_id = NEW.principal_id
       AND principal.disabled_at IS NULL
       AND principal.reactivated_at IS NOT NULL
  ) THEN
    DELETE FROM coordination_scope_privacy_progress WHERE scope_id = NEW.scope_id;
  ELSE
    RAISE EXCEPTION
      'offboarded owned scope or coordination-private scope cannot gain active memberships';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_privacy_membership_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_coordination_receipt_counter()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE changed BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.operation = 'renew' THEN
    DELETE FROM coordination_operation_receipts receipt
     WHERE (receipt.principal_id, receipt.operation, receipt.request_id) IN (
       SELECT retained.principal_id, retained.operation, retained.request_id
         FROM coordination_operation_receipts retained
        WHERE retained.operation = 'renew' AND retained.lease_id = NEW.lease_id
        ORDER BY retained.created_at DESC,
                 retained.principal_id, retained.request_id
        OFFSET 99 FOR UPDATE
     );
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.operation = 'release' THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' AND OLD.operation IN ('renew', 'release') THEN RETURN OLD; END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO coordination_principal_usage (principal_id)
    VALUES (NEW.principal_id) ON CONFLICT (principal_id) DO NOTHING;
    WITH expired AS MATERIALIZED (
      SELECT receipt.principal_id, receipt.operation, receipt.request_id
        FROM coordination_operation_receipts receipt
       WHERE receipt.principal_id = NEW.principal_id
         AND receipt.operation = 'acquire'
         AND receipt.retain_until <= clock_timestamp()
       ORDER BY receipt.retain_until, receipt.request_id
       LIMIT 100 FOR UPDATE
    )
    DELETE FROM coordination_operation_receipts receipt USING expired
     WHERE receipt.principal_id = expired.principal_id
       AND receipt.operation = expired.operation
       AND receipt.request_id = expired.request_id;
    IF NEW.outcome = 'acquired' THEN
      UPDATE coordination_principal_usage SET
        acquire_receipt_count = acquire_receipt_count + 1,
        updated_at = clock_timestamp()
       WHERE principal_id = NEW.principal_id
         AND acquire_receipt_count < acquire_receipt_limit
       RETURNING TRUE INTO changed;
    ELSE
      UPDATE coordination_principal_usage SET
        contended_receipt_count = contended_receipt_count + 1,
        updated_at = clock_timestamp()
       WHERE principal_id = NEW.principal_id
         AND contended_receipt_count < contended_receipt_limit
       RETURNING TRUE INTO changed;
    END IF;
    IF changed IS DISTINCT FROM TRUE THEN
      RAISE check_violation USING
        MESSAGE = 'coordination receipt quota exceeded',
        CONSTRAINT = 'coordination_receipt_quota';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.outcome = 'acquired' THEN
    UPDATE coordination_principal_usage SET
      acquire_receipt_count = GREATEST(0, acquire_receipt_count - 1),
      updated_at = clock_timestamp() WHERE principal_id = OLD.principal_id;
  ELSE
    UPDATE coordination_principal_usage SET
      contended_receipt_count = GREATEST(0, contended_receipt_count - 1),
      updated_at = clock_timestamp() WHERE principal_id = OLD.principal_id;
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_receipt_counter() FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_coordination_receipt_reassign_counter()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE changed BOOLEAN;
BEGIN
  IF NEW.principal_id IS NOT DISTINCT FROM OLD.principal_id
      OR NEW.operation <> 'acquire' THEN
    RETURN NEW;
  END IF;
  INSERT INTO coordination_principal_usage (principal_id)
  VALUES (OLD.principal_id), (NEW.principal_id) ON CONFLICT (principal_id) DO NOTHING;
  -- Release takes principal usage before receipt state. Privacy does the same,
  -- and this ordered lock prevents two reassignments from crossing each other.
  PERFORM 1 FROM coordination_principal_usage
   WHERE principal_id IN (OLD.principal_id, NEW.principal_id)
   ORDER BY principal_id FOR UPDATE;
  IF NEW.outcome = 'acquired' THEN
    UPDATE coordination_principal_usage SET
      acquire_receipt_count = GREATEST(0, acquire_receipt_count - 1),
      updated_at = clock_timestamp() WHERE principal_id = OLD.principal_id;
    UPDATE coordination_principal_usage SET
      acquire_receipt_count = acquire_receipt_count + 1,
      updated_at = clock_timestamp()
     WHERE principal_id = NEW.principal_id
       AND acquire_receipt_count < acquire_receipt_limit
     RETURNING TRUE INTO changed;
  ELSE
    UPDATE coordination_principal_usage SET
      contended_receipt_count = GREATEST(0, contended_receipt_count - 1),
      updated_at = clock_timestamp() WHERE principal_id = OLD.principal_id;
    UPDATE coordination_principal_usage SET
      contended_receipt_count = contended_receipt_count + 1,
      updated_at = clock_timestamp()
     WHERE principal_id = NEW.principal_id
       AND contended_receipt_count < contended_receipt_limit
     RETURNING TRUE INTO changed;
  END IF;
  IF changed IS DISTINCT FROM TRUE THEN
    RAISE check_violation USING
      MESSAGE = 'detached coordination receipt quota exceeded',
      CONSTRAINT = 'coordination_receipt_quota';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_receipt_reassign_counter() FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_operator_scrub_coordination_principal(
  authorization_principal_id UUID, target_principal_id UUID,
  owned_scope_id UUID, batch_limit INTEGER DEFAULT 1000
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET statement_timeout = '5s' AS $$
DECLARE detached_id CONSTANT UUID := '00000000-0000-4000-8000-000000000012';
DECLARE receipt_count INTEGER := 0; lease_count INTEGER := 0; audit_count INTEGER := 0;
DECLARE complete BOOLEAN := FALSE; audit_complete BOOLEAN := FALSE;
DECLARE started BOOLEAN := FALSE; cursor_id BIGINT := 0; scanned_to BIGINT;
DECLARE locked_scope UUID; progress_version INTEGER;
DECLARE detached_acquire_available INTEGER := 0;
DECLARE detached_contended_available INTEGER := 0;
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  IF batch_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'coordination privacy batch must be between 1 and 1000';
  END IF;

  -- This row lock is the reactivation fence. It is intentionally acquired
  -- before usage, receipt, resource, and lease state.
  PERFORM 1 FROM principals
   WHERE id = target_principal_id
     AND (disabled_at IS NOT NULL OR offboarded_at IS NOT NULL)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'coordination scrub target must be disabled or offboarded';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM principal_user_scopes mapping
    JOIN scopes scope ON scope.id = mapping.scope_id AND scope.kind = 'user'
     WHERE mapping.principal_id = target_principal_id
       AND mapping.scope_id = owned_scope_id
  ) THEN
    RAISE EXCEPTION 'owned scope does not belong to coordination scrub target';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(target_principal_id::text, 762));
  INSERT INTO coordination_principal_privacy_progress
    (principal_id, detached_principal_id)
  VALUES (target_principal_id, detached_id)
  ON CONFLICT (principal_id) DO NOTHING RETURNING TRUE INTO started;
  SELECT audit_cursor_id, privacy_version INTO cursor_id, progress_version
    FROM coordination_principal_privacy_progress
   WHERE principal_id = target_principal_id FOR UPDATE;
  IF started THEN
    INSERT INTO coordination_operator_events
      (principal_id, scope_id, operation, metadata)
    VALUES (authorization_principal_id, owned_scope_id,
      'coordination_principal_scrub', jsonb_build_object('phase', 'started'));
  END IF;

  -- Use the real (principal_id,id) keyset index. Completion is established
  -- only by an empty bounded page, never by changed < batch_limit.
  WITH candidates AS MATERIALIZED (
    SELECT audit.id FROM audit_log audit
     WHERE audit.principal_id = target_principal_id
       AND audit.id > cursor_id
       AND audit.scope_id IS DISTINCT FROM owned_scope_id
       AND audit.metadata ?| ARRAY[
         'lease_id', 'request_id', 'run_id', 'resource', 'resource_sha256'
       ]
     ORDER BY audit.id LIMIT batch_limit FOR UPDATE
  ), scrubbed AS (
    UPDATE audit_log audit SET metadata = audit.metadata
      - ARRAY['lease_id','request_id','run_id','resource','resource_sha256']::text[]
      FROM candidates WHERE audit.id = candidates.id RETURNING audit.id
  ) SELECT count(*)::int, max(id) INTO audit_count, scanned_to FROM scrubbed;
  IF scanned_to IS NOT NULL THEN
    UPDATE coordination_principal_privacy_progress SET
      audit_cursor_id = scanned_to,
      audit_rows_scrubbed = audit_rows_scrubbed + audit_count,
      completed_at = NULL, updated_at = clock_timestamp()
     WHERE principal_id = target_principal_id;
  ELSE
    audit_complete := TRUE;
  END IF;

  IF audit_complete THEN
    -- Reclaim expired detached receipts automatically and in a bounded page
    -- before moving more history into the detached quota.
    WITH expired AS MATERIALIZED (
      SELECT principal_id, operation, request_id
        FROM coordination_operation_receipts
       WHERE principal_id = detached_id AND retain_until <= clock_timestamp()
       ORDER BY retain_until, operation, request_id
       LIMIT 100 FOR UPDATE
    )
    DELETE FROM coordination_operation_receipts receipt USING expired
     WHERE receipt.principal_id = expired.principal_id
       AND receipt.operation = expired.operation
       AND receipt.request_id = expired.request_id;

    INSERT INTO coordination_principal_usage (principal_id)
    VALUES (target_principal_id), (detached_id) ON CONFLICT (principal_id) DO NOTHING;
    PERFORM 1 FROM coordination_principal_usage
     WHERE principal_id IN (target_principal_id, detached_id)
     ORDER BY principal_id FOR UPDATE;
    SELECT acquire_receipt_limit - acquire_receipt_count,
           contended_receipt_limit - contended_receipt_count
      INTO detached_acquire_available, detached_contended_available
      FROM coordination_principal_usage WHERE principal_id = detached_id;

    FOR locked_scope IN
      SELECT DISTINCT receipt.scope_id
        FROM coordination_operation_receipts receipt
       WHERE receipt.principal_id = target_principal_id
         AND receipt.scope_id <> owned_scope_id
       ORDER BY receipt.scope_id LIMIT batch_limit
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(locked_scope::text, 761));
    END LOOP;
    WITH ranked AS MATERIALIZED (
      SELECT receipt.principal_id, receipt.operation, receipt.request_id,
             receipt.outcome,
             row_number() OVER (
               PARTITION BY receipt.outcome
               ORDER BY receipt.operation, receipt.request_id
             ) AS outcome_ordinal
        FROM coordination_operation_receipts receipt
       WHERE receipt.principal_id = target_principal_id
         AND receipt.scope_id <> owned_scope_id
    ), candidates AS MATERIALIZED (
      SELECT receipt.principal_id, receipt.operation, receipt.request_id
        FROM coordination_operation_receipts receipt
        JOIN ranked ON ranked.principal_id = receipt.principal_id
         AND ranked.operation = receipt.operation
         AND ranked.request_id = receipt.request_id
       WHERE ranked.operation <> 'acquire'
          OR (ranked.outcome = 'acquired'
              AND ranked.outcome_ordinal <= detached_acquire_available)
          OR (ranked.outcome = 'contended'
              AND ranked.outcome_ordinal <= detached_contended_available)
       ORDER BY receipt.operation, receipt.request_id LIMIT batch_limit
       FOR UPDATE OF receipt
    ), scrubbed AS (
      UPDATE coordination_operation_receipts receipt SET
        principal_id = detached_id,
        request_id = gen_random_uuid(),
        run_id = CASE WHEN receipt.run_id IS NULL THEN NULL ELSE gen_random_uuid() END,
        payload_hash = sha256(convert_to(
          gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')),
        server_time = '2000-01-01 00:00:00+00'::timestamptz,
        expires_at = CASE WHEN receipt.expires_at IS NULL THEN NULL
                          ELSE '2000-01-01 00:00:00+00'::timestamptz END,
        retain_until = '2000-01-01 00:00:00+00'::timestamptz,
        created_at = '2000-01-01 00:00:00+00'::timestamptz
      FROM candidates
     WHERE receipt.principal_id = candidates.principal_id
       AND receipt.operation = candidates.operation
       AND receipt.request_id = candidates.request_id
      RETURNING 1
    ) SELECT count(*)::int INTO receipt_count FROM scrubbed;

    IF receipt_count = 0 THEN
      FOR locked_scope IN
        SELECT DISTINCT lease.scope_id FROM coordination_leases lease
         WHERE lease.principal_id = target_principal_id
           AND lease.scope_id <> owned_scope_id
           AND (lease.released_at IS NOT NULL
                OR lease.expires_at <= clock_timestamp())
         ORDER BY lease.scope_id LIMIT batch_limit
      LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(locked_scope::text, 761));
      END LOOP;
      WITH candidates AS MATERIALIZED (
        SELECT lease.lease_id FROM coordination_leases lease
         WHERE lease.principal_id = target_principal_id
           AND lease.scope_id <> owned_scope_id
           AND (lease.released_at IS NOT NULL
                OR lease.expires_at <= clock_timestamp())
         ORDER BY lease.lease_id LIMIT batch_limit FOR UPDATE
      ), scrubbed AS (
        UPDATE coordination_leases lease SET
          principal_id = detached_id, run_id = gen_random_uuid(),
          acquired_at = '2000-01-01 00:00:00+00'::timestamptz,
          expires_at = '2000-01-01 00:00:00+00'::timestamptz,
          released_at = CASE WHEN lease.released_at IS NULL THEN NULL
                             ELSE '2000-01-01 00:00:00+00'::timestamptz END,
          cleanup_eligible_at = CASE WHEN lease.cleanup_eligible_at IS NULL THEN NULL
                                     ELSE '2000-01-01 00:00:00+00'::timestamptz END
        FROM candidates WHERE candidates.lease_id = lease.lease_id RETURNING 1
      ) SELECT count(*)::int INTO lease_count FROM scrubbed;
    END IF;
  END IF;

  SELECT audit_complete
    AND NOT EXISTS (
      SELECT 1 FROM coordination_operation_receipts receipt
       WHERE receipt.principal_id = target_principal_id
         AND receipt.scope_id <> owned_scope_id)
    AND NOT EXISTS (
      SELECT 1 FROM coordination_leases lease
       WHERE lease.principal_id = target_principal_id
         AND lease.scope_id <> owned_scope_id)
    INTO complete;
  UPDATE coordination_principal_privacy_progress SET
    receipts_scrubbed = receipts_scrubbed + receipt_count,
    leases_scrubbed = leases_scrubbed + lease_count,
    privacy_version = CASE WHEN complete THEN 2 ELSE privacy_version END,
    completed_at = CASE WHEN complete THEN COALESCE(completed_at, clock_timestamp())
                        ELSE NULL END,
    updated_at = clock_timestamp()
   WHERE principal_id = target_principal_id;
  INSERT INTO coordination_operator_events
    (principal_id, scope_id, operation, metadata)
  VALUES (authorization_principal_id, owned_scope_id,
    'coordination_principal_scrub', jsonb_build_object(
      'phase', 'batch', 'audit_rows_scrubbed', audit_count,
      'receipts_scrubbed', receipt_count, 'leases_scrubbed', lease_count,
      'privacy_version', 2, 'complete', complete));
  IF complete AND NOT EXISTS (
    SELECT 1 FROM coordination_operator_events
     WHERE scope_id = owned_scope_id
       AND operation = 'coordination_principal_scrub'
       AND metadata->>'phase' = 'completed'
       AND metadata->>'privacy_version' = '2'
  ) THEN
    INSERT INTO coordination_operator_events
      (principal_id, scope_id, operation, metadata)
    VALUES (authorization_principal_id, owned_scope_id,
      'coordination_principal_scrub',
      jsonb_build_object('phase', 'completed', 'privacy_version', 2));
  END IF;
  RETURN jsonb_build_object(
    'audit_rows_scrubbed', audit_count, 'receipts_scrubbed', receipt_count,
    'leases_scrubbed', lease_count, 'privacy_version', 2, 'complete', complete);
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_scrub_coordination_principal(
  UUID, UUID, UUID, INTEGER) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_operator_sweep_coordination_state(
  authorization_principal_id UUID, batch_limit INTEGER DEFAULT 1000
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET statement_timeout = '5s' AS $$
DECLARE receipt_count INTEGER := 0; lease_count INTEGER := 0;
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  IF batch_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'coordination sweep batch must be between 1 and 1000';
  END IF;
  WITH doomed AS MATERIALIZED (
    SELECT principal_id, operation, request_id
      FROM coordination_operation_receipts
     WHERE retain_until <= clock_timestamp()
     ORDER BY retain_until, principal_id, operation, request_id
     LIMIT batch_limit FOR UPDATE SKIP LOCKED
  ), removed AS (
    DELETE FROM coordination_operation_receipts receipt USING doomed
     WHERE receipt.principal_id = doomed.principal_id
       AND receipt.operation = doomed.operation
       AND receipt.request_id = doomed.request_id RETURNING 1
  ) SELECT count(*)::int INTO receipt_count FROM removed;
  WITH doomed AS MATERIALIZED (
    SELECT lease.lease_id FROM coordination_leases lease
     WHERE lease.cleanup_eligible_at <= clock_timestamp() - interval '24 hours'
       AND NOT EXISTS (
         SELECT 1 FROM coordination_operation_receipts receipt
          WHERE receipt.lease_id = lease.lease_id)
     ORDER BY lease.cleanup_eligible_at, lease.lease_id
     LIMIT batch_limit FOR UPDATE OF lease SKIP LOCKED
  ), removed AS (
    DELETE FROM coordination_leases lease USING doomed
     WHERE lease.lease_id = doomed.lease_id RETURNING 1
  ) SELECT count(*)::int INTO lease_count FROM removed;
  INSERT INTO audit_log (principal_id, action, metadata)
  VALUES (authorization_principal_id, 'write', jsonb_build_object(
    'operation', 'coordination_state_swept',
    'receipt_count', receipt_count, 'lease_count', lease_count,
    'batch_limit', batch_limit));
  RETURN jsonb_build_object(
    'receipts_deleted', receipt_count, 'leases_deleted', lease_count);
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_sweep_coordination_state(UUID, INTEGER)
  FROM PUBLIC;

-- Preserve the 0061 versioned entry point while adding the same per-scope
-- advisory protocol used by membership writes.
DO $version$
BEGIN
  IF to_regprocedure(format(
      '%I.continuum_operator_pseudonymize_scope_v2_legacy(uuid,uuid,text)',
      current_schema()
    )) IS NULL THEN
    ALTER FUNCTION continuum_operator_pseudonymize_scope_v2(UUID, UUID, TEXT)
      RENAME TO continuum_operator_pseudonymize_scope_v2_legacy;
  END IF;
END;
$version$;
CREATE OR REPLACE FUNCTION continuum_operator_pseudonymize_scope_v2(
  authorization_principal_id UUID, target_scope_id UUID, pseudonym TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET statement_timeout = '5s' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(target_scope_id::text, 761));
  PERFORM continuum_operator_pseudonymize_scope_v2_legacy(
    authorization_principal_id, target_scope_id, pseudonym);
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_pseudonymize_scope_v2(UUID, UUID, TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION continuum_operator_pseudonymize_scope_v2_legacy(UUID, UUID, TEXT)
  FROM PUBLIC;

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT function.proname,
           pg_get_function_identity_arguments(function.oid) AS arguments
      FROM pg_proc function
     WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
       AND function.proname = ANY(ARRAY[
         'continuum_coordination_privacy_membership_guard',
         'continuum_coordination_receipt_counter',
         'continuum_coordination_receipt_reassign_counter',
         'continuum_operator_scrub_coordination_principal',
         'continuum_operator_sweep_coordination_state',
         'continuum_operator_pseudonymize_scope_v2',
         'continuum_operator_pseudonymize_scope_v2_legacy'
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
