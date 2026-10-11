-- Forward-only privacy, race, and bounded-retention repair for coordination leases.

CREATE INDEX IF NOT EXISTS coordination_receipts_global_sweep_idx
  ON coordination_operation_receipts
    (retain_until, principal_id, operation, request_id);
CREATE INDEX IF NOT EXISTS coordination_leases_terminal_sweep_idx
  ON coordination_leases
    ((COALESCE(released_at, expires_at)), lease_id);

ALTER TABLE coordination_principal_usage
  ADD COLUMN contended_receipt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE coordination_principal_usage
  DROP CONSTRAINT IF EXISTS coordination_principal_usage_contended_receipt_count_check,
  ADD CONSTRAINT coordination_principal_usage_contended_receipt_count_check
    CHECK (contended_receipt_count BETWEEN 0 AND 1000);

-- Contention polling has a separate, short retry horizon. It cannot consume the
-- successful-acquire 24-hour budget.
UPDATE coordination_operation_receipts
   SET retain_until = LEAST(retain_until, server_time + interval '90 seconds')
 WHERE operation = 'acquire' AND outcome = 'contended';
ALTER TABLE coordination_operation_receipts
  ADD CONSTRAINT coordination_contended_receipt_retention
  CHECK (
    operation <> 'acquire' OR outcome <> 'contended'
    OR retain_until <= server_time + interval '90 seconds'
  );

-- Repair every usage row, including principals whose retained count is zero.
WITH counts AS (
  SELECT usage.principal_id,
         count(receipt.*) FILTER (
           WHERE receipt.operation = 'acquire' AND receipt.outcome = 'acquired'
         )::int AS acquired_count,
         count(receipt.*) FILTER (
           WHERE receipt.operation = 'acquire' AND receipt.outcome = 'contended'
         )::int AS contended_count,
         count(receipt.*) FILTER (WHERE receipt.operation = 'release')::int
           AS mutation_count
    FROM coordination_principal_usage usage
    LEFT JOIN coordination_operation_receipts receipt
      ON receipt.principal_id = usage.principal_id
   GROUP BY usage.principal_id
)
UPDATE coordination_principal_usage usage
   SET acquire_receipt_count = counts.acquired_count,
       contended_receipt_count = counts.contended_count,
       mutation_receipt_count = counts.mutation_count,
       updated_at = clock_timestamp()
  FROM counts WHERE counts.principal_id = usage.principal_id;

-- Collapse legacy renew history before enforcing the per-lease retained bound.
WITH ranked AS (
  SELECT principal_id, operation, request_id,
         row_number() OVER (
           PARTITION BY lease_id
           ORDER BY created_at DESC, principal_id, request_id
         ) AS ordinal
    FROM coordination_operation_receipts
   WHERE operation = 'renew' AND lease_id IS NOT NULL
), removed AS (
  DELETE FROM coordination_operation_receipts receipt USING ranked
   WHERE ranked.ordinal > 100
     AND receipt.principal_id = ranked.principal_id
     AND receipt.operation = ranked.operation
     AND receipt.request_id = ranked.request_id
  RETURNING 1
)
SELECT count(*) FROM removed;

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
        OFFSET 99
        FOR UPDATE
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

CREATE OR REPLACE FUNCTION continuum_coordination_fencing_nondecreasing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.fencing_token < OLD.fencing_token THEN
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
BEFORE UPDATE OF fencing_token ON coordination_resources
FOR EACH ROW EXECUTE FUNCTION continuum_coordination_fencing_nondecreasing();

CREATE OR REPLACE FUNCTION continuum_operator_pseudonymize_scope(
  authorization_principal_id UUID,
  target_scope_id UUID,
  pseudonym TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE scope_floor BIGINT; active_members INTEGER := 0; membership RECORD;
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

  -- This ordering matches coordination authorization and conflicts with every
  -- FOR SHARE membership lock held by an in-flight coordination operation.
  FOR membership IN
    SELECT principal_id, source_kind, source_id
      FROM scope_memberships
     WHERE scope_id = target_scope_id AND active
     ORDER BY principal_id, source_kind, source_id
     FOR UPDATE
  LOOP
    active_members := active_members + 1;
  END LOOP;

  IF active_members > 0 AND EXISTS (
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
  UPDATE coordination_operation_receipts
     SET payload_hash = sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8'))
   WHERE scope_id = target_scope_id;
  UPDATE coordination_resources
     SET resource = 'offboarded:' || gen_random_uuid()::text,
         updated_at = clock_timestamp()
   WHERE scope_id = target_scope_id;
  UPDATE scopes SET name = pseudonym WHERE id = target_scope_id;
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_pseudonymize_scope(UUID, UUID, TEXT)
  FROM PUBLIC;

-- 0056 performed three source rewrites but only checked whether all three
-- missed. Verify every expected post-0056 replacement independently, then
-- remove receipt UPDATE from the exact app-role allow-list.
DO $allowlist$
DECLARE definition TEXT; revised TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_assert_application_role_allowlist(name,boolean)'::regprocedure)
    INTO definition;
  IF position('(''coordination_scope_usage'',''SELECT'')' IN definition) = 0 THEN
    RAISE EXCEPTION '0056 scope usage allow-list repair is missing';
  END IF;
  IF position('(''coordination_principal_usage'',''SELECT'')' IN definition) = 0 THEN
    RAISE EXCEPTION '0056 principal usage allow-list repair is missing';
  END IF;
  IF position('(''continuum_coordination_reserve_resource_creation(uuid)'')' IN definition) = 0 THEN
    RAISE EXCEPTION '0056 resource reservation allow-list repair is missing';
  END IF;
  IF position('(''continuum_coordination_scope_fencing_floor(uuid)'')' IN definition) = 0 THEN
    RAISE EXCEPTION '0056 fencing floor allow-list repair is missing';
  END IF;
  IF position('(''continuum_operator_sweep_coordination_state(uuid,integer)'')' IN definition) = 0 THEN
    RAISE EXCEPTION '0056 coordination operator allow-list repair is missing';
  END IF;
  revised := replace(
    definition,
    '      (''coordination_operation_receipts'',''UPDATE''),' || chr(10),
    '');
  IF position('(''coordination_operation_receipts'',''UPDATE'')' IN revised) <> 0 THEN
    RAISE EXCEPTION 'unable to remove coordination receipt UPDATE allow-list entry';
  END IF;
  IF revised <> definition THEN EXECUTE revised; END IF;
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
         'continuum_coordination_fencing_nondecreasing',
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
