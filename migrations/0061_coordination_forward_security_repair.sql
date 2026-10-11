-- Forward-only repair for coordination privacy, fencing, quotas, and rollout safety.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- Match the application's membership -> resource -> lease -> receipt lock order.
LOCK TABLE scope_memberships IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE coordination_resources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE coordination_leases IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE coordination_operation_receipts IN SHARE ROW EXCLUSIVE MODE;

UPDATE principals
   SET disabled_at = COALESCE(disabled_at, clock_timestamp())
 WHERE id = '00000000-0000-4000-8000-000000000012';

CREATE OR REPLACE FUNCTION continuum_coordination_fencing_nondecreasing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE scope_floor BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(fencing_floor, 0) INTO scope_floor
      FROM coordination_scope_fencing_floors WHERE scope_id = NEW.scope_id;
    NEW.fencing_token := GREATEST(NEW.fencing_token, COALESCE(scope_floor, 0));
  ELSIF NEW.fencing_token < OLD.fencing_token THEN
    RAISE check_violation USING
      MESSAGE = 'coordination fencing token must not decrease',
      CONSTRAINT = 'coordination_fencing_token_nondecreasing';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_fencing_nondecreasing() FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_coordination_privacy_membership_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
      AND NEW.active IS NOT DISTINCT FROM OLD.active
      AND NEW.scope_id IS NOT DISTINCT FROM OLD.scope_id THEN
    RETURN NEW;
  END IF;
  IF NOT NEW.active OR NOT EXISTS (
    SELECT 1 FROM coordination_scope_privacy_progress
     WHERE scope_id = NEW.scope_id
  ) THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.scope_id::text, 761));
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

ALTER TABLE coordination_principal_usage
  ADD COLUMN acquire_receipt_limit INTEGER NOT NULL DEFAULT 10000
    CHECK (acquire_receipt_limit BETWEEN 1 AND 1000000),
  ADD COLUMN contended_receipt_limit INTEGER NOT NULL DEFAULT 1000
    CHECK (contended_receipt_limit BETWEEN 1 AND 1000000);
ALTER TABLE coordination_principal_usage
  DROP CONSTRAINT IF EXISTS coordination_principal_usage_acquire_receipt_count_check,
  DROP CONSTRAINT IF EXISTS coordination_principal_usage_mutation_receipt_count_check,
  DROP CONSTRAINT IF EXISTS coordination_principal_usage_contended_receipt_count_check,
  ADD CONSTRAINT coordination_principal_usage_acquire_receipt_count_check
    CHECK (acquire_receipt_count BETWEEN 0 AND 1000000),
  ADD CONSTRAINT coordination_principal_usage_mutation_receipt_count_check
    CHECK (mutation_receipt_count BETWEEN 0 AND 1000000),
  ADD CONSTRAINT coordination_principal_usage_contended_receipt_count_check
    CHECK (contended_receipt_count BETWEEN 0 AND 1000000);

UPDATE coordination_principal_usage usage SET
  acquire_receipt_count = counts.acquired_count,
  contended_receipt_count = counts.contended_count,
  mutation_receipt_count = 0,
  updated_at = clock_timestamp()
FROM (
  SELECT principal.id,
         count(receipt.*) FILTER (
           WHERE receipt.operation = 'acquire' AND receipt.outcome = 'acquired')::int
           AS acquired_count,
         count(receipt.*) FILTER (
           WHERE receipt.operation = 'acquire' AND receipt.outcome = 'contended')::int
           AS contended_count
    FROM principals principal
    LEFT JOIN coordination_operation_receipts receipt
      ON receipt.principal_id = principal.id
   GROUP BY principal.id
) counts
WHERE usage.principal_id = counts.id;
INSERT INTO coordination_principal_usage
  (principal_id, acquire_receipt_limit, contended_receipt_limit)
