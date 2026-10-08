-- Forward-only bounded privacy and compatibility repair.

ALTER TABLE coordination_leases
  ADD COLUMN IF NOT EXISTS cleanup_eligible_at TIMESTAMPTZ;

CREATE TABLE coordination_migration_progress (
  name           TEXT PRIMARY KEY,
  rows_processed BIGINT NOT NULL DEFAULT 0 CHECK (rows_processed >= 0),
  completed_at   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON TABLE coordination_migration_progress FROM PUBLIC;

CREATE TABLE coordination_scope_privacy_progress (
  scope_id       UUID PRIMARY KEY REFERENCES scopes(id) ON DELETE RESTRICT,
  pseudonym      TEXT NOT NULL,
  phase          TEXT NOT NULL DEFAULT 'receipts'
    CHECK (phase IN ('receipts', 'leases', 'resources', 'complete')),
  rows_processed BIGINT NOT NULL DEFAULT 0 CHECK (rows_processed >= 0),
  completed_at   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON TABLE coordination_scope_privacy_progress FROM PUBLIC;

CREATE TABLE coordination_principal_privacy_progress (
  principal_id   UUID PRIMARY KEY REFERENCES principals(id) ON DELETE RESTRICT,
  detached_principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  last_lease_id  UUID,
  last_request_id UUID,
  leases_scrubbed BIGINT NOT NULL DEFAULT 0 CHECK (leases_scrubbed >= 0),
  receipts_scrubbed BIGINT NOT NULL DEFAULT 0 CHECK (receipts_scrubbed >= 0),
  completed_at   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON TABLE coordination_principal_privacy_progress FROM PUBLIC;

CREATE TABLE coordination_operator_events (
  id             BIGSERIAL PRIMARY KEY,
  at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  principal_id   UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  scope_id       UUID NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,
  operation      TEXT NOT NULL,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb
);
REVOKE ALL ON TABLE coordination_operator_events FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE coordination_operator_events FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_preserve_coordination_operator_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RAISE EXCEPTION 'coordination operator evidence is immutable';
END;
$$;
REVOKE ALL ON FUNCTION continuum_preserve_coordination_operator_event() FROM PUBLIC;
CREATE TRIGGER preserve_coordination_operator_event
BEFORE UPDATE OR DELETE ON coordination_operator_events
FOR EACH ROW EXECUTE FUNCTION continuum_preserve_coordination_operator_event();
CREATE TRIGGER preserve_coordination_operator_event_truncate
BEFORE TRUNCATE ON coordination_operator_events
FOR EACH STATEMENT EXECUTE FUNCTION continuum_preserve_coordination_operator_event();

-- One installation-wide detached identity preserves foreign keys without
-- retaining the offboarded principal beside shared-scope resource and run data.
INSERT INTO principals (id, external_id, kind, display_name)
VALUES ('00000000-0000-4000-8000-000000000012', gen_random_uuid()::text, 'service',
        'system:detached-coordination-history')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION continuum_coordination_compatibility_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.operation = 'acquire' AND NEW.outcome = 'contended' THEN
    NEW.retain_until := LEAST(
      NEW.retain_until, NEW.server_time + interval '90 seconds');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_compatibility_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS coordination_receipt_compatibility_guard
  ON coordination_operation_receipts;
CREATE TRIGGER coordination_receipt_compatibility_guard
BEFORE INSERT OR UPDATE OF operation, outcome, server_time, retain_until
ON coordination_operation_receipts
FOR EACH ROW EXECUTE FUNCTION continuum_coordination_compatibility_guard();

ALTER TABLE coordination_operation_receipts
  DROP CONSTRAINT IF EXISTS coordination_contended_receipt_retention,
  ADD CONSTRAINT coordination_contended_receipt_retention
  CHECK (
    operation <> 'acquire' OR outcome <> 'contended'
    OR retain_until <= server_time + interval '90 seconds'
  ) NOT VALID;

CREATE OR REPLACE FUNCTION continuum_coordination_fencing_nondecreasing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE scope_floor BIGINT;
BEGIN
  SELECT COALESCE(fencing_floor, 0) INTO scope_floor
    FROM coordination_scope_fencing_floors WHERE scope_id = NEW.scope_id;
  scope_floor := COALESCE(scope_floor, 0);
  IF TG_OP = 'INSERT' THEN
    NEW.fencing_token := GREATEST(NEW.fencing_token, scope_floor);
  ELSIF NEW.fencing_token < OLD.fencing_token OR NEW.fencing_token < scope_floor THEN
    RAISE check_violation USING
      MESSAGE = 'coordination fencing token must not decrease',
      CONSTRAINT = 'coordination_fencing_token_nondecreasing';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_fencing_nondecreasing() FROM PUBLIC;
DROP TRIGGER IF EXISTS coordination_fencing_nondecreasing ON coordination_resources;
CREATE TRIGGER coordination_fencing_nondecreasing
BEFORE INSERT OR UPDATE OF fencing_token ON coordination_resources
FOR EACH ROW EXECUTE FUNCTION continuum_coordination_fencing_nondecreasing();

CREATE OR REPLACE FUNCTION continuum_coordination_mark_displaced_lease()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF OLD.current_lease_id IS NOT NULL
      AND OLD.current_lease_id IS DISTINCT FROM NEW.current_lease_id THEN
    UPDATE coordination_leases
       SET cleanup_eligible_at = COALESCE(
         cleanup_eligible_at, released_at, expires_at, clock_timestamp())
     WHERE lease_id = OLD.current_lease_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_mark_displaced_lease() FROM PUBLIC;
DROP TRIGGER IF EXISTS coordination_mark_displaced_lease ON coordination_resources;
CREATE TRIGGER coordination_mark_displaced_lease
AFTER UPDATE OF current_lease_id ON coordination_resources
FOR EACH ROW EXECUTE FUNCTION continuum_coordination_mark_displaced_lease();

CREATE OR REPLACE FUNCTION continuum_coordination_privacy_membership_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.active THEN
    PERFORM 1 FROM scopes WHERE id = NEW.scope_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM coordination_scope_privacy_progress
                WHERE scope_id = NEW.scope_id) THEN
      IF EXISTS (
        SELECT 1 FROM principal_user_scopes mapping
        JOIN principals principal ON principal.id = mapping.principal_id
         WHERE mapping.scope_id = NEW.scope_id
           AND mapping.principal_id = NEW.principal_id
           AND principal.disabled_at IS NULL
           AND principal.reactivated_at IS NOT NULL
      ) THEN
        DELETE FROM coordination_scope_privacy_progress
         WHERE scope_id = NEW.scope_id;
      ELSE
        RAISE EXCEPTION
          'offboarded owned scope or coordination-private scope cannot gain active memberships';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_privacy_membership_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS coordination_privacy_membership_guard ON scope_memberships;
CREATE TRIGGER coordination_privacy_membership_guard
BEFORE INSERT OR UPDATE OF active, scope_id ON scope_memberships
FOR EACH ROW EXECUTE FUNCTION continuum_coordination_privacy_membership_guard();

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
  IF TG_OP = 'DELETE' AND OLD.operation = 'renew' THEN RETURN OLD; END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO coordination_principal_usage (principal_id)
    VALUES (NEW.principal_id) ON CONFLICT (principal_id) DO NOTHING;
    IF NEW.operation = 'acquire' AND NEW.outcome = 'acquired' THEN
      UPDATE coordination_principal_usage
         SET acquire_receipt_count = acquire_receipt_count + 1,
             updated_at = clock_timestamp()
       WHERE principal_id = NEW.principal_id AND acquire_receipt_count < 10000
       RETURNING TRUE INTO changed;
    ELSIF NEW.operation = 'acquire' AND NEW.outcome = 'contended' THEN
      UPDATE coordination_principal_usage
         SET contended_receipt_count = contended_receipt_count + 1,
             updated_at = clock_timestamp()
       WHERE principal_id = NEW.principal_id AND contended_receipt_count < 1000
       RETURNING TRUE INTO changed;
    ELSE
      DELETE FROM coordination_operation_receipts receipt
       WHERE (receipt.principal_id, receipt.operation, receipt.request_id) IN (
         SELECT retained.principal_id, retained.operation, retained.request_id
           FROM coordination_operation_receipts retained
          WHERE retained.principal_id = NEW.principal_id
            AND retained.operation = 'release'
          ORDER BY retained.created_at, retained.request_id LIMIT 1
          FOR UPDATE
       ) AND EXISTS (
         SELECT 1 FROM coordination_principal_usage usage
          WHERE usage.principal_id = NEW.principal_id
            AND usage.mutation_receipt_count >= 10000
       );
      UPDATE coordination_principal_usage
         SET mutation_receipt_count = LEAST(mutation_receipt_count, 9999),
             updated_at = clock_timestamp()
       WHERE principal_id = NEW.principal_id
         AND mutation_receipt_count >= 10000;
      UPDATE coordination_principal_usage
         SET mutation_receipt_count = mutation_receipt_count + 1,
             updated_at = clock_timestamp()
       WHERE principal_id = NEW.principal_id AND mutation_receipt_count < 10000
       RETURNING TRUE INTO changed;
    END IF;
    IF changed IS DISTINCT FROM TRUE THEN
      RAISE check_violation USING
        MESSAGE = 'coordination receipt quota exceeded',
        CONSTRAINT = 'coordination_receipt_quota';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.operation = 'acquire' AND OLD.outcome = 'acquired' THEN
    UPDATE coordination_principal_usage
       SET acquire_receipt_count = GREATEST(0, acquire_receipt_count - 1),
           updated_at = clock_timestamp()
     WHERE principal_id = OLD.principal_id;
  ELSIF OLD.operation = 'acquire' AND OLD.outcome = 'contended' THEN
    UPDATE coordination_principal_usage
       SET contended_receipt_count = GREATEST(0, contended_receipt_count - 1),
           updated_at = clock_timestamp()
     WHERE principal_id = OLD.principal_id;
  ELSE
    UPDATE coordination_principal_usage
       SET mutation_receipt_count = GREATEST(0, mutation_receipt_count - 1),
           updated_at = clock_timestamp()
     WHERE principal_id = OLD.principal_id;
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_receipt_counter() FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_backfill_coordination_cleanup(batch_limit INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout = '5s' AS $$
DECLARE changed INTEGER;
BEGIN
  IF batch_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'coordination backfill batch must be between 1 and 1000';
  END IF;
  WITH candidates AS (
    SELECT lease.lease_id FROM coordination_leases lease
     WHERE lease.cleanup_eligible_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM coordination_resources resource
          WHERE resource.current_lease_id = lease.lease_id)
     ORDER BY lease.lease_id LIMIT batch_limit FOR UPDATE SKIP LOCKED
  ), updated AS (
    UPDATE coordination_leases lease
       SET cleanup_eligible_at = COALESCE(
         lease.released_at, lease.expires_at, clock_timestamp())
      FROM candidates WHERE candidates.lease_id = lease.lease_id RETURNING 1
  ) SELECT count(*)::int INTO changed FROM updated;
  INSERT INTO coordination_migration_progress (name, rows_processed, completed_at)
  VALUES ('issue7-cleanup-eligibility', changed,
          CASE WHEN changed < batch_limit THEN clock_timestamp() END)
  ON CONFLICT (name) DO UPDATE SET
    rows_processed = coordination_migration_progress.rows_processed + changed,
    completed_at = CASE WHEN changed < batch_limit THEN clock_timestamp()
                        ELSE NULL END,
    updated_at = clock_timestamp();
  RETURN changed < batch_limit;
END;
$$;
REVOKE ALL ON FUNCTION continuum_backfill_coordination_cleanup(INTEGER) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_operator_scrub_coordination_principal(
  authorization_principal_id UUID,
  target_principal_id UUID,
  owned_scope_id UUID,
  batch_limit INTEGER DEFAULT 1000
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout = '5s' AS $$
DECLARE detached_id UUID := '00000000-0000-4000-8000-000000000012';
DECLARE receipt_count INTEGER := 0; lease_count INTEGER := 0; complete BOOLEAN;
DECLARE last_receipt UUID; last_lease UUID;
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  IF batch_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'coordination privacy batch must be between 1 and 1000';
  END IF;
  INSERT INTO coordination_principal_privacy_progress
    (principal_id, detached_principal_id)
  VALUES (target_principal_id, detached_id) ON CONFLICT (principal_id) DO NOTHING;

  WITH candidates AS (
    SELECT receipt.principal_id, receipt.operation, receipt.request_id
      FROM coordination_operation_receipts receipt
      JOIN scopes scope ON scope.id = receipt.scope_id
     WHERE receipt.principal_id = target_principal_id
       AND receipt.scope_id <> owned_scope_id
       AND scope.kind IN ('team', 'project', 'org')
     ORDER BY receipt.operation, receipt.request_id
     LIMIT batch_limit FOR UPDATE OF receipt SKIP LOCKED
  ), scrubbed AS (
    UPDATE coordination_operation_receipts receipt
       SET principal_id = detached_id,
           run_id = CASE WHEN receipt.run_id IS NULL THEN NULL ELSE gen_random_uuid() END,
           payload_hash = sha256(convert_to(
             gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8'))
      FROM candidates
     WHERE receipt.principal_id = candidates.principal_id
       AND receipt.operation = candidates.operation
       AND receipt.request_id = candidates.request_id
    RETURNING receipt.request_id
  ) SELECT count(*)::int, max(request_id::text)::uuid INTO receipt_count, last_receipt
      FROM scrubbed;

  IF receipt_count = 0 THEN
    WITH candidates AS (
      SELECT lease.lease_id FROM coordination_leases lease
      JOIN scopes scope ON scope.id = lease.scope_id
       WHERE lease.principal_id = target_principal_id
         AND lease.scope_id <> owned_scope_id
         AND scope.kind IN ('team', 'project', 'org')
       ORDER BY lease.lease_id LIMIT batch_limit
       FOR UPDATE OF lease SKIP LOCKED
    ), scrubbed AS (
      UPDATE coordination_leases lease
         SET principal_id = detached_id, run_id = gen_random_uuid()
        FROM candidates WHERE candidates.lease_id = lease.lease_id
      RETURNING lease.lease_id, lease.scope_id
    ), floors AS (
      INSERT INTO coordination_scope_fencing_floors (scope_id, fencing_floor)
      SELECT scrubbed.scope_id, max(resource.fencing_token)
        FROM scrubbed JOIN coordination_resources resource
          ON resource.scope_id = scrubbed.scope_id
       GROUP BY scrubbed.scope_id
      ON CONFLICT (scope_id) DO UPDATE SET
        fencing_floor = GREATEST(
          coordination_scope_fencing_floors.fencing_floor,
          EXCLUDED.fencing_floor), updated_at = clock_timestamp()
      RETURNING 1
    ) SELECT count(*)::int, max(lease_id::text)::uuid INTO lease_count, last_lease
        FROM scrubbed;
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM coordination_operation_receipts receipt
     WHERE receipt.principal_id = target_principal_id
       AND receipt.scope_id <> owned_scope_id
  ) AND NOT EXISTS (
    SELECT 1 FROM coordination_leases lease
     WHERE lease.principal_id = target_principal_id
       AND lease.scope_id <> owned_scope_id
  ) INTO complete;
  UPDATE coordination_principal_privacy_progress
     SET receipts_scrubbed = receipts_scrubbed + receipt_count,
         leases_scrubbed = leases_scrubbed + lease_count,
         last_request_id = COALESCE(last_receipt, last_request_id),
         last_lease_id = COALESCE(last_lease, last_lease_id),
         completed_at = CASE WHEN complete THEN COALESCE(completed_at, clock_timestamp()) END,
         updated_at = clock_timestamp()
   WHERE principal_id = target_principal_id;
  RETURN jsonb_build_object(
    'receipts_scrubbed', receipt_count, 'leases_scrubbed', lease_count,
    'complete', complete);
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_scrub_coordination_principal(
  UUID, UUID, UUID, INTEGER) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_operator_sweep_coordination_state(
  authorization_principal_id UUID, batch_limit INTEGER DEFAULT 1000
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout = '5s' AS $$
DECLARE receipt_count INTEGER; lease_count INTEGER;
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  IF batch_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'coordination sweep batch must be between 1 and 1000';
  END IF;
  WITH doomed AS (
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
  WITH doomed AS (
    SELECT lease_id FROM coordination_leases
     WHERE cleanup_eligible_at <= clock_timestamp() - interval '24 hours'
       AND NOT EXISTS (SELECT 1 FROM coordination_operation_receipts receipt
                        WHERE receipt.lease_id = coordination_leases.lease_id)
     ORDER BY cleanup_eligible_at, lease_id
     LIMIT batch_limit FOR UPDATE SKIP LOCKED
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

CREATE OR REPLACE FUNCTION continuum_operator_pseudonymize_scope(
  authorization_principal_id UUID,
  target_scope_id UUID,
  pseudonym TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout = '5s' AS $$
DECLARE batch_limit CONSTANT INTEGER := 1000; phase_name TEXT;
DECLARE changed INTEGER := 0; scope_floor BIGINT; started BOOLEAN := FALSE;
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  IF pseudonym IS NULL OR btrim(pseudonym) = '' THEN
    RAISE EXCEPTION 'scope pseudonym must not be empty';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM scopes WHERE id = target_scope_id AND kind = 'user'
      AND id <> continuum_org_scope_id() FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'only an existing non-organization user scope may be pseudonymized';
  END IF;
  IF EXISTS (SELECT 1 FROM scope_memberships
              WHERE scope_id = target_scope_id AND active) THEN
    RAISE EXCEPTION 'scope has active memberships';
  END IF;
  IF EXISTS (
    SELECT 1 FROM coordination_resources resource
    JOIN coordination_leases lease ON lease.lease_id = resource.current_lease_id
     WHERE resource.scope_id = target_scope_id
       AND lease.released_at IS NULL AND lease.expires_at > clock_timestamp()
  ) THEN RAISE EXCEPTION 'scope has live coordination leases'; END IF;

  INSERT INTO coordination_scope_privacy_progress (scope_id, pseudonym)
  VALUES (target_scope_id, pseudonym)
  ON CONFLICT (scope_id) DO UPDATE SET
    pseudonym = EXCLUDED.pseudonym, updated_at = clock_timestamp()
  RETURNING (xmax = 0) INTO started;
  IF started THEN
    INSERT INTO coordination_operator_events
      (principal_id, scope_id, operation, metadata)
    VALUES (authorization_principal_id, target_scope_id,
      'coordination_scope_pseudonymization', jsonb_build_object('phase', 'started'));
  END IF;
  SELECT phase INTO phase_name FROM coordination_scope_privacy_progress
   WHERE scope_id = target_scope_id FOR UPDATE;

  LOOP
  changed := 0;
  IF phase_name = 'receipts' THEN
    WITH candidates AS (
      SELECT principal_id, operation, request_id
        FROM coordination_operation_receipts
       WHERE scope_id = target_scope_id
       ORDER BY principal_id, operation, request_id
       LIMIT batch_limit FOR UPDATE SKIP LOCKED
    ), removed AS (
      DELETE FROM coordination_operation_receipts receipt USING candidates
       WHERE receipt.principal_id = candidates.principal_id
         AND receipt.operation = candidates.operation
         AND receipt.request_id = candidates.request_id RETURNING 1
    ) SELECT count(*)::int INTO changed FROM removed;
    IF changed < batch_limit THEN phase_name := 'leases'; END IF;
  ELSIF phase_name = 'leases' THEN
    UPDATE coordination_resources resource SET current_lease_id = NULL
     WHERE resource.scope_id = target_scope_id
       AND resource.current_lease_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM coordination_leases lease
         WHERE lease.lease_id = resource.current_lease_id
           AND (lease.released_at IS NOT NULL OR lease.expires_at <= clock_timestamp()));
    WITH candidates AS (
      SELECT lease_id FROM coordination_leases
       WHERE scope_id = target_scope_id
       ORDER BY lease_id LIMIT batch_limit FOR UPDATE SKIP LOCKED
    ), removed AS (
      DELETE FROM coordination_leases lease USING candidates
       WHERE lease.lease_id = candidates.lease_id RETURNING 1
    ) SELECT count(*)::int INTO changed FROM removed;
    IF changed < batch_limit THEN phase_name := 'resources'; END IF;
  ELSIF phase_name = 'resources' THEN
    WITH candidates AS (
      SELECT scope_id, resource, fencing_token FROM coordination_resources
       WHERE scope_id = target_scope_id
       ORDER BY resource COLLATE "C" LIMIT batch_limit FOR UPDATE SKIP LOCKED
    ) SELECT max(fencing_token) INTO scope_floor FROM candidates;
    IF scope_floor IS NOT NULL THEN
      INSERT INTO coordination_scope_fencing_floors (scope_id, fencing_floor)
      VALUES (target_scope_id, scope_floor)
      ON CONFLICT (scope_id) DO UPDATE SET
        fencing_floor = GREATEST(
          coordination_scope_fencing_floors.fencing_floor,
          EXCLUDED.fencing_floor), updated_at = clock_timestamp();
    END IF;
    WITH candidates AS (
      SELECT scope_id, resource FROM coordination_resources
       WHERE scope_id = target_scope_id
       ORDER BY resource COLLATE "C" LIMIT batch_limit FOR UPDATE SKIP LOCKED
    ), removed AS (
      DELETE FROM coordination_resources resource USING candidates
       WHERE resource.scope_id = candidates.scope_id
         AND resource.resource = candidates.resource RETURNING 1
    ) SELECT count(*)::int INTO changed FROM removed;
    IF changed < batch_limit THEN phase_name := 'complete'; END IF;
  END IF;
  EXIT WHEN changed >= batch_limit OR phase_name = 'complete';
  END LOOP;

  UPDATE scopes SET name = pseudonym WHERE id = target_scope_id;
  UPDATE coordination_scope_privacy_progress
     SET phase = phase_name, rows_processed = rows_processed + changed,
         completed_at = CASE WHEN phase_name = 'complete'
                             THEN COALESCE(completed_at, clock_timestamp()) END,
         updated_at = clock_timestamp()
   WHERE scope_id = target_scope_id;
  IF phase_name = 'complete' AND NOT EXISTS (
    SELECT 1 FROM coordination_operator_events
     WHERE scope_id = target_scope_id
       AND operation = 'coordination_scope_pseudonymization'
       AND metadata->>'phase' = 'completed'
  ) THEN
    INSERT INTO coordination_operator_events
      (principal_id, scope_id, operation, metadata)
    VALUES (authorization_principal_id, target_scope_id,
      'coordination_scope_pseudonymization', jsonb_build_object('phase', 'completed'));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_pseudonymize_scope(UUID, UUID, TEXT)
  FROM PUBLIC;

DO $allowlist$
DECLARE definition TEXT; revised TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_assert_application_role_allowlist(name,boolean)'::regprocedure)
    INTO definition;
  revised := replace(definition,
    '        (''continuum_operator_sweep_coordination_state(uuid,integer)''),',
    '        (''continuum_operator_sweep_coordination_state(uuid,integer)''),' || chr(10) ||
    '        (''continuum_operator_scrub_coordination_principal(uuid,uuid,uuid,integer)''),');
  IF revised = definition THEN
    RAISE EXCEPTION 'unable to update coordination privacy operator allow-list';
  END IF;
  EXECUTE revised;
END;
$allowlist$;

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT function.proname,
           pg_get_function_identity_arguments(function.oid) AS arguments
      FROM pg_proc function
     WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
       AND function.proname = ANY(ARRAY[
         'continuum_preserve_coordination_operator_event',
         'continuum_coordination_compatibility_guard',
         'continuum_coordination_fencing_nondecreasing',
         'continuum_coordination_mark_displaced_lease',
         'continuum_coordination_privacy_membership_guard',
         'continuum_coordination_receipt_counter',
         'continuum_backfill_coordination_cleanup',
         'continuum_operator_scrub_coordination_principal',
         'continuum_operator_sweep_coordination_state',
         'continuum_operator_pseudonymize_scope'
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
