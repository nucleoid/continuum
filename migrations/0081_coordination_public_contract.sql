-- Forward-only public coordination contract repair.
-- continuum:backfill-coordination-contract
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';
-- Establish the write gate only after pre-repair receipt transactions finish.
LOCK TABLE coordination_operation_receipts IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE coordination_contract_backfill_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  phase TEXT NOT NULL DEFAULT 'usage' CHECK (phase IN ('usage','floors','scopes','receipts','complete')),
  principal_cursor UUID,
  resource_scope_cursor UUID,
  resource_key_cursor TEXT,
  resource_rows_processed BIGINT NOT NULL DEFAULT 0 CHECK(resource_rows_processed >= 0),
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
      AND (SELECT oid FROM pg_roles WHERE rolname=continuum_invoking_database_role()) =
        (SELECT relowner FROM pg_class WHERE oid = 'coordination_contract_backfill_state'::regclass)) THEN
    RAISE object_not_in_prerequisite_state USING MESSAGE = 'coordination contract repair is incomplete',
      CONSTRAINT = 'coordination_contract_pending';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_require_contract_ready() FROM PUBLIC;

CREATE FUNCTION continuum_coordination_contract_is_ready()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS(SELECT 1 FROM coordination_contract_backfill_state WHERE singleton AND phase='complete')
$$;
REVOKE ALL ON FUNCTION continuum_coordination_contract_is_ready() FROM PUBLIC;

-- Role names returned by session_user are exact catalog names, not quoted
-- identifier expressions. A direct login can contain punctuation or capitals.
CREATE OR REPLACE FUNCTION continuum_require_coordination_privacy_client_v4()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE owner_role OID;
BEGIN
  SELECT function.proowner INTO owner_role FROM pg_proc function
   WHERE function.oid='continuum_require_coordination_privacy_client_v4()'::regprocedure;
  IF current_setting('role',TRUE)='none'
    AND (SELECT oid FROM pg_roles WHERE rolname=session_user)=owner_role THEN RETURN; END IF;
  IF current_setting('continuum.client_coordination_privacy_version',TRUE) IS DISTINCT FROM '4' THEN
    RAISE feature_not_supported USING MESSAGE='pre-0074 coordination privacy client refused before mutation';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_require_coordination_privacy_client_v4() FROM PUBLIC;

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