VALUES ('00000000-0000-4000-8000-000000000012', 1000000, 1000000)
ON CONFLICT (principal_id) DO UPDATE SET
  acquire_receipt_limit = 1000000, contended_receipt_limit = 1000000;

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
    DELETE FROM coordination_operation_receipts receipt
     WHERE receipt.principal_id = NEW.principal_id
       AND receipt.operation = 'acquire'
       AND receipt.retain_until <= clock_timestamp();
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
      updated_at = clock_timestamp()
     WHERE principal_id = OLD.principal_id;
  ELSE
    UPDATE coordination_principal_usage SET
      contended_receipt_count = GREATEST(0, contended_receipt_count - 1),
      updated_at = clock_timestamp()
     WHERE principal_id = OLD.principal_id;
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_receipt_counter() FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_coordination_receipt_reassign_counter()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.principal_id IS NOT DISTINCT FROM OLD.principal_id
      OR NEW.operation <> 'acquire' THEN
    RETURN NEW;
  END IF;
  INSERT INTO coordination_principal_usage (principal_id)
  VALUES (NEW.principal_id) ON CONFLICT (principal_id) DO NOTHING;
  IF NEW.outcome = 'acquired' THEN
    UPDATE coordination_principal_usage SET
      acquire_receipt_count = GREATEST(0, acquire_receipt_count - 1),
      updated_at = clock_timestamp() WHERE principal_id = OLD.principal_id;
    UPDATE coordination_principal_usage SET
      acquire_receipt_count = acquire_receipt_count + 1,
      updated_at = clock_timestamp() WHERE principal_id = NEW.principal_id;
  ELSE
    UPDATE coordination_principal_usage SET
      contended_receipt_count = GREATEST(0, contended_receipt_count - 1),
      updated_at = clock_timestamp() WHERE principal_id = OLD.principal_id;
    UPDATE coordination_principal_usage SET
      contended_receipt_count = contended_receipt_count + 1,
      updated_at = clock_timestamp() WHERE principal_id = NEW.principal_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_receipt_reassign_counter() FROM PUBLIC;
DROP TRIGGER IF EXISTS coordination_receipt_counter_reassign
  ON coordination_operation_receipts;
CREATE TRIGGER coordination_receipt_counter_reassign
AFTER UPDATE OF principal_id ON coordination_operation_receipts
FOR EACH ROW EXECUTE FUNCTION continuum_coordination_receipt_reassign_counter();

