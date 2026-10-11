-- Forward-only final remediation for coordination leases.

CREATE INDEX IF NOT EXISTS coordination_receipts_resource_idx
  ON coordination_operation_receipts
    (scope_id, resource, retain_until, principal_id, operation, request_id);

CREATE TABLE coordination_scope_fencing_floors (
  scope_id      UUID PRIMARY KEY REFERENCES scopes(id) ON DELETE RESTRICT,
  fencing_floor BIGINT NOT NULL CHECK (fencing_floor >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON TABLE coordination_scope_fencing_floors FROM PUBLIC;

INSERT INTO coordination_scope_fencing_floors (scope_id, fencing_floor)
SELECT scope_id, max(fencing_floor) FROM coordination_fencing_floors GROUP BY scope_id
ON CONFLICT (scope_id) DO UPDATE SET
  fencing_floor = GREATEST(
    coordination_scope_fencing_floors.fencing_floor, EXCLUDED.fencing_floor),
  updated_at = clock_timestamp();
DROP TABLE coordination_fencing_floors;

-- Renew receipts are short-lived retry evidence and do not consume the release
-- safety budget. Recalculate published-review counters before installing the
-- owner-owned maintenance triggers.
UPDATE coordination_principal_usage usage
   SET acquire_receipt_count = counts.acquire_count,
       mutation_receipt_count = counts.release_count,
       updated_at = clock_timestamp()
  FROM (
    SELECT principal_id,
           count(*) FILTER (WHERE operation = 'acquire')::int AS acquire_count,
           count(*) FILTER (WHERE operation = 'release')::int AS release_count
      FROM coordination_operation_receipts GROUP BY principal_id
  ) counts
 WHERE counts.principal_id = usage.principal_id;

CREATE OR REPLACE FUNCTION continuum_coordination_receipt_counter()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE changed BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.operation = 'renew' THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' AND OLD.operation = 'renew' THEN RETURN OLD; END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO coordination_principal_usage (principal_id)
    VALUES (NEW.principal_id) ON CONFLICT (principal_id) DO NOTHING;
    IF NEW.operation = 'acquire' THEN
      UPDATE coordination_principal_usage
         SET acquire_receipt_count = acquire_receipt_count + 1,
             updated_at = clock_timestamp()
       WHERE principal_id = NEW.principal_id AND acquire_receipt_count < 10000
       RETURNING TRUE INTO changed;
    ELSE
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
  IF OLD.operation = 'acquire' THEN
    UPDATE coordination_principal_usage
       SET acquire_receipt_count = GREATEST(0, acquire_receipt_count - 1),
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
DROP TRIGGER IF EXISTS coordination_receipt_counter_insert
  ON coordination_operation_receipts;
DROP TRIGGER IF EXISTS coordination_receipt_counter_delete
  ON coordination_operation_receipts;
CREATE TRIGGER coordination_receipt_counter_insert
BEFORE INSERT ON coordination_operation_receipts
FOR EACH ROW EXECUTE FUNCTION continuum_coordination_receipt_counter();
CREATE TRIGGER coordination_receipt_counter_delete
AFTER DELETE ON coordination_operation_receipts
FOR EACH ROW EXECUTE FUNCTION continuum_coordination_receipt_counter();

CREATE OR REPLACE FUNCTION continuum_coordination_resource_counter()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE changed BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO coordination_scope_usage (scope_id)
    VALUES (NEW.scope_id) ON CONFLICT (scope_id) DO NOTHING;
    UPDATE coordination_scope_usage
       SET resource_count = resource_count + 1, updated_at = clock_timestamp()
     WHERE scope_id = NEW.scope_id AND resource_count < resource_limit
     RETURNING TRUE INTO changed;
    IF changed IS DISTINCT FROM TRUE THEN
      RAISE check_violation USING
        MESSAGE = 'coordination resource quota exceeded',
        CONSTRAINT = 'coordination_scope_resource_quota';
    END IF;
    RETURN NEW;
  END IF;
  UPDATE coordination_scope_usage
     SET resource_count = GREATEST(0, resource_count - 1),
         updated_at = clock_timestamp()
   WHERE scope_id = OLD.scope_id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_resource_counter() FROM PUBLIC;
DROP TRIGGER IF EXISTS coordination_resource_counter_insert ON coordination_resources;
DROP TRIGGER IF EXISTS coordination_resource_counter_delete ON coordination_resources;
CREATE TRIGGER coordination_resource_counter_insert
BEFORE INSERT ON coordination_resources
FOR EACH ROW EXECUTE FUNCTION continuum_coordination_resource_counter();
CREATE TRIGGER coordination_resource_counter_delete
AFTER DELETE ON coordination_resources
FOR EACH ROW EXECUTE FUNCTION continuum_coordination_resource_counter();

CREATE OR REPLACE FUNCTION continuum_coordination_reserve_resource_creation(
  target_principal_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout = '5s' AS $$
DECLARE changed BOOLEAN;
BEGIN
  INSERT INTO coordination_principal_usage (principal_id)
  VALUES (target_principal_id) ON CONFLICT (principal_id) DO NOTHING;
  UPDATE coordination_principal_usage
     SET resource_window_started_at = CASE
           WHEN resource_window_started_at <= clock_timestamp() - interval '1 hour'
           THEN clock_timestamp() ELSE resource_window_started_at END,
         resource_window_count = CASE
           WHEN resource_window_started_at <= clock_timestamp() - interval '1 hour'
           THEN 1 ELSE resource_window_count + 1 END,
         updated_at = clock_timestamp()
   WHERE principal_id = target_principal_id
     AND (resource_window_started_at <= clock_timestamp() - interval '1 hour'
          OR resource_window_count < 100)
   RETURNING TRUE INTO changed;
  IF changed IS DISTINCT FROM TRUE THEN
    RAISE check_violation USING
      MESSAGE = 'coordination resource creation rate exceeded',
      CONSTRAINT = 'coordination_resource_rate_quota';
  END IF;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_reserve_resource_creation(UUID)
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_coordination_scope_fencing_floor(
  target_scope_id UUID
) RETURNS BIGINT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE((SELECT fencing_floor
    FROM coordination_scope_fencing_floors WHERE scope_id = target_scope_id), 0)
$$;
REVOKE ALL ON FUNCTION continuum_coordination_scope_fencing_floor(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_operator_reclaim_coordination_resource(
  authorization_principal_id UUID,
  target_scope_id UUID,
  target_resource TEXT
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout = '5s' AS $$
DECLARE state RECORD; expired_count INTEGER; history_count INTEGER;
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  SELECT fencing_token, current_lease_id INTO state
    FROM coordination_resources
   WHERE scope_id = target_scope_id AND resource = target_resource
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'coordination resource is not reclaimable'; END IF;
  IF EXISTS (
    SELECT 1 FROM coordination_leases lease
     WHERE lease.lease_id = state.current_lease_id
       AND lease.released_at IS NULL AND lease.expires_at > clock_timestamp()
  ) THEN RAISE EXCEPTION 'coordination resource has a live lease'; END IF;
  SELECT count(*)::int INTO expired_count FROM (
    SELECT 1 FROM coordination_operation_receipts
     WHERE scope_id = target_scope_id AND resource = target_resource
       AND retain_until <= clock_timestamp()
     ORDER BY retain_until, principal_id, operation, request_id LIMIT 1001
  ) bounded;
  IF expired_count > 1000 THEN
    RAISE EXCEPTION 'run bounded coordination sweep before reclaim';
  END IF;
  DELETE FROM coordination_operation_receipts
   WHERE scope_id = target_scope_id AND resource = target_resource
     AND retain_until <= clock_timestamp();
  IF EXISTS (
    SELECT 1 FROM coordination_operation_receipts
     WHERE scope_id = target_scope_id AND resource = target_resource
  ) THEN RAISE EXCEPTION 'coordination resource has retained receipts'; END IF;
  SELECT count(*)::int INTO history_count FROM (
    SELECT 1 FROM coordination_leases
     WHERE scope_id = target_scope_id AND resource = target_resource LIMIT 1001
  ) bounded;
  IF history_count > 1000 THEN
    RAISE EXCEPTION 'run bounded coordination sweep before reclaim';
  END IF;
  UPDATE coordination_resources SET current_lease_id = NULL
   WHERE scope_id = target_scope_id AND resource = target_resource;
  INSERT INTO coordination_scope_fencing_floors (scope_id, fencing_floor)
  VALUES (target_scope_id, state.fencing_token)
  ON CONFLICT (scope_id) DO UPDATE SET
    fencing_floor = GREATEST(
      coordination_scope_fencing_floors.fencing_floor, EXCLUDED.fencing_floor),
    updated_at = clock_timestamp();
  DELETE FROM coordination_leases
   WHERE scope_id = target_scope_id AND resource = target_resource;
  DELETE FROM coordination_resources
   WHERE scope_id = target_scope_id AND resource = target_resource;
  INSERT INTO audit_log (principal_id, action, scope_id, metadata)
  VALUES (authorization_principal_id, 'write', target_scope_id, jsonb_build_object(
    'operation', 'coordination_resource_reclaimed',
    'fencing_floor', state.fencing_token,
    'expired_receipts_deleted', expired_count,
    'lease_history_deleted', history_count));
  RETURN state.fencing_token;
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_reclaim_coordination_resource(
  UUID, UUID, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_operator_set_coordination_scope_quota(
  authorization_principal_id UUID,
  target_scope_id UUID,
  new_resource_limit INTEGER
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout = '5s' AS $$
DECLARE previous_limit INTEGER;
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  IF new_resource_limit NOT BETWEEN 1 AND 1000000 THEN
    RAISE EXCEPTION 'coordination resource limit is outside the supported range';
  END IF;
  SELECT resource_limit INTO previous_limit FROM coordination_scope_usage
   WHERE scope_id = target_scope_id FOR UPDATE;
  INSERT INTO coordination_scope_usage (scope_id, resource_limit)
  VALUES (target_scope_id, new_resource_limit)
  ON CONFLICT (scope_id) DO UPDATE SET
    resource_limit = EXCLUDED.resource_limit,
    updated_at = clock_timestamp();
  INSERT INTO audit_log (principal_id, action, scope_id, metadata)
  VALUES (authorization_principal_id, 'write', target_scope_id, jsonb_build_object(
    'operation', 'coordination_scope_quota_changed',
    'previous_limit', previous_limit,
    'new_limit', new_resource_limit));
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_set_coordination_scope_quota(
  UUID, UUID, INTEGER) FROM PUBLIC;

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
    SELECT lease.lease_id FROM coordination_leases lease
     WHERE (lease.released_at IS NOT NULL OR lease.expires_at <= clock_timestamp())
       AND NOT EXISTS (SELECT 1 FROM coordination_resources resource
         WHERE resource.current_lease_id = lease.lease_id)
       AND NOT EXISTS (SELECT 1 FROM coordination_operation_receipts receipt
         WHERE receipt.lease_id = lease.lease_id)
     ORDER BY COALESCE(lease.released_at, lease.expires_at), lease.lease_id
     LIMIT batch_limit FOR UPDATE SKIP LOCKED
  ), removed AS (
    DELETE FROM coordination_leases lease USING doomed
     WHERE lease.lease_id = doomed.lease_id RETURNING 1
  ) SELECT count(*)::int INTO lease_count FROM removed;
  INSERT INTO audit_log (principal_id, action, metadata)
  VALUES (authorization_principal_id, 'write', jsonb_build_object(
    'operation', 'coordination_state_swept',
    'receipt_count', receipt_count,
    'lease_count', lease_count,
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
DECLARE scope_floor BIGINT;
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  IF pseudonym IS NULL OR btrim(pseudonym) = '' THEN
    RAISE EXCEPTION 'scope pseudonym must not be empty';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM scopes WHERE id = target_scope_id AND kind = 'user'
      AND id <> continuum_org_scope_id() FOR NO KEY UPDATE
  ) THEN
    RAISE EXCEPTION 'only an existing non-organization user scope may be pseudonymized';
  END IF;
  IF EXISTS (
    SELECT 1 FROM coordination_resources resource
    JOIN coordination_leases lease ON lease.lease_id = resource.current_lease_id
     WHERE resource.scope_id = target_scope_id
       AND lease.released_at IS NULL AND lease.expires_at > clock_timestamp()
  ) THEN RAISE EXCEPTION 'scope has live coordination leases'; END IF;
  SELECT max(fencing_token) INTO scope_floor FROM coordination_resources
   WHERE scope_id = target_scope_id;
  IF scope_floor IS NOT NULL THEN
    INSERT INTO coordination_scope_fencing_floors (scope_id, fencing_floor)
    VALUES (target_scope_id, scope_floor)
    ON CONFLICT (scope_id) DO UPDATE SET
      fencing_floor = GREATEST(
        coordination_scope_fencing_floors.fencing_floor, EXCLUDED.fencing_floor),
      updated_at = clock_timestamp();
  END IF;
  UPDATE coordination_resources
     SET resource = 'offboarded:' || gen_random_uuid()::text,
         updated_at = clock_timestamp()
   WHERE scope_id = target_scope_id;
  UPDATE scopes SET name = pseudonym WHERE id = target_scope_id;
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_pseudonymize_scope(UUID, UUID, TEXT)
  FROM PUBLIC;

-- Upgrade review-era exact allow-lists without rewriting their ledgered bytes.
DO $allowlist$
DECLARE definition TEXT; revised TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_assert_application_role_allowlist(name,boolean)'::regprocedure)
    INTO definition;
  revised := replace(definition,
    '      (''coordination_scope_usage'',''SELECT''),(''coordination_scope_usage'',''INSERT''),' || chr(10) ||
    '      (''coordination_scope_usage'',''UPDATE''),' || chr(10) ||
    '      (''coordination_principal_usage'',''SELECT''),(''coordination_principal_usage'',''INSERT''),' || chr(10) ||
    '      (''coordination_principal_usage'',''UPDATE''),' || chr(10) ||
    '      (''coordination_fencing_floors'',''SELECT'')',
    '      (''coordination_scope_usage'',''SELECT''),' || chr(10) ||
    '      (''coordination_principal_usage'',''SELECT'')');
  revised := replace(revised,
    '        (''continuum_disable_principal(uuid,uuid)'')',
    '        (''continuum_disable_principal(uuid,uuid)''),' || chr(10) ||
    '        (''continuum_coordination_reserve_resource_creation(uuid)''),' || chr(10) ||
    '        (''continuum_coordination_scope_fencing_floor(uuid)'')');
  revised := replace(revised,
    '        (''continuum_operator_set_coordination_scope_quota(uuid,uuid,integer)''),',
    '        (''continuum_operator_set_coordination_scope_quota(uuid,uuid,integer)''),' || chr(10) ||
    '        (''continuum_operator_sweep_coordination_state(uuid,integer)''),');
  IF revised = definition THEN
    RAISE EXCEPTION 'unable to update coordination application allow-list';
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
         'continuum_coordination_receipt_counter',
         'continuum_coordination_resource_counter',
         'continuum_coordination_reserve_resource_creation',
         'continuum_coordination_scope_fencing_floor',
         'continuum_operator_pseudonymize_scope',
         'continuum_operator_reclaim_coordination_resource',
         'continuum_operator_set_coordination_scope_quota',
         'continuum_operator_sweep_coordination_state'
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