-- The application may SELECT/INSERT/DELETE receipts, but never UPDATE them.
-- PostgreSQL requires UPDATE for FOR UPDATE, so keep skip-locked selection
-- behind this bounded owner capability rather than broadening table grants.
CREATE FUNCTION continuum_coordination_cleanup_expired_receipts(target_principal_id UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE removed_count INTEGER;
BEGIN
  PERFORM continuum_coordination_require_contract_ready();
  WITH doomed AS MATERIALIZED (
    SELECT principal_id,operation,request_id FROM coordination_operation_receipts
    WHERE principal_id=target_principal_id AND retain_until<=clock_timestamp()
    ORDER BY retain_until,operation,request_id LIMIT 100 FOR UPDATE SKIP LOCKED
  ), removed AS (
    DELETE FROM coordination_operation_receipts receipt USING doomed
    WHERE receipt.principal_id=doomed.principal_id AND receipt.operation=doomed.operation
      AND receipt.request_id=doomed.request_id RETURNING 1
  ) SELECT count(*)::int INTO removed_count FROM removed;
  RETURN removed_count;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_cleanup_expired_receipts(UUID) FROM PUBLIC;

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
  batch_limit:=LEAST(batch_limit,1000);
  SELECT * INTO progress FROM coordination_contract_backfill_state WHERE singleton FOR UPDATE;
  IF progress.phase = 'complete' THEN RETURN TRUE; END IF;
  PERFORM set_config('continuum.coordination_contract_repair', 'on', TRUE);
  IF progress.phase = 'usage' THEN
    EXECUTE $usage$ WITH candidates AS MATERIALIZED (
      SELECT principal_id FROM coordination_principal_usage
      WHERE principal_id >= COALESCE($1,'00000000-0000-0000-0000-000000000000'::uuid)
        AND ($1 IS NULL OR principal_id>$1) ORDER BY principal_id LIMIT $2
    ), updated AS (
      UPDATE coordination_principal_usage usage SET acquire_receipt_count = 0, contended_receipt_count = 0,
        mutation_receipt_count = 0, acquire_receipt_limit = LEAST(acquire_receipt_limit,10000),
        contended_receipt_limit = LEAST(contended_receipt_limit,10000)
      FROM candidates WHERE usage.principal_id = candidates.principal_id RETURNING usage.principal_id
    ) SELECT count(*)::int, (array_agg(principal_id ORDER BY principal_id DESC))[1] FROM updated
    $usage$ INTO selected_count,next_id USING progress.principal_cursor,batch_limit;
    UPDATE coordination_contract_backfill_state SET principal_cursor = CASE WHEN selected_count<batch_limit THEN NULL
      ELSE COALESCE(next_id,principal_cursor) END,
      phase = CASE WHEN selected_count < batch_limit THEN 'floors' ELSE phase END WHERE singleton;
  ELSIF progress.phase = 'floors' THEN
    -- Surviving 0055-era renamed keys may have no privacy progress or floor.
    -- Read each physical key once; do not put a scoped aggregate on acquisition.
    EXECUTE $floors$ WITH candidates AS MATERIALIZED (
      SELECT scope_id,resource,fencing_token FROM coordination_resources
      WHERE (scope_id,resource)>=
        (COALESCE($1,'00000000-0000-0000-0000-000000000000'::uuid),COALESCE($2,''))
        AND ($1 IS NULL OR (scope_id,resource)>($1,$2))
      ORDER BY scope_id,resource LIMIT $3
    ), saved AS (
      INSERT INTO coordination_scope_fencing_floors(scope_id,fencing_floor)
      SELECT scope_id,max(fencing_token) FROM candidates GROUP BY scope_id ORDER BY scope_id
      ON CONFLICT(scope_id) DO UPDATE SET fencing_floor=GREATEST(
        coordination_scope_fencing_floors.fencing_floor,EXCLUDED.fencing_floor),updated_at=clock_timestamp()
    ) SELECT count(*)::int AS selected_count,
      (array_agg(scope_id ORDER BY scope_id DESC,resource DESC))[1] AS scope_id,
      (array_agg(resource ORDER BY scope_id DESC,resource DESC))[1] AS resource FROM candidates
    $floors$ INTO item USING progress.resource_scope_cursor,progress.resource_key_cursor,batch_limit;
    selected_count:=item.selected_count;
    UPDATE coordination_contract_backfill_state SET
      resource_scope_cursor=CASE WHEN selected_count<batch_limit THEN NULL
        ELSE COALESCE(item.scope_id,resource_scope_cursor) END,
      resource_key_cursor=CASE WHEN selected_count<batch_limit THEN NULL
        ELSE COALESCE(item.resource,resource_key_cursor) END,
      resource_rows_processed=resource_rows_processed+selected_count,
      phase=CASE WHEN selected_count<batch_limit THEN 'scopes' ELSE phase END WHERE singleton;
  ELSIF progress.phase = 'scopes' THEN
    EXECUTE $scopes$ WITH candidates AS MATERIALIZED (
      SELECT scope_id FROM coordination_scope_usage
      WHERE scope_id >= COALESCE($1,'00000000-0000-0000-0000-000000000000'::uuid)
        AND ($1 IS NULL OR scope_id>$1) ORDER BY scope_id LIMIT $2
    ), reopened AS (
      UPDATE coordination_scope_privacy_progress privacy SET phase='receipts',completed_at=NULL,updated_at=clock_timestamp()
      FROM candidates WHERE privacy.scope_id=candidates.scope_id AND privacy.phase='complete'
        AND EXISTS(SELECT 1 FROM coordination_resources resource WHERE resource.scope_id=privacy.scope_id)
      RETURNING privacy.scope_id
    ), pending AS (
      INSERT INTO coordination_principal_privacy_progress(principal_id,detached_principal_id,privacy_version,completed_at)
      SELECT mapping.principal_id,'00000000-0000-4000-8000-000000000012'::uuid,3,NULL
      FROM reopened JOIN principal_user_scopes mapping ON mapping.scope_id=reopened.scope_id
      JOIN principals principal ON principal.id=mapping.principal_id AND principal.disabled_at IS NOT NULL
      ON CONFLICT(principal_id) DO UPDATE SET completed_at=NULL,updated_at=clock_timestamp()
      RETURNING principal_id
    ), marked AS (
      INSERT INTO coordination_privacy_dirty_principals(principal_id)
      SELECT principal_id FROM pending ON CONFLICT(principal_id) DO UPDATE SET dirty_at=clock_timestamp()
    ), updated AS (
      UPDATE coordination_scope_usage usage SET resource_limit = LEAST(resource_limit,10000)
      FROM candidates WHERE usage.scope_id = candidates.scope_id RETURNING usage.scope_id
    ) SELECT count(*)::int, (array_agg(scope_id ORDER BY scope_id DESC))[1] FROM updated
    $scopes$ INTO selected_count,next_id USING progress.scope_cursor,batch_limit;
    UPDATE coordination_contract_backfill_state SET scope_cursor = CASE WHEN selected_count<batch_limit THEN NULL
      ELSE COALESCE(next_id,scope_cursor) END,
      phase = CASE WHEN selected_count < batch_limit THEN 'receipts' ELSE phase END WHERE singleton;
  ELSE
    EXECUTE $receipts$ WITH batch AS MATERIALIZED (
      SELECT principal_id,operation,request_id,outcome FROM coordination_operation_receipts
      WHERE (principal_id,operation,request_id) >=
        (COALESCE($1,'00000000-0000-0000-0000-000000000000'::uuid),COALESCE($2,''),
         COALESCE($3,'00000000-0000-0000-0000-000000000000'::uuid))
        AND ($1 IS NULL OR (principal_id,operation,request_id)>($1,$2,$3))
      ORDER BY principal_id,operation,request_id LIMIT $4
    ), retained AS (
      UPDATE coordination_operation_receipts receipt SET retain_until=GREATEST(receipt.retain_until,receipt.server_time+interval '24 hours')
      FROM batch WHERE (receipt.principal_id,receipt.operation,receipt.request_id)=(batch.principal_id,batch.operation,batch.request_id)
      RETURNING receipt.principal_id
    ), counts AS (
      SELECT principal_id,
      count(*) FILTER(WHERE operation='acquire' AND outcome='acquired')::int acquired,
      count(*) FILTER(WHERE outcome='contended')::int contended,
      count(*) FILTER(WHERE operation IN ('renew','release'))::int mutation
      FROM batch GROUP BY principal_id
    ), counted AS (
      INSERT INTO coordination_principal_usage(principal_id,acquire_receipt_count,contended_receipt_count,mutation_receipt_count)
      SELECT principal_id,acquired,contended,mutation FROM counts ORDER BY principal_id
      ON CONFLICT(principal_id) DO UPDATE SET
        acquire_receipt_count=coordination_principal_usage.acquire_receipt_count+EXCLUDED.acquire_receipt_count,
        contended_receipt_count=coordination_principal_usage.contended_receipt_count+EXCLUDED.contended_receipt_count,
        mutation_receipt_count=coordination_principal_usage.mutation_receipt_count+EXCLUDED.mutation_receipt_count
    ) SELECT count(*)::int AS selected_count,
      (array_agg(principal_id ORDER BY principal_id DESC,operation DESC,request_id DESC))[1] AS principal_id,
      (array_agg(operation ORDER BY principal_id DESC,operation DESC,request_id DESC))[1] AS operation,
      (array_agg(request_id ORDER BY principal_id DESC,operation DESC,request_id DESC))[1] AS request_id FROM batch
    $receipts$ INTO item USING progress.receipt_principal_cursor,progress.receipt_operation_cursor,
      progress.receipt_request_cursor,batch_limit;
    selected_count:=item.selected_count;
    UPDATE coordination_contract_backfill_state SET
      receipt_principal_cursor = CASE WHEN selected_count<batch_limit THEN NULL
        ELSE COALESCE(item.principal_id,receipt_principal_cursor) END,
      receipt_operation_cursor = CASE WHEN selected_count<batch_limit THEN NULL
        ELSE COALESCE(item.operation,receipt_operation_cursor) END,
      receipt_request_cursor = CASE WHEN selected_count<batch_limit THEN NULL
        ELSE COALESCE(item.request_id,receipt_request_cursor) END,
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
  RETURN QUERY EXECUTE $page$ WITH eligible AS MATERIALIZED (
    SELECT progress.principal_id FROM coordination_principal_privacy_progress progress
    WHERE progress.repair_eligible IS TRUE AND (progress.privacy_version < 3 OR progress.completed_at IS NULL)
      AND progress.principal_id>=COALESCE($1,'00000000-0000-0000-0000-000000000000'::uuid)
      AND ($1 IS NULL OR progress.principal_id>$1)
    ORDER BY progress.principal_id LIMIT $2+1
  ), legacy AS MATERIALIZED (
    SELECT progress.principal_id FROM coordination_principal_privacy_progress progress
    WHERE progress.repair_eligible IS NOT TRUE AND (progress.privacy_version < 3 OR progress.completed_at IS NULL)
      AND progress.principal_id>=COALESCE($1,'00000000-0000-0000-0000-000000000000'::uuid)
      AND ($1 IS NULL OR progress.principal_id>$1)
    ORDER BY progress.principal_id LIMIT $2+1
  ), dirty AS MATERIALIZED (
    SELECT marker.principal_id FROM coordination_privacy_dirty_principals marker
    WHERE marker.principal_id>=COALESCE($1,'00000000-0000-0000-0000-000000000000'::uuid)
      AND ($1 IS NULL OR marker.principal_id>$1)
    ORDER BY marker.principal_id LIMIT $2+1
  ), raw AS MATERIALIZED (
    SELECT principal_id FROM eligible UNION SELECT principal_id FROM legacy UNION SELECT principal_id FROM dirty
  ), lookahead AS MATERIALIZED (
    SELECT principal_id FROM raw ORDER BY principal_id LIMIT $2+1
  ), consumed AS MATERIALIZED (
    SELECT principal_id FROM lookahead ORDER BY principal_id LIMIT $2
  ), filtered AS MATERIALIZED (
    SELECT principal.id AS principal_id,mapping.scope_id,
      CASE WHEN principal.offboarded_at IS NOT NULL THEN 'offboarded' ELSE 'disabled_only' END AS repair_state
    FROM consumed JOIN principals principal ON principal.id=consumed.principal_id AND principal.disabled_at IS NOT NULL
    JOIN principal_user_scopes mapping ON mapping.principal_id=principal.id
  ), page AS (
    SELECT count(*) > $2 AS more FROM lookahead
  ) SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('principal_id',filtered.principal_id,
      'scope_id',filtered.scope_id,'repair_state',filtered.repair_state) ORDER BY filtered.principal_id) FROM filtered),'[]'::jsonb),
    CASE WHEN page.more THEN (SELECT principal_id FROM consumed ORDER BY principal_id DESC LIMIT 1) END,
    page.more,(SELECT count(*)::int FROM consumed) FROM page
    $page$ USING after_principal_id,row_limit;
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_list_coordination_privacy_repair_page(UUID,UUID,INTEGER) FROM PUBLIC;