CREATE OR REPLACE FUNCTION continuum_operator_set_coordination_principal_quota(
  authorization_principal_id UUID, target_principal_id UUID,
  acquire_limit INTEGER, contended_limit INTEGER
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET statement_timeout = '5s' AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  IF acquire_limit NOT BETWEEN 1 AND 1000000
      OR contended_limit NOT BETWEEN 1 AND 1000000 THEN
    RAISE EXCEPTION 'coordination principal quota must be between 1 and 1000000';
  END IF;
  INSERT INTO coordination_principal_usage
    (principal_id, acquire_receipt_limit, contended_receipt_limit)
  VALUES (target_principal_id, acquire_limit, contended_limit)
  ON CONFLICT (principal_id) DO UPDATE SET
    acquire_receipt_limit = EXCLUDED.acquire_receipt_limit,
    contended_receipt_limit = EXCLUDED.contended_receipt_limit,
    updated_at = clock_timestamp();
  INSERT INTO audit_log (principal_id, action, metadata)
  VALUES (authorization_principal_id, 'write', jsonb_build_object(
    'operation', 'coordination_principal_quota_changed',
    'target_principal_id', target_principal_id,
    'acquire_limit', acquire_limit, 'contended_limit', contended_limit));
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_set_coordination_principal_quota(
  UUID, UUID, INTEGER, INTEGER) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_operator_scrub_coordination_principal(
  authorization_principal_id UUID,
  target_principal_id UUID,
  owned_scope_id UUID,
  batch_limit INTEGER DEFAULT 1000
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout = '5s' AS $$
DECLARE detached_id UUID := '00000000-0000-4000-8000-000000000012';
DECLARE receipt_count INTEGER := 0; lease_count INTEGER := 0; complete BOOLEAN;
DECLARE last_receipt UUID; last_lease UUID; started BOOLEAN := FALSE;
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  IF batch_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'coordination privacy batch must be between 1 and 1000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM principals WHERE id = target_principal_id
      AND (disabled_at IS NOT NULL OR offboarded_at IS NOT NULL)
  ) THEN
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
  IF EXISTS (
    SELECT 1 FROM coordination_principal_privacy_progress progress
     WHERE progress.principal_id = target_principal_id
       AND progress.completed_at IS NOT NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM coordination_operation_receipts receipt
     WHERE receipt.principal_id = target_principal_id
       AND receipt.scope_id <> owned_scope_id
  ) AND NOT EXISTS (
    SELECT 1 FROM coordination_leases lease
     WHERE lease.principal_id = target_principal_id
       AND lease.scope_id <> owned_scope_id
  ) THEN
    RETURN jsonb_build_object(
      'receipts_scrubbed', 0, 'leases_scrubbed', 0, 'complete', TRUE);
  END IF;
  INSERT INTO coordination_principal_privacy_progress
    (principal_id, detached_principal_id)
  VALUES (target_principal_id, detached_id)
  ON CONFLICT (principal_id) DO NOTHING RETURNING TRUE INTO started;
  IF started THEN
    INSERT INTO coordination_operator_events
      (principal_id, scope_id, operation, metadata)
    VALUES (authorization_principal_id, owned_scope_id,
      'coordination_principal_scrub', jsonb_build_object('phase', 'started'));
  END IF;

  UPDATE audit_log SET metadata = metadata
      - ARRAY['lease_id', 'request_id', 'resource', 'resource_sha256']::text[]
   WHERE principal_id = target_principal_id
     AND scope_id IS DISTINCT FROM owned_scope_id
     AND metadata ?| ARRAY['lease_id', 'request_id', 'resource', 'resource_sha256'];

  WITH candidates AS (
    SELECT receipt.principal_id, receipt.operation, receipt.request_id
      FROM coordination_operation_receipts receipt
     WHERE receipt.principal_id = target_principal_id
       AND receipt.scope_id <> owned_scope_id
     ORDER BY receipt.operation, receipt.request_id
     LIMIT batch_limit FOR UPDATE OF receipt SKIP LOCKED
  ), scrubbed AS (
    UPDATE coordination_operation_receipts receipt SET
      principal_id = detached_id,
      run_id = CASE WHEN receipt.run_id IS NULL THEN NULL ELSE gen_random_uuid() END,
      payload_hash = sha256(convert_to(
        gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8'))
    FROM candidates
    WHERE receipt.principal_id = candidates.principal_id
      AND receipt.operation = candidates.operation
      AND receipt.request_id = candidates.request_id
    RETURNING receipt.request_id
  ) SELECT count(*)::int, max(request_id::text)::uuid
      INTO receipt_count, last_receipt FROM scrubbed;

  IF receipt_count = 0 THEN
    WITH candidates AS (
      SELECT lease.lease_id FROM coordination_leases lease
       WHERE lease.principal_id = target_principal_id
         AND lease.scope_id <> owned_scope_id
         AND (lease.released_at IS NOT NULL OR lease.expires_at <= clock_timestamp())
       ORDER BY lease.lease_id LIMIT batch_limit
       FOR UPDATE OF lease SKIP LOCKED
    ), scrubbed AS (
      UPDATE coordination_leases lease SET
        principal_id = detached_id, run_id = gen_random_uuid()
      FROM candidates WHERE candidates.lease_id = lease.lease_id
      RETURNING lease.lease_id
    ) SELECT count(*)::int, max(lease_id::text)::uuid
        INTO lease_count, last_lease FROM scrubbed;
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

  UPDATE coordination_principal_privacy_progress SET
    receipts_scrubbed = receipts_scrubbed + receipt_count,
    leases_scrubbed = leases_scrubbed + lease_count,
    last_request_id = COALESCE(last_receipt, last_request_id),
    last_lease_id = COALESCE(last_lease, last_lease_id),
    completed_at = CASE WHEN complete THEN COALESCE(completed_at, clock_timestamp()) END,
    updated_at = clock_timestamp()
  WHERE principal_id = target_principal_id;
  INSERT INTO coordination_operator_events
    (principal_id, scope_id, operation, metadata)
  VALUES (authorization_principal_id, owned_scope_id,
    'coordination_principal_scrub', jsonb_build_object(
      'phase', 'batch', 'receipts_scrubbed', receipt_count,
      'leases_scrubbed', lease_count, 'complete', complete));
  IF complete AND NOT EXISTS (
    SELECT 1 FROM coordination_operator_events
     WHERE principal_id = authorization_principal_id
       AND scope_id = owned_scope_id
       AND operation = 'coordination_principal_scrub'
       AND metadata->>'phase' = 'completed'
  ) THEN
    INSERT INTO coordination_operator_events
      (principal_id, scope_id, operation, metadata)
    VALUES (authorization_principal_id, owned_scope_id,
      'coordination_principal_scrub', jsonb_build_object('phase', 'completed'));
  END IF;
  RETURN jsonb_build_object(
    'receipts_scrubbed', receipt_count, 'leases_scrubbed', lease_count,
    'complete', complete);
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_scrub_coordination_principal(
  UUID, UUID, UUID, INTEGER) FROM PUBLIC;

ALTER TABLE coordination_migration_progress
  ADD COLUMN IF NOT EXISTS last_lease_id UUID;
UPDATE coordination_migration_progress
   SET last_lease_id = NULL, completed_at = NULL, updated_at = clock_timestamp()
 WHERE name = 'issue7-cleanup-eligibility';

CREATE OR REPLACE FUNCTION continuum_backfill_coordination_cleanup(batch_limit INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET statement_timeout = '5s' AS $$
DECLARE cursor_id UUID; changed INTEGER := 0; scanned_to UUID; remaining BOOLEAN;
BEGIN
  IF batch_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'coordination backfill batch must be between 1 and 1000';
  END IF;
  INSERT INTO coordination_migration_progress (name)
  VALUES ('issue7-cleanup-eligibility') ON CONFLICT (name) DO NOTHING;
  SELECT last_lease_id INTO cursor_id FROM coordination_migration_progress
   WHERE name = 'issue7-cleanup-eligibility' FOR UPDATE;
  WITH candidates AS (
    SELECT lease.lease_id FROM coordination_leases lease
     WHERE lease.cleanup_eligible_at IS NULL
       AND (cursor_id IS NULL OR lease.lease_id > cursor_id)
       AND NOT EXISTS (
         SELECT 1 FROM coordination_resources resource
          WHERE resource.current_lease_id = lease.lease_id)
     ORDER BY lease.lease_id LIMIT batch_limit FOR UPDATE SKIP LOCKED
  ), updated AS (
    UPDATE coordination_leases lease SET cleanup_eligible_at = COALESCE(
      lease.released_at, lease.expires_at, clock_timestamp())
    FROM candidates WHERE candidates.lease_id = lease.lease_id
    RETURNING lease.lease_id
  ) SELECT count(*)::int, max(lease_id::text)::uuid
      INTO changed, scanned_to FROM updated;
  IF changed > 0 THEN
    UPDATE coordination_migration_progress SET
      rows_processed = rows_processed + changed,
      last_lease_id = scanned_to, completed_at = NULL,
      updated_at = clock_timestamp()
    WHERE name = 'issue7-cleanup-eligibility';
    RETURN FALSE;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM coordination_leases lease
     WHERE lease.cleanup_eligible_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM coordination_resources resource
          WHERE resource.current_lease_id = lease.lease_id)
  ) INTO remaining;
  UPDATE coordination_migration_progress SET
    last_lease_id = CASE WHEN remaining THEN NULL ELSE last_lease_id END,
    completed_at = CASE WHEN remaining THEN NULL ELSE clock_timestamp() END,
    updated_at = clock_timestamp()
  WHERE name = 'issue7-cleanup-eligibility';
  RETURN NOT remaining;
END;
$$;
REVOKE ALL ON FUNCTION continuum_backfill_coordination_cleanup(INTEGER) FROM PUBLIC;

-- Version the bounded implementation. Old binaries fail closed instead of
-- recording completion after one batch.
DO $version$
BEGIN
  IF to_regprocedure(
      format('%I.continuum_operator_pseudonymize_scope_v2(uuid,uuid,text)', current_schema())
    ) IS NULL THEN
    ALTER FUNCTION continuum_operator_pseudonymize_scope(UUID, UUID, TEXT)
      RENAME TO continuum_operator_pseudonymize_scope_v2;
  END IF;
END;
$version$;
CREATE OR REPLACE FUNCTION continuum_operator_pseudonymize_scope(
  authorization_principal_id UUID, target_scope_id UUID, pseudonym TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RAISE EXCEPTION
    'coordination privacy v2 is required; upgrade the Continuum binary before offboarding';
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_pseudonymize_scope(UUID, UUID, TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION continuum_operator_pseudonymize_scope_v2(UUID, UUID, TEXT)
  FROM PUBLIC;

DO $allowlist$
DECLARE definition TEXT; revised TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_assert_application_role_allowlist(name,boolean)'::regprocedure)
    INTO definition;
  revised := replace(definition,
    '(''coordination_resources'',''UPDATE''),' || chr(10), '');
  revised := replace(revised,
    '(''coordination_leases'',''UPDATE''),', '');
  revised := replace(revised,
    '  IF EXISTS (' || chr(10) ||
    '    WITH column_acls AS MATERIALIZED (' || chr(10) ||
    '      SELECT attribute.attrelid, attribute.attacl' || chr(10) ||
    '        FROM pg_attribute attribute' || chr(10) ||
    '       WHERE attribute.attnum > 0 AND NOT attribute.attisdropped' || chr(10) ||
    '         AND cardinality(attribute.attacl) > 0' || chr(10) ||
    '    )' || chr(10) ||
    '    SELECT 1 FROM column_acls attribute' || chr(10) ||
    '    JOIN pg_class relation ON relation.oid = attribute.attrelid' || chr(10) ||
    '    CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege' || chr(10) ||
    '     WHERE relation.relnamespace = schema_oid AND privilege.grantee = target_oid' || chr(10) ||
    '  ) THEN RAISE EXCEPTION ''application role column privilege drift from exact allow-list''; END IF;',
    '  IF EXISTS (' || chr(10) ||
    '    WITH expected(object_name, column_name, privilege_type) AS (VALUES' || chr(10) ||
    '      (''coordination_resources'',''fencing_token'',''UPDATE''),' || chr(10) ||
    '      (''coordination_resources'',''current_lease_id'',''UPDATE''),' || chr(10) ||
    '      (''coordination_resources'',''updated_at'',''UPDATE''),' || chr(10) ||
    '      (''coordination_leases'',''expires_at'',''UPDATE''),' || chr(10) ||
    '      (''coordination_leases'',''released_at'',''UPDATE'')' || chr(10) ||
    '    ), actual AS (' || chr(10) ||
    '      SELECT relation.relname::text, attribute.attname::text,' || chr(10) ||
    '             upper(privilege.privilege_type)::text' || chr(10) ||
    '        FROM pg_attribute attribute' || chr(10) ||
    '        JOIN pg_class relation ON relation.oid = attribute.attrelid' || chr(10) ||
    '        CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege' || chr(10) ||
    '       WHERE attribute.attnum > 0 AND NOT attribute.attisdropped' || chr(10) ||
    '         AND relation.relnamespace = schema_oid AND privilege.grantee = target_oid' || chr(10) ||
    '    )' || chr(10) ||
    '    (SELECT * FROM actual EXCEPT SELECT * FROM expected)' || chr(10) ||
    '    UNION ALL (SELECT * FROM expected EXCEPT SELECT * FROM actual)' || chr(10) ||
    '  ) THEN RAISE EXCEPTION ''application role column privilege drift from exact allow-list''; END IF;');
  revised := replace(revised,
    '        (''continuum_operator_scrub_coordination_principal(uuid,uuid,uuid,integer)''),',
    '        (''continuum_operator_scrub_coordination_principal(uuid,uuid,uuid,integer)''),' || chr(10) ||
    '        (''continuum_operator_pseudonymize_scope_v2(uuid,uuid,text)''),' || chr(10) ||
    '        (''continuum_operator_set_coordination_principal_quota(uuid,uuid,integer,integer)''),');
  IF revised = definition THEN
    RAISE EXCEPTION 'unable to update coordination forward-security allow-list';
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
         'continuum_coordination_fencing_nondecreasing',
         'continuum_coordination_privacy_membership_guard',
         'continuum_coordination_receipt_counter',
         'continuum_coordination_receipt_reassign_counter',
         'continuum_operator_set_coordination_principal_quota',
         'continuum_operator_scrub_coordination_principal',
         'continuum_backfill_coordination_cleanup',
         'continuum_operator_pseudonymize_scope',
         'continuum_operator_pseudonymize_scope_v2'
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
