-- Forward-only public coordination contract repair.
-- continuum:backfill-coordination-contract
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';
-- Establish the write gate only after pre-repair receipt transactions finish.
LOCK TABLE coordination_operation_receipts IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE coordination_contract_backfill_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  phase TEXT NOT NULL DEFAULT 'usage' CHECK (phase IN ('usage','scopes','receipts','complete')),
  principal_cursor UUID,
  scope_cursor UUID,
  receipt_principal_cursor UUID,
  receipt_operation_cursor TEXT,
  receipt_request_cursor UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO coordination_contract_backfill_state(singleton) VALUES(TRUE);
REVOKE ALL ON TABLE coordination_contract_backfill_state FROM PUBLIC;

ALTER TABLE coordination_operation_receipts DROP CONSTRAINT coordination_contended_receipt_retention;
ALTER TABLE coordination_operation_receipts ADD CONSTRAINT coordination_receipt_minimum_retention
  CHECK(retain_until >= server_time + interval '24 hours') NOT VALID;
ALTER TABLE coordination_principal_usage
  DROP CONSTRAINT coordination_principal_usage_acquire_receipt_count_check,
  DROP CONSTRAINT coordination_principal_usage_contended_receipt_count_check,
  DROP CONSTRAINT coordination_principal_usage_mutation_receipt_count_check,
  ADD CONSTRAINT coordination_principal_usage_acquire_receipt_count_check CHECK(acquire_receipt_count >= 0),
  ADD CONSTRAINT coordination_principal_usage_contended_receipt_count_check CHECK(contended_receipt_count >= 0),
  ADD CONSTRAINT coordination_principal_usage_mutation_receipt_count_check CHECK(mutation_receipt_count >= 0);