-- A completed shared scrub must not hide an incomplete owned-scope repair.
DO $owned_dirty$
DECLARE definition TEXT; revised TEXT;
BEGIN
  definition:=pg_get_functiondef('continuum_refresh_coordination_privacy_dirty(uuid)'::regprocedure);
  revised:=replace(definition,
    '    IF EXISTS (' || chr(10) || '      SELECT 1 FROM audit_log audit',
    '    IF EXISTS (SELECT 1 FROM coordination_scope_privacy_progress owned ' ||
    'WHERE owned.scope_id=owned_scope_id AND (owned.phase<>''complete'' OR owned.completed_at IS NULL)) OR EXISTS (' ||
      chr(10) || '      SELECT 1 FROM audit_log audit');
  IF revised=definition THEN RAISE EXCEPTION 'unable to include owned scope privacy in dirty discovery'; END IF;
  definition:=revised;
  revised:=replace(definition,
    '  EXCEPTION WHEN lock_not_available THEN' || chr(10) || '    RETURN;',
    '  EXCEPTION WHEN lock_not_available THEN' || chr(10) ||
    '    INSERT INTO coordination_privacy_dirty_principals(principal_id)' || chr(10) ||
    '    VALUES(target_principal_id) ON CONFLICT(principal_id)' || chr(10) ||
    '    DO UPDATE SET dirty_at=clock_timestamp();');
  IF revised=definition THEN RAISE EXCEPTION 'unable to preserve dirty evidence after refresh contention'; END IF;
  EXECUTE revised;
  EXECUTE format('ALTER FUNCTION %I.continuum_refresh_coordination_privacy_dirty(uuid) SET lock_timeout=''1s''',current_schema());
END;
$owned_dirty$;

CREATE FUNCTION continuum_operator_coordination_scope_privacy_state(
  authorization_principal_id UUID,target_scope_id UUID
) RETURNS TABLE(repair_exists BOOLEAN,phase TEXT,pseudonym TEXT,rows_processed BIGINT,
  scope_complete BOOLEAN,resources_remain BOOLEAN,receipts_remain BOOLEAN,
  leases_remain BOOLEAN,live_lease_until TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id,'approve');
  IF NOT EXISTS(SELECT 1 FROM principals actor JOIN scope_memberships membership ON membership.principal_id=actor.id
    WHERE actor.id=authorization_principal_id AND actor.disabled_at IS NULL
      AND membership.scope_id=continuum_org_scope_id() AND membership.active AND membership.role='admin'
      AND membership.source_kind='manual' AND membership.source_id='manual') THEN
    RAISE insufficient_privilege USING MESSAGE='scope privacy state requires a current manual org administrator';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM principal_user_scopes mapping
    JOIN principals principal ON principal.id=mapping.principal_id AND principal.disabled_at IS NOT NULL AND principal.kind='user'
    JOIN scopes scope ON scope.id=mapping.scope_id AND scope.kind='user'
    WHERE mapping.scope_id=target_scope_id AND EXISTS(
      SELECT 1 FROM principal_user_scope_approvals approval WHERE approval.principal_id=mapping.principal_id
        AND approval.scope_id=mapping.scope_id AND approval.acknowledged_evidence_hash=mapping.acknowledged_evidence_hash
        AND approval.acknowledged_principal_ids=mapping.acknowledged_principal_ids)) THEN
    RAISE insufficient_privilege USING MESSAGE='scope privacy state requires an approved disabled user mapping';
  END IF;
  RETURN QUERY WITH physical AS (
    SELECT EXISTS(SELECT 1 FROM coordination_resources resource WHERE resource.scope_id=target_scope_id) AS resources,
      EXISTS(SELECT 1 FROM coordination_operation_receipts receipt WHERE receipt.scope_id=target_scope_id) AS receipts,
      EXISTS(SELECT 1 FROM coordination_leases lease WHERE lease.scope_id=target_scope_id) AS leases
  ) SELECT progress.scope_id IS NOT NULL,progress.phase,progress.pseudonym,COALESCE(progress.rows_processed,0),
    NOT physical.resources AND NOT physical.receipts AND NOT physical.leases
      AND (progress.scope_id IS NULL OR (progress.phase='complete' AND progress.completed_at IS NOT NULL)),
    physical.resources,physical.receipts,physical.leases,
    (SELECT lease.expires_at FROM coordination_resources resource JOIN coordination_leases lease ON lease.lease_id=resource.current_lease_id
      WHERE resource.scope_id=target_scope_id AND lease.released_at IS NULL AND lease.expires_at>clock_timestamp()
      ORDER BY resource.resource COLLATE "C" LIMIT 1)
    FROM physical LEFT JOIN coordination_scope_privacy_progress progress ON progress.scope_id=target_scope_id;
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_coordination_scope_privacy_state(UUID,UUID) FROM PUBLIC;

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
    '        (''continuum_coordination_lock_principal_usage(uuid)''),' || chr(10) ||
    '        (''continuum_coordination_cleanup_expired_receipts(uuid)''),' || chr(10) ||
    '        (''continuum_coordination_contract_is_ready()'')');
  IF revised = definition THEN RAISE EXCEPTION 'unable to extend coordination quota lock allow-list'; END IF;
  definition := revised;
  revised := replace(definition,
    '        (''continuum_operator_list_coordination_privacy_repairs(uuid,uuid,uuid,integer)''),',
    '        (''continuum_operator_list_coordination_privacy_repairs(uuid,uuid,uuid,integer)''),' || chr(10) ||
    '        (''continuum_operator_list_coordination_privacy_repair_page(uuid,uuid,integer)''),' || chr(10) ||
    '        (''continuum_operator_coordination_scope_privacy_state(uuid,uuid)''),');
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
  ) THEN RAISE check_violation USING MESSAGE='scope has live coordination leases',
    CONSTRAINT='coordination_scope_live_lease'; END IF;

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