CREATE OR REPLACE FUNCTION continuum_coordination_require_contract_ready()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM coordination_contract_backfill_state WHERE singleton AND phase = 'complete')
    AND NOT (COALESCE(current_setting('continuum.coordination_contract_repair', TRUE), '') = 'on'
      AND continuum_invoking_database_role()::regrole = (SELECT relowner FROM pg_class WHERE oid = 'coordination_contract_backfill_state'::regclass)) THEN
    RAISE object_not_in_prerequisite_state USING MESSAGE = 'coordination contract repair is incomplete';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_require_contract_ready() FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_coordination_compatibility_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_coordination_require_contract_ready();
  NEW.retain_until := GREATEST(NEW.retain_until, NEW.server_time + interval '24 hours');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_coordination_lock_principal_usage(target_principal_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_coordination_require_contract_ready();
  INSERT INTO coordination_principal_usage(principal_id) VALUES(target_principal_id) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM coordination_principal_usage WHERE principal_id = target_principal_id FOR UPDATE;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_lock_principal_usage(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_coordination_receipt_counter()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE changed BOOLEAN;
BEGIN
  PERFORM continuum_coordination_require_contract_ready();
  IF TG_OP = 'INSERT' THEN
    INSERT INTO coordination_principal_usage(principal_id) VALUES(NEW.principal_id) ON CONFLICT DO NOTHING;
    UPDATE coordination_principal_usage SET
      acquire_receipt_count = acquire_receipt_count + CASE WHEN NEW.operation = 'acquire' AND NEW.outcome = 'acquired' THEN 1 ELSE 0 END,
      contended_receipt_count = contended_receipt_count + CASE WHEN NEW.outcome = 'contended' THEN 1 ELSE 0 END,
      mutation_receipt_count = mutation_receipt_count + CASE WHEN NEW.operation IN ('renew','release') THEN 1 ELSE 0 END,
      updated_at = clock_timestamp()
    WHERE principal_id = NEW.principal_id
      AND acquire_receipt_count::bigint + contended_receipt_count + mutation_receipt_count < LEAST(acquire_receipt_limit,10000)
    RETURNING TRUE INTO changed;
    IF changed IS DISTINCT FROM TRUE THEN
      RAISE check_violation USING MESSAGE = 'coordination receipt quota exceeded', CONSTRAINT = 'coordination_receipt_quota';
    END IF;
    RETURN NEW;
  END IF;
  UPDATE coordination_principal_usage SET
    acquire_receipt_count = GREATEST(0, acquire_receipt_count - CASE WHEN OLD.operation = 'acquire' AND OLD.outcome = 'acquired' THEN 1 ELSE 0 END),
    contended_receipt_count = GREATEST(0, contended_receipt_count - CASE WHEN OLD.outcome = 'contended' THEN 1 ELSE 0 END),
    mutation_receipt_count = GREATEST(0, mutation_receipt_count - CASE WHEN OLD.operation IN ('renew','release') THEN 1 ELSE 0 END),
    updated_at = clock_timestamp()
  WHERE principal_id = OLD.principal_id;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_coordination_receipt_reassign_counter()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE changed BOOLEAN;
BEGIN
  IF NEW.principal_id IS NOT DISTINCT FROM OLD.principal_id THEN RETURN NEW; END IF;
  PERFORM continuum_coordination_require_contract_ready();
  INSERT INTO coordination_principal_usage(principal_id) VALUES(OLD.principal_id),(NEW.principal_id) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM coordination_principal_usage WHERE principal_id IN (OLD.principal_id,NEW.principal_id) ORDER BY principal_id FOR UPDATE;
  UPDATE coordination_principal_usage SET
    acquire_receipt_count = GREATEST(0, acquire_receipt_count - CASE WHEN OLD.operation = 'acquire' AND OLD.outcome = 'acquired' THEN 1 ELSE 0 END),
    contended_receipt_count = GREATEST(0, contended_receipt_count - CASE WHEN OLD.outcome = 'contended' THEN 1 ELSE 0 END),
    mutation_receipt_count = GREATEST(0, mutation_receipt_count - CASE WHEN OLD.operation IN ('renew','release') THEN 1 ELSE 0 END)
  WHERE principal_id = OLD.principal_id;
  UPDATE coordination_principal_usage SET
    acquire_receipt_count = acquire_receipt_count + CASE WHEN NEW.operation = 'acquire' AND NEW.outcome = 'acquired' THEN 1 ELSE 0 END,
    contended_receipt_count = contended_receipt_count + CASE WHEN NEW.outcome = 'contended' THEN 1 ELSE 0 END,
    mutation_receipt_count = mutation_receipt_count + CASE WHEN NEW.operation IN ('renew','release') THEN 1 ELSE 0 END,
    updated_at = clock_timestamp()
  WHERE principal_id = NEW.principal_id
    AND acquire_receipt_count::bigint + contended_receipt_count + mutation_receipt_count < LEAST(acquire_receipt_limit,10000)
  RETURNING TRUE INTO changed;
  IF changed IS DISTINCT FROM TRUE THEN
    RAISE check_violation USING MESSAGE = 'detached coordination receipt quota exceeded', CONSTRAINT = 'coordination_receipt_quota';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_backfill_coordination_contract(batch_limit INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE progress coordination_contract_backfill_state%ROWTYPE; selected_count INTEGER; next_id UUID; item RECORD;
BEGIN
  IF batch_limit NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'coordination contract batch limit must be between 1 and 5000'; END IF;
  SELECT * INTO progress FROM coordination_contract_backfill_state WHERE singleton FOR UPDATE;
  IF progress.phase = 'complete' THEN RETURN TRUE; END IF;
  PERFORM set_config('continuum.coordination_contract_repair', 'on', TRUE);
  IF progress.phase = 'usage' THEN
    WITH candidates AS MATERIALIZED (
      SELECT principal_id FROM coordination_principal_usage
      WHERE progress.principal_cursor IS NULL OR principal_id > progress.principal_cursor ORDER BY principal_id LIMIT batch_limit
    ), updated AS (
      UPDATE coordination_principal_usage usage SET acquire_receipt_count = 0, contended_receipt_count = 0,
        mutation_receipt_count = 0, acquire_receipt_limit = LEAST(acquire_receipt_limit,10000),
        contended_receipt_limit = LEAST(contended_receipt_limit,10000)
      FROM candidates WHERE usage.principal_id = candidates.principal_id RETURNING usage.principal_id
    ) SELECT count(*)::int, (array_agg(principal_id ORDER BY principal_id DESC))[1] INTO selected_count,next_id FROM updated;
    UPDATE coordination_contract_backfill_state SET principal_cursor = COALESCE(next_id,principal_cursor),
      phase = CASE WHEN selected_count < batch_limit THEN 'scopes' ELSE phase END WHERE singleton;
  ELSIF progress.phase = 'scopes' THEN
    WITH candidates AS MATERIALIZED (
      SELECT scope_id FROM coordination_scope_usage WHERE progress.scope_cursor IS NULL OR scope_id > progress.scope_cursor ORDER BY scope_id LIMIT batch_limit
    ), reopened AS (
      UPDATE coordination_scope_privacy_progress privacy SET phase='receipts',completed_at=NULL,updated_at=clock_timestamp()
      FROM candidates WHERE privacy.scope_id=candidates.scope_id AND privacy.phase='complete'
        AND EXISTS(SELECT 1 FROM coordination_resources resource WHERE resource.scope_id=privacy.scope_id)
      RETURNING privacy.scope_id
    ), updated AS (
      UPDATE coordination_scope_usage usage SET resource_limit = LEAST(resource_limit,10000)
      FROM candidates WHERE usage.scope_id = candidates.scope_id RETURNING usage.scope_id
    ) SELECT count(*)::int, (array_agg(scope_id ORDER BY scope_id DESC))[1] INTO selected_count,next_id FROM updated;
    UPDATE coordination_contract_backfill_state SET scope_cursor = COALESCE(next_id,scope_cursor),
      phase = CASE WHEN selected_count < batch_limit THEN 'receipts' ELSE phase END WHERE singleton;
  ELSE
    CREATE TEMP TABLE IF NOT EXISTS coordination_contract_batch(principal_id UUID,operation TEXT,request_id UUID,outcome TEXT,
      PRIMARY KEY(principal_id,operation,request_id)) ON COMMIT DELETE ROWS;
    TRUNCATE coordination_contract_batch;
    INSERT INTO coordination_contract_batch SELECT principal_id,operation,request_id,outcome FROM coordination_operation_receipts
      WHERE progress.receipt_principal_cursor IS NULL OR (principal_id,operation,request_id) >
        (progress.receipt_principal_cursor,progress.receipt_operation_cursor,progress.receipt_request_cursor)
      ORDER BY principal_id,operation,request_id LIMIT batch_limit;
    GET DIAGNOSTICS selected_count = ROW_COUNT;
    UPDATE coordination_operation_receipts receipt SET retain_until = GREATEST(receipt.retain_until,receipt.server_time + interval '24 hours')
      FROM coordination_contract_batch batch WHERE (receipt.principal_id,receipt.operation,receipt.request_id) = (batch.principal_id,batch.operation,batch.request_id);
    FOR item IN SELECT principal_id,
      count(*) FILTER(WHERE operation='acquire' AND outcome='acquired')::int acquired,
      count(*) FILTER(WHERE outcome='contended')::int contended,
      count(*) FILTER(WHERE operation IN ('renew','release'))::int mutation
      FROM coordination_contract_batch GROUP BY principal_id ORDER BY principal_id LOOP
      INSERT INTO coordination_principal_usage(principal_id) VALUES(item.principal_id) ON CONFLICT DO NOTHING;
      UPDATE coordination_principal_usage SET acquire_receipt_count=acquire_receipt_count+item.acquired,
        contended_receipt_count=contended_receipt_count+item.contended,mutation_receipt_count=mutation_receipt_count+item.mutation
      WHERE principal_id=item.principal_id;
    END LOOP;
    SELECT principal_id,operation,request_id INTO item FROM coordination_contract_batch ORDER BY principal_id DESC,operation DESC,request_id DESC LIMIT 1;
    UPDATE coordination_contract_backfill_state SET
      receipt_principal_cursor = COALESCE(item.principal_id,receipt_principal_cursor),
      receipt_operation_cursor = COALESCE(item.operation,receipt_operation_cursor),
      receipt_request_cursor = COALESCE(item.request_id,receipt_request_cursor),
      phase = CASE WHEN selected_count < batch_limit THEN 'complete' ELSE phase END WHERE singleton;
  END IF;
  UPDATE coordination_contract_backfill_state SET updated_at=clock_timestamp() WHERE singleton;
  RETURN EXISTS(SELECT 1 FROM coordination_contract_backfill_state WHERE singleton AND phase='complete');
END;
$$;
REVOKE ALL ON FUNCTION continuum_backfill_coordination_contract(INTEGER) FROM PUBLIC;

CREATE FUNCTION continuum_operator_list_coordination_privacy_repair_page(
  authorization_principal_id UUID, after_principal_id UUID, row_limit INTEGER
) RETURNS TABLE(repairs JSONB,next_cursor UUID,has_more BOOLEAN,scanned_count INTEGER)
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id,'approve');
  IF row_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'coordination privacy repair page limit must be between 1 and 1000'; END IF;
  RETURN QUERY WITH eligible AS MATERIALIZED (
    SELECT progress.principal_id FROM coordination_principal_privacy_progress progress
    WHERE progress.repair_eligible IS TRUE AND (progress.privacy_version < 3 OR progress.completed_at IS NULL)
      AND (after_principal_id IS NULL OR progress.principal_id > after_principal_id)
    ORDER BY progress.principal_id LIMIT row_limit+1
  ), legacy AS MATERIALIZED (
    SELECT progress.principal_id FROM coordination_principal_privacy_progress progress
    WHERE progress.repair_eligible IS NOT TRUE AND (progress.privacy_version < 3 OR progress.completed_at IS NULL)
      AND (after_principal_id IS NULL OR progress.principal_id > after_principal_id)
    ORDER BY progress.principal_id LIMIT row_limit+1
  ), dirty AS MATERIALIZED (
    SELECT marker.principal_id FROM coordination_privacy_dirty_principals marker
    WHERE after_principal_id IS NULL OR marker.principal_id > after_principal_id
    ORDER BY marker.principal_id LIMIT row_limit+1
  ), raw AS MATERIALIZED (
    SELECT principal_id FROM eligible UNION SELECT principal_id FROM legacy UNION SELECT principal_id FROM dirty
  ), lookahead AS MATERIALIZED (
    SELECT principal_id FROM raw ORDER BY principal_id LIMIT row_limit+1
  ), consumed AS MATERIALIZED (
    SELECT principal_id FROM lookahead ORDER BY principal_id LIMIT row_limit
  ), filtered AS MATERIALIZED (
    SELECT principal.id AS principal_id,mapping.scope_id,
      CASE WHEN principal.offboarded_at IS NOT NULL THEN 'offboarded' ELSE 'disabled_only' END AS repair_state
    FROM consumed JOIN principals principal ON principal.id=consumed.principal_id AND principal.disabled_at IS NOT NULL
    JOIN principal_user_scopes mapping ON mapping.principal_id=principal.id
  ), page AS (
    SELECT count(*) > row_limit AS more FROM lookahead
  ) SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('principal_id',filtered.principal_id,
      'scope_id',filtered.scope_id,'repair_state',filtered.repair_state) ORDER BY filtered.principal_id) FROM filtered),'[]'::jsonb),
    CASE WHEN page.more THEN (SELECT principal_id FROM consumed ORDER BY principal_id DESC LIMIT 1) END,
    page.more,(SELECT count(*)::int FROM consumed) FROM page;
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_list_coordination_privacy_repair_page(UUID,UUID,INTEGER) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_coordination_resource_counter()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE changed BOOLEAN;
BEGIN
  PERFORM continuum_coordination_require_contract_ready();
  IF TG_OP = 'INSERT' THEN
    INSERT INTO coordination_scope_usage (scope_id)
    VALUES (NEW.scope_id) ON CONFLICT (scope_id) DO NOTHING;
    UPDATE coordination_scope_usage
       SET resource_count = resource_count + 1, updated_at = clock_timestamp()
     WHERE scope_id = NEW.scope_id AND resource_count < LEAST(resource_limit, 10000)
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
  IF new_resource_limit NOT BETWEEN 1 AND 10000 THEN
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