-- Apply only the effective v3 capacity and erased-retention fixes; keep its guards and ACLs.
DO $detached_capacity$
DECLARE definition TEXT; revised TEXT; old_anchor TEXT; new_anchor TEXT;
BEGIN
  SELECT replace(pg_get_functiondef('continuum_operator_scrub_coordination_principal_v3(uuid,uuid,uuid,integer)'::regprocedure),chr(13)||chr(10),chr(10)) INTO definition;
  revised := definition;
  old_anchor := $old_anchor_0$DECLARE detached_acquire_available INTEGER := 0;
DECLARE detached_contended_available INTEGER := 0;$old_anchor_0$;
  new_anchor := $new_anchor_0$DECLARE detached_receipt_available INTEGER := 0;$new_anchor_0$;
  IF position(old_anchor IN revised)=0 THEN RAISE EXCEPTION 'coordination detached capacity source anchor 0 is missing'; END IF;
  revised := replace(revised,old_anchor,new_anchor);
  old_anchor := $old_anchor_1$    SELECT COALESCE((
             SELECT acquire_receipt_limit - acquire_receipt_count
               FROM coordination_principal_usage WHERE principal_id = detached_id
           ), 10000),
           COALESCE((
             SELECT contended_receipt_limit - contended_receipt_count
               FROM coordination_principal_usage WHERE principal_id = detached_id
           ), 1000)
      INTO detached_acquire_available, detached_contended_available;
$old_anchor_1$;
  new_anchor := $new_anchor_1$    SELECT COALESCE((
      SELECT GREATEST(0,LEAST(acquire_receipt_limit,10000)-acquire_receipt_count::bigint-contended_receipt_count-mutation_receipt_count)::int
      FROM coordination_principal_usage WHERE principal_id=detached_id
    ),10000) INTO detached_receipt_available;
$new_anchor_1$;
  IF position(old_anchor IN revised)=0 THEN RAISE EXCEPTION 'coordination detached capacity source anchor 1 is missing'; END IF;
  revised := replace(revised,old_anchor,new_anchor);
  old_anchor := $old_anchor_2$    WITH ranked AS MATERIALIZED (
      SELECT receipt.operation, receipt.request_id, receipt.outcome,
             row_number() OVER (
               PARTITION BY receipt.outcome
               ORDER BY receipt.operation, receipt.request_id
             ) AS outcome_ordinal
        FROM coordination_operation_receipts receipt
       WHERE receipt.principal_id = target_principal_id
         AND receipt.scope_id <> owned_scope_id
    ), candidates AS MATERIALIZED (
      SELECT operation, request_id FROM ranked
       WHERE operation <> 'acquire'
          OR (outcome = 'acquired'
              AND outcome_ordinal <= detached_acquire_available)
          OR (outcome = 'contended'
              AND outcome_ordinal <= detached_contended_available)
       ORDER BY operation, request_id LIMIT batch_limit
    )
$old_anchor_2$;
  new_anchor := $new_anchor_2$    WITH bounded AS MATERIALIZED (
      SELECT receipt.operation,receipt.request_id
      FROM coordination_operation_receipts receipt
      WHERE receipt.principal_id=target_principal_id AND receipt.scope_id<>owned_scope_id
      ORDER BY receipt.operation,receipt.request_id LIMIT batch_limit
    ), ranked AS MATERIALIZED (
      SELECT bounded.*,row_number() OVER(ORDER BY operation,request_id) AS receipt_ordinal FROM bounded
    ), candidates AS MATERIALIZED (
      SELECT operation,request_id FROM ranked WHERE receipt_ordinal<=detached_receipt_available
      ORDER BY operation,request_id
    )
$new_anchor_2$;
  IF position(old_anchor IN revised)=0 THEN RAISE EXCEPTION 'coordination detached capacity source anchor 2 is missing'; END IF;
  revised := replace(revised,old_anchor,new_anchor);
  old_anchor := $old_anchor_3$    SELECT LEAST(detached_acquire_available,
                 acquire_receipt_limit - acquire_receipt_count),
           LEAST(detached_contended_available,
                 contended_receipt_limit - contended_receipt_count)
      INTO detached_acquire_available, detached_contended_available
      FROM coordination_principal_usage WHERE principal_id = detached_id;

$old_anchor_3$;
  new_anchor := $new_anchor_3$    SELECT LEAST(detached_receipt_available,
      GREATEST(0,LEAST(acquire_receipt_limit,10000)-acquire_receipt_count::bigint-contended_receipt_count-mutation_receipt_count)::int)
    INTO detached_receipt_available FROM coordination_principal_usage WHERE principal_id=detached_id;
$new_anchor_3$;
  IF position(old_anchor IN revised)=0 THEN RAISE EXCEPTION 'coordination detached capacity source anchor 3 is missing'; END IF;
  revised := replace(revised,old_anchor,new_anchor);
  old_anchor := $old_anchor_4$             receipt.outcome,
             row_number() OVER (
               PARTITION BY receipt.outcome
               ORDER BY receipt.operation, receipt.request_id
             ) AS outcome_ordinal$old_anchor_4$;
  new_anchor := $new_anchor_4$             row_number() OVER(ORDER BY receipt.operation,receipt.request_id) AS receipt_ordinal$new_anchor_4$;
  IF position(old_anchor IN revised)=0 THEN RAISE EXCEPTION 'coordination detached capacity source anchor 4 is missing'; END IF;
  revised := replace(revised,old_anchor,new_anchor);
  old_anchor := $old_anchor_5$       WHERE ranked.operation <> 'acquire'
          OR (ranked.outcome = 'acquired'
              AND ranked.outcome_ordinal <= detached_acquire_available)
          OR (ranked.outcome = 'contended'
              AND ranked.outcome_ordinal <= detached_contended_available)$old_anchor_5$;
  new_anchor := $new_anchor_5$       WHERE ranked.receipt_ordinal<=detached_receipt_available$new_anchor_5$;
  IF position(old_anchor IN revised)=0 THEN RAISE EXCEPTION 'coordination detached capacity source anchor 5 is missing'; END IF;
  revised := replace(revised,old_anchor,new_anchor);
  old_anchor := $old_anchor_6$        retain_until = '2000-01-01 00:00:00+00'::timestamptz,$old_anchor_6$;
  new_anchor := $new_anchor_6$        retain_until = '2000-01-02 00:00:00+00'::timestamptz,$new_anchor_6$;
  IF position(old_anchor IN revised)=0 THEN RAISE EXCEPTION 'coordination detached capacity source anchor 6 is missing'; END IF;
  revised := replace(revised,old_anchor,new_anchor);
  IF position('detached_acquire_available' IN revised)>0 OR position('detached_contended_available' IN revised)>0 OR position('outcome_ordinal' IN revised)>0 THEN RAISE EXCEPTION 'coordination detached capacity legacy bypass remains'; END IF;
  EXECUTE revised;