CREATE OR REPLACE FUNCTION continuum_operator_set_coordination_principal_quota(
  authorization_principal_id UUID, target_principal_id UUID,
  acquire_limit INTEGER, contended_limit INTEGER
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET statement_timeout = '5s' AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  IF acquire_limit NOT BETWEEN 1 AND 10000
      OR contended_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'coordination principal quota must be between 1 and 10000';
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

DO $allowlist$
DECLARE definition TEXT; revised TEXT;
BEGIN
  SELECT pg_get_functiondef('continuum_assert_application_role_allowlist(name,boolean)'::regprocedure) INTO definition;
  revised := replace(definition,
    '        (''continuum_coordination_lock_entra_freshness()'')',
    '        (''continuum_coordination_lock_entra_freshness()''),' || chr(10) ||
    '        (''continuum_coordination_lock_principal_usage(uuid)'')');
  IF revised = definition THEN RAISE EXCEPTION 'unable to extend coordination quota lock allow-list'; END IF;
  definition := revised;
  revised := replace(definition,
    '        (''continuum_operator_list_coordination_privacy_repairs(uuid,uuid,uuid,integer)''),',
    '        (''continuum_operator_list_coordination_privacy_repairs(uuid,uuid,uuid,integer)''),' || chr(10) ||
    '        (''continuum_operator_list_coordination_privacy_repair_page(uuid,uuid,integer)''),');
  IF revised = definition THEN RAISE EXCEPTION 'unable to extend coordination repair page allow-list'; END IF;
  EXECUTE revised;
END;
$allowlist$;



CREATE OR REPLACE FUNCTION continuum_operator_reclaim_coordination_resource(
  authorization_principal_id UUID,
  target_scope_id UUID,
  target_resource TEXT
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout = '5s' AS $$
DECLARE state RECORD; expired_count INTEGER; history_count INTEGER; quota_principal UUID; expired_receipt RECORD; quota_principals UUID[] := ARRAY[]::UUID[]; reclaim_time TIMESTAMPTZ;
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  PERFORM continuum_coordination_require_contract_ready();
  reclaim_time := clock_timestamp();
  expired_count := 0;
  FOR expired_receipt IN SELECT principal_id,operation,request_id FROM coordination_operation_receipts
    WHERE scope_id=target_scope_id AND resource=target_resource AND retain_until<=reclaim_time
    ORDER BY principal_id,operation,request_id LIMIT 1001 FOR UPDATE LOOP
    expired_count := expired_count + 1;
    quota_principals := array_append(quota_principals,expired_receipt.principal_id);
  END LOOP;
  IF expired_count>1000 THEN RAISE EXCEPTION 'run bounded coordination sweep before reclaim'; END IF;
  FOR quota_principal IN SELECT DISTINCT principal_id FROM unnest(quota_principals) AS candidate(principal_id) ORDER BY principal_id LOOP
    PERFORM continuum_coordination_lock_principal_usage(quota_principal);
  END LOOP;
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
       AND retain_until <= reclaim_time
     ORDER BY retain_until, principal_id, operation, request_id LIMIT 1001
  ) bounded;
  IF expired_count > 1000 THEN
    RAISE EXCEPTION 'run bounded coordination sweep before reclaim';
  END IF;
  DELETE FROM coordination_operation_receipts
   WHERE scope_id = target_scope_id AND resource = target_resource
     AND retain_until <= reclaim_time;
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

CREATE OR REPLACE FUNCTION continuum_operator_pseudonymize_scope_v2_legacy(
  authorization_principal_id UUID,
  target_scope_id UUID,
  pseudonym TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout = '5s' AS $$
DECLARE batch_limit CONSTANT INTEGER := 1000; phase_name TEXT;
DECLARE changed INTEGER := 0; processed INTEGER := 0; remaining_budget INTEGER; previous_phase TEXT; scope_floor BIGINT; started BOOLEAN := FALSE;
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  PERFORM continuum_coordination_require_contract_ready();
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
  previous_phase := phase_name;
  remaining_budget := batch_limit - processed;
  IF phase_name = 'receipts' THEN
    WITH candidates AS (
      SELECT principal_id, operation, request_id
        FROM coordination_operation_receipts
       WHERE scope_id = target_scope_id
       ORDER BY principal_id, operation, request_id
       LIMIT remaining_budget FOR UPDATE SKIP LOCKED
    ), removed AS (
      DELETE FROM coordination_operation_receipts receipt USING candidates
       WHERE receipt.principal_id = candidates.principal_id
         AND receipt.operation = candidates.operation
         AND receipt.request_id = candidates.request_id RETURNING 1
    ) SELECT count(*)::int INTO changed FROM removed;
    IF NOT EXISTS(SELECT 1 FROM coordination_operation_receipts WHERE scope_id=target_scope_id) THEN phase_name := 'leases'; END IF;
  ELSIF phase_name = 'leases' THEN
    WITH candidates AS MATERIALIZED (
      SELECT lease_id FROM coordination_leases WHERE scope_id=target_scope_id
      ORDER BY lease_id LIMIT remaining_budget FOR UPDATE SKIP LOCKED
    ), cleared AS (
      UPDATE coordination_resources resource SET current_lease_id=NULL
      FROM candidates WHERE resource.scope_id=target_scope_id AND resource.current_lease_id=candidates.lease_id
      RETURNING resource.current_lease_id
    ), removed AS (
      DELETE FROM coordination_leases lease USING candidates
      WHERE lease.lease_id=candidates.lease_id AND (SELECT count(*) FROM cleared)>=0 RETURNING 1
    ) SELECT count(*)::int INTO changed FROM removed;
    IF NOT EXISTS(SELECT 1 FROM coordination_leases WHERE scope_id=target_scope_id) THEN phase_name := 'resources'; END IF;
  ELSIF phase_name = 'resources' THEN
    WITH candidates AS MATERIALIZED (
      SELECT scope_id,resource FROM coordination_resources WHERE scope_id=target_scope_id
      ORDER BY resource COLLATE "C" LIMIT remaining_budget FOR UPDATE SKIP LOCKED
    ), removed AS (
      DELETE FROM coordination_resources resource USING candidates
      WHERE resource.scope_id=candidates.scope_id AND resource.resource=candidates.resource
      RETURNING resource.fencing_token
    ) SELECT count(*)::int,max(fencing_token) INTO changed,scope_floor FROM removed;
    IF scope_floor IS NOT NULL THEN
      INSERT INTO coordination_scope_fencing_floors(scope_id,fencing_floor) VALUES(target_scope_id,scope_floor)
      ON CONFLICT(scope_id) DO UPDATE SET fencing_floor=GREATEST(coordination_scope_fencing_floors.fencing_floor,EXCLUDED.fencing_floor),updated_at=clock_timestamp();
    END IF;
    IF NOT EXISTS(SELECT 1 FROM coordination_resources WHERE scope_id=target_scope_id) THEN phase_name := 'complete'; END IF;
  END IF;
  processed := processed + changed;
  EXIT WHEN processed >= batch_limit OR phase_name = 'complete' OR phase_name=previous_phase;
  END LOOP;

  UPDATE scopes SET name = pseudonym WHERE id = target_scope_id;
  UPDATE coordination_scope_privacy_progress
     SET phase = phase_name, rows_processed = rows_processed + processed,
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

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN SELECT function.proname,pg_get_function_identity_arguments(function.oid) arguments
    FROM pg_proc function WHERE function.pronamespace=quote_ident(current_schema())::regnamespace
      AND function.proname=ANY(ARRAY[
        'continuum_coordination_require_contract_ready','continuum_coordination_compatibility_guard',
        'continuum_coordination_lock_principal_usage','continuum_coordination_receipt_counter',
        'continuum_coordination_receipt_reassign_counter','continuum_backfill_coordination_contract',
        'continuum_coordination_resource_counter','continuum_operator_set_coordination_scope_quota',
        'continuum_operator_set_coordination_principal_quota','continuum_operator_reclaim_coordination_resource',
        'continuum_operator_list_coordination_privacy_repair_page','continuum_operator_pseudonymize_scope_v2_legacy'
      ]) LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path=pg_catalog,%I,pg_temp',schema_name,function_record.proname,function_record.arguments,schema_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC',schema_name,function_record.proname,function_record.arguments);
  END LOOP;
END;
$harden$;