END;
$detached_capacity$;

-- Committed access revocation is protected authorization evidence, even when
-- its independently resumable coordination privacy phase is still blocked.
DO $access_evidence$
DECLARE definition TEXT; revised TEXT; signature TEXT;
BEGIN
  definition:=pg_get_functiondef('continuum_offboarding_expected_audit_metadata(jsonb)'::regprocedure);
  revised:=replace(definition,'  SELECT CASE', $branch$  SELECT CASE
    WHEN audit_metadata->>'operation'='principal_offboarding_access_revoked' THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key,entry.value),'{}'::jsonb)
       FROM jsonb_each(audit_metadata) entry WHERE entry.key=ANY(ARRAY[
         'operation','principal_id','approval_id','acknowledged_evidence_hash','run_id',
         'privacy_pending','reason','memberships','aliases','entra_bindings']::text[]))$branch$);
  IF revised=definition THEN RAISE EXCEPTION 'unable to extend access revocation audit classifier'; END IF;
  EXECUTE revised;
  FOREACH signature IN ARRAY ARRAY[
    'continuum_redact_offboarding_audit(uuid,uuid,bigint[])',
    'continuum_protect_offboarded_audit_tombstone()',
    'continuum_apply_audit_retention_internal_v44(uuid,timestamp with time zone,integer,uuid,integer,jsonb,text,text)'
  ] LOOP
    definition:=pg_get_functiondef(signature::regprocedure);
    revised:=replace(definition,'''principal_offboarding_repaired''',
      '''principal_offboarding_repaired'', ''principal_offboarding_access_revoked''');
    IF revised=definition THEN RAISE EXCEPTION 'unable to protect access revocation evidence in %',signature; END IF;
    EXECUTE revised;
  END LOOP;
END;
$access_evidence$;

CREATE FUNCTION continuum_guard_offboarding_access_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.metadata->>'operation'='principal_offboarding_access_revoked' THEN
      RAISE insufficient_privilege USING MESSAGE='access revocation audit evidence is immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.metadata->>'operation'='principal_offboarding_access_revoked' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE insufficient_privilege USING MESSAGE='access revocation audit evidence is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.metadata->>'operation' IS DISTINCT FROM 'principal_offboarding_access_revoked' THEN RETURN NEW; END IF;
  IF TG_OP<>'INSERT' THEN
    RAISE insufficient_privilege USING MESSAGE='access revocation audit evidence must be inserted by its approved operator';
  END IF;
  PERFORM continuum_require_trusted_database_identity(NEW.principal_id,'approve');
  IF NEW.action IS DISTINCT FROM 'archive' OR NEW.memory_id IS NOT NULL OR NEW.query IS NOT NULL
    OR NEW.metadata IS DISTINCT FROM continuum_offboarding_expected_audit_metadata(NEW.metadata)
    OR NEW.metadata->'privacy_pending' IS DISTINCT FROM 'true'::jsonb
    OR NOT COALESCE(NEW.metadata->>'reason' IN ('migration_pending','owned_live_lease'),FALSE)
    OR NOT COALESCE(jsonb_typeof(NEW.metadata->'memberships')='number'
      AND NEW.metadata->>'memberships' ~ '^[0-9]+$'
      AND jsonb_typeof(NEW.metadata->'aliases')='number' AND NEW.metadata->>'aliases' ~ '^[0-9]+$'
      AND jsonb_typeof(NEW.metadata->'entra_bindings')='number' AND NEW.metadata->>'entra_bindings' ~ '^[0-9]+$',FALSE)
    OR NOT EXISTS(SELECT 1 FROM principals actor JOIN scope_memberships membership ON membership.principal_id=actor.id
      WHERE actor.id=NEW.principal_id AND actor.disabled_at IS NULL
        AND membership.scope_id=continuum_org_scope_id() AND membership.active AND membership.role='admin'
        AND membership.source_kind='manual' AND membership.source_id='manual') THEN
    RAISE insufficient_privilege USING MESSAGE='access revocation audit evidence has invalid authorization or metadata';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM principal_offboarding_runs run
    JOIN principal_user_scope_approvals approval ON approval.id=run.approval_id
      AND approval.principal_id=run.principal_id AND approval.scope_id=run.scope_id
      AND approval.acknowledged_evidence_hash=run.approval_evidence_hash
    JOIN principals target ON target.id=run.principal_id AND target.disabled_at IS NOT NULL
    JOIN principal_offboarding_run_events started ON started.run_id=run.run_id AND started.phase='started'
      AND started.principal_id=run.principal_id AND started.scope_id=run.scope_id
      AND started.approval_id=run.approval_id AND started.approval_evidence_hash=run.approval_evidence_hash
      AND started.initiated_by=run.initiated_by
    WHERE run.completed_at IS NULL AND run.scope_id=NEW.scope_id
      AND run.run_id::text=NEW.metadata->>'run_id' AND run.principal_id::text=NEW.metadata->>'principal_id'
      AND run.approval_id::text=NEW.metadata->>'approval_id'
      AND run.approval_evidence_hash=NEW.metadata->>'acknowledged_evidence_hash'
  ) THEN RAISE insufficient_privilege USING MESSAGE='access revocation audit evidence does not match its approved run'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_guard_offboarding_access_audit() FROM PUBLIC;
CREATE TRIGGER guard_offboarding_access_audit BEFORE INSERT OR UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION continuum_guard_offboarding_access_audit();

-- The detached history identity is a storage sink, never an interactive actor.
DO $detached_preflight$
BEGIN
  IF EXISTS(SELECT 1 FROM principals WHERE id='00000000-0000-4000-8000-000000000012'
      AND (disabled_at IS NULL OR kind<>'service'))
    OR EXISTS(SELECT 1 FROM scope_memberships WHERE principal_id='00000000-0000-4000-8000-000000000012')
    OR EXISTS(SELECT 1 FROM service_api_keys WHERE principal_id='00000000-0000-4000-8000-000000000012')
    OR EXISTS(SELECT 1 FROM continuum_trusted_database_identities WHERE principal_id='00000000-0000-4000-8000-000000000012') THEN
    RAISE EXCEPTION 'reserved detached coordination identity has authority drift; the migration owner must review and remove its memberships, keys and trusted bindings and restore its disabled service state before retrying';
  END IF;
END;
$detached_preflight$;
ALTER TABLE principals ADD CONSTRAINT principals_detached_coordination_identity_check
CHECK(id<>'00000000-0000-4000-8000-000000000012' OR (kind='service' AND disabled_at IS NOT NULL));

CREATE FUNCTION continuum_guard_detached_coordination_authority()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.principal_id='00000000-0000-4000-8000-000000000012' THEN
    RAISE insufficient_privilege USING MESSAGE='reserved detached coordination principal cannot have memberships, keys or trusted identities';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_guard_detached_coordination_authority() FROM PUBLIC;
CREATE TRIGGER guard_detached_coordination_membership BEFORE INSERT OR UPDATE ON scope_memberships
FOR EACH ROW EXECUTE FUNCTION continuum_guard_detached_coordination_authority();
CREATE TRIGGER guard_detached_coordination_key BEFORE INSERT OR UPDATE ON service_api_keys
FOR EACH ROW EXECUTE FUNCTION continuum_guard_detached_coordination_authority();
CREATE TRIGGER guard_detached_coordination_identity BEFORE INSERT OR UPDATE ON continuum_trusted_database_identities
FOR EACH ROW EXECUTE FUNCTION continuum_guard_detached_coordination_authority();

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN SELECT function.proname,pg_get_function_identity_arguments(function.oid) arguments
    FROM pg_proc function WHERE function.pronamespace=quote_ident(current_schema())::regnamespace
      AND function.proname=ANY(ARRAY[
        'continuum_coordination_require_contract_ready','continuum_coordination_contract_is_ready','continuum_require_coordination_privacy_client_v4','continuum_coordination_compatibility_guard',
        'continuum_coordination_lock_principal_usage','continuum_coordination_cleanup_expired_receipts','continuum_coordination_receipt_counter',
        'continuum_coordination_receipt_reassign_counter','continuum_backfill_coordination_contract',
        'continuum_coordination_resource_counter','continuum_operator_set_coordination_scope_quota',
        'continuum_operator_set_coordination_principal_quota','continuum_operator_reclaim_coordination_resource',
        'continuum_operator_list_coordination_privacy_repair_page','continuum_operator_coordination_scope_privacy_state','continuum_operator_pseudonymize_scope_v2_legacy',
        'continuum_operator_scrub_coordination_principal_v3','continuum_guard_offboarding_access_audit',
        'continuum_guard_detached_coordination_authority'
      ]) LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path=pg_catalog,%I,pg_temp',schema_name,function_record.proname,function_record.arguments,schema_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC',schema_name,function_record.proname,function_record.arguments);
  END LOOP;
END;
$harden$;
